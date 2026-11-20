import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentState, CacheStats, KeepState, MainState, Overrides, PauseState, QuotaLimits, QuotaState, QuotaWindow, WarmFacts } from '../types'
import {
  DEFAULT_THRESHOLDS,
  EMPTY_STATS,
  addUsage,
  cachedNow,
  fmtTok,
  hitRate,
  HOUR,
  MINUTE,
  alertsFor,
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
  windowsOf,
} from './logic'
import type { Alert, Sample, Thresholds } from './logic'
import { barSvg, blocks, cacheTone, heroRingSvg, hitTone, pct, ringSvg, scaleSvg, toneOf } from './view'
import type { Tone } from './view'

const PANE = 'quota'
const SHAPE = 'quota-1'
const SAMPLE_SPAN = 6 * HOUR
const MAX_SAMPLES = 400
const MAX_ROWS = 12

// What a keep-alive ping says. One word: the model answers in a word, so a ping costs a cache
// read of the prefix and a few output tokens, and the transcript row stays small.
export const PING_MAIN = 'ping'
export const PING_AGENT = 'ping'

const quota = atom({ plugin: 'quota-keepalive', key: 'quota' } as const, { limits: null, samples: [], said: [], refreshedAt: 0, needsRefresh: true, unavailable: '' } as QuotaState, { shape: SHAPE })
const overrides = atom({ plugin: 'quota-keepalive', key: 'overrides' } as const, { thresholds: {}, simulate: null, weekModelPercent: null, pingMinutes: null } as Overrides, { shape: SHAPE })
const NO_PAUSE: PauseState = { kind: 'none', until: null, window: '', startedAt: 0, lastPingAt: 0, reason: '' }
const pause = atom({ plugin: 'quota-keepalive', key: 'pause' } as const, NO_PAUSE, { shape: SHAPE })
const main = atom({ plugin: 'quota-keepalive', key: 'main' } as const, { model: '', lastTurnAt: 0, lastCacheAt: 0 } as MainState, { shape: SHAPE })
const said = atom({ plugin: 'quota-keepalive', key: 'said' } as const, '' as string, { shape: SHAPE })
const settingsOpen = atom({ plugin: 'quota-keepalive', key: 'settingsOpen' } as const, false as boolean, { shape: SHAPE })
const NO_KEEP: KeepState = { choice: 'off', until: null, startedAt: 0, lastPingAt: 0 }
const keep = atom({ plugin: 'quota-keepalive', key: 'keep' } as const, NO_KEEP, { shape: SHAPE })
const warm = atom({ plugin: 'quota-keepalive', key: 'warm' } as const, { lastWorkAt: 0, lastPingAt: 0, busy: false } as WarmFacts, { shape: SHAPE })
const agents = atom({ plugin: 'quota-keepalive', key: 'agents' } as const, {} as Record<string, AgentState>, { shape: SHAPE })
const stats = atom({ plugin: 'quota-keepalive', key: 'stats' } as const, EMPTY_STATS as CacheStats, { shape: SHAPE })

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
  // A timed keep warm ends with the pause; Always stays on until the person turns it off.
  const now = await $.clock.now()
  await update($, keep, k => (k.choice === 'always' ? { ...k, startedAt: now, lastPingAt: 0 } : NO_KEEP))
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

// The one keep-warm target: a running pause's end, else the end the person picked
// (a time, or the 5-hour reset as last read). Null when nothing asks for the cache to stay warm.
type Target = { until: number | null; startedAt: number; lastPingAt: number; source: 'pause' | 'keep' }

async function warmTarget($: EngineInterface): Promise<Target | null> {
  const p = await read($, pause)
  if (p.kind !== 'none') return { until: p.until, startedAt: p.startedAt, lastPingAt: p.lastPingAt, source: 'pause' }
  const k = await read($, keep)
  if (k.choice === 'off') return null
  // Always: no end, a ping every 50 minutes of idle until the person turns it off.
  if (k.choice === 'always') return { until: null, startedAt: k.startedAt, lastPingAt: k.lastPingAt, source: 'keep' }
  // Until reset: the reset as it was when picked (a value stored before that was kept reads it live).
  const q = await read($, quota)
  const until = k.choice === 'reset' ? (k.until ?? q.limits?.fiveHour?.resetsAt ?? null) : k.until
  return { until, startedAt: k.startedAt, lastPingAt: k.lastPingAt, source: 'keep' }
}

// Keep warm: one rule for every case. From each cache's last write to the target, pings at the
// fewest equal gaps of at most 50 minutes, so the 60-minute cache is still warm at the end.
// The person's own replies write the cache too, so it only pings while the session idles.
// It stands down while a turn runs, at 100% of a limit (every request is refused), and for a
// quota pause days long (a weekly window), where pings would cost more than they save.
async function keepWarm($: EngineInterface): Promise<void> {
  const tgt = await warmTarget($)
  if (!tgt) return
  const now = await $.clock.now()
  if (tgt.source === 'keep' && tgt.until !== null && now >= tgt.until) {
    await update($, keep, () => NO_KEEP)
    return
  }
  const p = await read($, pause)
  if (p.kind === 'quota' && !keepAliveWorth(p.until, now)) return
  if (spentNow(await read($, quota))) return
  if ((await read($, warm)).busy) return
  const m = await read($, main)
  const writtenAt = cacheWrittenAt(m.lastCacheAt, tgt.startedAt)
  // A ping went out, nothing wrote the cache since, and the cache is past its hour: it is gone,
  // so stop retrying until something writes it again (a message of the person's).
  const dead = tgt.lastPingAt > writtenAt && now - writtenAt >= HOUR

  if (!dead && planDue(pingPlan(writtenAt, tgt.until), tgt.lastPingAt, now)) {
    if (tgt.source === 'pause') await update($, pause, prev => ({ ...prev, lastPingAt: now }))
    else await update($, keep, prev => ({ ...prev, lastPingAt: now }))
    await update($, stats, s => ({ ...EMPTY_STATS, ...s, pings: (s?.pings ?? 0) + 1 }))
    $.prompt.submit({ text: PING_MAIN }).catch(err => $.ui.log(`quota: keep-warm ping failed: ${(err as Error).message}`))
  }

  if (tgt.source !== 'pause') return
  const map = await read($, agents)
  for (const [id, a] of Object.entries(map)) {
    if (a.status !== 'paused') continue
    if (!planDue(pingPlan(cacheWrittenAt(a.lastCacheAt, tgt.startedAt), tgt.until), a.lastPingAt ?? 0, now)) continue
    await update($, agents, all => (all[id] ? { ...all, [id]: { ...all[id], lastPingAt: now } } : all))
    await update($, stats, s => ({ ...EMPTY_STATS, ...s, pings: (s?.pings ?? 0) + 1 }))
    try {
      await $.session.send({ to: { agentId: id }, text: PING_AGENT })
    } catch (err) {
      $.ui.log(`quota: keep-warm ping to subagent ${id} failed: ${(err as Error).message}`)
    }
  }
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
    await keepWarm($)
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

  const tgt = await warmTarget($)
  const k = await read($, keep)
  if (m.lastCacheAt) {
    const age = now - m.lastCacheAt
    const due = !tgt
      ? 'keep warm off'
      : p.kind === 'quota' && !keepAliveWorth(p.until, now)
        ? 'no pings: the pause ends too far off to keep the cache warm'
        : (() => {
            const plan = pingPlan(cacheWrittenAt(m.lastCacheAt, tgt.startedAt), tgt.until)
            return plan ? `next ping in ${fmtDur(Math.max(0, plan.next - now))}` : 'no ping needed before the end'
          })()
    out.push(`Main cache: ${fmtDur(age)} old; ${due}`)
  }
  const st: CacheStats = { ...EMPTY_STATS, ...(await read($, stats)) }
  const hr = hitRate(st.read, st.written, st.uncached)
  out.push(
    hr === null
      ? 'Cache usage: no model calls yet'
      : `Cache usage: ${fmtTok(cachedNow(st))} in cache · hit ${pct(hr * 100)} · miss ${pct((1 - hr) * 100)} · read ${fmtTok(st.read)} · written ${fmtTok(st.written)} · uncached ${fmtTok(st.uncached)} · ${st.calls} calls · ${st.rebuilds} rebuilds · ${st.pings} pings`,
  )
  out.push('Overage: a mod cannot see it. If the session enters extra usage, the cache drops to 5 minutes.')

  if (p.kind === 'quota') out.push(`Paused for quota (${p.window}) until ${p.until ? fmtDur(p.until - now) : 'the reset'} from now; keep-alive on`)
  else if (p.kind === 'time') out.push(`Paused until ${p.until ? new Date(p.until).toLocaleTimeString() : '?'}; keep-alive on`)
  else if (k.choice === 'always') out.push('Keep warm: always on, until you turn it off')
  else if (tgt) out.push(`Keep warm: until ${tgt.until ? new Date(tgt.until).toLocaleTimeString() : 'the reset'}`)
  else out.push('Keep warm: off')

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
type Saved = { thresholds: Partial<Thresholds>; defaultKeep?: 'off' | 'always' }

async function saveSettings($: EngineInterface): Promise<void> {
  const ov = await read($, overrides)
  const saved: Saved = { thresholds: ov.thresholds, defaultKeep: ov.defaultKeep ?? 'off' }
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
  const defaultKeep: 'off' | 'always' = raw.defaultKeep === 'always' ? 'always' : 'off'
  await update($, overrides, prev => ({ ...prev, thresholds, pingMinutes: null, defaultKeep }))
}

// Once per session (not on a reload): a new chat starts with the keep warm the person chose for every chat.
async function applyDefaultKeep($: EngineInterface): Promise<void> {
  const w = await read($, warm)
  if (w.defaultApplied) return
  await update($, warm, prev => ({ ...prev, defaultApplied: true }))
  const ov = await read($, overrides)
  if (ov.defaultKeep !== 'always') return
  const k = await read($, keep)
  const p = await read($, pause)
  if (k.choice === 'off' && p.kind === 'none') await setKeep($, 'always')
}

async function setDefaultKeep($: EngineInterface, value: 'off' | 'always'): Promise<string> {
  await update($, overrides, prev => ({ ...prev, defaultKeep: value }))
  await saveSettings($)
  if (value === 'off') return 'New chats start with keep warm off.'
  const k = await read($, keep)
  const p = await read($, pause)
  if (k.choice === 'off' && p.kind === 'none') await setKeep($, 'always')
  return 'Every chat now keeps its cache warm until you turn it off, this one included.'
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

const KEEP_HOURS = [1, 2, 4] as const

async function setKeep($: EngineInterface, choice: KeepState['choice']): Promise<string> {
  const now = await $.clock.now()
  const p = await read($, pause)
  if (choice === 'off') {
    await update($, keep, () => NO_KEEP)
    return p.kind === 'none' ? 'Not keeping the cache warm.' : continueNow($)
  }
  if (choice === 'always') {
    await update($, keep, () => ({ choice, until: null, startedAt: now, lastPingAt: 0 }))
    return 'Keeping the cache warm until you turn it off.'
  }
  const q = await read($, quota)
  const reset = q.limits?.fiveHour?.resetsAt ?? null
  if (choice === 'reset' && (reset === null || reset <= now)) return 'The 5-hour reset time is not known yet.'
  const until = choice === 'reset' ? reset! : now + Number(choice) * HOUR
  await update($, keep, () => ({ choice, until, startedAt: now, lastPingAt: 0 }))
  // A pause the person set follows the new end; a limit's pause keeps waiting on its reset.
  if (p.kind === 'time') await update($, pause, prev => ({ ...prev, until }))
  return `Keeping the cache warm until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
}

async function pauseWork($: EngineInterface): Promise<string> {
  const tgt = await warmTarget($)
  if (!tgt || tgt.until === null) return 'Pick how long to keep warm first.'
  return pauseAt($, tgt.until)
}

async function resetSettings($: EngineInterface): Promise<string> {
  await update($, overrides, prev => ({ ...prev, thresholds: {}, pingMinutes: null, defaultKeep: 'off' as const }))
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
      description: 'Quota mod: opens the Quota panel, where every control and setting lives. Typed forms still work: keep <off|1|2|4|reset|always>, pause until HH:MM, continue, threshold, simulate, model',
    })
    await loadSettings($)
    await applyDefaultKeep($)
    void $.ui.open({ id: PANE, title: 'Quota' })
    await tick($, opts)
    $.clock.every(TICK_MS, () => {
      void tick($, opts)
    })
    return started
  })

  on('turn.start', async ($, e, next) => {
    // A main turn our ping started is tagged, so its tokens count as the ping's.
    if (e.agentId === undefined) await update($, warm, prev => ({ ...prev, busy: true, pingTurn: e.text.trim() === PING_MAIN ? e.turnId : '' }))
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
    const isPing = !e.agentId && (await read($, warm)).pingTurn === e.turnId
    await update($, stats, prev => addUsage(prev, usage, now, { agent: Boolean(e.agentId), ping: isPing }))
    if (!e.agentId) {
      const recache =
        (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0)
      await update($, main, m => ({ ...m, model, lastTurnAt: now, lastCacheAt: cached ? now : m.lastCacheAt, recache }))
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

    if (verb === 'keep') {
      const choices: Record<string, KeepState['choice']> = { off: 'off', '1': '1', '1h': '1', '2': '2', '2h': '2', '4': '4', '4h': '4', reset: 'reset', always: 'always', on: 'always' }
      const choice = choices[a]
      if (!choice) return { text: 'Use: /quota keep <off|1h|2h|4h|reset|always>' }
      return { text: await setKeep($, choice) }
    }

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

    return { text: 'Quota commands: show · keep <off|1h|2h|4h|reset|always> · pause until HH:MM · continue · threshold · simulate · model' }
  })

  // The side panel. Two pages, picked by the tabs at the top: Overview (the cache and keep
  // warm, cache usage, plan limits, subagents) and Settings. Desktop and phone draw rings and
  // bars as SVG; the terminal draws block characters. A minimized desktop pane (the widget)
  // gets a glance with no controls. Every control is a click; nothing needs typing.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const isRich = e.surface !== 'terminal' && e.surface !== 'vscode'
    const Svg = isRich ? $.ui.resolve(e).Svg : null
    const cols = e.props.bodyColumns
    const gapY = isRich ? 1 : 0

    const now = await $.clock.now()
    const q = await read($, quota)
    const ov = await read($, overrides)
    const p = await read($, pause)
    const m = await read($, main)
    const map = await read($, agents)
    const note = await read($, said)
    const k = await read($, keep)
    const st: CacheStats = { ...EMPTY_STATS, ...(await read($, stats)) }
    const busy = (await read($, warm)).busy
    const tgt = await warmTarget($)
    const onSettings = await read($, settingsOpen)
    const t = thresholdsOf(opts, ov)
    const l = q.limits

    const act = (work: () => Promise<string>) => {
      void work().then(
        text => update($, said, () => text),
        err => update($, said, () => `Failed: ${(err as Error).message}`),
      )
    }
    const clockAt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    // A figure and its label: bold value, dim label.
    const stat = (value: string, label: string, tone?: Tone) =>
      isRich ? (
        <Box key={label} gap={1} alignItems="center">
          <Text bold tabular color={tone}>
            {value}
          </Text>
          <Text dimColor size="footnote">
            {label}
          </Text>
        </Box>
      ) : (
        <Box key={label} gap={1}>
          <Text dimColor>{label}</Text>
          <Text bold color={tone}>
            {value}
          </Text>
        </Box>
      )

    // A big figure over its label, for the cache usage row.
    const figure = (value: string, label: string, tone?: Tone) =>
      isRich ? (
        <Box key={label} flexDirection="column" minWidth={72}>
          <Text bold tabular size="heading" color={tone}>
            {value}
          </Text>
          <Text dimColor size="caption">
            {label}
          </Text>
        </Box>
      ) : (
        stat(value, label, tone)
      )

    const ring = (share: number, tone: Tone, alt: string) =>
      Svg ? <Svg source={ringSvg(share, tone)} alt={alt} width={18} height={18} /> : <Text color={tone}>{share > 0 ? '●' : '○'}</Text>

    // A bar: SVG (with threshold marks) on desktop, blocks sized to the pane in the terminal.
    const bar = (percent: number, tone: Tone, marks: number[], alt: string) => {
      if (Svg) return <Svg source={barSvg(percent, tone, marks)} alt={alt} />
      const b = blocks(percent / 100, Math.max(10, Math.min(40, cols - 8)))
      return (
        <Text>
          <Text color={tone}>{b.filled}</Text>
          <Text dimColor>{b.empty}</Text>
        </Text>
      )
    }

    const card = (key: string, tone: Tone | null, children: RenderChildren) => (
      <Box
        key={key}
        flexDirection="column"
        borderStyle="round"
        borderDimColor={tone === null || tone === 'success'}
        borderColor={tone && tone !== 'success' ? tone : undefined}
        paddingX={1}
        paddingY={isRich ? 1 : 0}
        marginBottom={1}
        gap={gapY}
      >
        {children}
      </Box>
    )

    const heading = (title: string, right?: RenderChildren) => (
      <Box key={`h-${title}`} justifyContent="space-between" alignItems="center" gap={2}>
        <Text bold size={isRich ? 'body' : undefined} weight={isRich ? 'semibold' : undefined}>
          {title}
        </Text>
        {right ?? null}
      </Box>
    )

    // The cache: its lifetime (5 minutes once a limit is spent and extra usage may be in play).
    const ttl = l && windowsOf(l).some(w => w.win.percent >= 100) ? 5 * MINUTE : HOUR
    const cacheLeft = m.lastCacheAt ? m.lastCacheAt + ttl - now : null
    const share = cacheLeft === null ? 0 : Math.max(0, cacheLeft / ttl)
    const cTone: Tone = cacheLeft === null ? 'success' : cacheTone(share)
    const farOff = p.kind === 'quota' && !keepAliveWorth(p.until, now)
    const spent = spentNow(q)
    const plan = !tgt || farOff || spent ? null : pingPlan(cacheWrittenAt(m.lastCacheAt, tgt.startedAt), tgt.until)
    const chosen: KeepState['choice'] = p.kind === 'quota' ? 'reset' : k.choice
    const hit = hitRate(st.read, st.written, st.uncached)
    const inCache = cachedNow(st)
    const leftShort = cacheLeft === null ? '—' : cacheLeft > 0 ? (cacheLeft >= HOUR ? '60m' : `${Math.max(1, Math.ceil(cacheLeft / MINUTE))}m`) : 'cold'

    const statusText =
      p.kind === 'quota'
        ? `Work paused by the ${p.window}${p.until ? ` until ${clockAt(p.until)}` : ''}`
        : p.kind === 'time'
          ? `Work paused until ${p.until ? clockAt(p.until) : '?'}`
          : !tgt
            ? 'Not keeping warm'
            : k.choice === 'always'
              ? 'Keeping warm · always on'
              : `Keeping warm until ${tgt.until ? clockAt(tgt.until) : 'the reset'}`
    const statusTone: Tone | undefined = p.kind !== 'none' ? 'warning' : tgt ? 'success' : undefined

    // The minimized desktop pane: a glance, no controls (clicks may not reach it).
    if (e.props.placement === 'widget') {
      const five = l?.fiveHour
      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          <Box gap={1} alignItems="center">
            {ring(share, cTone, cacheLeft === null ? 'Prompt cache: no reply yet' : `Prompt cache: ${leftShort} left`)}
            <Text bold color={cTone}>
              {cacheLeft === null ? 'No reply yet' : cacheLeft > 0 ? `${leftShort} left` : 'Cache cold'}
            </Text>
          </Box>
          <Text dimColor size="footnote">
            {[tgt ? (k.choice === 'always' && p.kind === 'none' ? 'Warm ∞' : p.kind !== 'none' ? 'Paused' : 'Warm') : 'Keep warm off', hit === null ? '' : `${pct(hit * 100)} hit`, five ? `5h ${pct(five.percent)}` : '']
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Box>
      )
    }

    const parts: RenderChildren[] = []

    // Tabs: the two pages.
    parts.push(
      <Box key="tabs" gap={1} alignItems="center" marginBottom={1}>
        <Button key="tab-overview" label="Overview" variant={onSettings ? 'secondary' : 'primary'} onPress={() => void update($, settingsOpen, () => false)} />
        <Button key="tab-settings" label="Settings" variant={onSettings ? 'primary' : 'secondary'} onPress={() => void update($, settingsOpen, () => true)} />
        <Box flexGrow={1} />
        <Button key="refresh" label="Refresh" dimColor onPress={() => act(async () => { await refresh($); await judge($, opts); return 'Refreshed.' })} />
      </Box>,
    )

    if (ov.simulate)
      parts.push(
        <Box key="sim" gap={1} alignItems="center" marginBottom={1} flexWrap="wrap">
          <Text bold color="warning">
            Test mode
          </Text>
          <Text dimColor>
            5-hour {ov.simulate.fiveHour}%, weekly {ov.simulate.week}% (made up)
          </Text>
          <Button key="sim-off" label="End test" onPress={() => act(() => simulateOff($))} />
        </Box>,
      )
    if (q.unavailable)
      parts.push(
        <Text key="unavailable" color="error">
          {q.unavailable}
        </Text>,
      )
    // Feedback from the last press, at the top where it is seen.
    if (note)
      parts.push(
        <Box key="note" marginBottom={1}>
          <Text color={note.startsWith('Failed') || note.startsWith('Use') || note.startsWith('The 5-hour reset') || note.startsWith('Pick') ? 'error' : 'success'}>{note}</Text>
        </Box>,
      )

    if (!onSettings) {
      // 1. The prompt cache and keep warm: the panel's main job.
      const keepChip = (choice: KeepState['choice'], label: string) => (
        <Button
          key={`keep-${choice}`}
          label={label}
          variant={(choice === 'off' ? chosen === 'off' && p.kind === 'none' : chosen === choice) ? 'primary' : 'secondary'}
          onPress={() => act(() => setKeep($, choice))}
        />
      )
      const planLine: RenderChildren = !tgt ? (
        <Text key="plan" dimColor>
          Pick how long to keep the cache warm while you are away.
        </Text>
      ) : spent ? (
        <Text key="plan" dimColor>
          No pings: the limit is at 100%, requests are refused.
        </Text>
      ) : farOff ? (
        <Text key="plan" dimColor>
          No pings: the reset is too far off to be worth it.
        </Text>
      ) : busy ? (
        <Text key="plan" dimColor>
          A turn is running; it keeps the cache warm.
        </Text>
      ) : plan === null ? (
        <Text key="plan" dimColor>
          No ping needed: the cache lasts until then.
        </Text>
      ) : (
        <Box key="plan" gap={isRich ? 3 : 2} flexWrap="wrap">
          {stat(fmtDur(Math.max(0, plan.next - now)), 'to next ping', statusTone)}
          {plan.left !== null ? stat(String(plan.left), plan.left === 1 ? 'ping left' : 'pings left') : stat('∞', 'until you stop')}
          {stat(`${Math.round(plan.gap / MINUTE)}m`, 'apart')}
        </Box>
      )
      const hint =
        k.choice === 'always' && p.kind === 'none'
          ? 'A one-word ping every 50 minutes of idle, until you press Off. Your own messages count too.'
          : 'Pings go out evenly to the end, at most 50 minutes apart. Your own messages count, so it only pings while you are away.'

      const timeLeft: RenderChildren =
        cacheLeft === null ? (
          <Text key="left" dimColor>
            No reply yet
          </Text>
        ) : cacheLeft > 0 ? (
          <Box key="left" gap={1} alignItems="center">
            <Text bold tabular color={cTone} size={isRich ? 'title' : undefined}>
              {fmtDur(cacheLeft)}
            </Text>
            <Text dimColor>left of {ttl === HOUR ? '60m' : '5m'}</Text>
          </Box>
        ) : (
          <Text key="left" bold color="error" size={isRich ? 'title' : undefined}>
            Expired
          </Text>
        )

      parts.push(
        card('cache', p.kind === 'none' ? (cacheLeft === null ? null : cTone === 'success' ? null : cTone) : 'warning', [
          <Box key="hero" gap={2} alignItems="center">
            {Svg ? (
              <Svg
                key="hero-ring"
                source={heroRingSvg(share, cacheLeft !== null && cacheLeft <= 0 ? 'error' : cTone, leftShort, cacheLeft !== null && cacheLeft > 0 ? 'left' : '')}
                alt={cacheLeft === null ? 'Prompt cache: no reply yet' : `Prompt cache: ${fmtDur(Math.max(0, cacheLeft))} left`}
                width={64}
                height={64}
              />
            ) : (
              ring(share, cTone, 'Prompt cache')
            )}
            <Box flexDirection="column" flexShrink={1}>
              <Text bold>Prompt cache</Text>
              {timeLeft}
              <Text key="status" bold color={statusTone}>
                {statusText}
              </Text>
            </Box>
          </Box>,
          planLine,
          <Box key="keep" flexDirection="column" gap={isRich ? 1 : 0}>
            <Text dimColor size="footnote">
              Keep warm
            </Text>
            <Box gap={1} alignItems="center" flexWrap="wrap">
              {keepChip('off', 'Off')}
              {KEEP_HOURS.map(hours => keepChip(String(hours) as KeepState['choice'], `${hours}h`))}
              {l?.fiveHour?.resetsAt && l.fiveHour.resetsAt > now ? keepChip('reset', 'Until reset') : null}
              {keepChip('always', 'Always')}
            </Box>
          </Box>,
          p.kind !== 'none' ? (
            <Box key="actions" gap={1}>
              <Button key="continue" variant="primary" label="Continue now" onPress={() => act(() => continueNow($))} />
            </Box>
          ) : tgt && tgt.until !== null ? (
            <Box key="actions" gap={1}>
              <Button key="pause-work" label={`Pause work until ${clockAt(tgt.until)}`} onPress={() => act(() => pauseWork($))} />
            </Box>
          ) : null,
          <Text key="hint" dimColor size="footnote">
            {hint}
          </Text>,
        ]),
      )

      // 2. Cache usage: what is cached now, the hit and miss rates, and the session's totals.
      const missTone: Tone | undefined = hit === null ? undefined : hitTone(hit) === 'success' ? undefined : hitTone(hit)
      const agentHit = hitRate(st.agentRead, st.agentWritten, st.agentUncached)
      parts.push(
        card(
          'usage',
          null,
          st.calls === 0
            ? [heading('Cache usage'), <Text key="none" dimColor>No model calls in this chat yet.</Text>]
            : [
                heading('Cache usage', <Text dimColor size="footnote">{`${st.calls} ${st.calls === 1 ? 'call' : 'calls'}`}</Text>),
                <Box key="figures" gap={isRich ? 3 : 2} flexWrap="wrap">
                  {figure(fmtTok(inCache), 'in cache')}
                  {figure(hit === null ? '…' : pct(hit * 100), 'hit rate', hit === null ? undefined : hitTone(hit))}
                  {figure(hit === null ? '…' : pct((1 - hit) * 100), 'miss rate', missTone)}
                </Box>,
                hit === null ? null : <Box key="hitbar">{bar(hit * 100, hitTone(hit), [], `Cache hit rate ${pct(hit * 100)}`)}</Box>,
                <Box key="totals" gap={isRich ? 3 : 2} flexWrap="wrap">
                  {stat(fmtTok(st.read), 'read')}
                  {stat(fmtTok(st.written), 'written')}
                  {stat(fmtTok(st.uncached), 'uncached')}
                  {stat(fmtTok(st.output), 'output')}
                </Box>,
                <Box key="events" gap={isRich ? 3 : 2} flexWrap="wrap">
                  {stat(String(st.rebuilds), st.lastRebuildAt ? `${st.rebuilds === 1 ? 'rebuild' : 'rebuilds'}, last ${clockAt(st.lastRebuildAt)}` : 'rebuilds')}
                  {stat(String(st.pings), st.pings === 1 ? 'ping' : 'pings')}
                  {st.pingRead + st.pingWritten > 0 ? stat(fmtTok(st.pingRead + st.pingWritten), 'ping tokens') : null}
                </Box>,
                st.agentCalls > 0 ? (
                  <Text key="agents-usage" dimColor size="footnote">
                    Subagents: {st.agentCalls} calls · {agentHit === null ? '…' : `${pct(agentHit * 100)} hit`} · {fmtTok(st.agentRead)} read · {fmtTok(st.agentWritten)} written
                  </Text>
                ) : null,
              ],
        ),
      )

      // 3. Plan limits, in one card: 5-hour, weekly, the main model's weekly (set by hand), context.
      const limitRow = (key: 'fiveHour' | 'weekAll', win: QuotaWindow, stopAt: number) => {
        const tone = toneOf(win.percent, t.headsUp, stopAt)
        const pace = paceOf(q.samples, key, now)
        const o = outlookOf(win, pace, now)
        const marks = key === 'fiveHour' ? [t.headsUp, t.subagentsStop, t.mainStop] : [t.headsUp, t.weekStop]
        const outlook = o.hoursToFull === null ? 'pace needs more readings' : o.lastsToReset ? 'lasts to the reset' : `runs out in ${fmtDur(o.hoursToFull * HOUR)}`
        return (
          <Box key={key} flexDirection="column">
            <Box justifyContent="space-between" alignItems="center" gap={2}>
              <Box gap={1} alignItems="center" flexShrink={1}>
                {ring(win.percent / 100, tone, `${win.label}: ${pct(win.percent)} used`)}
                <Text bold>{win.label}</Text>
              </Box>
              <Text bold tabular color={tone}>
                {pct(win.percent)}
              </Text>
            </Box>
            <Box marginY={isRich ? 1 : 0}>{bar(win.percent, tone, marks, `${pct(win.percent)} of ${win.label}`)}</Box>
            <Box gap={isRich ? 3 : 2} flexWrap="wrap">
              {stat(win.resetsAt ? fmtDur(win.resetsAt - now) : '?', 'to reset')}
              {stat(pace === null ? '…' : `${pace.toFixed(key === 'fiveHour' ? 1 : 2)}%/h`, 'pace')}
              <Text dimColor size="footnote" color={o.lastsToReset === false ? 'warning' : undefined}>
                {outlook}
              </Text>
            </Box>
          </Box>
        )
      }
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

      if (!l) parts.push(card('limits', null, [heading('Plan limits'), <Text key="reading" dimColor>Reading the limits…</Text>]))
      else {
        const tones = windowsOf(l).map(({ key, win }) => toneOf(win.percent, t.headsUp, key === 'fiveHour' ? t.mainStop : t.weekStop))
        const worst: Tone | null = tones.includes('error') ? 'error' : tones.includes('warning') ? 'warning' : null
        const wm = l.weekModel
        const modelName = m.model || 'main model'
        const wmTone = wm ? toneOf(wm.percent, t.headsUp, t.weekStop) : 'success'
        parts.push(
          card('limits', worst, [
            heading('Plan limits', l.contextPercent !== null ? stat(`${l.contextPercent}%`, 'context') : null),
            l.fiveHour ? limitRow('fiveHour', l.fiveHour, t.mainStop) : <Text key="no-five" dimColor>5-hour limit: not reported</Text>,
            l.weekAll ? limitRow('weekAll', l.weekAll, t.weekStop) : <Text key="no-week" dimColor>Weekly · all models: not reported</Text>,
            <Box key="weekModel" flexDirection="column">
              <Box justifyContent="space-between" alignItems="center" gap={2}>
                <Box gap={1} alignItems="center" flexShrink={1}>
                  {ring(wm ? wm.percent / 100 : 0, wmTone, `Weekly ${modelName}: ${wm ? pct(wm.percent) : 'not set'}`)}
                  <Text bold>Weekly · {modelName}</Text>
                </Box>
                {wm ? (
                  <Text bold tabular color={wmTone}>
                    {pct(wm.percent)}
                  </Text>
                ) : (
                  <Text dimColor>not set</Text>
                )}
              </Box>
              {wm ? <Box marginY={isRich ? 1 : 0}>{bar(wm.percent, wmTone, [t.headsUp, t.weekStop], `${pct(wm.percent)} of ${wm.label}`)}</Box> : null}
              {wm ? null : (
                <Text dimColor size="footnote">
                  A mod cannot read this one: pick what the usage card shows.
                </Text>
              )}
              {modelPicker(wm ? String(wm.percent) : 'off')}
            </Box>,
          ]),
        )
      }

      // 4. Subagents, one row each, only when there are any.
      const agentList = (await $.agent.list()).slice(0, MAX_ROWS)
      if (agentList.length > 0)
        parts.push(
          card('agents', null, [
            heading('Subagents'),
            ...agentList.map(a => {
              const s = map[a.id]
              const paused = s?.status === 'paused'
              const window = s && m.model ? (spendsWindow(s.model, m.model) === 'model' ? 'model window' : 'all-models') : ''
              return (
                <Box key={a.id} flexDirection="column">
                  <Text color={paused ? 'warning' : undefined}>
                    {paused ? '❚❚' : a.status === 'running' ? '●' : '○'} {a.description || a.type}
                  </Text>
                  <Text dimColor size="footnote">
                    {[s?.model ?? '', paused ? 'paused for quota' : a.status, `${fmtTok(s?.tokens ?? 0)} tok`, s?.lastCacheAt ? `cache ${fmtDur(now - s.lastCacheAt)} old` : '', window].filter(Boolean).join(' · ')}
                  </Text>
                </Box>
              )
            }),
          ]),
        )

      parts.push(
        <Box key="footer" gap={isRich ? 3 : 2} alignItems="center" flexWrap="wrap">
          <Text dimColor size="footnote">
            Read {q.refreshedAt ? `${fmtDur(now - q.refreshedAt)} ago` : 'never'} · alerts {t.headsUp}% · main stops {t.mainStop}%
          </Text>
        </Box>,
      )
    } else {
      // Settings: every option and test mode as one-click choices; nothing to type.
      const chips = (prefix: string, values: number[], current: number | null, fmt: (v: number) => string, pick: (v: number) => Promise<string>) => (
        <Box gap={1} flexWrap="wrap" alignItems="center">
          {values.map(v => (
            <Button key={`${prefix}-${v}`} label={fmt(v)} variant={v === current ? 'primary' : 'secondary'} onPress={() => act(() => pick(v))} />
          ))}
        </Box>
      )
      const row = (key: keyof Thresholds, hint: string) => (
        <Box key={`row-${key}`} flexDirection="column">
          <Box gap={1} alignItems="center" flexWrap="wrap">
            <Text bold>{THRESHOLD_NAMES[key]}</Text>
            <Text bold color={key === 'headsUp' ? 'warning' : 'error'}>
              {t[key]}%
            </Text>
            <Text dimColor size="footnote">
              {hint}
            </Text>
          </Box>
          {chips(`t-${key}`, withCurrent(CHOICES[key], t[key]), t[key], v => `${v}%`, v => setThreshold($, key, String(v)))}
        </Box>
      )
      const defaultKeep = ov.defaultKeep ?? 'off'

      parts.push(
        card('new-chats', defaultKeep === 'always' ? 'success' : null, [
          heading('Every chat'),
          <Text key="nc-hint" dimColor size="footnote">
            What keep warm a new chat starts with. Always pings each idle chat every 50 minutes until you press Off there.
          </Text>,
          <Box key="nc-chips" gap={1} alignItems="center" flexWrap="wrap">
            <Button key="default-off" label="Off" variant={defaultKeep === 'off' ? 'primary' : 'secondary'} onPress={() => act(() => setDefaultKeep($, 'off'))} />
            <Button key="default-always" label="Always" variant={defaultKeep === 'always' ? 'primary' : 'secondary'} onPress={() => act(() => setDefaultKeep($, 'always'))} />
          </Box>,
        ]),
      )

      parts.push(
        card('levels', null, [
          heading('Levels'),
          Svg ? (
            <Box key="scale" flexDirection="column">
              <Svg source={scaleSvg(t)} alt={`Levels: heads-up ${t.headsUp}%, subagents stop ${t.subagentsStop}%, main stop ${t.mainStop}%, weekly stop ${t.weekStop}%`} />
            </Box>
          ) : null,
          row('headsUp', 'a toast for any limit'),
          row('subagentsStop', 'subagents pause, 5-hour'),
          row('mainStop', 'main session pauses, 5-hour'),
          row('weekStop', 'everything stops, weekly'),
          <Text key="levels-hint" dimColor size="footnote">
            Saved for every session. Each level is said once per window reset.
          </Text>,
        ]),
      )

      parts.push(
        card('test', ov.simulate ? 'warning' : null, [
          heading('Test mode', ov.simulate ? <Text bold color="warning">on</Text> : null),
          <Text key="test-hint" dimColor size="footnote">
            Made-up readings, to watch a level fire.
          </Text>,
          <Box key="test-chips" gap={1} flexWrap="wrap" alignItems="center">
            {SCENARIOS.map(sc => (
              <Button
                key={`sim-${sc.key}`}
                label={sc.label}
                variant={ov.simulate && ov.simulate.fiveHour === sc.five && ov.simulate.week === sc.week ? 'primary' : 'secondary'}
                onPress={() => act(async () => { const text = await simulate($, `${sc.five} ${sc.week}`); await tick($, opts); return text })}
              />
            ))}
            {ov.simulate ? <Button key="sim-end" label="End test" onPress={() => act(() => simulateOff($))} /> : null}
          </Box>,
        ]),
      )

      parts.push(
        <Box key="settings-footer" flexDirection="column" gap={gapY}>
          <Box>
            <Button key="settings-reset" label="Reset to defaults" onPress={() => act(() => resetSettings($))} />
          </Box>
          <Text dimColor size="footnote">
            Extra usage drops the cache to 5 minutes; a mod cannot see it.
          </Text>
        </Box>,
      )
    }

    return <Box flexDirection="column">{parts}</Box>
  })

  // The band above the prompt: the cache's time left, what is cached and the miss rate, the
  // live warning from the thresholds, and while kept warm or paused, the ping plan. Quota opens
  // the panel. What sits beneath (another plugin's band) is kept.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isRich = e.surface !== 'terminal' && e.surface !== 'vscode'
    const Svg = isRich ? $.ui.resolve(e).Svg : null
    const isNarrow = e.props.bodyColumns < 88

    const now = await $.clock.now()
    const q = await read($, quota)
    const m = await read($, main)
    const p = await read($, pause)
    const k = await read($, keep)
    const st: CacheStats = { ...EMPTY_STATS, ...(await read($, stats)) }
    const t = thresholdsOf(opts, await read($, overrides))
    const l = q.limits
    if (!m.lastCacheAt) return below

    // The cache: time left of its lifetime, what is cached, and the session's miss rate.
    const ttl = l && windowsOf(l).some(w => w.win.percent >= 100) ? 5 * MINUTE : HOUR
    const left = m.lastCacheAt + ttl - now
    const isWarm = left > 0
    const share = Math.max(0, left / ttl)
    const tone: Tone = cacheTone(share)
    const recache = fmtTok(m.recache ?? cachedNow(st))
    const cached = fmtTok(cachedNow(st) || m.recache || 0)
    const hit = hitRate(st.read, st.written, st.uncached)
    const miss = hit === null ? null : pct((1 - hit) * 100)
    const missTone: Tone | undefined = hit === null ? undefined : hitTone(hit) === 'success' ? undefined : hitTone(hit)

    // The live warning: the highest level any limit has reached.
    let warning: { text: string; tone: Tone; rank: number } | null = null
    for (const { key, win } of l ? windowsOf(l) : []) {
      const name = key === 'fiveHour' ? '5-hour' : key === 'weekAll' ? 'weekly' : 'model weekly'
      const stopAt = key === 'fiveHour' ? t.mainStop : t.weekStop
      const at = pct(win.percent)
      const w =
        win.percent >= stopAt
          ? { text: `${name} ${at}: stop`, tone: 'error' as Tone, rank: 3 }
          : key === 'fiveHour' && win.percent >= t.subagentsStop
            ? { text: `${name} ${at}: subagents stop`, tone: 'error' as Tone, rank: 2 }
            : win.percent >= t.headsUp
              ? { text: `${name} ${at}: heads-up`, tone: 'warning' as Tone, rank: 1 }
              : null
      if (w && (!warning || w.rank > warning.rank)) warning = w
    }

    // Kept warm or paused: the plan that keeps the cache alive.
    const tgt = await warmTarget($)
    const clockAt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const farOff = p.kind === 'quota' && !keepAliveWorth(p.until, now)
    const plan = tgt && !farOff && !spentNow(q) ? pingPlan(cacheWrittenAt(m.lastCacheAt, tgt.startedAt), tgt.until) : null
    const holdText = !tgt
      ? null
      : p.kind !== 'none'
        ? `Paused${tgt.until ? ` until ${clockAt(tgt.until)}` : ''}`
        : k.choice === 'always'
          ? 'Warm ∞'
          : `Warm${tgt.until ? ` until ${clockAt(tgt.until)}` : ''}`
    const planText = !tgt
      ? null
      : farOff
        ? 'no pings: the reset is days off'
        : spentNow(q)
          ? 'no pings: limit at 100%'
          : plan === null
            ? 'no ping needed'
            : `${plan.left === null ? 'ping' : plan.left === 1 ? '1 ping' : `${plan.left} pings`} · next ${fmtDur(Math.max(0, plan.next - now))}`

    const openPanel = async () => {
      await update($, settingsOpen, () => false)
      await $.ui.open({ id: PANE, title: 'Quota' })
    }
    const minutes = (ms: number) => (ms >= 60 * 1000 ? `${Math.ceil(ms / 60000)} min` : `${Math.ceil(ms / 1000)} sec`)

    // After the cache figures: the ping plan while kept warm or paused, else the warning; then Quota.
    const extras = () => [
      holdText ? (
        <Box key="hold" gap={1} alignItems="center">
          <Text bold color={p.kind !== 'none' ? 'warning' : 'success'}>
            {holdText}
          </Text>
          {planText && !isNarrow ? <Text dimColor>{planText}</Text> : null}
        </Box>
      ) : null,
      warning && !holdText ? (
        <Text key="warning" bold color={warning.tone}>
          {warning.text}
        </Text>
      ) : null,
      <Button key="band-open" label="Quota" dimColor onPress={() => void openPanel()} />,
    ]

    let ours: RenderChildren
    if (isRich && Svg) {
      const stat = (value: string, label: string, color?: Tone) => (
        <Box key={label} gap={1} alignItems="center">
          <Text bold tabular color={color}>
            {value}
          </Text>
          <Text dimColor>{label}</Text>
        </Box>
      )
      const alt = isWarm ? `Prompt cache warm, ${minutes(left)} left` : `Prompt cache cold, next message re-caches ${recache} tokens`
      ours = (
        <Box borderStyle="round" borderDimColor paddingX={1} alignItems="center" justifyContent="space-between" gap={3}>
          <Box gap={1} alignItems="center" flexShrink={0}>
            <Svg source={ringSvg(isWarm ? share : 0, tone)} alt={alt} width={18} height={18} />
            <Text bold>Prompt cache</Text>
            {isWarm ? (
              <Box gap={1} alignItems="center">
                <Text color={tone} bold tabular>
                  {minutes(left)} left
                </Text>
                {holdText || isNarrow ? null : <Text dimColor>of {ttl === HOUR ? '60 min' : '5 min'}</Text>}
              </Box>
            ) : (
              <Text color={tone} bold>
                Expired
              </Text>
            )}
          </Box>
          <Box gap={3} alignItems="center" flexShrink={1} flexWrap="wrap" justifyContent="flex-end">
            {isWarm ? (isNarrow ? null : stat(cached, 'cached')) : stat(`${recache} tokens`, 'to re-cache', 'error')}
            {miss === null ? null : stat(miss, 'miss', missTone)}
            {extras()}
          </Box>
        </Box>
      )
    } else {
      const stat = (label: string, value: string, color?: Tone) => (
        <Box key={label} gap={1}>
          <Text dimColor>{label}</Text>
          <Text bold color={color}>
            {value}
          </Text>
        </Box>
      )
      const status = (
        <Box gap={1} flexShrink={0}>
          <Text color={tone} bold>
            {isWarm ? '●' : '○'} cache
          </Text>
          <Text color={tone}>{isWarm ? 'warm' : 'cold'}</Text>
          {isWarm ? <Text dimColor>{ttl === HOUR ? '1h' : '5m'} ttl</Text> : null}
        </Box>
      )
      if (!isWarm) {
        ours = (
          <Box borderStyle="round" borderColor={tone} paddingX={1} gap={2} flexWrap="wrap">
            {status}
            <Box gap={1}>
              <Text dimColor>next message re-caches</Text>
              <Text bold color={tone}>
                {recache} tokens
              </Text>
            </Box>
            {miss === null ? null : stat('miss', miss, missTone)}
            {extras()}
          </Box>
        )
      } else {
        // The bar takes what the row leaves: status and time on the left, the stats on the right.
        const cells = Math.max(6, Math.min(24, e.props.bodyColumns - (isNarrow ? 44 : 100)))
        const filled = Math.max(1, Math.round(share * cells))
        const leftText =
          left >= HOUR ? `${Math.floor(left / HOUR)}h ${Math.floor((left % HOUR) / 60000)}m` : left >= 60 * 1000 ? `${Math.ceil(left / 60000)}m` : `${Math.ceil(left / 1000)}s`
        ours = (
          <Box borderStyle="round" borderColor={tone} borderDimColor={tone === 'success'} paddingX={1} justifyContent="space-between" gap={2}>
            <Box gap={2} flexShrink={0}>
              {status}
              <Box gap={1}>
                <Text>
                  <Text color={tone}>{'█'.repeat(filled)}</Text>
                  <Text dimColor>{'░'.repeat(cells - filled)}</Text>
                </Text>
                <Text bold color={tone}>
                  {leftText}
                </Text>
                <Text dimColor>left</Text>
              </Box>
            </Box>
            <Box gap={2} flexShrink={1} flexWrap="wrap">
              {isNarrow ? null : stat('cached', cached)}
              {miss === null ? null : stat('miss', miss, missTone)}
              {extras()}
            </Box>
          </Box>
        )
      }
    }

    return (
      <Box flexDirection="column">
        {ours}
        {below}
      </Box>
    )
  })

}
