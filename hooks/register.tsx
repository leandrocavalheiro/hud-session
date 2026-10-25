import { atom, read, update } from 'claude-code'
import type { HookFor, Register, RenderInput } from 'claude-code'

type Ctx = Parameters<HookFor<'session.start'>>[0]

import type { AgentUsage, Flow, Usage } from '../types'

// width of the main row's lead Client (hooks/lead.tsx): robot 5 + ` [Lead] ` 8 + `turn 99 · ` 10 + clock 16
const LEAD_W = 39

const usage = atom({ plugin: 'hud-session', key: 'usage' } as const, null)
const agents = atom({ plugin: 'hud-session', key: 'agents' } as const, {} as Record<string, AgentUsage>)
// effort of the main loop's last request; null until the first one
const effort = atom({ plugin: 'hud-session', key: 'effort' } as const, null as string | null)
// context tokens at the end of the main loop's last turns, oldest first
const turns = atom({ plugin: 'hud-session', key: 'turns' } as const, [] as number[])
// the main session's task progress (set by the `progress` tool); null until the first call
const flow = atom({ plugin: 'hud-session', key: 'flow' } as const, null as Flow | null)
// the main loop's own activity: running from turn.start to turn.complete; null until the first turn
const main = atom({ plugin: 'hud-session', key: 'main' } as const, null as { status: 'running' | 'done'; startedAt?: number; finishedAt?: number; turn?: number } | null)
// the main loop's context tokens from the last API response of the running turn; null once session.measure lands
const live = atom({ plugin: 'hud-session', key: 'live' } as const, null as number | null)
// prompt-cache spend in the session so far (every agent) and when the main loop last got a response; null until the first priced one
const cache = atom({ plugin: 'hud-session', key: 'cache' } as const, null as { usd: number; at: number } | null)
const PANE = 'hud-session'
// cost ledger kept in $.store (key COSTS): { [sessionId]: { usd, at } }, last 7 days, newest LEDGER entries
const COSTS = 'costs'
const LEDGER = 500
const DAY = 86_400_000
type Ledger = Record<string, { usd: number; at: number }>
// Claude Code's prompt-cache TTL for this setup (1h writes); not exposed to mods
const CACHE_TTL = 3_600_000
// $ per MTok by model id prefix, most specific first; a cache write costs 2x input (1h TTL)
const CACHE_PRICE: [string, { input: number; read: number }][] = [
  ['claude-fable-5-1', { input: 10, read: 0.25 }], ['claude-mythos-5-1', { input: 10, read: 0.25 }],
  ['claude-fable-5', { input: 10, read: 1 }], ['claude-mythos-5', { input: 10, read: 1 }],
  ['claude-opus-5-5', { input: 4, read: 0.2 }],
  ['claude-opus-5', { input: 5, read: 0.5 }], ['claude-opus-4', { input: 5, read: 0.5 }],
  ['claude-sonnet-5-5', { input: 2, read: 0.2 }], ['claude-sonnet-5', { input: 2, read: 0.2 }],
  ['claude-sonnet-4', { input: 3, read: 0.3 }],
  ['claude-haiku-5-5', { input: 0.1, read: 0.01 }],
  ['claude-haiku-4', { input: 1, read: 0.1 }],
]
const PHASES = ['plan', 'design', 'delegate', 'review', 'close']
const HISTORY = 12
// MaterialM dark palette; every color the pane draws comes from here
const THEME = { primary: '#5D87FF', secondary: '#49BEFF', success: '#13DEB9', warning: '#FFAE1F', error: '#FA896B', muted: '#7C8FAC', line: '#333F55', text: '#EAEFF4' }
// text on a filled chip/badge
const INK = '#1A2537'
// Braille dots per column, bottom to top: 4 height levels
const DOTS = [[0x40, 0x04, 0x02, 0x01], [0x80, 0x20, 0x10, 0x08]]

// one turn per cell, both Braille columns filled to the turn's height (1-4); bars scale to the busiest turn shown, a turn with tokens is never empty
// returns the filled cells and the empty slots (full-height, drawn gray) up to HISTORY
function sparkline(t: number[]): [string, string] {
  const last = t.slice(-HISTORY)
  const top = Math.max(...last, 1)
  const filled = last.map(n => {
    const h = n > 0 ? Math.max(1, Math.round((n / top) * 4)) : 0
    return String.fromCharCode(0x2800 + DOTS.reduce((m, col) => col.slice(0, h).reduce((x, d) => x | d, m), 0))
  }).join('')
  return [filled, '\u28FF'.repeat(HISTORY - last.length)]
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
// off: subagents report no steps, their bar falls back to token use; set true to ask them again
const ASK_STEPS = false
const STEP_BRIEF = '\n\nProgress reporting: before any other work, call `mcp__hud-session__step` with `total` (your plan in 3-8 steps) and `done: 0`; call it again with `done` and a few-word `note` as each step finishes. It only draws a progress bar.'
// agent role prefix from `subagentType name`, first match wins; numbered at spawn (Dev01, Dev02, QA01...)
const ROLES: [RegExp, string][] = [[/\bplan/, 'Plan'], [/\b(review|audit)/, 'Rev'], [/\b(test|qa\b|verif)/, 'QA'], [/\b(explor|investigat|research|search)/, 'Exp']]
const roleFor = (text: string, taken: AgentUsage[]) => {
  const prefix = ROLES.find(([re]) => re.test(text.toLowerCase()))?.[1] ?? 'Dev'
  return `${prefix}${String(1 + taken.filter(a => a.role?.startsWith(prefix) && /^\d\d$/.test(a.role.slice(prefix.length))).length).padStart(2, '0')}`
}
// context delta: whole units, no decimals, no sign (800, 3k, 1M); the color says up or down
const deltaLabel = (d: number) => {
  const a = Math.abs(d)
  return `${a >= 1e6 ? `${Math.round(a / 1e6)}M` : a >= 1000 ? `${Math.round(a / 1000)}k` : Math.round(a)}`
}
const BADGES = [THEME.primary, THEME.secondary, THEME.success, THEME.warning, THEME.error, '#8965E5', '#E58FD0']
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

// claude-opus-5-5[1m] -> Opus 5.5
function modelName(id: string): string {
  const m = id.replace(/\[.*\]$/, '').match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?\b/)
  if (!m) return id
  const [, family = '', major, minor] = m
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}

// time left on the prompt cache: 59m · 1h05m · cold; - before any response
function cacheLeft(at: number | undefined, now: number): string {
  if (at == null) return '-'
  const min = Math.round((at + CACHE_TTL - now) / 60000)
  return min <= 0 ? 'cold' : min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m` : `${min}m`
}

function resetIn(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const min = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  return `reset ${d ? `${d}d` : ''}${h}h${String(min % 60).padStart(2, '0')}m`
}

// epoch ms -> 14:05:09, in the machine's local time
function clock(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// green < 25% · blue < 50% · yellow < 75% · red above that
function usedColor(pct: number): string {
  return pct < 25 ? THEME.success : pct < 50 ? THEME.primary : pct < 75 ? THEME.warning : THEME.error
}

// 950 · 1.6k · 10.0k · 1.0M · 1.5M
function kTokens(n: number): string {
  const fmt = (v: number, unit: string) => `${v.toFixed(1)}${unit}`
  return n >= 1e6 ? fmt(n / 1e6, 'M') : n >= 1000 ? fmt(n / 1000, 'k') : String(n)
}

// everything the pane shows, gathered once per draw; `cols` is the pane's body width
async function gather($: Ctx, e: RenderInput, cols: number) {
  const [u0, running, model, root, now, tools, commands, home, think, hist, fl, mn, lv, ch] = await Promise.all([
    read($, usage), read($, agents), $.session.model(), $.session.root(), $.clock.now(),
    $.tool.list(), $.command.list(), $.env.get('HOME'), read($, effort), read($, turns), read($, flow), read($, main), read($, live), read($, cache),
  ])
  const sid = await $.session.id().catch(() => '')
  const ledger = ((await $.store.get(COSTS).catch(() => undefined)) ?? {}) as Ledger
  const u1 = u0 ?? (await $.session.usage())
  // cost footer: Today / 7d sums and the 7d mean per session; the live cost overrides the current ledger entry
  const entries = Object.entries(u1.cost ? { ...ledger, [sid]: { usd: u1.cost.usd, at: now } } : ledger).map(([, v]) => v)
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0)
  const wk = entries.filter(v => v.at >= now - 7 * DAY)
  const today = entries.filter(v => v.at >= midnight.getTime())
  const sum = (a: typeof wk) => a.reduce((t, v) => t + v.usd, 0)
  const foot = [
    { label: 'Today', usd: today.length ? sum(today) : undefined },
    { label: '7d', usd: wk.length ? sum(wk) : undefined },
    { label: 'avg', usd: wk.length ? sum(wk) / wk.length : undefined },
  ]
  // mid-turn the last response's size beats the stale measure; percent only when the window is known
  const u: Usage = lv == null ? u1 : { ...u1, context: { ...u1.context, tokens: lv, ...(u1.context.window ? { percent: lv / u1.context.window * 100 } : {}) } }
  // before the first turn.step: the /config effort row, then the settings.json key, else 'default'
  const effortDefault = think ?? await $.config.list()
    .then(r => { const v = r.find(x => /effort/i.test(x.key))?.value; return typeof v === 'string' && v ? v : null }, () => null)
    ?? await $.settings.read({ key: 'effortLevel' }).then(v => (typeof v === 'string' && v ? v : null), () => null)
    ?? 'default'
  const branch = await $.process.run(['git', 'branch', '--show-current'], { cwd: root })
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : ''), () => '')
  const level = await $.fs.read(`${home}/.claude/.ponytail-active`).then(s => s.trim(), () => 'off')
  // settings.json is read once: enabledPlugins for the plugin chips, the text for the hooks check
  const settingsText = await $.fs.read(`${home}/.claude/settings.json`).catch(() => '')
  const plugins: Record<string, boolean> = (() => { try { return JSON.parse(settingsText).enabledPlugins ?? {} } catch { return {} } })()
  // Orca already rewrote settings.json and wiped these hooks: MCP on + hooks gone = yellow
  const aiMemoryHooks = /ai-memory.*hook --event/.test(settingsText)
  // mcp__<server>__<tool>; hud-session is this mod's own server
  const mcpServers = [...new Set(tools.map(t => t.name.startsWith('mcp__') ? t.name.split('__')[1] : undefined))]
    .filter((s): s is string => !!s && s !== 'hud-session')
  const graphify = commands.some(c => c.name.includes('graphify'))

  const { Box, Text, Client } = $.ui.resolve(e)
  const inner = Math.max(0, cols - 4) // site less 2 borders and 2 padding cells
  // thin bar: filled in `color`, the rest in the line color
  const thin = (frac: number, n: number, color: string) => {
    const f = Math.round(Math.max(0, Math.min(1, frac)) * n)
    return <Text><Text color={color}>{'━'.repeat(f)}</Text><Text color={THEME.line}>{'━'.repeat(n - f)}</Text></Text>
  }

  // header: title, model + effort + branch, root path
  const modelText = modelName(model)
  const header = (
    <Box borderStyle="round" borderColor={THEME.line} flexDirection="column" alignItems="center">
      <Text color={THEME.primary} bold>HudSession</Text>
      <Text wrap="truncate-end">
        <Text color={THEME.primary}>{ICON.model} {modelText}</Text>
        <Text color={THEME.muted}>  effort: {effortDefault}</Text>
        {branch ? <Text color={THEME.success}>  {ICON.git} {branch}</Text> : null}
      </Text>
      <Text color={THEME.muted} wrap="truncate-end">{home && (root === home || root.startsWith(`${home}/`)) ? `~${root.slice(home.length)}` : root}</Text>
    </Box>
  )

  // KPI cards: label, value, bar, sub-line (+ the context's last turns); `pct` set draws the bar
  type Part = [string, { color?: string; bold?: boolean }?]
  type Card = { key: string; label: string; value: string; color: string; pct?: number; sub?: string; extra?: Part[]; foot?: { label: string; usd?: number }[]; money?: number; right?: { label: string; reset: string; usd?: number } }
  const t = hist ?? []
  const delta = t.length > 1 ? t[t.length - 1]! - t[t.length - 2]! : 0
  // over the limit reads 100%, nothing (or garbage) reads 0%
  const clamp = (raw: number) => (Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0)
  const ctxPct = clamp(u.context.percent ?? 0)
  const cards: Card[] = [
    { key: 'cost', label: 'Cost', value: '', money: u.cost?.usd, color: THEME.primary, foot, right: { label: 'Cache', reset: cacheLeft(ch?.at, now), usd: ch?.usd } },
    {
      key: 'context', label: 'Context', value: `${Math.round(ctxPct)}%`, color: usedColor(ctxPct), pct: ctxPct,
      // no percent yet: still draw it at 0% so the layout never shifts
      sub: `${u.context.percent != null && u.context.tokens != null ? `${kTokens(u.context.tokens)}/${kTokens(u.context.window)}` : `0.0k${u.context.window ? `/${kTokens(u.context.window)}` : ''}`}`,
      // always drawn (12 gray slots before the first turn) so the card never changes shape
      extra: [[sparkline(t)[0], { color: THEME.warning }], [sparkline(t)[1], { color: THEME.line }], ...(delta ? [[` ${deltaLabel(delta)}`, { color: delta > 0 ? THEME.error : THEME.success }]] : [])] as Part[],
    },
    // 5h and 7d always drawn (0% until the session reports them), then any other kind reported
    ...[...Object.keys(LABEL), ...u.rateLimits.map(l => l.kind).filter(k => !(k in LABEL))].map(kind => {
      const l = u.rateLimits.find(x => x.kind === kind)
      const p = clamp(l?.percentUsed ?? 0)
      return { key: kind, label: LABEL[kind] ?? kind, value: `${Math.round(p)}%`, color: usedColor(p), pct: p, sub: resetIn(l?.resetsAt, now) }
    }),
  ]
  const perRow = Math.min(cards.length, Math.max(1, Math.floor(cols / 18)))
  const rows: Card[][] = []
  for (let i = 0; i < cards.length; i += perRow) rows.push(cards.slice(i, i + perRow))
  const cardBox = (c: Card, w: number, height: number) => {
    const cw = Math.max(1, w - 4)
    const row = (parts: Part[]) => {
      const len = parts.reduce((s, [x]) => s + x.length, 0)
      return (
        <Text>
          <Text color={THEME.line}>│ </Text>
          {parts.map(([x, p]) => <Text {...p}>{x}</Text>)}
          {' '.repeat(Math.max(0, cw - len))}
          <Text color={THEME.line}> │</Text>
        </Text>
      )
    }
    // footer: 3 fixed columns + 2 separators fill cw exactly; the remainder goes to the first columns
    const base = Math.floor((cw - 2) / 3), rem = (cw - 2) % 3
    const ws = [0, 1, 2].map(i => base + (i < rem ? 1 : 0))
    // offsets of the 2 column separators inside the w-2 span between the corners
    const joints = c.foot ? [1 + ws[0]!, 2 + ws[0]! + ws[1]!] : []
    const rule = (l: string, js: string[], r: string) =>
      l + Array.from({ length: Math.max(0, w - 2) }, (_, i) => js[joints.indexOf(i)] ?? '─').join('') + r
    // >= 1000: 0 decimals, >= 100: 1, else 2; fewer decimals if it does not fit the column
    const usd = (v: number, n: number) => {
      let d = v >= 1000 ? 0 : v >= 100 ? 1 : 2
      while (d > 0 && `$${v.toFixed(d)}`.length > n) d--
      return `$${v.toFixed(d)}`
    }
    // sparkline: narrower than the 12 slots keeps the newest filled cells, then as many empty slots as fit
    // a delta part is kept whole: the cells give up room (oldest first) before it does
    const spark = c.extra ? (() => { const dp = c.extra[2], room = cw - (dp?.[0].length ?? 0), f = c.extra[0]![0].slice(-Math.max(0, room)); return [[f, c.extra[0]![1]], [c.extra[1]![0].slice(0, Math.max(0, room - f.length)), c.extra[1]![1]], ...(dp ? [dp] : [])] as Part[] })() : null
    const lines = [
      row([[fit(c.label, cw), { color: THEME.muted }]]),
      row([[fit(c.value, cw), { color: c.color, bold: true }]]),
      c.pct != null ? <Text><Text color={THEME.line}>│ </Text>{thin(c.pct / 100, cw, c.color)}<Text color={THEME.line}> │</Text></Text> : row([]),
      row([[fit(c.sub ?? '', cw), { color: THEME.muted }]]),
      ...(spark ? [row(spark)] : []),
    ]
    if (c.foot) {
      // centered like the labels
      const mid = (x: string, n: number) => `${' '.repeat(Math.max(0, Math.floor((n - x.length) / 2)))}${x}`.padEnd(n)
      const cols3 = (cell: (i: number) => Part): Part[] =>
        ws.flatMap((_, i) => (i ? [['│', { color: THEME.line }] as Part, cell(i)] : [cell(i)]))
      // top part split in two: left = footer column 1, right = columns 2 and 3 with their separator
      const rw = ws[1]! + 1 + ws[2]!
      const split = (l: Part, r: Part[]): Part[] => [[l[0].padEnd(ws[0]!), l[1]], ['│', { color: THEME.line }], ...r]
      const rt = c.right
      const rightVal: Part[] = rt?.usd == null
        ? [['-', { color: THEME.muted }]]
        : [[`${rt.reset} `, { color: THEME.muted }], [fit(usd(rt.usd, rw), Math.max(1, rw - rt.reset.length - 1)), { color: THEME.text }]]
      lines.splice(0, 2,
        row(split([fit(c.label, ws[0]!), { color: THEME.muted }], [[fit(rt?.label ?? '', rw), { color: THEME.muted }]])),
        row(split(
          c.money == null ? ['-', { color: THEME.muted }] : [fit(usd(c.money, ws[0]!), ws[0]!), { color: c.color, bold: true }],
          rightVal,
        )),
      )
      // the Cost card has no bar/sub line: divider + footer reuse those two slots and add one
      lines.splice(2, 2,
        <Text color={THEME.line}>{rule('├', ['┼', '┬'], '┤')}</Text>,
        row(cols3(i => [mid(c.foot![i]!.label, ws[i]!), { color: THEME.muted }])),
        row(cols3(i => { const v = c.foot![i]!.usd; return [v == null ? mid('-', ws[i]!) : fit(usd(v, ws[i]!), ws[i]!).padEnd(ws[i]!), { color: v == null ? THEME.muted : THEME.text }] })),
      )
    }
    while (lines.length < height) lines.push(row([]))
    return (
      <Box key={`kpi-${c.key}`} flexDirection="column">
        <Text color={THEME.line}>{rule('╭', ['┬'], '╮')}</Text>
        {lines}
        <Text color={THEME.line}>{rule('╰', ['┴', '┴'], '╯')}</Text>
      </Box>
    )
  }
  const kpis = (
    <Box flexDirection="column">
      {rows.map((r, i) => {
        // cards stretch to fill the row: the remainder goes to the first ones
        const height = r.some(c => c.extra || c.foot) ? 5 : 4
        return <Box key={`kpi-row-${i}`}>{r.map((c, j) => cardBox(c, Math.floor(cols / r.length) + (j < cols % r.length ? 1 : 0), height))}</Box>
      })}
    </Box>
  )

  // frame drawn by hand: a Box border has no title, and an absolute title on it is not painted
  // one line per row; no rows draws `empty` centered
  const frame = (title: string, lines: ReturnType<typeof Text>[], empty = 'Empty') => (
    <Box flexDirection="column">
      <Text color={THEME.line}>╭─ <Text color={THEME.text} bold>{title}</Text> {'─'.repeat(Math.max(0, cols - 5 - title.length))}╮</Text>
      {(lines.length ? lines : [<Text color={THEME.muted}>{empty}</Text>]).map(r => (
        <Box>
          <Text color={THEME.line}>│ </Text>
          <Box flexGrow={1} justifyContent={lines.length ? 'flex-start' : 'center'}>{r}</Box>
          <Text color={THEME.line}> │</Text>
        </Box>
      ))}
      <Text color={THEME.line}>╰{'─'.repeat(Math.max(0, cols - 2))}╯</Text>
    </Box>
  )

  // `w`: cells the chip takes (the Nerd Font glyph counts as one), for wrapping
  const chip = (ok: boolean, icon: string, label: string, warn = false) => ({
    el: <Text backgroundColor={!ok ? THEME.error : warn ? THEME.warning : THEME.success} color={INK}> {icon} {label} </Text>,
    w: label.length + 4,
  })
  type Chip = ReturnType<typeof chip>
  // chips split into lines of the inner width, one cell between them
  const wrapLines = (items: Chip[]) => items.reduce<Chip[][]>((ls, it) => {
    const last = ls[ls.length - 1]
    const used = last ? last.reduce((s, x) => s + x.w, 0) + (last.length - 1) : 0
    if (last && used + 1 + it.w <= inner) last.push(it)
    else ls.push([it])
    return ls
  }, [])
  // ponytail also needs its level on; other plugins are just enabled or not
  const pluginChips = Object.entries(plugins).flatMap(([key, enabled]) => {
    const name = key.split('@')[0]!
    if (name === 'hud-session') return [] // this mod itself
    return [name === 'ponytail' ? chip(enabled && level !== 'off', ICON.ponytail, `ponytail(${level})`) : chip(enabled, ICON.plugin, name)]
  })
  const mcpChips = mcpServers.map(s => /^ai[-_]memory$/.test(s)
    ? chip(true, ICON.memory, aiMemoryHooks ? 'ai-memory' : 'ai-memory (no hooks)', !aiMemoryHooks)
    : chip(true, ICON.mcp, s.replace(/^claude_ai_/, '').replace(/_/g, ' ')))
  const sections: [string, Chip[]][] = [
    ['Plugins', pluginChips], ['Skills', [chip(graphify, ICON.graphify, 'graphify')]], ['MCP', mcpChips],
  ]
  const integrations = frame('Integrations', sections.flatMap(([label, items]) => [
    <Text color={THEME.muted}>{label}</Text>,
    ...(items.length
      ? wrapLines(items).map(l => <Box>{l.flatMap((c, i) => (i ? [<Text> </Text>, c.el] : [c.el]))}</Box>)
      : [<Text color={THEME.muted}>Empty</Text>]),
  ]))

  const all = Object.entries(running ?? {})
  const finished = all.filter(([, a]) => a.status === 'done').length
  // a finished flow stays drawn (full) until the next one starts
  // no flow and no subagents: the task is the main loop's own turn
  const mainTask = !fl && !all.length && !!mn
  const taskPct = fl ? (fl.finished ? 1 : fl.total ? Math.min(1, fl.done / fl.total) : 0) : all.length ? finished / all.length : mainTask && mn.status === 'done' ? 1 : 0
  // the flow's own times; without a flow, the first agent's start and, once all are done, the last one's end
  const starts = all.map(([, a]) => a.startedAt).filter((v): v is number => v != null)
  const ends = all.map(([, a]) => a.finishedAt).filter((v): v is number => v != null)
  const startedAt = fl?.startedAt ?? (starts.length ? Math.min(...starts) : mainTask ? mn.startedAt : undefined)
  const finishedAt = fl ? fl.finishedAt : all.length && finished === all.length && ends.length ? Math.max(...ends) : mainTask && mn.status === 'done' ? mn.finishedAt : undefined
  const taskRunning = fl ? !fl.finished : finishedAt == null
  const taskRow = fl || all.length || mainTask ? (
    <Box>
      <Client key="sprite-task" module="./sprite.tsx" props={{ kind: 'task', running: taskRunning, color: THEME.primary, muted: THEME.muted, done: THEME.success }} width={5} height={1} />
      <Text> </Text>
      <Text wrap="truncate-end">
        <Text color={THEME.primary} bold>{fl?.title || 'current task'} </Text>{thin(taskPct, 12, THEME.primary)}<Text color={THEME.primary}> {Math.round(taskPct * 100)}%</Text>
        {fl ? <Text> <Text backgroundColor={THEME.primary} color={INK}> {fl.phase} </Text></Text> : null}
        {startedAt != null ? <Text color={THEME.muted}>  started at {clock(startedAt)}</Text> : null}
        {finishedAt != null ? <Text color={THEME.muted}>  finished at {clock(finishedAt)}</Text> : null}
      </Text>
    </Box>
  ) : null
  // table columns: badge+name flexes, the rest is fixed
  const MODEL = 11, EFFORT = 8, TOKENS = 7
  // floor: the main row's lead Client (LEAD_W) must fit, so every row shares one grid
  const nameW = Math.max(LEAD_W - 6, inner - (6 + MODEL + EFFORT + 13 + TOKENS))
  const head = (
    <Text color={THEME.muted} wrap="truncate-end">
      {'AGENT'.padEnd(6 + nameW)}{'MODEL'.padEnd(MODEL)}{'EFFORT'.padEnd(EFFORT)}{'PROGRESS'.padEnd(13)}TOKENS
    </Text>
  )
  const sorted = [...all].sort(([, a], [, b]) => Number(a.status === 'done') - Number(b.status === 'done'))
  // the main agent is always the first row, its bar the context fill
  const mainEntry: [string, AgentUsage] = ['main', { model, tokens: u.context.tokens ?? 0, status: mn?.status ?? 'done', role: 'Lead', label: 'main', effort: effortDefault }]
  const listed = [mainEntry, ...sorted]
  const agentRow = ([id, a]: [string, AgentUsage]) => {
    const done = a.status === 'done'
    const name = a.label ?? a.kind ?? id
    const tag = a.role ? `[${a.role}] ` : ''
    const badge = BADGES[hash(a.kind ?? name) % BADGES.length]!
    const isMain = id === 'main' && a === mainEntry[1]
    const frac = isMain ? ctxPct / 100 : done ? 1 : a.step?.total ? a.step.done / a.step.total : u.context.window ? a.tokens / u.context.window : 0
    // main row: lead Client + pad must total the same cells as a subagent row (nameW + 6)
    const indeterminate = !isMain && !done && !a.step?.total && !u.context.window
    return (
      <Box key={id} flexWrap="nowrap">
        {isMain ? (
          // one Client per row, at its start: a second Client in a row is drawn on the next line by the host
          <Client key="lead-main" module="./lead.tsx" props={{ running: !done, color: badge, done: THEME.success, primary: THEME.primary, muted: THEME.muted, ...(mn?.turn ? { turn: mn.turn } : {}), ...(mn?.startedAt != null ? { since: mn.startedAt } : {}), ...(mn?.finishedAt != null ? { until: mn.finishedAt } : {}) }} width={LEAD_W} height={1} />
        ) : (
          <Client key={`sprite-${id}`} module="./sprite.tsx" props={{ running: !done, color: badge, done: THEME.success }} width={5} height={1} />
        )}
        <Text wrap="truncate-end">
          {isMain ? null : tag ? <Text color={badge}> {tag.trimEnd()}</Text> : null}
          <Text>{isMain ? ' '.repeat(Math.max(0, nameW + 6 - LEAD_W)) : ` ${fit(name, nameW - tag.length).padEnd(nameW - tag.length)}`}</Text>
          <Text color={THEME.muted}>{fit(modelName(a.model), MODEL - 1).padEnd(MODEL)}{fit(a.effort ?? '-', EFFORT - 1).padEnd(EFFORT)}</Text>
          {indeterminate ? <Text color={THEME.line}>{'━'.repeat(12)}</Text> : thin(frac, 12, done && !isMain ? THEME.success : usedColor(frac * 100))}
          <Text color={THEME.muted}> {kTokens(a.tokens)}</Text>
        </Text>
      </Box>
    )
  }
  // the pane scrolls: every agent is drawn
  const agentsBox = frame('Agents', [...(taskRow ? [taskRow] : []), head, ...listed.map(agentRow)])

  return (
    <Box flexDirection="column">{header}{kpis}{integrations}{agentsBox}</Box>
  )
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
    await $.command.register({ name: 'hud-session', description: 'Reopen the HudSession side pane' })
    void $.ui.open({ id: PANE, title: 'HudSession' })
    return started
  })

  on('command.run', { command: 'hud-session' }, async $ => {
    await $.ui.open({ id: PANE, title: 'HudSession' })
    return { text: 'HudSession pane opened.' }
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
      const at = await $.clock.now().catch(() => undefined)
      await update($, main, m => ({ ...m, status: 'done' as const, finishedAt: at })).catch(() => {})
      const tokens = await $.session.usage().then(s => s.context.tokens, () => undefined)
      if (tokens) await update($, turns, t => [...(t ?? []), tokens].slice(-HISTORY)).catch(() => {})
      $.ui.invalidate('ui.render') // ponytail level, MCPs and branch may have changed
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const u: Usage = { context: e.context, rateLimits: e.rateLimits, cost: e.cost }
    await update($, usage, () => u)
    if (e.cost) {
      const usd = e.cost.usd
      // a store failure must never break the hook
      await (async () => {
        const id = await $.session.id()
        const l = ((await $.store.get(COSTS)) ?? {}) as Ledger
        if (l[id]?.usd === usd) return
        const at = await $.clock.now()
        const upd: Ledger = { ...l, [id]: { usd, at } }
        const keep = Object.entries(upd).filter(([, v]) => v.at >= at - 7 * DAY).sort((a, b) => b[1].at - a[1].at).slice(0, LEDGER)
        await $.store.set(COSTS, Object.fromEntries(keep))
      })().catch(() => {})
    }
    await update($, live, () => null).catch(() => {})
    return next(e)
  })

  // a new main-loop turn with a typed prompt starts a clean Agents box
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      // injected turns (<agent-message>, <task-notification>...) are continuations, not typed prompts
      const typed = (e.text ?? '').trim()
      if (typed && !typed.startsWith('<')) {
        // a typed prompt: clean Agents box; a finished flow is over, so the task row falls back to this turn's times
        await update($, agents, () => ({})).catch(() => {})
        await update($, flow, f => (f?.finished ? null : f ?? null)).catch(() => {})
        const at = await $.clock.now().catch(() => undefined)
        await update($, main, m => ({ status: 'running' as const, startedAt: at, turn: (m?.turn ?? 0) + 1 })).catch(() => {})
      }
      // continuation (e.g. a background subagent finished): same request, keep agents, flow and start time
      else await update($, main, m => ({ status: 'running' as const, ...(m?.startedAt != null ? { startedAt: m.startedAt } : {}), ...(m?.turn != null ? { turn: m.turn } : {}) })).catch(() => {})
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(!ASK_STEPS || e.prompt.includes('mcp__hud-session__step') ? e : { ...e, prompt: e.prompt + STEP_BRIEF })
    if ('agentId' in r && r.agentId) {
      const id = r.agentId
      // a failed write must never fail the spawn itself
      const at = await $.clock.now().catch(() => undefined)
      await update($, agents, a => ({ ...a, [id]: { model: r.model, tokens: 0, status: 'running' as const, role: roleFor(`${e.subagentType ?? ''} ${e.name ?? e.description ?? ''}`, Object.values(a ?? {})), label: e.name ?? e.description ?? e.subagentType, kind: e.subagentType, startedAt: at } })).catch(() => {})
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
      await update($, agents, a => (a?.[id] ? { ...a, [id]: { ...a[id]!, model: u.model, tokens, effort: eff, status: 'running' as const } } : a ?? {}))
    }
    if (u) {
      // one response at a time, subagents included (cost is session-wide); only a main-loop response refreshes the TTL
      const p = CACHE_PRICE.find(([k]) => u.model.startsWith(k))?.[1]
      if (p) {
        const add = (u.cache_read_input_tokens * p.read + u.cache_creation_input_tokens * p.input * 2) / 1e6
        const at = await $.clock.now()
        await update($, cache, c => ({ usd: (c?.usd ?? 0) + add, at: e.agentId && c ? c.at : at })).catch(() => {})
      }
    }
    if (!e.agentId && u) {
      const tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
      await update($, live, () => tokens).catch(() => {})
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => gather($, e, e.props.bodyColumns))
}
