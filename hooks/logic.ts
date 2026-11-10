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
    const id = `${key}:${level}:${win.resetsAt ?? 'none'}`
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

// Which family of model: 'opus', 'sonnet', 'haiku', 'fable', or the id as it came.
export function familyOf(model: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)/i.exec(model)
  return m ? m[1].toLowerCase() : model.toLowerCase()
}

// A subagent spends the weekly window of its own model; the all-models window is spent by every model.
export function spendsWindow(agentModel: string, mainModel: string): 'model' | 'all-only' {
  return agentModel && mainModel && familyOf(agentModel) === familyOf(mainModel) ? 'model' : 'all-only'
}
