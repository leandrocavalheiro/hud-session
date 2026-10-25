# HudSession

A Claude Code mod: a side pane rendered in the terminal (Ink-style `Box`/`Text` from `$.ui.resolve(e)`). All UI lives in `gather()` in `hooks/register.tsx`.

## Design system (MaterialM dark) — mandatory for every UI change

The look follows the MaterialM dark dashboard (https://material-m-nextjs-dark.vercel.app/dashboards/crm), adapted to a terminal. Keep it consistent: new UI reuses the tokens and building blocks below instead of inventing new ones.

### Where it draws

- **Side pane only** (`ui.render` for `component: 'Pane', requestId: PANE`). Do not draw in the band above the prompt (`AbovePrompt`); a test guards this.
- The pane scrolls: never truncate lists by row count. Width comes from `e.props.bodyColumns` (`cols`); content width inside a frame is `inner = cols - 4`.

### Color tokens

Every color comes from these constants; no hex or named color (`'green'`, `'cyan'`, `dimColor`) inline in JSX.

| token | value | use |
|---|---|---|
| `THEME.primary` | `#5D87FF` | title, model, task row + Pac-man, cost, phase chip |
| `THEME.secondary` | `#49BEFF` | secondary accent |
| `THEME.success` | `#13DEB9` | on / done / branch / usage < 25% |
| `THEME.warning` | `#FFAE1F` | degraded state, sparkline, usage < 75% |
| `THEME.error` | `#FA896B` | off / usage ≥ 75% |
| `THEME.muted` | `#7C8FAC` | labels, sub-lines, empty states, table header |
| `THEME.line` | `#333F55` | borders, empty part of bars |
| `THEME.text` | `#EAEFF4` | frame titles |
| `INK` | `#1A2537` | text on filled chips/badges |
| `BADGES` | theme accents + `#8965E5`, `#E58FD0` | per-agent badge, picked by `hash(kind)` |

Usage percentages always go through `usedColor(pct)` (success < 25 · primary < 50 · warning < 75 · error).

### Building blocks

- **`frame(title, lines, empty)`** — section card: hand-drawn rounded border in `line`, title in `text` bold, one line per row, `empty` (default `Empty`) centered in `muted`. Use it for every new section.
- **KPI card (`cardBox`)** — small frame: `muted` label, bold value in its status color, `thin` bar when it is a percentage, `muted` sub-line, optional footer (`foot`: a full-width `line` divider `├─┼─┬─┤` joined to the frame, then 3 fixed columns split by `line` `│` separators with `muted` labels `Today` `7d` `avg` and `text` values, closed by `┴` in the bottom border; makes the card 5 lines; Cost uses it for Today / 7d / avg). Its top part (label + value rows) is split in two by a `line` `│` above the first footer separator (`┬` in the top border, `┼` in the divider): left `Cost` (bold `primary`), width of footer column 1; right `Cache` (`muted` reset time, `text` USD), columns 2 and 3 wide. Money uses the same `usd` rule in the top and the footer. Cards in a row share the tallest height. Cards share rows: `floor(cols / 18)` per row, stretched to fill the width. New metrics become a new entry in `cards`, not a new layout.
- **`chip(ok, icon, label, warn)`** — status pill: filled background (success / warning / error), `INK` text, Nerd Font icon, wrapped by `wrapLines` with a 1-cell gap. Use for any on/off status.
- **`sparkline(t)`** — Braille bars, one row high, exactly `HISTORY` (12) cells, ONE turn per cell using both Braille columns (heights 1-4 → `⣀ ⣤ ⣶ ⣿`), scaled to the busiest turn shown, any turn above 0 keeps at least height 1. Slots fill left to right (the latest 12 once full, oldest left); filled cells in `THEME.warning`, empty slots a full `⣿` in `THEME.line`. Always drawn in the Context card's extra line (12 gray slots before the first turn) so the card never changes shape; the context delta follows the 12 cells after one space: no arrow, no sign, no decimals (`800`, `3k`, `1M`), `THEME.error` when growing, `THEME.success` when shrinking, absent when 0 or under 2 turns; a narrow card trims the oldest cells, never the delta. The sub line is tokens/window only.
- **`thin(frac, n, color)`** — progress bar of `━`: filled part in `color`, rest in `line`. The only bar style.
- **Tables** — a `muted` header row with fixed column widths (`padEnd`), the first column flexes with `inner`, rows `wrap="truncate-end"`, no divider lines between rows.
- **`sprite` (`hooks/sprite.tsx`)** — animated 5-cell `Client` at the start of every subagent row (the main row's robot lives inside `lead`; `key` `sprite-<id>`, props `{ running, color, done }`): a blinking robot (`ROBOT`: `[o_o]` x3 then `[-_-]`) in the row's badge color while running, ~200ms per frame (Pac-man ~280ms) from a local `surface.every` timer started once. It never redraws through `$`. When done it draws a static `[^_^]` in `THEME.success` and cancels the timer. Colors come in as props. Optional `kind: 'task'` (5 cells, same as agents, key `sprite-task`, first in the task row, `running` = task not finished, extra prop `muted`): Pac-man (`PACMAN`: `ᗧ····` → `    ᗧ`) in `color` (`THEME.primary`) eating dots in `muted`; static `    ᗧ` in `done` once finished. The Agents table header and `nameW` assume badge 5 + 1 space.
- **`lead` (`hooks/lead.tsx`)** — the whole left part of the main row in ONE `Client` (`key` `lead-main`, width `LEAD_W` = 39 = robot 5 + ` [Lead] ` 8 + `turn 99 · ` 10 + clock 16, props `{ running, color, done, primary, muted, turn?, since?, until? }`): the `sprite` robot (`[^_^]` in `done` when not running), ` [Lead] ` in the badge color, `turn N · ` in `THEME.muted` (omitted before the first turn), then the clock: `working M:SS` in `THEME.primary` while running, `done in M:SS` (`until - since`) in `THEME.muted`, `idle` in `THEME.muted` with no `since`. One local `surface.every` timer (200ms) while running: the robot advances each tick, the clock is recomputed from `Date.now()` (the client has no clock); never through `$`. `M:SS` under 1h, `H:MM:SS` from 1h (`fmt`, exported). Optional props are omitted, not `undefined`. **Only one Client per row, at its start — a second Client in a row is drawn on the next line by the host.**
- **Header** — rounded `Box` border: `HudSession` in primary bold, then model · effort · branch, then the path in muted, with `~` for `$HOME`.

### Conventions

- Section order: header → KPI cards → Integrations → Agents. The Agents table always has a header and a `main` row first (bar = context fill, `[^_^]` sprite before the first turn and once its turn is done), with or without subagents, so the box is never empty. Agent rows start with a role tag (`main` is always `[Lead]`, followed by `turn N · ` in `THEME.muted` (N = typed prompts so far, kept by continuations, absent before the first) and the clock (all inside the `lead` Client) instead of a label: `[Lead] turn 3 · working 0:12` / `done in M:SS` / `idle`; all rows total `nameW + 6` cells, `nameW` has a floor of `LEAD_W - 6` = 33 so the main row always fits its grid, rows are `flexWrap="nowrap"`; a turn whose text starts with `<`, like an injected `<agent-message>` or `<task-notification>`, is a continuation: it keeps the start time and the Agents box; subagents e.g. `[Dev01]`) in the row's badge color, then the label: `role` is set once at spawn from `ROLES` (regex table on `subagentType name`, first match wins: Plan, Rev, QA, Exp, else Dev) plus a two-digit count of same-prefix agents already in the atom, so numbers never shift and restart when the box clears. Times use `HH:MM:SS`.
- The main loop's context is live: `turn.step` writes the `live` atom, `session.measure` clears it; `gather` prefers `live` for the Context card and the `main` row. The sparkline only gets one point per turn.
- `ASK_STEPS` (default `false`): when true, `agent.spawn` appends `STEP_BRIEF` to each subagent prompt so it reports steps via `mcp__hud-session__step`. Off to save tokens; a subagent bar then shows token use.
- The `cache` atom (`{ usd, at } | null`) sums prompt-cache spend: `turn.step` (one event per API response, subagents included) adds `cache_read * read + cache_creation * 2 * input` (per-MTok `CACHE_PRICE` table by model id prefix; unknown model adds nothing). Only main-loop responses set `at`; the Cache reset is `at + CACHE_TTL` (1h, Claude Code's cache TTL, not exposed to mods) minus now, `cold` when expired, `-` before any response.
- The cost ledger lives in `$.store` key `costs` (`{ [sessionId]: { usd, at } }`, last 7 days, max 500): `session.measure` writes the current session and prunes the rest; `gather` sums Today and 7d and averages the 7d window, the live cost overriding the current session. Store failures are swallowed.
- Everything user-visible (labels, table headers, command text), code, comments and docs are English.
- Icons are Nerd Font glyphs in `ICON`; add new ones there with their name as a comment.
- Any visual change updates the screenshot (`docs/hud.png`, a real capture of the pane) and the section list in `README.md`.

## Develop

```bash
claude plugin validate .
claude plugin test .
```
