import { expect, test } from 'claude-code/testing'
import { fmt } from './lead.tsx'

const pane = (bodyRows: number, bodyColumns = 60) => ({
  plugin: 'hud-session',
  component: 'Pane',
  requestId: 'hud-session',
  surface: 'terminal',
  props: { title: 'HudSession', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
}) as const

// the plugin's key-value store, in memory; reset by each engine()
let store: Record<string, unknown> = {}
let nowMs = 0

// every `$` call gather makes, answered as the engine would on a fresh session
let spawned = 0
function engine(on: Parameters<Parameters<typeof test>[1]>[1], settings?: string, tokens?: () => number, root = '/repo/demo') {
  on('command.register', () => ({ value: { command: 'hud-session' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'hud-session', isPlaced: true }] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.root', () => ({ value: root }))
  on('session.usage', () => ({ value: { context: { window: 1_000_000, ...(tokens ? { tokens: tokens() } : {}) }, rateLimits: [] } }))
  nowMs = 0
  spawned = 0
  on('clock.now', () => ({ value: nowMs }))
  store = {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => { store[e.key] = e.value; return { value: undefined } })
  on('session.id', () => ({ value: 'cur' }))
  on('tool.list', () => ({ value: [] }))
  on('command.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/t' }))
  on('config.list', () => ({ value: [] }))
  on('settings.read', () => ({ value: {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('fs.read', (_, e) => (settings && e.path.endsWith('/settings.json') ? { value: settings } : { deny: 'no file' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++spawned}` }))
}

async function spawnAndFind($: Parameters<Parameters<typeof test>[1]>[0], rows: number) {
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Explore repo', subagentType: 'Explore' })
  const ui = await $.ui.mount(pane(rows, 100))
  const row = await ui.find({ type: 'Text', text: /Explore/ })
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
  expect(await ui.find({ type: 'Text', text: /started at \d\d:\d\d:\d\d/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /finished at/ })).toBeFalsy()
  await ui.unmount()
})

test('a flow closed through `progress` shows its finish time', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__hud-session__progress', title: 'HUD tweak', total: 2, done: 0, phase: 'delegate' } as never)
  await $.tool.call({ tool: 'mcp__hud-session__progress', done: 2, finished: true } as never)
  const ui = await $.ui.mount(pane(60))
  const row = await ui.find({ type: 'Text', text: /HUD tweak/ })
  expect(row?.text).toMatch(/100%.*started at \d\d:\d\d:\d\d.*finished at \d\d:\d\d:\d\d/)
  await ui.unmount()
})

test('before any turn the Agents box already lists the main agent', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(pane(60))
  const main = await ui.find({ key: 'lead-main' })
  const none = await ui.find({ type: 'Text', text: /no task/ })
  await ui.unmount()
  expect(main).toBeTruthy()
  expect(none).toBeFalsy()
})

test('with a subagent the Agents box lists main first, then the subagent', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Explore repo', subagentType: 'Explore' })
  const ui = await $.ui.mount(pane(60, 100))
  const main = await ui.find({ key: 'lead-main' })
  const sub = await ui.find({ type: 'Text', text: /Explore/ })
  await ui.unmount()
  expect(main).toBeTruthy()
  expect(sub).toBeTruthy()
})

test('the main loop alone drives the task row: started at on turn.start, finished at on turn.complete', async ($, on) => {
  engine(on)
  on('turn.start', () => ({ turnId: 't1' }) as never)
  on('turn.complete', () => ({ turnId: 't1', text: '', answer: '' }) as never)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'hi' } as never)
  let ui = await $.ui.mount(pane(60))
  expect(await ui.find({ type: 'Text', text: /current task.*started at \d\d:\d\d:\d\d/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /finished at/ })).toBeFalsy()
  await ui.unmount()
  await $.turn.complete({ turnId: 't1', text: '', answer: '' } as never)
  ui = await $.ui.mount(pane(60))
  expect(await ui.find({ type: 'Text', text: /100%.*finished at \d\d:\d\d:\d\d/ })).toBeTruthy()
  await ui.unmount()
})

test('KPI cards wrap by pane width: one per row when narrow, all four when wide', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  let ui = await $.ui.mount(pane(60, 30))
  expect(await ui.find({ key: 'kpi-row-3' })).toBeTruthy()
  expect((await ui.find({ key: 'kpi-row-0' }))?.children).toHaveLength(1)
  await ui.unmount()
  ui = await $.ui.mount(pane(60, 80))
  expect((await ui.find({ key: 'kpi-row-0' }))?.children).toHaveLength(4)
  expect(await ui.find({ key: 'kpi-row-1' })).toBeFalsy()
  await ui.unmount()
})

test('an enabled plugin is a chip with the success background', async ($, on) => {
  engine(on, JSON.stringify({ enabledPlugins: { 'blast-radius@x': true, 'old@x': false } }))
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(pane(60))
  expect((await ui.find({ type: 'Text', text: /blast-radius/ }))?.props.backgroundColor).toBe('#13DEB9')
  expect((await ui.find({ type: 'Text', text: /old/ }))?.props.backgroundColor).toBe('#FA896B')
  await ui.unmount()
})

test('the AbovePrompt band draws nothing from this mod', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...pane(60), component: 'AbovePrompt', requestId: 'above-prompt', props: { bodyColumns: 60, maxRows: 20, hasSurvey: false } } as never)
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /HudSession|Integrations/ })).toBeFalsy()
  await ui.unmount()
})

test('the Context card draws 12 gray slots before any turn', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(pane(60, 80))
  const empty = await ui.find({ type: 'Text', text: /^\u28FF{12}$/ })
  expect(empty?.props.color).toBe('#333F55')
  await ui.unmount()
})

test('the Context card draws one turn per cell, filled in warning, the rest gray; the delta rides the sparkline line', async ($, on) => {
  let tokens = 0
  engine(on, undefined, () => tokens)
  on('turn.complete', () => ({ turnId: 't', text: '', answer: '' }) as never)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  for (const t of [100_000, 200_000, 400_000]) {
    tokens = t
    await $.turn.complete({ turnId: 't', text: '', answer: '' } as never)
  }
  const ui = await $.ui.mount(pane(60, 120))
  // heights 1, 2, 4 -> ⣀ ⣤ ⣿
  expect((await ui.find({ type: 'Text', text: /^\u28C0\u28E4\u28FF$/ }))?.props.color).toBe('#FFAE1F')
  expect((await ui.find({ type: 'Text', text: /^\u28FF{9}$/ }))?.props.color).toBe('#333F55')
  expect(await ui.find({ type: 'Text', text: /\/1\.0M$/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^ 200k$/ }))?.props.color).toBe('#FA896B')
  expect(await ui.find({ type: 'Text', text: /▲|▼/ })).toBeFalsy()
  await ui.unmount()
  tokens = 300_000
  await $.turn.complete({ turnId: 't', text: '', answer: '' } as never)
  const ui2 = await $.ui.mount(pane(60, 120))
  expect((await ui2.find({ type: 'Text', text: /^ 100k$/ }))?.props.color).toBe('#13DEB9')
  expect(await ui2.find({ type: 'Text', text: /▲|▼/ })).toBeFalsy()
  await ui2.unmount()
})

test('agent rows carry a numbered role tag assigned at spawn', async ($, on) => {
  await turnEngine($, on)
  await $.turn.start({ turnId: 't', text: 'hi' } as never)
  await $.agent.spawn({ prompt: 'x', description: 'Fix bug', subagentType: 'general-purpose' })
  await $.agent.spawn({ prompt: 'x', description: 'Add feature', subagentType: 'general-purpose' })
  await $.agent.spawn({ prompt: 'x', description: 'Look at diff', subagentType: 'code-reviewer' })
  await $.agent.spawn({ prompt: 'x', description: 'Run the test suite', subagentType: 'general-purpose' })
  await $.agent.spawn({ prompt: 'x', description: 'Design it', subagentType: 'Plan' })
  expect(await seen($, /\[Dev01\]/)).toBe(true)
  expect(await seen($, /Fix bug/)).toBe(true)
  expect(await seen($, /\[Dev02\]/)).toBe(true)
  expect(await seen($, /\[Rev01\]/)).toBe(true)
  expect(await seen($, /\[QA01\]/)).toBe(true)
  expect(await seen($, /\[Plan01\]/)).toBe(true)
  expect(await seen($, /\[Dev03\]/)).toBe(false)
})

test('a main turn.step updates the Context card before session.measure, which then overrides it', async ($, on) => {
  engine(on)
  on('turn.step', async function* () { return { turnId: "t1", index: 0, answer: "", toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 100_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0, output_tokens: 0 } } as never })
  on('session.measure', () => ({ changed: [] }) as never)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  const st = $.turn.step({ turnId: "t1", index: 0, model: "claude-opus-5-5" } as never) as any
  if (st[Symbol.asyncIterator]) { for await (const _ of st) {} } else await st
  let ui = await $.ui.mount(pane(60, 80))
  expect(await ui.find({ type: 'Text', text: /150\.0k\/1\.0M/ })).toBeTruthy()
  await ui.unmount()
  await $.session.measure({ context: { window: 1_000_000, percent: 20, tokens: 200_000 }, rateLimits: [] } as never)
  ui = await $.ui.mount(pane(60, 80))
  expect(await ui.find({ type: 'Text', text: /200\.0k\/1\.0M/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /150\.0k\/1\.0M/ })).toBeFalsy()
  await ui.unmount()
})

const NOON = new Date(2026, 5, 15, 12).getTime()
const DAY = 86_400_000

test('the Cost card footer has Today / 7d / avg labels and dashes with an empty ledger', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(pane(60, 80))
  expect(await ui.find({ type: 'Text', text: /Today\s*│\s*7d\s*│\s*avg/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /│\s+-\s+│\s*-\s*│\s*-\s*│/ })).toBeTruthy()
  await ui.unmount()
})

test('the Cost card splits Today from 7d, averages the 7d window and ignores older entries', async ($, on) => {
  engine(on)
  nowMs = NOON
  store.costs = {
    t1: { usd: 1, at: NOON - 1000 }, t2: { usd: 2, at: NOON - 2000 },
    w1: { usd: 3, at: NOON - 2 * DAY }, old: { usd: 50, at: NOON - 8 * DAY },
  }
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(pane(60, 120))
  // today 3, 7d 6, avg 2
  expect(await ui.find({ type: 'Text', text: /\$3\.00\s*│\$6\.00\s*│\$2\.00/ })).toBeTruthy()
  await ui.unmount()
})

test('the Cost card counts the current session with its live cost', async ($, on) => {
  engine(on)
  on('session.measure', () => ({ changed: [] }) as never)
  nowMs = NOON
  store.costs = { cur: { usd: 1, at: NOON - 1000 }, a: { usd: 2, at: NOON - 2000 } }
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 4 } } as never)
  const ui = await $.ui.mount(pane(60, 120))
  // cur overridden by 4: today 6, 7d 6, avg 3
  expect(await ui.find({ type: 'Text', text: /\$6\.00\s*│\$6\.00\s*│\$3\.00/ })).toBeTruthy()
  await ui.unmount()
})

test('the Cost card formats by size: 2 decimals, 1 from 100, 0 from 1000; values stay left-aligned', async ($, on) => {
  engine(on)
  nowMs = NOON
  store.costs = { a: { usd: 123.45, at: NOON - DAY }, b: { usd: 1111.05, at: NOON - 2 * DAY } }
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(pane(60, 120))
  // today -, 7d 1234.5 -> $1235, avg 617.25 -> $617.3
  expect(await ui.find({ type: 'Text', text: /\$1235\s*│\$617\.3/ })).toBeTruthy()
  await ui.unmount()
  store.costs = { a: { usd: 123.45, at: NOON - DAY } }
  const ui2 = await $.ui.mount(pane(60, 120))
  expect(await ui2.find({ type: 'Text', text: /\$123\.5\s*│\$123\.5/ })).toBeTruthy()
  await ui2.unmount()
})

test('the Cost card is 5 lines plus 2 borders, same height as Context in its row', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(pane(60, 80))
  expect((await ui.find({ key: 'kpi-cost' }))?.children).toHaveLength(7)
  expect((await ui.find({ key: 'kpi-context' }))?.children).toHaveLength(7)
  expect(await ui.find({ type: 'Text', text: /├─+┼─+┬─+┤/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /╰─+┴─+┴─+╯/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /╭─+┬─+╮/ })).toBeTruthy()
  await ui.unmount()
})

test('session.measure with a cost writes the current session to the ledger', async ($, on) => {
  engine(on)
  on('session.measure', () => ({ changed: [] }) as never)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 1.5 } } as never)
  expect((store.costs as any).cur.usd).toBe(1.5)
})

test('session.measure drops ledger entries older than 7 days', async ($, on) => {
  engine(on)
  on('session.measure', () => ({ changed: [] }) as never)
  nowMs = NOON
  store.costs = { old: { usd: 9, at: NOON - 8 * DAY }, keep: { usd: 2, at: NOON - 6 * DAY } }
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 1.5 } } as never)
  expect(Object.keys(store.costs as object).sort()).toEqual(['cur', 'keep'])
})

test('the main sprite is idle before any turn, and the task sprite uses the primary color', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__hud-session__progress', title: 'HUD tweak', total: 2, done: 0, phase: 'delegate' } as never)
  const ui = await $.ui.mount(pane(60))
  expect(((await ui.find({ key: 'lead-main' }))?.props.props as any).running).toBe(false)
  expect(((await ui.find({ key: 'sprite-task' }))?.props.props as any).color).toBe('#5D87FF')
  await ui.unmount()
})

test('each agent row has a sprite Client: running while working, not once done', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ turnId: 't', text: '', answer: '', agentId: 'a1' }) as never)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Explore repo', subagentType: 'Explore' })
  let ui = await $.ui.mount(pane(60))
  const sub = await ui.find({ key: 'sprite-a1' })
  expect(sub?.props.module).toMatch(/sprite\.tsx$/)
  expect((sub?.props.props as any).running).toBe(true)
  expect(await ui.find({ key: 'sprite-main' })).toBeFalsy()
  expect(await ui.find({ key: 'elapsed-main' })).toBeFalsy()
  expect((await ui.find({ key: 'lead-main' }))?.props.width).toBe(39)
  await ui.unmount()
  await $.turn.complete({ turnId: 't', agentId: 'a1', text: '', answer: '' } as never)
  ui = await $.ui.mount(pane(60))
  expect(((await ui.find({ key: 'sprite-a1' }))?.props.props as any).running).toBe(false)
  await ui.unmount()
})

test('task row has a task sprite Client: running while the flow is open, not once finished', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__hud-session__progress', title: 'HUD tweak', total: 2, done: 0, phase: 'delegate' } as never)
  let ui = await $.ui.mount(pane(60))
  let sp = await ui.find({ key: 'sprite-task' })
  expect((sp?.props.props as any).kind).toBe('task')
  expect((sp?.props.props as any).running).toBe(true)
  expect(sp?.props.width).toBe(5)
  await ui.unmount()
  await $.tool.call({ tool: 'mcp__hud-session__progress', done: 2, finished: true } as never)
  ui = await $.ui.mount(pane(60))
  sp = await ui.find({ key: 'sprite-task' })
  expect((sp?.props.props as any).running).toBe(false)
  await ui.unmount()
})

const FLOW = { tool: 'mcp__hud-session__progress' }

async function turnEngine($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  on('turn.start', () => ({ turnId: 't' }) as never)
  on('turn.complete', () => ({ turnId: 't', text: '', answer: '' }) as never)
  on('turn.step', async function* () { return { turnId: 't', index: 0, answer: '', toolUses: [], usage: { model: 'claude-sonnet-5-5', input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } } as never })
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
}

async function seen($: Parameters<Parameters<typeof test>[1]>[0], re: RegExp) {
  const ui = await $.ui.mount(pane(60, 100))
  const r = await ui.find({ type: 'Text', text: re })
  await ui.unmount()
  return !!r
}

test('a new main turn.start clears finished subagents; one spawned afterwards shows', async ($, on) => {
  await turnEngine($, on)
  await $.turn.start({ turnId: 't', text: 'hi' } as never)
  await $.agent.spawn({ prompt: 'x', description: 'Explore repo', subagentType: 'Explore' })
  await $.turn.complete({ turnId: 't', agentId: 'a1', text: '', answer: '' } as never)
  expect(await seen($, /Explore/)).toBe(true)
  await $.turn.start({ turnId: 't', text: 'hi' } as never)
  expect(await seen($, /Explore/)).toBe(false)
  await $.agent.spawn({ prompt: 'x', description: 'Fix bug', subagentType: 'Explore' })
  expect(await seen($, /Fix bug/)).toBe(true)
})

test('a new main turn.start shows started at and no finished at after a completed turn', async ($, on) => {
  await turnEngine($, on)
  await $.turn.start({ turnId: 't', text: 'hi' } as never)
  await $.turn.complete({ turnId: 't', text: '', answer: '' } as never)
  expect(await seen($, /finished at/)).toBe(true)
  await $.turn.start({ turnId: 't', text: 'hi' } as never)
  expect(await seen($, /started at \d\d:\d\d:\d\d/)).toBe(true)
  expect(await seen($, /finished at/)).toBe(false)
})

test('the main row has one lead Client: idle, then running since the typed turn, then done with until', async ($, on) => {
  await turnEngine($, on)
  let ui = await $.ui.mount(pane(60, 100))
  let el = await ui.find({ key: 'lead-main' })
  expect(el?.props.module).toMatch(/lead\.tsx$/)
  expect(el?.props.width).toBe(39)
  expect((el?.props.props as any).since).toBeUndefined()
  expect((el?.props.props as any).running).toBe(false)
  await ui.unmount()
  nowMs = 5000
  await $.turn.start({ turnId: 't', text: 'Fix the login bug' } as never)
  ui = await $.ui.mount(pane(60, 100))
  el = await ui.find({ key: 'lead-main' })
  expect((el?.props.props as any).running).toBe(true)
  expect((el?.props.props as any).since).toBe(5000)
  expect(await ui.find({ type: 'Text', text: /Fix the login bug/ })).toBeFalsy()
  await ui.unmount()
  nowMs = 46000
  await $.turn.complete({ turnId: 't', text: '', answer: '' } as never)
  ui = await $.ui.mount(pane(60, 100))
  el = await ui.find({ key: 'lead-main' })
  expect((el?.props.props as any).running).toBe(false)
  expect((el?.props.props as any).until).toBe(46000)
  await ui.unmount()
})

test('lead fmt: M:SS under an hour, H:MM:SS from one hour', async () => {
  expect(fmt(12_000)).toBe('0:12')
  expect(fmt(41_000)).toBe('0:41')
  expect(fmt(3_723_000)).toBe('1:02:03')
})

test('turn.start clears a finished flow and keeps an open one', async ($, on) => {
  await turnEngine($, on)
  await $.tool.call({ ...FLOW, title: 'HUD tweak', total: 2, done: 0, phase: 'delegate' } as never)
  await $.turn.start({ turnId: 't', text: 'hi' } as never)
  expect(await seen($, /HUD tweak/)).toBe(true)
  await $.tool.call({ ...FLOW, done: 2, finished: true } as never)
  await $.turn.start({ turnId: 't', text: 'hi' } as never)
  expect(await seen($, /HUD tweak/)).toBe(false)
  expect(await seen($, /current task/)).toBe(true)
})

test('a turn.step from an unknown agent id adds no row', async ($, on) => {
  await turnEngine($, on)
  const st = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', agentId: 'ghost' } as never) as any
  if (st[Symbol.asyncIterator]) { for await (const _ of st) {} } else await st
  const ui = await $.ui.mount(pane(60))
  expect(await ui.find({ key: 'sprite-ghost' })).toBeFalsy()
  await ui.unmount()
})

test('a continuation turn.start (empty text) keeps a finished subagent and the start time', async ($, on) => {
  await turnEngine($, on)
  await $.turn.start({ turnId: 't', text: 'hi' } as never)
  await $.agent.spawn({ prompt: 'x', description: 'Explore repo', subagentType: 'Explore' })
  await $.turn.complete({ turnId: 't', agentId: 'a1', text: '', answer: '' } as never)
  nowMs = 3_600_000
  const before = await seenText($, /started at \d\d:\d\d:\d\d/)
  await $.turn.start({ turnId: 't', text: '' } as never)
  expect(await seen($, /Explore/)).toBe(true)
  expect(await seenText($, /started at \d\d:\d\d:\d\d/)).toBe(before)
  expect(before).toBeTruthy()
})

async function seenText($: Parameters<Parameters<typeof test>[1]>[0], re: RegExp) {
  const ui = await $.ui.mount(pane(60, 100))
  const r = await ui.find({ type: 'Text', text: re })
  await ui.unmount()
  return r?.text.match(re)?.[0]
}

test('a path under HOME shows as ~', async ($, on) => {
  engine(on, undefined, undefined, '/home/t/dados/app')
  await $.session.start({ cwd: '/home/t/dados/app', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(pane(60, 80))
  expect(await ui.find({ type: 'Text', text: /^~\/dados\/app$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\/home\/t/ })).toBeFalsy()
  await ui.unmount()
})

let stepUsage: object = {}
// registers the turn.step answer (must precede the first `$` call), then fires one step
function cacheEngine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  engine(on)
  on('turn.step', async function* () { return { turnId: 't', index: 0, answer: '', toolUses: [], usage: stepUsage } as never })
}
async function cacheStep($: Parameters<Parameters<typeof test>[1]>[0], usage: object, agentId?: string) {
  stepUsage = usage
  const st = $.turn.step({ turnId: 't', index: 0, model: 'x', ...(agentId ? { agentId } : {}) } as never) as any
  if (st[Symbol.asyncIterator]) { for await (const _ of st) {} } else await st
}
const U = (model: string, read: number, write: number) => ({ model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: write })

test('the Cost card is labeled Cost and splits a Cache column from it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(pane(60, 80))
  expect(await ui.find({ type: 'Text', text: /^│ Cost\s*│Cache\s*│$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Current Cost/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^│ -\s*│-\s*│$/ })).toBeTruthy()
  await ui.unmount()
})

test('cache spend sums reads at the read price and writes at 2x input; reset counts down from the last response', async ($, on) => {
  cacheEngine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  // opus 5.5: read $0.20, write $8.00 per MTok
  await cacheStep($, U('claude-opus-5-5', 1_000_000, 1_000_000))
  nowMs = 60_000
  let ui = await $.ui.mount(pane(60, 80))
  expect(await ui.find({ type: 'Text', text: /59m \$8\.20/ })).toBeTruthy()
  await ui.unmount()
  nowMs = 3_600_000 + 60_000
  ui = await $.ui.mount(pane(60, 80))
  expect(await ui.find({ type: 'Text', text: /cold \$8\.20/ })).toBeTruthy()
  await ui.unmount()
})

test('a subagent response adds to the cache spend but does not refresh the reset', async ($, on) => {
  cacheEngine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await cacheStep($, U('claude-opus-5-5', 1_000_000, 0))
  nowMs = 120_000
  await cacheStep($, U('claude-opus-5-5', 1_000_000, 0), 'ghost')
  const ui = await $.ui.mount(pane(60, 80))
  expect(await ui.find({ type: 'Text', text: /58m \$0\.40/ })).toBeTruthy()
  await ui.unmount()
})

test('an unknown model adds nothing to the cache spend', async ($, on) => {
  cacheEngine(on)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  await cacheStep($, U('claude-unknown-9', 1_000_000, 1_000_000))
  const ui = await $.ui.mount(pane(60, 80))
  expect(await ui.find({ type: 'Text', text: /^│ -\s*│-\s*│$/ })).toBeTruthy()
  await ui.unmount()
})

test('an injected <agent-message> turn keeps the start time and the Agents box', async ($, on) => {
  engine(on)
  on('turn.start', () => ({ turnId: 't' }) as never)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  nowMs = 7000
  await $.turn.start({ turnId: 't1', text: 'Fix the login bug' } as never)
  nowMs = 9000
  await $.turn.start({ turnId: 't2', text: '<agent-message from="a1">done</agent-message>' } as never)
  const ui = await $.ui.mount(pane(100, 80))
  expect(await ui.find({ type: 'Text', text: /agent-message/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^\s*AGENT/ })).toBeTruthy()
  expect((((await ui.find({ key: 'lead-main' }))?.props.props) as any).since).toBe(7000)
  await ui.unmount()
})

// total cells of a row: string lengths plus Client widths
const width = (n: any): number => (typeof n === 'string' ? n.length : n.type === 'Client' ? n.props.width : (n.children ?? []).reduce((a: number, c: any) => a + width(c), 0))

for (const cols of [100, 60]) {
  test(`main row is as wide as a subagent row at pane width ${cols}`, async ($, on) => {
    engine(on)
    on('turn.start', () => ({ turnId: 't' }) as never)
    await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
    await $.turn.start({ turnId: 't1', text: 'Fix' } as never)
    await $.agent.spawn({ prompt: 'x', description: 'Explore repo', subagentType: 'Explore' })
    const ui = await $.ui.mount(pane(100, cols))
    const boxes = await ui.findAll({ type: 'Box' })
    await ui.unmount()
    const rows = boxes.filter(b => b.children.some((c: any) => typeof c !== 'string' && /^(sprite|lead)-(?!task)/.test(String(c.props?.key)))).map(width)
    expect(rows.length).toBe(2)
    expect(rows[0]).toBe(rows[1])
  })
}

async function turnOf($: Parameters<Parameters<typeof test>[1]>[0]) {
  const ui = await $.ui.mount(pane(60, 100))
  const r = await ui.find({ key: 'lead-main' })
  await ui.unmount()
  return (r?.props.props as any).turn as number | undefined
}

test('turn counter: turn N after typed prompts, unchanged by continuations', async ($, on) => {
  engine(on)
  on('turn.start', () => ({ turnId: 't' }) as never)
  await $.session.start({ cwd: '/repo/demo', surface: 'terminal', isInteractive: true })
  expect(await turnOf($)).toBeUndefined()
  await $.turn.start({ turnId: 't1', text: 'one' } as never)
  expect(await turnOf($)).toBe(1)
  await $.turn.start({ turnId: 't2', text: 'two' } as never)
  expect(await turnOf($)).toBe(2)
  await $.turn.start({ turnId: 't3', text: '<agent-message from="a1">x</agent-message>' } as never)
  expect(await turnOf($)).toBe(2)
  await $.turn.start({ turnId: 't4', text: '' } as never)
  expect(await turnOf($)).toBe(2)
})
