import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentState, MainState, Overrides, PauseState, QuotaLimits, QuotaState, QuotaWindow } from '../types'
import {
  DEFAULT_THRESHOLDS,
  HOUR,
  MINUTE,
  alertsFor,
  fmtDur,
  nextClock,
  outlookOf,
  paceOf,
  pingDue,
  resetPassed,
  spendsWindow,
  windowsOf,
} from './logic'
import type { Alert, Sample, Thresholds } from './logic'

const PANE = 'quota'
const SHAPE = 'quota-1'
const SAMPLE_SPAN = 6 * HOUR
const MAX_SAMPLES = 400
const MAX_ROWS = 12

// Words the model reads on each ping. A ping does nothing but keep the cache warm.
const PING_MAIN = 'Keep-alive ping from the quota mod. Reply with the single word ok and do nothing else.'
const PING_AGENT = 'Keep-alive ping from the quota mod. Reply with the single word ok and do nothing else; stay paused.'

const quota = atom({ plugin: 'quota-keepalive', key: 'quota' } as const, { limits: null, samples: [], said: [], refreshedAt: 0, needsRefresh: true, unavailable: '' } as QuotaState, { shape: SHAPE })
const overrides = atom({ plugin: 'quota-keepalive', key: 'overrides' } as const, { thresholds: {}, simulate: null, weekModelPercent: null, pingMinutes: null } as Overrides, { shape: SHAPE })
const pause = atom({ plugin: 'quota-keepalive', key: 'pause' } as const, { kind: 'none', until: null, window: '', startedAt: 0, lastPingAt: 0, reason: '' } as PauseState, { shape: SHAPE })
const main = atom({ plugin: 'quota-keepalive', key: 'main' } as const, { model: '', lastTurnAt: 0, lastCacheAt: 0 } as MainState, { shape: SHAPE })
const agents = atom({ plugin: 'quota-keepalive', key: 'agents' } as const, {} as Record<string, AgentState>, { shape: SHAPE })

type Options = Record<string, unknown>

// Options from the manifest's userConfig; anything not a number falls back to the default.
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

const baseThresholds = (o: Options): Thresholds => ({
  headsUp: num(o.headsUpPercent, DEFAULT_THRESHOLDS.headsUp),
  subagentsStop: num(o.subagentsStopPercent, DEFAULT_THRESHOLDS.subagentsStop),
  mainStop: num(o.mainStopPercent, DEFAULT_THRESHOLDS.mainStop),
  weekStop: num(o.weekStopPercent, DEFAULT_THRESHOLDS.weekStop),
})

const pingMs = (o: Options, ov: Overrides): number => {
  const m = ov.pingMinutes ?? num(o.pingMinutes, 45)
  // Under the one-hour cache lifetime, with a margin.
  return Math.min(55, Math.max(1, m)) * MINUTE
}

const refreshMs = (o: Options): number => Math.max(1, num(o.refreshMinutes, 10)) * MINUTE

const thresholdsOf = (o: Options, ov: Overrides): Thresholds => ({ ...baseThresholds(o), ...ov.thresholds })

const toWindow = (kind: string, label: string, rl: { kind: string; percentUsed: number; resetsAt?: string }[]): QuotaWindow | null => {
  const hit = rl.find(r => r.kind === kind)
  if (!hit) return null
  return { label, percent: hit.percentUsed, resetsAt: hit.resetsAt ? Date.parse(hit.resetsAt) : null }
}

const clipText = (s: string): string => (s.length > 220 ? s.slice(0, 219) + '…' : s)

// A plain user row the model reads; the person sees nothing of it as typed.
async function tellMain($: EngineInterface, text: string): Promise<void> {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

// Pauses or wakes what is running beneath the main session.
async function tellRunningAgents($: EngineInterface, text: string): Promise<void> {
  const list = await $.agent.list()
  const map = await read($, agents)
  for (const a of list) {
    if (a.status !== 'running') continue
    if (map[a.id]?.status === 'paused') continue
    await $.session.send({ to: { agentId: a.id }, text })
  }
}

// Refresh the readings: the live plan windows, or the simulated ones in test mode.
async function refresh($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const ov = await read($, overrides)
  const q = await read($, quota)
  const m = await read($, main)
  let limits: QuotaLimits | null = q.limits
  let unavailable = ''

  if (ov.simulate) {
    const week: QuotaWindow = { label: 'Weekly · all models', percent: ov.simulate.week, resetsAt: now + 5 * 24 * HOUR }
    limits = {
      at: now,
      fiveHour: { label: '5-hour limit', percent: ov.simulate.fiveHour, resetsAt: now + 3 * HOUR },
      weekAll: week,
      weekModel: ov.weekModelPercent === null ? null : { label: `Weekly · ${m.model || 'model'}`, percent: ov.weekModelPercent, resetsAt: week.resetsAt },
      contextPercent: null,
      source: 'simulated',
    }
  } else {
    try {
      const u = await $.session.usage()
      const rl = u.rateLimits ?? []
      const weekAll = toWindow('seven_day', 'Weekly · all models', rl)
      limits = {
        at: now,
        fiveHour: toWindow('five_hour', '5-hour limit', rl),
        weekAll,
        weekModel: ov.weekModelPercent === null ? null : { label: `Weekly · ${m.model || 'model'}`, percent: ov.weekModelPercent, resetsAt: weekAll?.resetsAt ?? null },
        contextPercent: u.context.percent ?? null,
        source: 'live',
      }
    } catch (err) {
      unavailable = clipText(`could not read the plan limits: ${(err as Error).message}`)
    }
  }

  const sample: Sample = { at: now, fiveHour: limits?.fiveHour?.percent ?? null, weekAll: limits?.weekAll?.percent ?? null }
  const samples = [...q.samples, sample].filter(s => now - s.at <= SAMPLE_SPAN).slice(-MAX_SAMPLES)
  await update($, quota, prev => ({ ...prev, limits, samples, refreshedAt: now, needsRefresh: false, unavailable }))
}

// Says each new threshold once, and starts the pause the stop levels call for.
async function judge($: EngineInterface, opts: Options): Promise<void> {
  const q = await read($, quota)
  if (!q.limits) return
  const ov = await read($, overrides)
  const t = thresholdsOf(opts, ov)
  const fresh = alertsFor(q.limits, t, q.said)
  if (fresh.length === 0) return
  const now = await $.clock.now()

  for (const a of fresh) await deliver($, a, now)
  await update($, quota, prev => ({ ...prev, said: [...prev.said, ...fresh.map(a => a.id)] }))
}

async function deliver($: EngineInterface, a: Alert, now: number): Promise<void> {
  void $.ui.toast(`Quota: ${a.text}`)
  if (a.level === 'heads-up') return

  if (a.level === 'subagents-stop') {
    await tellRunningAgents($, `Quota: ${a.window} at ${a.percent}%. Stop at a clean point, save what you have, and reply "paused for quota".`)
    return
  }

  if (a.level === 'main-stop') {
    await tellRunningAgents($, `Quota: ${a.window} at ${a.percent}%. Stop at a clean point, save what you have, and reply "paused for quota".`)
    await tellMain($, `[quota mod] ${a.text}`)
    await startPause($, 'quota', a.window, now)
    return
  }

  // week-stop
  await tellRunningAgents($, `Quota: ${a.window} at ${a.percent}%. Stop at a clean point, save what you have, and reply "paused for quota".`)
  await tellMain($, `[quota mod] ${a.text} Tell the person plainly; they can enable a quota reset themselves.`)
  await startPause($, 'quota', a.window, now)
}

// Starts a pause. Its end is the window's reset (or the clock time the person gave).
async function startPause($: EngineInterface, kind: 'quota' | 'time', window: string, now: number, until: number | null = null): Promise<void> {
  const p = await read($, pause)
  if (p.kind !== 'none' && kind === 'quota') return
  const q = await read($, quota)
  const limits = q.limits
  const resets = kind === 'time' ? until : windowEnd(limits, window)
  await update($, pause, () => ({ kind, until: resets, window, startedAt: now, lastPingAt: now, reason: window }))
}

function windowEnd(limits: QuotaLimits | null, label: string): number | null {
  if (!limits) return null
  const hit = windowsOf(limits).find(w => w.win.label === label)
  return hit ? hit.win.resetsAt : null
}

// Ends a pause: main continues, paused subagents resume.
async function resume($: EngineInterface, why: string): Promise<string> {
  const p = await read($, pause)
  if (p.kind === 'none') return 'Nothing is paused.'
  await update($, pause, () => ({ kind: 'none', until: null, window: '', startedAt: 0, lastPingAt: 0, reason: '' }))
  const list = await $.agent.list()
  const map = await read($, agents)
  for (const a of list) {
    if (map[a.id]?.status === 'paused') {
      await $.session.send({ to: { agentId: a.id }, text: `${why} Continue the work from where you stopped.` })
    }
  }
  await update($, agents, m => Object.fromEntries(Object.entries(m).map(([id, a]) => [id, a.status === 'paused' ? { ...a, status: 'running' } : a])))
  void $.prompt.submit({ text: `${why} Continue the work from where you stopped.` })
  return why
}

// Pings the main session and each paused subagent, once per interval, while a pause runs.
async function keepAlive($: EngineInterface, opts: Options): Promise<void> {
  const p = await read($, pause)
  if (p.kind === 'none') return
  const now = await $.clock.now()
  const ov = await read($, overrides)
  if (!pingDue(p.lastPingAt, now, pingMs(opts, ov))) return
  await update($, pause, prev => ({ ...prev, lastPingAt: now }))
  void $.prompt.submit({ text: PING_MAIN })
  const map = await read($, agents)
  for (const [id, a] of Object.entries(map)) {
    if (a.status === 'paused') await $.session.send({ to: { agentId: id }, text: PING_AGENT })
  }
}

// One pass, once a minute: refresh when due, judge thresholds, end pauses, ping.
async function tick($: EngineInterface, opts: Options): Promise<void> {
  const now = await $.clock.now()
  const q = await read($, quota)
  if (q.needsRefresh || !q.limits || now - q.refreshedAt >= refreshMs(opts)) await refresh($)
  await judge($, opts)

  const p = await read($, pause)
  if (p.kind === 'quota' && resetPassed(p.until, now)) await resume($, 'The quota window reset.')
  else if (p.kind === 'time' && p.until !== null && now >= p.until) await resume($, 'The time you gave has come.')
  else await keepAlive($, opts)
}

// Plain-language rows for the pane; read only.
async function rows($: EngineInterface, opts: Options): Promise<string[]> {
  const now = await $.clock.now()
  const q = await read($, quota)
  const ov = await read($, overrides)
  const p = await read($, pause)
  const m = await read($, main)
  const map = await read($, agents)
  const t = thresholdsOf(opts, ov)
  const out: string[] = []

  if (ov.simulate) out.push('SIMULATED values (test mode): /quota simulate off ends it')
  if (q.unavailable) out.push(q.unavailable)
  const l = q.limits
  if (!l) return [...out, 'Reading the limits…']

  const five = l.fiveHour
  const week = l.weekAll
  const wm = l.weekModel
  if (five) {
    const pace = paceOf(q.samples, 'fiveHour', now)
    const o = outlookOf(five, pace, now)
    out.push(`5-hour limit: ${five.percent}% used, resets in ${five.resetsAt ? fmtDur(five.resetsAt - now) : '?'}`)
    out.push(`  pace ${o.perHour === null ? '…' : o.perHour.toFixed(1)}%/h; ${paceWords(o.hoursToFull, o.lastsToReset)}`)
  } else out.push('5-hour limit: not reported')

  if (week) {
    const pace = paceOf(q.samples, 'weekAll', now)
    const o = outlookOf(week, pace, now)
    out.push(`Weekly · all models: ${week.percent}% used, resets in ${week.resetsAt ? fmtDur(week.resetsAt - now) : '?'}`)
    out.push(`  pace ${o.perHour === null ? '…' : o.perHour.toFixed(2)}%/h; ${paceWords(o.hoursToFull, o.lastsToReset)}`)
  } else out.push('Weekly · all models: not reported')

  const modelName = m.model || 'main model (no turn yet)'
  if (wm) out.push(`Weekly · ${modelName}: ${wm.percent}% (set by hand)`)
  else out.push(`Weekly · ${modelName}: not readable by a mod. Set it with /quota model <percent>`)

  if (l.contextPercent !== null) out.push(`Context: ${l.contextPercent}%`)
  out.push(`Thresholds: heads-up ${t.headsUp}% · subagents stop ${t.subagentsStop}% · main stop ${t.mainStop}% · weekly stop ${t.weekStop}%`)

  if (m.lastCacheAt) {
    const age = now - m.lastCacheAt
    const due = p.kind === 'none' ? 'no pings (not paused)' : `next ping in ${fmtDur(Math.max(0, p.lastPingAt + pingMs(opts, ov) - now))}`
    out.push(`Main cache: ${fmtDur(age)} old; ${due}`)
  }
  out.push('Overage: a mod cannot see it. If the session enters extra usage, the cache drops to 5 minutes.')

  if (p.kind === 'none') out.push('Pause: none')
  else if (p.kind === 'quota') out.push(`Paused for quota (${p.window}) until ${p.until ? fmtDur(p.until - now) : 'the reset'} from now; keep-alive on`)
  else out.push(`Paused until ${p.until ? new Date(p.until).toLocaleTimeString() : '?'}; keep-alive on`)

  const agentList = await $.agent.list()
  const seen = agentList.slice(0, MAX_ROWS)
  if (seen.length === 0) out.push('Subagents: none yet')
  for (const a of seen) {
    const s = map[a.id]
    const modelLabel = s?.model ? s.model : 'model ?'
    const status = s?.status === 'paused' ? 'paused for quota' : a.status
    const cache = s?.lastCacheAt ? `cache ${fmtDur(now - s.lastCacheAt)} old` : 'cache ?'
    const spend = s && m.model ? (spendsWindow(s.model, m.model) === 'model' ? 'spends model window' : 'spends all-models window') : ''
    out.push(`  ${a.description || a.type} · ${modelLabel} · ${status} · ${s?.tokens ?? 0} tokens · ${cache}${spend ? ' · ' + spend : ''}`)
  }
  return out
}

function paceWords(hoursToFull: number | null, lastsToReset: boolean | null): string {
  if (hoursToFull === null) return 'not enough readings yet'
  if (lastsToReset === null) return `runs out in ${fmtDur(hoursToFull * HOUR)} at this pace`
  return lastsToReset ? `at this pace it runs out in ${fmtDur(hoursToFull * HOUR)}, after its reset` : `at this pace it runs out in ${fmtDur(hoursToFull * HOUR)}, before its reset`
}

export const register: Register = (on, options) => {
  const opts = options as unknown as Options

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'quota',
      description:
        'Quota mod: /quota shows the plan limits; `/quota pause until HH:MM` keeps the cache alive until then; `/quota continue`; `/quota threshold <heads-up|subagents|main|week> <percent>`; `/quota simulate <5h%> <week%>` or `off` (test mode); `/quota model <percent>` or `off`',
    })
    void $.ui.open({ id: PANE, title: 'Quota' })
    await tick($, opts)
    $.clock.every(MINUTE, () => {
      void tick($, opts)
    })
    return started
  })

  // Main model and the main cache: observed, never answered.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (!usage) return result
    const now = await $.clock.now()
    const model = usage.model || e.model
    const cached = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) > 0
    const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
    if (!e.agentId) {
      await update($, main, m => ({ ...m, model, lastTurnAt: now, lastCacheAt: cached ? now : m.lastCacheAt }))
    } else {
      const agentId = e.agentId
      await update($, agents, map => {
        const prev = map[agentId] ?? { model, tokens: 0, lastCacheAt: 0, status: 'running' as const }
        return { ...map, [agentId]: { ...prev, model, tokens: prev.tokens + tokens, lastCacheAt: cached ? now : prev.lastCacheAt } }
      })
    }
    return result
  })

  // A subagent's turn ended: read its status, and take a fresh reading (once per subagent end, never per turn).
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const agentId = (e as unknown as { agentId?: string }).agentId
    if (!agentId) return r
    const text = String((r as unknown as { text?: string }).text ?? '')
    const saysPaused = /paused for quota/i.test(text)
    await update($, agents, map => {
      const prev = map[agentId]
      if (!prev) return map
      // A paused subagent stays paused until resume(): its ping replies ("ok") do not end the pause.
      const status: AgentState['status'] = saysPaused || prev.status === 'paused' ? 'paused' : 'finished'
      return { ...map, [agentId]: { ...prev, status } }
    })
    await update($, quota, prev => ({ ...prev, needsRefresh: true }))
    return r
  })

  on('command.run', { command: 'quota' }, async ($, e) => {
    const [verb = '', a = '', b = ''] = (e.args ?? '').trim().split(/\s+/)
    const now = await $.clock.now()

    if (verb === '' || verb === 'show') {
      await refresh($)
      return { text: (await rows($, opts)).join('\n') }
    }

    if (verb === 'pause') {
      if (a !== 'until') return { text: 'Use: /quota pause until HH:MM' }
      const at = nextClock(b, now)
      if (at === null) return { text: 'Use a clock time: /quota pause until 15:45' }
      await startPause($, 'time', 'time', now, at)
      await tellMain($, `[quota mod] The person paused you until ${new Date(at).toLocaleTimeString()}. Stop starting work; finish only what is in hand and report. The mod keeps the cache warm and will tell you to continue.`)
      await tellRunningAgents($, 'The person paused the work. Stop at a clean point, save what you have, and reply "paused for quota".')
      return { text: `Paused until ${new Date(at).toLocaleTimeString()}; keep-alive pings on.` }
    }

    if (verb === 'continue') {
      const why = await resume($, 'The person said to continue.')
      return { text: why === 'Nothing is paused.' ? why : 'Continuing.' }
    }

    if (verb === 'threshold') {
      const names: Record<string, keyof Thresholds> = { 'heads-up': 'headsUp', subagents: 'subagentsStop', main: 'mainStop', week: 'weekStop' }
      const key = names[a]
      const pct = Number(b)
      if (!key || !Number.isFinite(pct) || pct < 1 || pct > 100) return { text: 'Use: /quota threshold <heads-up|subagents|main|week> <1-100>' }
      await update($, overrides, prev => ({ ...prev, thresholds: { ...prev.thresholds, [key]: pct } }))
      await update($, quota, prev => ({ ...prev, said: [] }))
      return { text: `Threshold ${a} set to ${pct}%.` }
    }

    if (verb === 'simulate') {
      if (a === 'off') {
        await update($, overrides, prev => ({ ...prev, simulate: null }))
        await update($, quota, prev => ({ ...prev, needsRefresh: true, said: [] }))
        return { text: 'Simulation off: live values again.' }
      }
      const five = Number(a)
      const week = Number(b)
      if (!Number.isFinite(five) || !Number.isFinite(week)) return { text: 'Use: /quota simulate <5-hour %> <week %>, or /quota simulate off' }
      await update($, overrides, prev => ({ ...prev, simulate: { fiveHour: five, week } }))
      await update($, quota, prev => ({ ...prev, needsRefresh: true, said: [] }))
      await tick($, opts)
      return { text: `SIMULATED: 5-hour ${five}%, weekly ${week}%. Thresholds fire from these numbers.` }
    }

    if (verb === 'model') {
      if (a === 'off') {
        await update($, overrides, prev => ({ ...prev, weekModelPercent: null }))
        return { text: 'Per-model weekly reading cleared.' }
      }
      const pct = Number(a)
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { text: 'Use: /quota model <percent>, or /quota model off' }
      await update($, overrides, prev => ({ ...prev, weekModelPercent: pct }))
      await update($, quota, prev => ({ ...prev, needsRefresh: true }))
      return { text: `Per-model weekly set to ${pct}% by hand.` }
    }

    return { text: 'Quota commands: show · pause until HH:MM · continue · threshold · simulate · model' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = await rows($, opts)
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i} dimColor={line.startsWith('  ') || line.startsWith('Overage')}>
            {line}
          </Text>
        ))}
      </Box>
    )
  })
}
