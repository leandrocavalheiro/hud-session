import { expect, test } from 'claude-code/testing'

const pane = (bodyRows: number) => ({
  plugin: 'hud-session',
  component: 'Pane',
  requestId: 'hud-session',
  surface: 'terminal',
  props: { title: 'HudSession', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
}) as const

// every `$` call gather makes, answered as the engine would on a fresh session
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('command.register', () => ({ value: { command: 'hud-session' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'hud-session', isPlaced: true }] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.root', () => ({ value: '/repo/demo' }))
  on('session.usage', () => ({ value: { context: { window: 1_000_000 }, rateLimits: [] } }))
  on('clock.now', () => ({ value: 0 }))
  on('tool.list', () => ({ value: [] }))
  on('command.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/t' }))
  on('config.list', () => ({ value: [] }))
  on('settings.read', () => ({ value: {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('fs.read', () => ({ deny: 'no file' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
}

async function spawnAndFind($: Parameters<Parameters<typeof test>[1]>[0], rows: number) {
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Explore repo', subagentType: 'Explore' })
  const ui = await $.ui.mount(pane(rows))
  const row = await ui.find({ type: 'Text', text: /Explore repo/ })
  const none = await ui.find({ type: 'Text', text: /no task/ })
  await ui.unmount()
  return { row, none }
}

test('a spawned agent shows in the Agents box of a tall pane', async ($, on) => {
  engine(on)
  const { row, none } = await spawnAndFind($, 60)
  expect(row).toBeTruthy()
  expect(none).toBeFalsy()
})

test('a spawned agent still shows in a pane of an ordinary terminal height', async ($, on) => {
  engine(on)
  const { row } = await spawnAndFind($, 30)
  expect(row).toBeTruthy()
})

test('a spawned agent shows in a short pane', async ($, on) => {
  engine(on)
  const { row } = await spawnAndFind($, 24)
  expect(row).toBeTruthy()
})

test('the task row shows when it started, and when it finished', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Explore repo', subagentType: 'Explore' })
  let ui = await $.ui.mount(pane(60))
  expect(await ui.find({ type: 'Text', text: /started at \d\d:\d\d/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /finished at/ })).toBeFalsy()
  await ui.unmount()
})

test('a flow closed through `progress` shows its finish time', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__hud-session__progress', title: 'Ajuste do HUD', total: 2, done: 0, phase: 'delegate' } as never)
  await $.tool.call({ tool: 'mcp__hud-session__progress', done: 2, finished: true } as never)
  const ui = await $.ui.mount(pane(60))
  const row = await ui.find({ type: 'Text', text: /Ajuste do HUD/ })
  expect(row?.text).toMatch(/100%.*started at \d\d:\d\d.*finished at \d\d:\d\d/)
  await ui.unmount()
})
