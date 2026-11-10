import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentState, MainState, Overrides, PauseState, QuotaLimits, QuotaState, QuotaWindow, WarmFacts } from '../types'
import {
  DEFAULT_THRESHOLDS,
  HOUR,
  MINUTE,
  alertsFor,
  STAY_WARM_DEFAULT,
  STAY_WARM_EVERY,
  STAY_WARM_FOR,
  limitSpent,
  pingPlan,
  planDue,
  cacheWrittenAt,
  fmtDur,
  keepAliveWorth,
  nextClock,
  outlookOf,
  paceOf,
  quotaBack,
  spendsWindow,
  stayWarmPlan,
  windowsOf,
} from './logic'
import type { Alert, Sample, StayWarm, Thresholds, WarmPlan } from './logic'
import { barSvg, blocks, cacheTone, pct, ringSvg, scaleSvg, toneOf } from './view'
import type { Tone } from './view'

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
const NO_PAUSE: PauseState = { kind: 'none', until: null, window: '', startedAt: 0, lastPingAt: 0, reason: '' }
const pause = atom({ plugin: 'quota-keepalive', key: 'pause' } as const, NO_PAUSE, { shape: SHAPE })
const main = atom({ plugin: 'quota-keepalive', key: 'main' } as const, { model: '', lastTurnAt: 0, lastCacheAt: 0 } as MainState, { shape: SHAPE })
const said = atom({ plugin: 'quota-keepalive', key: 'said' } as const, '' as string, { shape: SHAPE })
const settingsOpen = atom({ plugin: 'quota-keepalive', key: 'settingsOpen' } as const, false as boolean, { shape: SHAPE })
const warmCfg = atom({ plugin: 'quota-keepalive', key: 'warmCfg' } as const, STAY_WARM_DEFAULT as StayWarm, { shape: SHAPE })
const warm = atom({ plugin: 'quota-keepalive', key: 'warm' } as const, { lastWorkAt: 0, lastPingAt: 0, busy: false } as WarmFacts, { shape: SHAPE })
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


// The panel's pass, as often as the cache-countdown band's: reading the plan limits is local and free.
const TICK_MS = 15_000
// Pace keeps one reading a minute, so six hours of history fit in MAX_SAMPLES.
const SAMPLE_EVERY = MINUTE

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
  const last = q.samples[q.samples.length - 1]
  const kept = last && now - last.at < SAMPLE_EVERY ? q.samples : [...q.samples, sample]
  const samples = kept.filter(s => now - s.at <= SAMPLE_SPAN).slice(-MAX_SAMPLES)
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
  await update($, pause, () => ({ kind, until: resets, window, startedAt: now, lastPingAt: 0, reason: window }))
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
  await update($, pause, () => NO_PAUSE)
  const list = await $.agent.list()
  const map = await read($, agents)
  for (const a of list) {
    if (map[a.id]?.status === 'paused') {
      await $.session.send({ to: { agentId: a.id }, text: `${why} Continue the work from where you stopped.` })
    }
  }
  await update($, agents, m => Object.fromEntries(Object.entries(m).map(([id, a]) => [id, a.status === 'paused' ? { ...a, status: 'running' as const } : a])))
  void $.prompt.submit({ text: `${why} Continue the work from where you stopped.` })
  return why
}

// Pings the main session and each paused subagent while a pause runs: each cache on its own
// clock, from when it was last written, so a cache already old when the pause began is not lost.
// The window a pause waits on, as last read: its percent, for the stand-down at 100%.
function spentNow(q: QuotaState): boolean {
  const l = q.limits
  return l ? limitSpent(windowsOf(l).map(w => w.win.percent)) : false
}

// Pings the main session and each paused subagent while a pause runs, on a plan made from the
// time to reset: equal gaps of at most 50 minutes from each cache's last write, so every cache is
// still warm when the pause ends. Nothing to set. The keep-alive stands down when a pause is
// days long (a weekly window) or a limit is at 100%, where every request is refused.
async function keepAlive($: EngineInterface): Promise<void> {
  const p = await read($, pause)
  if (p.kind === 'none') return
  const now = await $.clock.now()
  if (p.kind === 'quota' && !keepAliveWorth(p.until, now)) return
  if (spentNow(await read($, quota))) return
  const m = await read($, main)

  if (planDue(pingPlan(cacheWrittenAt(m.lastCacheAt, p.startedAt), p.until), p.lastPingAt, now)) {
    await update($, pause, prev => ({ ...prev, lastPingAt: now }))
    $.prompt.submit({ text: PING_MAIN }).catch(err => $.ui.log(`quota: keep-alive ping to the main session failed: ${(err as Error).message}`))
  }

  const map = await read($, agents)
  for (const [id, a] of Object.entries(map)) {
    if (a.status !== 'paused') continue
    if (!planDue(pingPlan(cacheWrittenAt(a.lastCacheAt, p.startedAt), p.until), a.lastPingAt ?? 0, now)) continue
    await update($, agents, all => (all[id] ? { ...all, [id]: { ...all[id], lastPingAt: now } } : all))
    try {
      await $.session.send({ to: { agentId: id }, text: PING_AGENT })
    } catch (err) {
      $.ui.log(`quota: keep-alive ping to subagent ${id} failed: ${(err as Error).message}`)
    }
  }
}

// What Stay warm would do now, from the readings and the session's state.
async function warmPlanNow($: EngineInterface, opts: Options): Promise<WarmPlan> {
  const now = await $.clock.now()
  const cfg = await read($, warmCfg)
  const w = await read($, warm)
  const p = await read($, pause)
  const q = await read($, quota)
  const m = await read($, main)
  const t = thresholdsOf(opts, await read($, overrides))
  const percents = q.limits ? windowsOf(q.limits).map(x => x.win.percent) : []
  return stayWarmPlan(
    cfg,
    {
      paused: p.kind !== 'none',
      busy: w.busy,
      maxPercent: percents.length ? Math.max(...percents) : null,
      headsUp: t.headsUp,
      lastCacheAt: m.lastCacheAt,
      lastWorkAt: w.lastWorkAt,
      lastPingAt: w.lastPingAt,
    },
    now,
  )
}

// Stay warm: while usage is low and the session idles, a ping each interval keeps the cache
// alive for the person's return, up to the time limit they picked. Off unless they turn it on.
async function stayWarm($: EngineInterface, opts: Options): Promise<void> {
  const plan = await warmPlanNow($, opts)
  if (!plan.due) return
  const now = await $.clock.now()
  await update($, warm, prev => ({ ...prev, lastPingAt: now }))
  $.prompt.submit({ text: PING_MAIN }).catch(err => $.ui.log(`quota: stay-warm ping failed: ${(err as Error).message}`))
}

// The level that started a quota pause on this window: the 5-hour main stop, else the weekly stop.
function stopLevelOf(window: string, t: Thresholds): number {
  return window === '5-hour limit' ? t.mainStop : t.weekStop
}

// One pass at a time: a slow refresh must not let the next minute's pass start beside it.
let ticking = false

// One pass, once a minute: refresh when due, judge thresholds, end pauses, ping.
async function tick($: EngineInterface, opts: Options): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const now = await $.clock.now()
    // Every pass reads the limits afresh; the write redraws the panel, so its countdowns stay live.
    await refresh($)
    await judge($, opts)

    const p = await read($, pause)
    if (p.kind === 'quota') {
      const fresh = await read($, quota)
      const win = fresh.limits ? windowsOf(fresh.limits).find(w => w.win.label === p.window)?.win ?? null : null
      // A pause begun before the reset time was known learns it from a later reading.
      if (p.until === null && win?.resetsAt) await update($, pause, prev => ({ ...prev, until: win.resetsAt }))
      const t = thresholdsOf(opts, await read($, overrides))
      // Only a reading taken after the pause began can say the window came back.
      const readAfter = fresh.limits !== null && fresh.limits.at > p.startedAt
      if (quotaBack(p.until ?? win?.resetsAt ?? null, now, readAfter && win ? win.percent : null, stopLevelOf(p.window, t))) {
        await resume($, 'The quota window reset.')
        return
      }
    } else if (p.kind === 'time' && p.until !== null && now >= p.until) {
      await resume($, 'The time you gave has come.')
      return
    }
    await keepAlive($)
    await stayWarm($, opts)
  } finally {
    ticking = false
  }
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
    const due =
      p.kind === 'none'
        ? 'no pings (not paused)'
        : p.kind === 'quota' && !keepAliveWorth(p.until, now)
          ? 'no pings: the pause ends too far off to keep the cache warm'
          : (() => {
              const plan = pingPlan(cacheWrittenAt(m.lastCacheAt, p.startedAt), p.until)
              return plan ? `next ping in ${fmtDur(Math.max(0, plan.next - now))}` : 'no ping needed before the reset'
            })()
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

// What /quota and the pane's controls do; each answers the line to show.
async function pauseUntil($: EngineInterface, hhmm: string): Promise<string> {
  const now = await $.clock.now()
  const at = nextClock(hhmm, now)
  if (at === null) return 'Use a clock time, like 15:45.'
  return pauseAt($, at)
}

async function pauseAt($: EngineInterface, at: number): Promise<string> {
  const now = await $.clock.now()
  if (at <= now) return 'That time has passed.'
  await update($, pause, () => NO_PAUSE)
  await startPause($, 'time', 'time', now, at)
  await tellMain($, `[quota mod] The person paused you until ${new Date(at).toLocaleTimeString()}. Stop starting work; finish only what is in hand and report. The mod keeps the cache warm and will tell you to continue.`)
  await tellRunningAgents($, 'The person paused the work. Stop at a clean point, save what you have, and reply "paused for quota".')
  return `Paused until ${new Date(at).toLocaleTimeString()}; keep-alive pings on.`
}

async function continueNow($: EngineInterface): Promise<string> {
  const why = await resume($, 'The person said to continue.')
  return why === 'Nothing is paused.' ? why : 'Continuing.'
}

async function setModelPercent($: EngineInterface, raw: string): Promise<string> {
  if (raw.trim() === 'off' || raw.trim() === '') {
    await update($, overrides, prev => ({ ...prev, weekModelPercent: null }))
    await refresh($)
    return 'Per-model weekly reading cleared.'
  }
  const pct = Number(raw.replace('%', ''))
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return 'Use a percent from 0 to 100, or off.'
  await update($, overrides, prev => ({ ...prev, weekModelPercent: pct }))
  // Read again now so the card shows the picked value at once.
  await refresh($)
  return `Per-model weekly set to ${pct}% by hand.`
}

async function simulateOff($: EngineInterface): Promise<string> {
  await update($, overrides, prev => ({ ...prev, simulate: null }))
  await update($, quota, prev => ({ ...prev, needsRefresh: true, said: [] }))
  return 'Simulation off: live values again.'
}

// Settings the person changes in the panel; kept in $.store so they outlast the session.
const STORE_KEY = 'settings'
type Saved = { thresholds: Partial<Thresholds>; stayWarm?: StayWarm }

async function saveSettings($: EngineInterface): Promise<void> {
  const ov = await read($, overrides)
  const saved: Saved = { thresholds: ov.thresholds, stayWarm: await read($, warmCfg) }
  try {
    await $.store.set(STORE_KEY, saved)
  } catch (err) {
    $.ui.log(`quota: settings not saved: ${(err as Error).message}`)
  }
}

async function loadSettings($: EngineInterface): Promise<void> {
  let raw: Partial<Saved> | undefined | null
  try {
    raw = (await $.store.get(STORE_KEY)) as Partial<Saved> | undefined | null
  } catch (err) {
    // A store that cannot be read leaves the defaults; the mod still starts.
    $.ui.log(`quota: saved settings not read: ${(err as Error).message}`)
    return
  }
  if (!raw || typeof raw !== 'object') return
  const thresholds: Partial<Thresholds> = {}
  for (const k of ['headsUp', 'subagentsStop', 'mainStop', 'weekStop'] as const) {
    const v = raw.thresholds?.[k]
    if (typeof v === 'number' && v >= 1 && v <= 100) thresholds[k] = v
  }
  await update($, overrides, prev => ({ ...prev, thresholds, pingMinutes: null }))
  const w = raw.stayWarm
  if (w && typeof w === 'object') {
    const cfg: StayWarm = {
      on: w.on === true,
      everyMin: typeof w.everyMin === 'number' && w.everyMin >= 1 && w.everyMin <= 55 ? w.everyMin : STAY_WARM_DEFAULT.everyMin,
      forHours: typeof w.forHours === 'number' && w.forHours > 0 && w.forHours <= 24 ? w.forHours : STAY_WARM_DEFAULT.forHours,
    }
    await update($, warmCfg, () => cfg)
  }
}

const THRESHOLD_NAMES: Record<keyof Thresholds, string> = {
  headsUp: 'Heads-up',
  subagentsStop: 'Subagents stop',
  mainStop: 'Main stop',
  weekStop: 'Weekly stop',
}

async function setThreshold($: EngineInterface, key: keyof Thresholds, raw: string): Promise<string> {
  const pct = Number(raw.replace('%', '').trim())
  if (raw.trim() === '' || !Number.isFinite(pct) || pct < 1 || pct > 100) return 'Use a percent from 1 to 100.'
  await update($, overrides, prev => ({ ...prev, thresholds: { ...prev.thresholds, [key]: pct } }))
  await update($, quota, prev => ({ ...prev, said: [] }))
  await saveSettings($)
  return `${THRESHOLD_NAMES[key]} set to ${pct}%.`
}

// The chips offered for each setting; the current value is added when it is none of them.
const CHOICES: Record<keyof Thresholds, number[]> = {
  headsUp: [75, 80, 85, 90, 95],
  subagentsStop: [90, 93, 95, 96, 97],
  mainStop: [95, 96, 97, 98, 99],
  weekStop: [95, 97, 98, 99, 100],
}
const withCurrent = (list: number[], current: number): number[] => (list.includes(current) ? list : [...list, current].sort((a, b) => a - b))

// Test scenarios: made-up readings that each cross one level.
const SCENARIOS: { key: string; label: string; five: number; week: number }[] = [
  { key: 'heads-up', label: 'Heads-up', five: 91, week: 40 },
  { key: 'subagents', label: 'Subagents stop', five: 96.5, week: 40 },
  { key: 'main', label: 'Main stop', five: 98.5, week: 40 },
  { key: 'week', label: 'Weekly stop', five: 40, week: 99.5 },
]

async function setStayWarm($: EngineInterface, change: Partial<StayWarm>): Promise<string> {
  const cfg = await update($, warmCfg, prev => ({ ...prev, ...change }))
  await saveSettings($)
  if (change.on === false) return 'Stay warm is off.'
  if (change.on === true) return `Stay warm is on: a ping every ${cfg.everyMin}m while idle, up to ${cfg.forHours}h after your last prompt.`
  if (change.everyMin !== undefined) return `Stay warm pings every ${cfg.everyMin}m.`
  return `Stay warm keeps going up to ${cfg.forHours}h after your last prompt.`
}

async function resetSettings($: EngineInterface): Promise<string> {
  await update($, warmCfg, () => STAY_WARM_DEFAULT)
  await update($, overrides, prev => ({ ...prev, thresholds: {}, pingMinutes: null }))
  await update($, quota, prev => ({ ...prev, said: [] }))
  await saveSettings($)
  return 'Settings back to the defaults.'
}

async function simulate($: EngineInterface, raw: string): Promise<string> {
  const [a = '', b = ''] = raw.trim().split(/[\s,]+/)
  const five = Number(a.replace('%', ''))
  const week = Number(b.replace('%', ''))
  if (!a || !b || !Number.isFinite(five) || !Number.isFinite(week)) return 'Type two percents: 5-hour then weekly, like 97 40.'
  await update($, overrides, prev => ({ ...prev, simulate: { fiveHour: five, week } }))
  await update($, quota, prev => ({ ...prev, needsRefresh: true, said: [] }))
  return `Simulating 5-hour ${five}%, weekly ${week}%. Thresholds fire from these.`
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
      description: 'Quota mod: opens the Quota panel, where every control and setting lives. Typed forms still work: pause until HH:MM, continue, threshold, simulate, model',
    })
    await loadSettings($)
    void $.ui.open({ id: PANE, title: 'Quota' })
    await tick($, opts)
    $.clock.every(TICK_MS, () => {
      void tick($, opts)
    })
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, warm, prev => ({ ...prev, lastWorkAt: now }))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, warm, prev => ({ ...prev, busy: true }))
    return next(e)
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

  // A turn ended: take a fresh reading at once, so the panel shows what that turn spent.
  // A subagent's end also records whether it paused for quota.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const agentId = (e as unknown as { agentId?: string }).agentId
    if (!agentId) {
      await update($, warm, prev => ({ ...prev, busy: false }))
      await refresh($)
      await judge($, opts)
      return r
    }
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

    // Bare /quota opens the panel; `/quota show` still prints the readings as text.
    if (verb === '') {
      await refresh($)
      await $.ui.open({ id: PANE, title: 'Quota' })
      return { text: 'Quota panel open: controls and Settings are in it.' }
    }
    if (verb === 'show') {
      await refresh($)
      return { text: (await rows($, opts)).join('\n') }
    }

    if (verb === 'pause') {
      if (a !== 'until') return { text: 'Use: /quota pause until HH:MM' }
      return { text: await pauseUntil($, b) }
    }

    if (verb === 'continue') return { text: await continueNow($) }

    if (verb === 'threshold') {
      const names: Record<string, keyof Thresholds> = { 'heads-up': 'headsUp', subagents: 'subagentsStop', main: 'mainStop', week: 'weekStop' }
      const key = names[a]
      if (!key) return { text: 'Use: /quota threshold <heads-up|subagents|main|week> <1-100>' }
      return { text: await setThreshold($, key, b) }
    }

    if (verb === 'simulate') {
      if (a === 'off') return { text: await simulateOff($) }
      const text = await simulate($, `${a} ${b}`)
      await tick($, opts)
      return { text }
    }

    if (verb === 'model') return { text: await setModelPercent($, a) }

    return { text: 'Quota commands: show · pause until HH:MM · continue · threshold · simulate · model' }
  })

  // The pane: one card per limit, then the cache and pause card, subagents, and a footer.
  // Desktop and phone draw rings and bars as SVG; the terminal draws block characters.
  // Every command works from the pane's own controls, with no /quota typed.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const isRich = e.surface !== 'terminal' && e.surface !== 'vscode'
    const Svg = isRich ? $.ui.resolve(e).Svg : null
    const cols = e.props.bodyColumns

    const now = await $.clock.now()
    const q = await read($, quota)
    const ov = await read($, overrides)
    const p = await read($, pause)
    const m = await read($, main)
    const map = await read($, agents)
    const note = await read($, said)
    const t = thresholdsOf(opts, ov)

    const act = (work: () => Promise<string>) => {
      void work().then(
        text => update($, said, () => text),
        err => update($, said, () => `Failed: ${(err as Error).message}`),
      )
    }

    const stat = (value: string, label: string, tone?: Tone) =>
      isRich ? (
        <Box key={label} gap={1} alignItems="center">
          <Text bold color={tone}>
            {value}
          </Text>
          <Text dimColor>{label}</Text>
        </Box>
      ) : (
        <Box key={label} gap={1}>
          <Text dimColor>{label}</Text>
          <Text bold color={tone}>
            {value}
          </Text>
        </Box>
      )

    const ring = (share: number, tone: Tone, alt: string) =>
      Svg ? <Svg source={ringSvg(share, tone)} alt={alt} width={18} height={18} /> : <Text color={tone}>{share > 0 ? '●' : '○'}</Text>

    // A usage bar: SVG with threshold marks on desktop, blocks sized to the pane in the terminal.
    const bar = (percent: number, tone: Tone, marks: number[], alt: string) => {
      if (Svg) return <Svg source={barSvg(percent, tone, marks)} alt={alt} />
      const b = blocks(percent / 100, Math.max(10, Math.min(40, cols - 16)))
      return (
        <Text>
          <Text color={tone}>{b.filled}</Text>
          <Text dimColor>{b.empty}</Text>
        </Text>
      )
    }

    // A row of one-click choices; the current one is drawn as the primary button.
    const chips = (prefix: string, values: number[], current: number | null, fmt: (v: number) => string, pick: (v: number) => Promise<string>) => (
      <Box gap={1} flexWrap="wrap" alignItems="center">
        {values.map(v => (
          <Button key={`${prefix}-${v}`} label={fmt(v)} variant={v === current ? 'primary' : 'secondary'} onPress={() => act(() => pick(v))} />
        ))}
      </Box>
    )

    const modelPicker = (value: string) => (
      <Select
        key="model-week"
        label="Usage card says"
        value={value}
        // A Select holds at most 64 options: every 2%, plus the current value when it is odd.
        options={[
          { value: 'off', label: 'not set' },
          ...withCurrent(
            Array.from({ length: 51 }, (_, i) => i * 2),
            value === 'off' ? 0 : Number(value),
          ).map(i => ({ value: String(i), label: `${i}%` })),
        ]}
        onSelect={v => act(() => setModelPercent($, v))}
      />
    )

    const card = (key: string, tone: Tone | null, children: RenderChildren) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderDimColor={tone === null || tone === 'success'} borderColor={tone && tone !== 'success' ? tone : undefined} paddingX={1} marginBottom={1}>
        {children}
      </Box>
    )

    // One limit: name and percent, the bar, then reset, pace and outlook.
    const windowCard = (key: 'fiveHour' | 'weekAll', win: QuotaWindow, stopAt: number) => {
      const tone = toneOf(win.percent, t.headsUp, stopAt)
      const pace = paceOf(q.samples, key, now)
      const o = outlookOf(win, pace, now)
      const marks = key === 'fiveHour' ? [t.headsUp, t.subagentsStop, t.mainStop] : [t.headsUp, t.weekStop]
      const outlook =
        o.hoursToFull === null ? 'pace needs more readings' : o.lastsToReset ? 'lasts to the reset' : `runs out in ${fmtDur(o.hoursToFull * HOUR)}`
      return card(
        key,
        tone,
        <>
          <Box justifyContent="space-between" alignItems="center" gap={2}>
            <Box gap={1} alignItems="center" flexShrink={1}>
              {ring(win.percent / 100, tone, `${win.label}: ${pct(win.percent)} used`)}
              <Text bold>{win.label}</Text>
            </Box>
            <Box gap={1} alignItems="center" flexShrink={0}>
              <Text bold color={tone}>
                {pct(win.percent)}
              </Text>
              <Text dimColor>used</Text>
            </Box>
          </Box>
          <Box marginY={isRich ? 1 : 0}>{bar(win.percent, tone, marks, `${pct(win.percent)} of ${win.label}`)}</Box>
          <Box gap={isRich ? 3 : 2} flexWrap="wrap">
            {stat(win.resetsAt ? fmtDur(win.resetsAt - now) : '?', 'to reset')}
            {stat(pace === null ? '…' : `${pace.toFixed(key === 'fiveHour' ? 1 : 2)}%/h`, 'pace')}
            <Text dimColor color={o.lastsToReset === false ? 'warning' : undefined}>
              {outlook}
            </Text>
          </Box>
        </>,
      )
    }

    const l = q.limits
    const parts: RenderChildren[] = []

    if (ov.simulate)
      parts.push(
        <Box key="sim" gap={1} alignItems="center" marginBottom={1}>
          <Text bold color="warning">
            Simulated
          </Text>
          <Text dimColor>test values, thresholds fire from them</Text>
          <Button key="sim-off" label="End" onPress={() => act(() => simulateOff($))} />
        </Box>,
      )
    if (q.unavailable)
      parts.push(
        <Text key="unavailable" color="error">
          {q.unavailable}
        </Text>,
      )

    if (!l) parts.push(<Text key="reading" dimColor>Reading the limits…</Text>)
    else {
      if (l.fiveHour) parts.push(windowCard('fiveHour', l.fiveHour, t.mainStop))
      if (l.weekAll) parts.push(windowCard('weekAll', l.weekAll, t.weekStop))

      // The main model's weekly window: the mod cannot read it, so it is typed in.
      const wm = l.weekModel
      const modelName = m.model || 'main model'
      if (wm) {
        const tone = toneOf(wm.percent, t.headsUp, t.weekStop)
        parts.push(
          card(
            'weekModel',
            tone,
            <>
              <Box justifyContent="space-between" alignItems="center" gap={2}>
                <Box gap={1} alignItems="center" flexShrink={1}>
                  {ring(wm.percent / 100, tone, `${wm.label}: ${pct(wm.percent)} used`)}
                  <Text bold>Weekly · {modelName}</Text>
                </Box>
                <Box gap={1} alignItems="center" flexShrink={0}>
                  <Text bold color={tone}>
                    {pct(wm.percent)}
                  </Text>
                  <Text dimColor>set by hand</Text>
                </Box>
              </Box>
              <Box marginY={isRich ? 1 : 0}>{bar(wm.percent, tone, [t.headsUp, t.weekStop], `${pct(wm.percent)} of ${wm.label}`)}</Box>
              {modelPicker(String(wm.percent))}
            </>,
          ),
        )
      } else {
        parts.push(
          card(
            'weekModel',
            null,
            <>
              <Box gap={1} alignItems="center">
                {ring(0, 'success', `Weekly ${modelName}: not set`)}
                <Text bold>Weekly · {modelName}</Text>
              </Box>
              <Text dimColor>A mod cannot read this one. Pick the number the usage card shows.</Text>
              {modelPicker('off')}
            </>,
          ),
        )
      }
    }

    // Cache and pause: how long the main cache has, and what the keep-alive is doing.
    const ttl = l && windowsOf(l).some(w => w.win.percent >= 100) ? 5 * MINUTE : HOUR
    const cacheLeft = m.lastCacheAt ? m.lastCacheAt + ttl - now : null
    const share = cacheLeft === null ? 0 : Math.max(0, cacheLeft / ttl)
    const cTone: Tone = cacheLeft === null ? 'success' : cacheTone(share)
    const farOff = p.kind === 'quota' && !keepAliveWorth(p.until, now)
    const spent = spentNow(q)
    const wcfg = await read($, warmCfg)
    const wp = await warmPlanNow($, opts)
    const clockAt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const warmWords: Record<WarmPlan['state'], string> = {
      off: 'off',
      paused: 'resting: the reset bridge has it',
      high: 'resting: usage passed the heads-up level',
      'no-cache': 'on: starts after your next reply',
      busy: 'on: a turn is running',
      done: `done: ${wcfg.forHours}h since your last prompt`,
      waiting: 'on',
    }
    const warmLine = (
      <>
        <Text bold color={wcfg.on ? 'success' : undefined}>Stay warm</Text>
        <Text dimColor={wp.state !== 'waiting'}>{warmWords[wp.state]}</Text>
        {wp.state === 'waiting' && wp.next !== null ? stat(fmtDur(Math.max(0, wp.next - now)), 'to next ping', 'success') : null}
        {wp.state === 'waiting' && wp.until !== null ? stat(clockAt(wp.until), 'until') : null}
      </>
    )
    const plan = p.kind === 'none' || farOff || spent ? null : pingPlan(cacheWrittenAt(m.lastCacheAt, p.startedAt), p.until)
    const pauseText =
      p.kind === 'none'
        ? 'Not paused'
        : p.kind === 'quota'
          ? `Paused for ${p.window}${p.until ? `, ${fmtDur(p.until - now)} to go` : ''}`
          : `Paused until ${p.until ? new Date(p.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?'}`

    parts.push(
      card(
        'cache',
        p.kind === 'none' ? (cacheLeft === null ? null : cTone) : 'warning',
        <>
          <Box justifyContent="space-between" alignItems="center" gap={2}>
            <Box gap={1} alignItems="center" flexShrink={1}>
              {ring(share, cTone, cacheLeft === null ? 'Prompt cache: no reply yet' : `Prompt cache: ${fmtDur(Math.max(0, cacheLeft))} left`)}
              <Text bold>Prompt cache</Text>
            </Box>
            <Box gap={1} alignItems="center" flexShrink={0}>
              {cacheLeft === null ? (
                <Text dimColor>no reply yet</Text>
              ) : cacheLeft > 0 ? (
                <>
                  <Text bold color={cTone}>
                    {fmtDur(cacheLeft)} left
                  </Text>
                  <Text dimColor>of {ttl === HOUR ? '60m' : '5m'}</Text>
                </>
              ) : (
                <Text bold color="error">
                  Expired
                </Text>
              )}
            </Box>
          </Box>
          <Box gap={isRich ? 3 : 2} flexWrap="wrap" marginTop={isRich ? 1 : 0}>
            <Text bold color={p.kind === 'none' ? undefined : 'warning'}>
              {pauseText}
            </Text>
            {p.kind !== 'none' ? <Text bold color="warning">Reset bridge</Text> : null}
            {p.kind === 'none' ? (
              warmLine
            ) : spent ? (
              <Text dimColor>no pings: the limit is at 100%, requests are refused</Text>
            ) : farOff ? (
              <Text dimColor>no pings: the reset is too far off</Text>
            ) : plan === null ? (
              <Text dimColor>no ping needed: the cache outlasts the wait</Text>
            ) : (
              <>
                {stat(fmtDur(Math.max(0, plan.next - now)), 'to next ping', 'warning')}
                {plan.left !== null ? stat(String(plan.left), plan.left === 1 ? 'ping before reset' : 'pings before reset') : null}
                {stat(`${Math.round(plan.gap / MINUTE)}m`, 'apart')}
              </>
            )}
          </Box>
          {p.kind !== 'none' ? (
            <Box marginTop={isRich ? 1 : 0}>
              <Button key="continue" variant="primary" label="Continue now" onPress={() => act(() => continueNow($))} />
            </Box>
          ) : null}
          <Box gap={1} alignItems="center" marginTop={isRich ? 1 : 0} flexWrap="wrap">
            <Text dimColor>{p.kind === 'none' ? 'Pause for' : 'Move to'}</Text>
            {[30, 60, 120, 180].map(min => (
              <Button key={`pause-${min}`} label={min < 60 ? `${min}m` : `${min / 60}h`} onPress={() => act(() => pauseAt($, now + min * MINUTE))} />
            ))}
            {l?.fiveHour?.resetsAt && l.fiveHour.resetsAt > now ? (
              <Button key="pause-reset" label="Until 5-hour reset" onPress={() => act(() => pauseAt($, l.fiveHour!.resetsAt!))} />
            ) : null}
          </Box>
          {/* Stay warm lives on the page: switched and tuned here, no trip to Settings. */}
          <Box flexDirection="column" marginTop={isRich ? 1 : 0}>
            <Box gap={1} alignItems="center" flexWrap="wrap">
              <Text dimColor>Stay warm</Text>
              <Button key="warm-off" label="Off" variant={wcfg.on ? 'secondary' : 'primary'} onPress={() => act(() => setStayWarm($, { on: false }))} />
              <Button key="warm-on" label="On" variant={wcfg.on ? 'primary' : 'secondary'} onPress={() => act(() => setStayWarm($, { on: true }))} />
            </Box>
            {wcfg.on ? (
              <>
                <Box gap={1} flexWrap="wrap" alignItems="center">
                  <Text dimColor>Ping every</Text>
                  {STAY_WARM_EVERY.map(v => (
                    <Button key={`warm-every-${v}`} label={`${v}m`} variant={v === wcfg.everyMin ? 'primary' : 'secondary'} onPress={() => act(() => setStayWarm($, { everyMin: v }))} />
                  ))}
                </Box>
                <Box gap={1} flexWrap="wrap" alignItems="center">
                  <Text dimColor>Away up to</Text>
                  {STAY_WARM_FOR.map(v => (
                    <Button key={`warm-for-${v}`} label={`${v}h`} variant={v === wcfg.forHours ? 'primary' : 'secondary'} onPress={() => act(() => setStayWarm($, { forHours: v }))} />
                  ))}
                </Box>
              </>
            ) : null}
            <Text dimColor>Keeps the cache warm while you're away and usage is low. Rests at the heads-up level; each ping spends a little quota.</Text>
          </Box>
        </>,
      ),
    )

    // Subagents, one row each, only when there are any.
    const agentList = (await $.agent.list()).slice(0, MAX_ROWS)
    if (agentList.length > 0)
      parts.push(
        card(
          'agents',
          null,
          <>
            <Text bold>Subagents</Text>
            {agentList.map(a => {
              const s = map[a.id]
              const paused = s?.status === 'paused'
              const window = s && m.model ? (spendsWindow(s.model, m.model) === 'model' ? 'model window' : 'all-models') : ''
              return (
                <Box key={a.id} gap={2} flexWrap="wrap">
                  <Text color={paused ? 'warning' : undefined}>
                    {paused ? '❚❚' : a.status === 'running' ? '●' : '○'} {a.description || a.type}
                  </Text>
                  <Text dimColor>
                    {[s?.model ?? '', paused ? 'paused for quota' : a.status, `${s?.tokens ?? 0} tok`, s?.lastCacheAt ? `cache ${fmtDur(now - s.lastCacheAt)} old` : '', window].filter(Boolean).join(' · ')}
                  </Text>
                </Box>
              )
            })}
          </>,
        ),
      )

    // Settings: every option and test mode as one-click choices; nothing to type.
    const isOpen = await read($, settingsOpen)
    if (isOpen) {
      const row = (key: keyof Thresholds, hint: string) => (
        <Box key={`row-${key}`} flexDirection="column" marginTop={isRich ? 1 : 0}>
          <Box gap={1} alignItems="center">
            <Text bold>{THRESHOLD_NAMES[key]}</Text>
            <Text bold color={key === 'headsUp' ? 'warning' : 'error'}>
              {t[key]}%
            </Text>
            <Text dimColor>{hint}</Text>
          </Box>
          {chips(`t-${key}`, withCurrent(CHOICES[key], t[key]), t[key], v => `${v}%`, v => setThreshold($, key, String(v)))}
        </Box>
      )
      parts.push(
        card(
          'settings',
          null,
          <>
            <Box justifyContent="space-between" alignItems="center">
              <Text bold>Settings</Text>
              <Button key="settings-close" role="dismiss" label="Close" onPress={() => void update($, settingsOpen, () => false)} />
            </Box>
            {Svg ? (
              <Box flexDirection="column" marginTop={1}>
                <Svg source={scaleSvg(t)} alt={`Levels: heads-up ${t.headsUp}%, subagents stop ${t.subagentsStop}%, main stop ${t.mainStop}%, weekly stop ${t.weekStop}%`} />
                <Text dimColor>Where each level sits on its limit. Saved for every session.</Text>
              </Box>
            ) : (
              <Text dimColor>Saved for every session.</Text>
            )}
            {row('headsUp', 'a toast for any limit')}
            {row('subagentsStop', 'subagents pause, 5-hour')}
            {row('mainStop', 'main session pauses, 5-hour')}
            {row('weekStop', 'everything stops, weekly')}
            <Box flexDirection="column" marginTop={1}>
              <Box gap={1} alignItems="center">
                <Text bold>Reset bridge</Text>
                <Text bold color="success">automatic</Text>
              </Box>
              <Text dimColor>
                When a limit pauses the work, pings are spread evenly up to the reset, at most 50 minutes apart, so the 60-minute cache is warm when work resumes. Stops at 100% of a limit, and for waits over 12 hours.
              </Text>
            </Box>
            <Box flexDirection="column" marginTop={1}>
              <Box gap={1} alignItems="center">
                <Text bold>Test mode</Text>
                {ov.simulate ? (
                  <Text bold color="warning">
                    on: 5-hour {ov.simulate.fiveHour}%, weekly {ov.simulate.week}%
                  </Text>
                ) : (
                  <Text dimColor>made-up readings to watch a level fire</Text>
                )}
              </Box>
              <Box gap={1} flexWrap="wrap" alignItems="center">
                {SCENARIOS.map(sc => (
                  <Button
                    key={`sim-${sc.key}`}
                    label={sc.label}
                    variant={ov.simulate && ov.simulate.fiveHour === sc.five && ov.simulate.week === sc.week ? 'primary' : 'secondary'}
                    onPress={() => act(async () => { const text = await simulate($, `${sc.five} ${sc.week}`); await tick($, opts); return text })}
                  />
                ))}
                {ov.simulate ? <Button key="sim-end" label="End test" onPress={() => act(() => simulateOff($))} /> : null}
              </Box>
            </Box>
            <Box marginTop={1}>
              <Button key="settings-reset" label="Reset to defaults" onPress={() => act(() => resetSettings($))} />
            </Box>
          </>,
        ),
      )
    }

    // Footer: refresh, context, the thresholds, the one thing a mod cannot see.
    parts.push(
      <Box key="footer" flexDirection="column">
        <Box gap={isRich ? 3 : 2} alignItems="center" flexWrap="wrap">
          <Button key="refresh" label="Refresh" onPress={() => act(async () => { await refresh($); await judge($, opts); return 'Refreshed.' })} />
          <Button key="settings" label={isOpen ? 'Hide settings' : 'Settings'} onPress={() => void update($, settingsOpen, v => !v)} />
          {l && l.contextPercent !== null ? stat(`${l.contextPercent}%`, 'context') : null}
          {stat(q.refreshedAt ? `${fmtDur(now - q.refreshedAt)} ago` : 'never', 'read')}
        </Box>
        <Text dimColor>
          Alerts at {t.headsUp}% · subagents stop {t.subagentsStop}% · main stops {t.mainStop}% · weekly stop {t.weekStop}%
        </Text>
        <Text dimColor>Extra usage drops the cache to 5 minutes; a mod cannot see it.</Text>
        {note ? <Text color={note.startsWith('Failed') || note.startsWith('Use') ? 'error' : 'success'}>{note}</Text> : null}
      </Box>,
    )

    return <Box flexDirection="column">{parts}</Box>
  })
}
