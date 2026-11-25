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
 ◈ default  (shift+tab to cycle)        claude-sonnet-5 · effort Medium   ·   loop glyphh
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
- **Status line** — the spinner and verb while a turn works; beneath it the model's thinking as
  one dim line (`Thinking… …`) until the answer starts.
- **Footer** — permission mode (bottom-left); the model the next turn runs on and its effort
  (bottom-right).

## Run

```sh
npm run dev          # develop against ~/.glyphh session + config
npm run build && node dist/main.js
```

The TUI signs in on its own (device login) and keeps its session in
`~/.glyphh/session.json`; the desktop app keeps a separate one.

Keys, the way every agent CLI has them: **Enter** send · **↑/↓** prompt history · **←/→** cursor
(**ctrl+a/e** home/end, **ctrl+w** delete word, **ctrl+u** clear) · **Shift+Tab** cycle the
permission mode · **Esc** stop the turn · **ctrl+o** expand tool output · **PgUp/PgDn** scroll ·
**Ctrl+C** clear the line, twice to quit. A parked permission ask takes **y** / **a**lways / **n**.

Permission modes are the standard four: `default` (asks before edits and commands),
`acceptEdits`, `plan` (read-only) and `bypass`. shift+tab cycles the first three.

Effort — how hard the model thinks on a turn — is a five-step dial: `low` Low, `medium` Medium
(the default), `high` High, `xhigh` Extra high, `max` Ultra. `/effort` opens a selector like
`/model` (Enter sets this device's default, `s` this session only); `/effort high` sets it
outright. The pick lives in `~/.glyphh/config.json` beside the model, so it survives restarts;
`--effort <level>` overrides it for one run.

Commands (type `/` for the menu): `/help` `/clear` `/compact` `/config` `/cost` `/effort` `/exit`
`/login` `/logout` `/mcp` `/model` `/permissions` `/remote-control` `/resume` `/status` `/theme`
`/version`.

Flags: `glyphh [remote-control] [--model <id>] [--permission default|acceptEdits|plan|bypass]
[--effort low|medium|high|xhigh|max] [--resume <chatId> | --continue] [--trust] [prompt…]` —
what the desktop passes when it opens the Glyphh loop in a terminal card. A bad `--effort`
exits 2 with the allowed list.

Env: `GLYPHH_SERVER_URL`, `GLYPHH_HOME`; `GLYPHH_APP_MCP_URL` + `GLYPHH_APP_MCP_TOKEN` lend the
desktop's own glyphh_* tools to the loop (the desktop sets them).


## License

Apache-2.0. See LICENSE and NOTICE. Copyright 2026 Chris Timmerman / Glyphh AI LLC. More about it: https://glyphh.ai/projects/glyphh-cli
