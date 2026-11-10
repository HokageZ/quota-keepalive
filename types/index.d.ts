// The quota mod's state contract. Mirrors the value shapes in hooks/logic.ts.
// Values are kept with `$.state` (session) so a hot reload does not lose them.

export type Thresholds = {
  headsUp: number
  subagentsStop: number
  mainStop: number
  weekStop: number
}

export type QuotaWindow = {
  label: string
  percent: number
  resetsAt: number | null
}

export type QuotaLimits = {
  at: number
  fiveHour: QuotaWindow | null
  weekAll: QuotaWindow | null
  weekModel: QuotaWindow | null
  contextPercent: number | null
  source: 'live' | 'simulated'
}

export type QuotaSample = {
  at: number
  fiveHour: number | null
  weekAll: number | null
}

export type QuotaState = {
  limits: QuotaLimits | null
  samples: QuotaSample[]
  said: string[]
  refreshedAt: number
  needsRefresh: boolean
  unavailable: string
}

export type Overrides = {
  thresholds: Partial<Thresholds>
  simulate: { fiveHour: number; week: number } | null
  weekModelPercent: number | null
  pingMinutes: number | null
}

export type PauseState = {
  kind: 'none' | 'quota' | 'time'
  until: number | null
  window: string
  startedAt: number
  lastPingAt: number
  reason: string
}

export type MainState = {
  model: string
  lastTurnAt: number
  lastCacheAt: number
}

export type AgentState = {
  model: string
  tokens: number
  lastCacheAt: number
  status: 'running' | 'paused' | 'finished'
}

declare module 'claude-code' {
  interface PluginState {
    'quota-keepalive': {
      quota: Shaped<QuotaState>
      overrides: Shaped<Overrides>
      pause: Shaped<PauseState>
      main: Shaped<MainState>
      agents: Shaped<Record<string, AgentState>>
    }
  }
}
