import type { ClientModule } from 'claude-code'

// blinking robot, 5 cells: eyes open, blink on every 4th frame
export const ROBOT = ['[o_o]', '[o_o]', '[o_o]', '[-_-]']
// task kind, 5 cells like the agents: pac-man eating dots (mouth open/closed)
export const PACMAN = ['ᗧ····', ' ●···', '  ᗧ··', '   ●·', '    ᗧ']
const MS = 200 // robot
const MS_TASK = 280 // pac-man

type Props = { running: boolean; color: string; done: string; muted?: string; kind?: 'agent' | 'task' }
type State = { i: number; stop: (() => void) | null }

// one row's sprite: animated while running, static once done.
// The timer follows `running`: started when it turns true, cancelled when it turns false.
const Sprite: ClientModule<Props, State> = (p, s) => {
  const { Text } = s.elements
  let st = s.state
  if (!st) {
    st = { i: 0, stop: null }
    s.setState(st) // the only unconditional seed: once, while state is undefined
  }
  const cur = st
  const task = p.kind === 'task'
  const frames = task ? PACMAN : ROBOT
  if (p.running && !cur.stop) {
    cur.stop = s.every(task ? MS_TASK : MS, () => { cur.i = (cur.i + 1) % frames.length; s.setState(cur) })
  } else if (!p.running && cur.stop) {
    cur.stop()
    cur.stop = null
  }
  if (!p.running) return <Text color={p.done}>{task ? '    ᗧ' : '[^_^]'}</Text>
  const f = frames[cur.i % frames.length]
  if (task) {
    const m = [...f].findIndex((c) => c === 'ᗧ' || c === '●')
    const dots = [...f]
    return (
      <Text>
        <Text color={p.muted}>{dots.slice(0, m).join('')}</Text>
        <Text color={p.color}>{dots[m]}</Text>
        <Text color={p.muted}>{dots.slice(m + 1).join('')}</Text>
      </Text>
    )
  }
  return <Text color={p.color}>{f}</Text>
}

export default Sprite
