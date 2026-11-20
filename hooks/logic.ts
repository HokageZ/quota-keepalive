// Pure rules of the quota mod: thresholds, pace, pause and ping timing.
// No engine imports here, so `node --test` can run them directly.

export type Level = 'heads-up' | 'subagents-stop' | 'main-stop' | 'week-stop'

export type Thresholds = {
  headsUp: number // any window, percent
  subagentsStop: number // five-hour window: running subagents stop at a clean point
  mainStop: number // five-hour window: main session stops starting work
  weekStop: number // any weekly window: stop and tell the person
}

export type Window = {
  label: string
  percent: number
  resetsAt: number | null // epoch ms
}

export type Limits = {
  at: number // epoch ms of the reading
  fiveHour: Window | null
  weekAll: Window | null
  weekModel: Window | null // null when the mod cannot read it (set by hand with /quota model)
  contextPercent: number | null
  source: 'live' | 'simulated'
}

export type Sample = { at: number; fiveHour: number | null; weekAll: number | null }

export type Alert = {
  id: string // one per threshold per window per reset: said once
  level: Level
  window: string
  percent: number
  text: string
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  headsUp: 90,
  subagentsStop: 96,
  mainStop: 98,
  weekStop: 99,
}

export const HOUR = 3_600_000
export const MINUTE = 60_000

// Windows that can raise an alert, with the label the person sees.
export function windowsOf(l: Limits): { key: 'fiveHour' | 'weekAll' | 'weekModel'; win: Window }[] {
  const out: { key: 'fiveHour' | 'weekAll' | 'weekModel'; win: Window }[] = []
  if (l.fiveHour) out.push({ key: 'fiveHour', win: l.fiveHour })
  if (l.weekAll) out.push({ key: 'weekAll', win: l.weekAll })
  if (l.weekModel) out.push({ key: 'weekModel', win: l.weekModel })
  return out
}

// The alerts that the current readings reach. `said` holds the ids already given;
// the caller adds the returned ids to it, so each threshold of each window is said once per reset.
export function alertsFor(l: Limits, t: Thresholds, said: string[]): Alert[] {
  const out: Alert[] = []
  const add = (level: Level, key: string, win: Window, text: string) => {
    // The reset time to the nearest 10 minutes: a reading that drifts by seconds is the same window.
    const id = `${key}:${level}:${win.resetsAt === null ? 'none' : Math.round(win.resetsAt / (10 * MINUTE))}`
    if (said.includes(id)) return
    out.push({ id, level, window: win.label, percent: win.percent, text })
  }
  for (const { key, win } of windowsOf(l)) {
    const p = win.percent
    if (key === 'fiveHour') {
      if (p >= t.mainStop) add('main-stop', key, win, `5-hour limit at ${p}%: stop starting new work, finish only what is in hand, and report. Keep the cache warm; the mod will tell you when to continue.`)
      else if (p >= t.subagentsStop) add('subagents-stop', key, win, `5-hour limit at ${p}%: stop at a clean point and report "paused for quota".`)
      else if (p >= t.headsUp) add('heads-up', key, win, `5-hour limit at ${p}%.`)
    } else {
      if (p >= t.weekStop) add('week-stop', key, win, `${win.label} at ${p}%: stop and tell the person. They can enable a quota reset.`)
      else if (p >= t.headsUp) add('heads-up', key, win, `${win.label} at ${p}%.`)
    }
  }
  return out
}

// Percent per hour over the last `spanMs` of samples, for one window; null with fewer than two points.
export function paceOf(samples: Sample[], key: 'fiveHour' | 'weekAll', now: number, spanMs = 3 * HOUR): number | null {
  const pts = samples
    .filter(s => now - s.at <= spanMs && s[key] !== null)
    .sort((a, b) => a.at - b.at)
  if (pts.length < 2) return null
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (!first || !last) return null
  const hours = (last.at - first.at) / HOUR
  if (hours <= 0) return null
  const delta = (last[key] as number) - (first[key] as number)
  return Math.max(0, delta / hours)
}

export type Outlook = { perHour: number | null; hoursToFull: number | null; lastsToReset: boolean | null }

// At the current pace, when the window would reach 100%, and whether that is before its reset.
export function outlookOf(win: Window | null, perHour: number | null, now: number): Outlook {
  if (!win || perHour === null) return { perHour, hoursToFull: null, lastsToReset: null }
  if (perHour <= 0) return { perHour, hoursToFull: null, lastsToReset: true }
  const hoursToFull = Math.max(0, (100 - win.percent) / perHour)
  const lastsToReset = win.resetsAt === null ? null : now + hoursToFull * HOUR >= win.resetsAt
  return { perHour, hoursToFull, lastsToReset }
}

// Has the reset time of the window passed? A pause made for it ends then.
export function resetPassed(resetsAt: number | null, now: number): boolean {
  return resetsAt !== null && now >= resetsAt
}

// Is a keep-alive ping due: the last one is at least `everyMs` old.
export function pingDue(lastPingAt: number, now: number, everyMs: number): boolean {
  return now - lastPingAt >= everyMs
}

// A failed or unanswered ping is tried again after this, not after a whole interval.
export const PING_RETRY = 5 * MINUTE

// When the cache was last written, as far as the mod knows: the last cached request,
// or the pause start when no request was seen (a session that never ran a turn).
export function cacheWrittenAt(lastCacheAt: number, startedAt: number): number {
  return lastCacheAt > 0 ? lastCacheAt : startedAt
}

// Is a keep-alive ping due for one cache: its last write is `everyMs` old, and no ping
// went out in the last PING_RETRY (a ping still in flight, or one that failed, is retried then).
export function cachePingDue(writtenAt: number, lastPingAt: number, now: number, everyMs: number): boolean {
  return now - writtenAt >= everyMs && now - lastPingAt >= PING_RETRY
}

// The cache lives an hour; a ping lands at least this long before it would expire.
export const CACHE_TTL = HOUR
export const PING_MARGIN = 10 * MINUTE

// The keep-alive plan for one cache: from its last write to the reset, the fewest equal gaps of
// at most CACHE_TTL - PING_MARGIN (50 minutes), so the cache is still warm when the pause ends.
// `next` is when the next ping is due, `left` how many pings remain before the reset.
// Null when the reset comes before the cache needs one. With no reset time, one gap at a time.
export type PingPlan = { next: number; gap: number; left: number | null }

export function pingPlan(writtenAt: number, until: number | null, ttl = CACHE_TTL, margin = PING_MARGIN): PingPlan | null {
  const maxGap = ttl - margin
  if (until === null) return { next: writtenAt + maxGap, gap: maxGap, left: null }
  const span = until - writtenAt
  if (span <= maxGap) return null
  const parts = Math.ceil(span / maxGap)
  const gap = span / parts
  return { next: writtenAt + gap, gap, left: parts - 1 }
}

// Is a planned ping due now: its time came, and no ping went out in the last PING_RETRY
// (one in flight, or one that did not land, is tried again then).
export function planDue(plan: PingPlan | null, lastPingAt: number, now: number): boolean {
  return plan !== null && now >= plan.next && now - lastPingAt >= PING_RETRY
}

// A limit at 100% rejects every request, pings included: the keep-alive stands down.
export function limitSpent(percents: readonly (number | null)[]): boolean {
  return percents.some(p => p !== null && p >= 100)
}

// Pings stop paying past this: a ping reads the whole context at the cache-read price,
// one every 45 minutes over 12 hours costs about what rebuilding the cache once does.
export const KEEPALIVE_HORIZON = 12 * HOUR

// Is keeping the cache warm worth it for a pause ending at `until`? An unknown end or one
// past the horizon (a weekly window days away) is not: pings would spend the very quota that ran out.
export function keepAliveWorth(until: number | null, now: number, horizon = KEEPALIVE_HORIZON): boolean {
  return until !== null && until - now <= horizon
}

// Has the window a quota pause waits on come back: its reset time passed, or a fresh
// reading shows it under the level that paused it (the reset the mod never saw a time for).
export function quotaBack(until: number | null, now: number, percent: number | null, stopAt: number): boolean {
  if (resetPassed(until, now)) return true
  return percent !== null && percent < stopAt
}

// Parse "15:45" or "9:05" into the next epoch ms at that local time (today, or tomorrow when it has passed).
export function nextClock(hhmm: string, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

// Minutes or hours, short.
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

// Prompt-cache totals for the session, from each model call's usage.
// read: tokens served from the cache (hits); written: tokens written to it (misses that get
// cached); uncached: input neither read nor written. A rebuild is a call that wrote more than
// it read: the cache had lapsed (or it was the first call), so the whole prefix was paid again.
export type CacheStats = {
  calls: number
  read: number
  written: number
  uncached: number
  output: number
  rebuilds: number
  lastAt: number
  lastRebuildAt: number
  // The last main call: what it read, wrote and sent uncached.
  last: { read: number; written: number; uncached: number } | null
  // Keep-alive pings sent (main and subagents), and what the main pings' calls read and wrote.
  pings: number
  pingRead: number
  pingWritten: number
  // Subagents' calls, kept apart so the main hit rate is the session's own.
  agentCalls: number
  agentRead: number
  agentWritten: number
  agentUncached: number
}

export const EMPTY_STATS: CacheStats = {
  calls: 0,
  read: 0,
  written: 0,
  uncached: 0,
  output: 0,
  rebuilds: 0,
  lastAt: 0,
  lastRebuildAt: 0,
  last: null,
  pings: 0,
  pingRead: 0,
  pingWritten: 0,
  agentCalls: 0,
  agentRead: 0,
  agentWritten: 0,
  agentUncached: 0,
}

export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

// Adds one call's usage. A stored value from an older version may lack fields: they start at 0.
export function addUsage(prev: Partial<CacheStats> | null | undefined, u: Usage, now: number, who: { agent: boolean; ping: boolean }): CacheStats {
  const s: CacheStats = { ...EMPTY_STATS, ...(prev ?? {}) }
  const read = u.cache_read_input_tokens || 0
  const written = u.cache_creation_input_tokens || 0
  const uncached = u.input_tokens || 0
  if (who.agent) {
    return { ...s, agentCalls: s.agentCalls + 1, agentRead: s.agentRead + read, agentWritten: s.agentWritten + written, agentUncached: s.agentUncached + uncached }
  }
  const rebuild = written > read && written > 0
  return {
    ...s,
    calls: s.calls + 1,
    read: s.read + read,
    written: s.written + written,
    uncached: s.uncached + uncached,
    output: s.output + (u.output_tokens || 0),
    rebuilds: s.rebuilds + (rebuild ? 1 : 0),
    lastAt: now,
    lastRebuildAt: rebuild ? now : s.lastRebuildAt,
    last: { read, written, uncached },
    pingRead: s.pingRead + (who.ping ? read : 0),
    pingWritten: s.pingWritten + (who.ping ? written : 0),
  }
}

// The share of input tokens the cache served, 0 to 1; null before any input was seen.
export function hitRate(read: number, written: number, uncached: number): number | null {
  const total = read + written + uncached
  return total > 0 ? read / total : null
}

// The size of the cached prefix after the last call: what it read plus what it wrote.
export function cachedNow(s: Partial<CacheStats> | null | undefined): number {
  const l = s?.last
  return l ? l.read + l.written : 0
}

// Token counts, short: 950, 12.4k, 1.32M.
export function fmtTok(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
}

// Which family of model: 'opus', 'sonnet', 'haiku', 'fable', or the id as it came.
export function familyOf(model: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)/i.exec(model)
  return m?.[1] ? m[1].toLowerCase() : model.toLowerCase()
}

// A subagent spends the weekly window of its own model; the all-models window is spent by every model.
export function spendsWindow(agentModel: string, mainModel: string): 'model' | 'all-only' {
  return agentModel && mainModel && familyOf(agentModel) === familyOf(mainModel) ? 'model' : 'all-only'
}
