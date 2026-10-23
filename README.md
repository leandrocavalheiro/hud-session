# HudSession

A side pane for [Claude Code](https://claude.com/claude-code) that keeps the state of your session in view: the model and what it costs, how full the context is, your usage limits, the plugins, skills and MCP servers you have, where you are, and what your agents are doing.

```
╭─ HudSession v1.0.0 ───────────────────────────────╮
╭─ Session ─────────────────────────────────────────╮
│ 󰚩 Opus 5.5 (thinking: high) | sessão $1.23 | last turns ▂▃▅▇ ▲ +2.1k │
│ ───────────────────────────────────────────────── │
│ current context ███░░░░░░░ 31% 310.0k/1.0M        │
│ ───────────────────────────────────────────────── │
│ 5h ██░░░░░░░░ 18% (resets 2h10m) | 7d █░░░░░░░░░ 9% │
╰───────────────────────────────────────────────────╯
╭─ Plugins ─────────────────────────────────────────╮
│ 󱖿 ponytail(full) | 󰐱 blast-radius                  │
╰───────────────────────────────────────────────────╯
╭─ Skills ──────────────────────────────────────────╮
│ 󱁉 graphify                                         │
╰───────────────────────────────────────────────────╯
╭─ MCP ─────────────────────────────────────────────╮
│ 󰧑 ai-memory | 󰒍 supabase | 󰒍 linear               │
╰───────────────────────────────────────────────────╯
╭─ Path ────────────────────────────────────────────╮
│ /Users/me/projects/app  main                     │
╰───────────────────────────────────────────────────╯
╭─ Agents ──────────────────────────────────────────╮
│ current task ████████░░░░ 66%  delegate  started at 14:05 │
│ ───────────────────────────────────────────────── │
│  E  Explore repo  [Sonnet 5.5] medium  ██░░░░░░░░ 41.2k │
╰───────────────────────────────────────────────────╯
```

## What each box shows

### Session

| line | what it is |
|---|---|
| model | the main loop's model (`claude-opus-5-5` reads `Opus 5.5`) and its thinking effort: the last request's, else the `/config` effort, else `effortLevel` from `settings.json`, else `default` |
| `sessão $` | the session's cost so far, when Claude Code reports one |
| `last turns` | a sparkline of the context size at the end of the last 12 turns, scaled to the largest, and the change since the previous turn (`▲ +2.1k`, `▼ 800`) |
| `current context` | how full the context window is: percent, tokens used / window size. `0%` before the first turn |
| `5h`, `7d` | your usage limits: percent used and the time until each resets. Always drawn: `0%` until Claude Code reports them, `100%` once a limit is reached. Any other limit kind reported shows after these two |

Bar colors: green below 25%, blue below 50%, yellow below 75%, red above.

### Plugins

The plugins enabled in `~/.claude/settings.json` (`enabledPlugins`): green when on, red when off. `ponytail` also shows its level (read from `~/.claude/.ponytail-active`) and is red while the level is `off`. HudSession leaves itself out.

### Skills

`graphify`: green when its command is available in the session, red when it is not.

### MCP

The MCP servers whose tools the session has, read from the tool list (`mcp__<server>__<tool>`). `ai-memory` turns yellow and reads `ai-memory (sem hooks)` when its capture hooks are missing from `~/.claude/settings.json`.

### Path

The session's working directory and the current git branch.

### Agents

- **The task row**: the current task's title (`current task` when it has none), a progress bar and percent, the phase, and `started at` / `finished at` in local time.
  - With a flow reported through the `progress` tool, the bar is tasks done over tasks planned, and the times are the flow's.
  - Without one, the bar is agents finished over agents spawned, `started at` is the first agent's spawn and `finished at` appears once every agent is done.
- **One row per agent**, the running ones first: a colored badge (`✓` once done), its name, `[model] effort`, a bar of its own steps (or of its context against the window when it reports none), and its context size in tokens.
- A separator line between rows.
- `no task` when there is nothing to show.

Finished agents stay until the first agent of your next request is spawned.

Every box shows `Vazio` (empty) centered when it has nothing to list. Long lists wrap onto as many lines as they need.

## Where it is drawn

- **The pane** (the side panel): every box, in the order above. It opens with the session; `/hud-session` reopens it. The pane scrolls, so every agent is listed.
- **The band above the prompt**: the same boxes, only while the pane is not placed (closed, or a terminal too narrow for it). The band does not scroll, so agents beyond the rows left show as `+N`.

## Tools it adds

| tool | for | what it does |
|---|---|---|
| `mcp__hud-session__progress` | the main session | reports the task flow: `title`, `total`, `done`, `phase` (`plan`, `design`, `delegate`, `review`, `close`), `finished`. A new title starts a new flow. Calls from subagents are ignored |
| `mcp__hud-session__step` | subagents | reports an agent's own steps (`done`, `total`, `note`) for its bar. Every spawned agent gets a line in its prompt asking it to call this |

## Install

Requirements: Claude Code with mods (plugins with a hooks module), and a [Nerd Font](https://www.nerdfonts.com/) in the terminal for the icons.

```bash
git clone https://github.com/leandrocavalheiro/hud-session ~/.claude/mods/hud-session
```

Then load it, either for one session:

```bash
claude --plugin-dir ~/.claude/mods/hud-session
```

or for every session, in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/hud-session" } }
```

## Develop

```bash
claude plugin validate .   # what the engine would refuse
claude plugin test .       # hooks/register.test.tsx
```

The engine writes the API types into `.claude-plugin/types/` when it loads the mod (ignored by git); `tsconfig.json` extends them.

| file | what it is |
|---|---|
| `.claude-plugin/plugin.json` | the manifest |
| `hooks/hooks.json` | names the hooks module |
| `hooks/register.tsx` | the hooks: state, tools, the pane and the band |
| `hooks/register.test.tsx` | the tests |
| `types/index.d.ts` | the state contract |

## Privacy

Everything is read locally and drawn in your terminal: `~/.claude/settings.json`, `~/.claude/.ponytail-active` and `git branch`. Nothing is sent anywhere.
