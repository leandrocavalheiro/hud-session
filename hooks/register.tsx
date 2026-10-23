import { atom, read, update } from 'claude-code'
import type { HookFor, Register, RenderInput } from 'claude-code'

type Ctx = Parameters<HookFor<'session.start'>>[0]

import type { AgentUsage, Flow, Usage } from '../types'

const usage = atom({ plugin: 'hud-session', key: 'usage' } as const, null)
const agents = atom({ plugin: 'hud-session', key: 'agents' } as const, {} as Record<string, AgentUsage>)
// effort of the main loop's last request; null until the first one
const effort = atom({ plugin: 'hud-session', key: 'effort' } as const, null as string | null)
// context tokens at the end of the main loop's last turns, oldest first
const turns = atom({ plugin: 'hud-session', key: 'turns' } as const, [] as number[])
// true once the user sends a new prompt: the shown agents belong to the previous request
const stale = atom({ plugin: 'hud-session', key: 'stale' } as const, false)
// the main session's task progress (set by the `progress` tool); null until the first call
const flow = atom({ plugin: 'hud-session', key: 'flow' } as const, null as Flow | null)
const PANE = 'hud-session'
const PHASES = ['plan', 'design', 'delegate', 'review', 'close']
const HISTORY = 12
// box borders and dividers share one discreet color
const LINE = '#3b4252'
// box titles and "Vazio": a gray that still reads on the dark background
const MUTED = '#a3abb8'
const BARS = '▁▂▃▄▅▆▇█'

// bars scale to the busiest turn shown, so growth shows at any fill level
function sparkline(t: number[]): string {
  const top = Math.max(...t, 1)
  return t.map(n => BARS[Math.min(BARS.length - 1, Math.floor((n / top) * (BARS.length - 1)))]).join('')
}

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
// Nerd Font glyphs (the terminal uses FiraCode Nerd Font; Lucide has no terminal font)
const ICON = {
  model: '\u{F06A9}', // md-robot
  git: '\u{E725}', // dev-git_branch
  memory: '\u{F09D1}', // md-brain
  ponytail: '\u{F15BF}', // md-horse
  graphify: '\u{F1049}', // md-graph
  plugin: '\u{F0431}', // md-puzzle
  mcp: '\u{F048D}', // md-server_network
}
const BAR = 10
// subagent briefing: models skip reporting phrased as a condition, so it goes in the prompt itself
const STEP_BRIEF = '\n\nProgress reporting: before any other work, call `mcp__hud-session__step` with `total` (your plan in 3-8 steps) and `done: 0`; call it again with `done` and a few-word `note` as each step finishes. It only draws a progress bar.'
const PALETTE = ['#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#d19a66']
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

// claude-opus-5-5[1m] -> Opus 5.5
function modelName(id: string): string {
  const m = id.replace(/\[.*\]$/, '').match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?\b/)
  if (!m) return id
  const [, family = '', major, minor] = m
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}

function resetIn(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const min = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  return ` (resets ${d ? `${d}d` : ''}${h}h${String(min % 60).padStart(2, '0')}m)`
}

// epoch ms -> 14:05, in the machine's local time
function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// verde < 25% · azul < 50% · amarelo < 75% · vermelho daí pra cima
function usedColor(pct: number): string {
  return pct < 25 ? 'green' : pct < 50 ? 'blue' : pct < 75 ? 'yellow' : 'red'
}

// 950 · 1.6k · 10.0k · 1.0M · 1.5M
function kTokens(n: number): string {
  const fmt = (v: number, unit: string) => `${v.toFixed(1)}${unit}`
  return n >= 1e6 ? fmt(n / 1e6, 'M') : n >= 1000 ? fmt(n / 1000, 'k') : String(n)
}

// everything the boxes show, gathered once per draw; `cols` is the drawing site's own width (band or pane)
async function gather($: Ctx, e: RenderInput, cols: number) {
  const [u0, running, model, root, now, tools, commands, home, think, hist, fl] = await Promise.all([
    read($, usage), read($, agents), $.session.model(), $.session.root(), $.clock.now(),
    $.tool.list(), $.command.list(), $.env.get('HOME'), read($, effort), read($, turns), read($, flow),
  ])
  const u = u0 ?? (await $.session.usage())
  // before the first turn.step: the /config effort row, then the settings.json key, else 'default'
  const effortDefault = think ?? await $.config.list()
    .then(r => { const v = r.find(x => /effort/i.test(x.key))?.value; return typeof v === 'string' && v ? v : null }, () => null)
    ?? await $.settings.read({ key: 'effortLevel' }).then(v => (typeof v === 'string' && v ? v : null), () => null)
    ?? 'default'
  const branch = await $.process.run(['git', 'branch', '--show-current'], { cwd: root })
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : ''), () => '')
  const level = await $.fs.read(`${home}/.claude/.ponytail-active`).then(s => s.trim(), () => 'off')
  // settings.json is read once: enabledPlugins for the plugin tags, the text for the hooks check
  const settingsText = await $.fs.read(`${home}/.claude/settings.json`).catch(() => '')
  const plugins: Record<string, boolean> = (() => { try { return JSON.parse(settingsText).enabledPlugins ?? {} } catch { return {} } })()
  // Orca já reescreveu o settings.json e apagou estes hooks: MCP on + hooks fora = amarelo
  const aiMemoryHooks = /ai-memory.*hook --event/.test(settingsText)
  // mcp__<server>__<tool>; hud-session is this mod's own server
  const mcpServers = [...new Set(tools.map(t => t.name.startsWith('mcp__') ? t.name.split('__')[1] : undefined))]
    .filter((s): s is string => !!s && s !== 'hud-session')
  const graphify = commands.some(c => c.name.includes('graphify'))

  const { Box, Text } = $.ui.resolve(e)
  const sep = <Text dimColor> | </Text>
  // each meter carries its width (`w`, in cells) so the session box wraps them like the tags
  const bar = (label: string, raw: number, tail = '') => {
    // over the limit reads 100%, nothing (or garbage) reads 0%
    const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0
    return {
      el: (
        <Text>
          <Text bold>{label} </Text>
          <Text color={usedColor(pct)}>{'█'.repeat(Math.round((pct / 100) * BAR))}</Text>
          <Text dimColor>{'░'.repeat(BAR - Math.round((pct / 100) * BAR))}</Text>
          <Text color={usedColor(pct)}> {Math.round(pct)}%</Text>
          <Text dimColor>{tail}</Text>
        </Text>
      ),
      w: label.length + 1 + BAR + 2 + String(Math.round(pct)).length + tail.length,
    }
  }
  const t = hist ?? []
  const delta = t.length > 1 ? t[t.length - 1]! - t[t.length - 2]! : 0
  const deltaText = delta ? ` ${delta > 0 ? `▲ +${kTokens(delta)}` : `▼ ${kTokens(-delta)}`}` : ''
  const lastTurns = {
    el: (
      <Text>
        <Text bold>last turns </Text>
        <Text color="yellow">{sparkline(t)}</Text>
        {deltaText ? <Text dimColor>{deltaText}</Text> : null}
      </Text>
    ),
    w: 11 + t.length + deltaText.length,
  }
  const cost = u.cost ? `$${u.cost.usd.toFixed(2)}` : ''
  // no percent yet: still draw it at 0% so the layout never shifts
  const ctxBar = bar('current context', u.context.percent ?? 0, u.context.percent != null && u.context.tokens != null ? ` ${kTokens(u.context.tokens)}/${kTokens(u.context.window)}` : ` 0.0k${u.context.window ? `/${kTokens(u.context.window)}` : ''}`)
  // 5h and 7d always drawn (0% until the session reports them), then any other kind reported
  const meters = [...Object.keys(LABEL), ...u.rateLimits.map(l => l.kind).filter(k => !(k in LABEL))].map(kind => {
    const l = u.rateLimits.find(x => x.kind === kind)
    return bar(LABEL[kind] ?? kind, l?.percentUsed ?? 0, resetIn(l?.resetsAt, now))
  })
  // the model line: model, then the session cost and the last turns
  const modelText = modelName(model)
  const modelLine = [
    { el: <Text><Text color="cyan">{ICON.model} {modelText}</Text><Text dimColor> (thinking: {effortDefault})</Text></Text>, w: 2 + modelText.length + 12 + effortDefault.length },
    ...(cost ? [{ el: <Text><Text bold>sessão </Text><Text dimColor>{cost}</Text></Text>, w: 7 + cost.length }] : []),
    ...(t.length ? [lastTurns] : []),
  ]
  // `w`: cells it takes (the Nerd Font glyph counts as one), for wrapping the hand-drawn boxes
  const tag = (ok: boolean, icon: string, label: string, warn = false) => ({
    el: <Text>{icon} <Text color={!ok ? 'red' : warn ? 'yellow' : 'green'}>{label}</Text></Text>,
    w: label.length + 2,
  })
  // ponytail also needs its level on; other plugins are just enabled or not
  const pluginTags = Object.entries(plugins).flatMap(([key, enabled]) => {
    const name = key.split('@')[0]!
    if (name === 'hud-session') return [] // this mod itself
    return [name === 'ponytail' ? tag(enabled && level !== 'off', ICON.ponytail, `ponytail(${level})`) : tag(enabled, ICON.plugin, name)]
  })
  const mcpTags = mcpServers.map(s => /^ai[-_]memory$/.test(s)
    ? tag(true, ICON.memory, aiMemoryHooks ? 'ai-memory' : 'ai-memory (sem hooks)', !aiMemoryHooks)
    : tag(true, ICON.mcp, s.replace(/^claude_ai_/, '').replace(/_/g, ' ')))

  const all = Object.entries(running ?? {})
  const finished = all.filter(([, a]) => a.status === 'done').length
  // a finished flow stays drawn (full) until the next one starts
  const fOn = fl
  const taskPct = fOn ? (fOn.finished ? 1 : fOn.total ? Math.min(1, fOn.done / fOn.total) : 0) : all.length ? finished / all.length : 0
  const miniBar = (frac: number, color: string) => {
    const n = Math.round(Math.max(0, Math.min(1, frac)) * 12)
    return <Text><Text color={color}>{'█'.repeat(n)}</Text><Text dimColor>{'░'.repeat(12 - n)}</Text></Text>
  }
  // the flow's own times; without a flow, the first agent's start and, once all are done, the last one's end
  const starts = all.map(([, a]) => a.startedAt).filter((v): v is number => v != null)
  const ends = all.map(([, a]) => a.finishedAt).filter((v): v is number => v != null)
  const startedAt = fOn?.startedAt ?? (starts.length ? Math.min(...starts) : undefined)
  const finishedAt = fOn ? fOn.finishedAt : all.length && finished === all.length && ends.length ? Math.max(...ends) : undefined
  const taskRow = fOn || all.length ? (
    <Text>
      <Text color="cyan">{fOn?.title || 'current task'} </Text>{miniBar(taskPct, 'cyan')}<Text color="cyan"> {Math.round(taskPct * 100)}%</Text>
      {fOn ? <Text dimColor>  {fOn.phase}</Text> : null}
      {startedAt != null ? <Text dimColor>  started at {clock(startedAt)}</Text> : null}
      {finishedAt != null ? <Text dimColor>  finished at {clock(finishedAt)}</Text> : null}
    </Text>
  ) : null
  const sorted = [...all].sort(([, a], [, b]) => Number(a.status === 'done') - Number(b.status === 'done'))
  const agentRow = ([id, a]: [string, AgentUsage]) => {
    const done = a.status === 'done'
    const name = a.label ?? a.kind ?? id
    const seed = a.kind ?? name
    const badge = done ? '✓' : (name.charAt(0).toUpperCase() || '?')
    const frac = done ? 1 : a.step?.total ? a.step.done / a.step.total : u.context.window ? a.tokens / u.context.window : 0
    const indeterminate = !done && !a.step?.total && !u.context.window
    return (
      <Text key={id}>
        <Text backgroundColor={done ? 'green' : PALETTE[hash(seed) % PALETTE.length]} color="black" bold> {badge} </Text>
        <Text> {fit(name, Math.max(8, Math.floor((cols - 4) / 4)))}  </Text>
        <Text dimColor>[{modelName(a.model)}] {a.effort ?? '-'}  </Text>
        {indeterminate ? <Text dimColor>{'░'.repeat(12)}</Text> : miniBar(frac, done ? 'green' : usedColor(frac * 100))}
        <Text dimColor> {kTokens(a.tokens)}</Text>
      </Text>
    )
  }
  // inner width: site less 2 borders and 2 padding cells; also stretches each box to the full site
  const divider = <Text color={LINE}>{'─'.repeat(Math.max(0, cols - 4))}</Text>
  // agents box without its agent lines: top and bottom lines + the task row, or the "Vazio" one
  const agentsRows = taskRow || !all.length ? 3 : 2
  // items split into lines of the inner width (site less "│ " and " │"); " | " between items is 3 cells
  const wrapLines = (items: ReturnType<typeof tag>[]) => items.reduce<ReturnType<typeof tag>[][]>((ls, it) => {
    const last = ls[ls.length - 1]
    const used = last ? last.reduce((s, x) => s + x.w, 0) + 3 * (last.length - 1) : 0
    if (last && used + 3 + it.w <= cols - 4) last.push(it)
    else ls.push([it])
    return ls
  }, [])
  // frame drawn by hand: a Box border has no title, and an absolute title on it is not painted
  // one line per row; no rows draws `empty` centered
  const frame = (title: string, rows: ReturnType<typeof Text>[], empty = 'Vazio') => (
    <Box flexDirection="column">
      <Text color={LINE}>╭─ <Text color={MUTED} bold>{title}</Text> {'─'.repeat(Math.max(0, cols - 5 - title.length))}╮</Text>
      {(rows.length ? rows : [<Text color={MUTED}>{empty}</Text>]).map(r => (
        <Box>
          <Text color={LINE}>│ </Text>
          <Box flexGrow={1} justifyContent={rows.length ? 'flex-start' : 'center'}>{r}</Box>
          <Text color={LINE}> │</Text>
        </Box>
      ))}
      <Text color={LINE}>╰{'─'.repeat(Math.max(0, cols - 2))}╯</Text>
    </Box>
  )
  const joined = (items: ReturnType<typeof tag>[]) =>
    wrapLines(items).map(l => <Text wrap="truncate-end">{l.flatMap((p, i) => (i ? [sep, p.el] : [p.el]))}</Text>)
  const listBox = (title: string, items: ReturnType<typeof tag>[]) => frame(title, joined(items))
  // model line(s) | context alone | rate limits, a divider between each, inside the top and bottom lines
  const sessionBox = frame('Session', [
    ...joined(modelLine), divider, ...joined([ctxBar]), divider, ...joined(meters),
  ])
  const sessionRows = 5 + wrapLines(modelLine).length + wrapLines(meters).length
  const pathBox = frame('Path', [
    <Text wrap="truncate-end">
      <Text color="white">{root}</Text>
      {branch ? <Text><Text color="#f05032"> {ICON.git} </Text><Text color="#3fb950" bold>{branch}</Text></Text> : null}
    </Text>,
  ])
  const pathRows = 3
  const lists: [string, ReturnType<typeof tag>[]][] = [
    ['Plugins', pluginTags], ['Skills', [tag(graphify, ICON.graphify, 'graphify')]], ['MCP', mcpTags],
  ]
  const tagsBox = <Box flexDirection="column">{lists.map(([t, it]) => listBox(t, it))}</Box>
  // each box: its lines (at least the "Vazio" one) + top and bottom lines
  const tagsRows = lists.reduce((s, [, it]) => s + 2 + Math.max(1, wrapLines(it).length), 0)
  // `room` = rows left for agent lines
  const agentsBox = (room: number) => {
    // each agent line (and the "+N" one) takes 2 rows: its separator above it and itself
    const cap = Math.floor(room / 2)
    const shown = sorted.length > cap ? sorted.slice(0, Math.max(0, cap - 1)) : sorted
    const hidden = sorted.length - shown.length
    // rows truncate, so a long one never breaks the frame
    const rows = [
      ...(taskRow ? [taskRow] : []),
      ...shown.map(agentRow),
      ...(hidden ? [<Text dimColor>+{hidden}</Text>] : []),
    ].map(r => <Text wrap="truncate-end">{r}</Text>)
    return frame('Agents', rows.flatMap((r, i) => (i ? [divider, r] : [r])), 'no task')
  }
  // every box in its order; `rows` = rows taken before the agent lines
  const boxes = (room: number) => (
    <Box flexDirection="column">{sessionBox}{tagsBox}{pathBox}{agentsBox(room)}</Box>
  )
  return { boxes, rows: sessionRows + tagsRows + pathRows + agentsRows }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'progress',
      description:
        'Report task progress to the progress line above the prompt. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value. ' +
        'For the main session only: a call from a subagent is ignored (workers report with `step`).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: PHASES },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          tasks: {
            type: 'array',
            description: 'The planned worker tasks in order, numbered from 1 (accepted, not displayed).',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                tier: { type: 'string' },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title', 'tier'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      // in every agent's tool list: workers do not go looking for it
      isDeferred: false,
    })
    await $.command.register({ name: 'hud-session', description: 'Reabre o painel lateral do HudSession' })
    void $.ui.open({ id: PANE, title: 'HudSession' })
    return started
  })

  on('command.run', { command: 'hud-session' }, async $ => {
    await $.ui.open({ id: PANE, title: 'HudSession' })
    return { text: 'Painel do HudSession aberto.' }
  })

  on('tool.call', { tool: /^mcp__hud-session__progress$/ }, async ($, e) => {
    // the flow is the main session's: a subagent's call carries its agentId and changes nothing
    if (e.agentId) return { result: 'ignored: only the main session reports the flow' }
    const i = e as unknown as Partial<Flow>
    const num = (v: unknown, d: number) => (typeof v === 'number' ? Math.max(0, Math.round(v)) : d)
    const now = await $.clock.now()
    const next = await update($, flow, p => {
      // a new title starts a fresh flow
      const b: Flow = p && !p.finished && (i.title === undefined || i.title === p.title) ? p : { title: '', phase: 'plan', done: 0, total: 0, finished: false, startedAt: now }
      const finished = typeof i.finished === 'boolean' ? i.finished : b.finished
      return {
        title: i.title?.trim() || b.title, phase: PHASES.includes(i.phase as string) ? i.phase! : b.phase,
        done: num(i.done, b.done), total: num(i.total, b.total), finished,
        startedAt: b.startedAt ?? now, ...(finished ? { finishedAt: b.finishedAt ?? now } : {}),
      }
    })
    return { result: `ok: ${next?.title} ${next?.done}/${next?.total}` }
  })

  // a worker's own progress: the call runs in the worker's loop, so agentId names it
  on('tool.call', { tool: /^mcp__hud-session__step$/ }, async ($, e) => {
    const id = e.agentId
    if (!id) return { result: 'ignored: only subagents report steps' }
    const i = e as unknown as { done?: number; total?: number; note?: string }
    let matched = false
    await update($, agents, a => {
      const cur = a?.[id]
      if (!cur) return a ?? {}
      matched = true
      const total = Math.max(0, Math.round(i.total ?? cur.step?.total ?? 0))
      const done = Math.max(0, Math.round(i.done ?? cur.step?.done ?? 0))
      return { ...a, [id]: { ...cur, step: { done: total ? Math.min(total, done) : done, total, note: i.note?.trim() || undefined } } }
    })
    return { result: matched ? 'ok' : `ignored: no panel row for agent ${id}` }
  })

  on('turn.complete', async ($, e, next) => {
    // finished agents stay in the panel until the next main-loop turn starts
    if (e.agentId) {
      const at = await $.clock.now()
      await update($, agents, a => (a?.[e.agentId!] ? { ...a, [e.agentId!]: { ...a[e.agentId!]!, status: 'done' as const, finishedAt: at } } : a ?? {}))
    }
    else {
      const tokens = await $.session.usage().then(s => s.context.tokens, () => undefined)
      if (tokens) await update($, turns, t => [...(t ?? []), tokens].slice(-HISTORY)).catch(() => {})
      $.ui.invalidate('ui.render') // ponytail level, MCPs and branch may have changed
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const u: Usage = { context: e.context, rateLimits: e.rateLimits, cost: e.cost }
    await update($, usage, () => u)
    return next(e)
  })

  // a new main-loop turn (the user's next prompt) only marks the batch stale: it stays on screen for review
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await update($, stale, () => true).catch(() => {})
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e.prompt.includes('mcp__hud-session__step') ? e : { ...e, prompt: e.prompt + STEP_BRIEF })
    if ('agentId' in r && r.agentId) {
      const id = r.agentId
      // the first agent of a new request replaces the stale batch; background agents still running stay
      if (await read($, stale)) {
        await update($, stale, () => false).catch(() => {})
        await update($, agents, a => Object.fromEntries(Object.entries(a ?? {}).filter(([, v]) => v.status !== 'done'))).catch(() => {})
      }
      // a failed write must never fail the spawn itself
      const at = await $.clock.now().catch(() => undefined)
      await update($, agents, a => ({ ...a, [id]: { model: r.model, tokens: 0, status: 'running' as const, label: e.name ?? e.description ?? e.subagentType, kind: e.subagentType, startedAt: at } })).catch(() => {})
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const eff = e.effort === undefined ? 'none' : String(e.effort)
    if (!e.agentId) await update($, effort, () => eff).catch(() => {})
    const r = yield* next(e)
    const u = 'usage' in r ? r.usage : null
    if (e.agentId && u) {
      const id = e.agentId
      // the agent's live context: everything the last response was answered over, plus what it wrote
      const tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
      await update($, agents, a => ({ ...a, [id]: { ...a?.[id], model: u.model, tokens, effort: eff, status: 'running' as const } }))
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Stack other mods' bands below the HUD; Claude Code's own placeholder ({ type: 'engine' }) is never nested.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    // every box lives in the pane; they come back to the band while the pane is not placed (narrow terminal, closed)
    const inBand = !(await $.ui.panes().then(ps => ps.some(p => p.id === PANE && p.isPlaced), () => false))
    if (!inBand) return drawn
    const g = await gather($, e, e.props.bodyColumns)
    const { Box } = $.ui.resolve(e)
    // rows left for agent lines, under every box and any band below
    const room = Math.max(0, e.props.maxRows - g.rows - (below ? 1 : 0))

    return (
      <Box flexDirection="column">
        {g.boxes(room)}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const g = await gather($, e, e.props.bodyColumns)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor={LINE} justifyContent="center">
          <Text color="cyan" bold>HudSession v1.0.0</Text>
        </Box>
        {/* the pane scrolls: every agent is drawn; only the band, which does not, trims them */}
        {g.boxes(Infinity)}
      </Box>
    )
  })
}
