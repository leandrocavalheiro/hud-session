export type Usage = {
  context: { percent?: number; tokens?: number; window: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

export type AgentUsage = {
  model: string; tokens: number; step?: { done: number; total: number; note?: string }
  label?: string; kind?: string; role?: string; effort?: string; status?: 'running' | 'done'
  // epoch ms: when it was spawned, and when its last turn completed
  startedAt?: number; finishedAt?: number
}
export type Flow = { title: string; phase: string; done: number; total: number; finished: boolean; startedAt?: number; finishedAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'hud-session': {
      usage: Usage | null
      agents: Record<string, AgentUsage>
      effort: string | null
      flow: Flow | null
      turns: number[]
      live: number | null
      cache: { usd: number; at: number } | null
      main: { status: 'running' | 'done'; startedAt?: number; finishedAt?: number } | null
    }
  }
}
