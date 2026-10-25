import type { ClientModule } from 'claude-code'
import { ROBOT } from './sprite.tsx'

// M:SS under an hour, H:MM:SS from one hour on
export const fmt = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// total width is LEAD_W (39) in register.tsx: robot 5 + ` [Lead] ` 8 + `turn 99 · ` 10 + clock 16
const MS = 200

type Props = { running: boolean; color: string; done: string; primary: string; muted: string; turn?: number; since?: number; until?: number }
type State = { i: number; stop: (() => void) | null }

// the whole left part of the main row in ONE Client: robot, tag, turn, clock.
// One timer while running: the robot advances every tick, the clock is recomputed from Date.now().
const Lead: ClientModule<Props, State> = (p, s) => {
  const { Text } = s.elements
  let st = s.state
  if (!st) {
    st = { i: 0, stop: null }
    s.setState(st)
  }
  const cur = st
  if (p.running && !cur.stop) {
    cur.stop = s.every(MS, () => { cur.i = (cur.i + 1) % ROBOT.length; s.setState(cur) })
  } else if (!p.running && cur.stop) {
    cur.stop()
    cur.stop = null
  }
  const robot = p.running ? <Text color={p.color}>{ROBOT[cur.i % ROBOT.length]}</Text> : <Text color={p.done}>[^_^]</Text>
  // the client has no clock: wall time
  const clock = p.since == null ? <Text color={p.muted}>idle</Text>
    : p.running ? <Text color={p.primary}>working {fmt(Date.now() - p.since)}</Text>
    : <Text color={p.muted}>done in {fmt((p.until ?? p.since) - p.since)}</Text>
  return (
    <Text>
      {robot}
      <Text color={p.color}> [Lead] </Text>
      {p.turn ? <Text color={p.muted}>turn {p.turn} · </Text> : null}
      {clock}
    </Text>
  )
}

export default Lead
