# @glyphh-ai/cli

The Glyphh full-screen agent **TUI** — the Glyphh loop itself (`@glyphh/sdk/loop`), running in
your terminal on any model your organization serves on the gateway. A thin view over [`@glyphh/sdk`](../sdk).

```
┌─ Glyphh v1.0.0 ──────────────────────────────────────────────────────────┐
│  <cat>   Tom Tommerson                                      latest release │
│          tom.tommerson@glyphh.ai                         v1.0.0 — chat TUI │
│          plan Pro                                            api.glyphh.ai │
└───────────────────────────────────────────────────────────────────────────┘

  you
  refactor the auth module and add tests

  glyphh
  Done — split auth into bearer/session and added 12 tests.
  * Cooked for 8.3s · 1204↑ 312↓

┌───────────────────────────────────────────────────────────────────────────┐
│ › now wire it into the CLI▍                                       Send ⏎    │
└───────────────────────────────────────────────────────────────────────────┘
 ◈ ask each time                                       claude-sonnet-5
```

## Install

```sh
npm i -g @glyphh-ai/cli
glyphh
```

## Layout

- **Header** — a single-outline box with the version in the border (`Glyphh v1.x.x`).
  Left: the braille cat + the signed-in user & plan. Right: the latest release note.
- **Chat** — the streaming transcript. Each assistant turn streams token-by-token; tool
  calls (files, shell, connected apps) land as collapsible receipts (ctrl+o), and the
  turn closes with a `* Verbed for Ns · tokens` meta line.
- **Composer** — the input with a **Send** button pinned right.
- **Footer** — permission mode (bottom-left), the model the next turn runs on (bottom-right).

## Run

```sh
npm run dev          # develop against ~/.glyphh session + config
npm run build && node dist/main.js
```

The TUI signs in on its own (device login) and keeps its session in
`~/.glyphh/session.json`; the desktop app keeps a separate one.

Keys: **Enter** send · **Shift+Tab** cycle permission mode · **Esc** stop the turn ·
**ctrl+o** expand tool output · **Ctrl+C** quit. A parked permission ask takes **y** / **a**lways / **n**.

Commands: `/model` (list or pick the gateway model), `/use` (this session only), `/theme`,
`/clear`, `/status`, `/login`, `/logout`, `/help`.

Flags: `glyphh [--model <id>] [--permission ask|plan|acceptEdits|auto] [--bridge] [prompt…]` —
what the desktop passes when it opens the Glyphh loop in a terminal card.

Env: `GLYPHH_SERVER_URL`, `GLYPHH_HOME`; `GLYPHH_APP_MCP_URL` + `GLYPHH_APP_MCP_TOKEN` lend the
desktop's own glyphh_* tools to the loop (the desktop sets them).
