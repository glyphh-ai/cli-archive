# @glyphh/cli

The Glyphh full-screen chat **TUI** — a thin client over [`@glyphh/client`](../sdk).

```
┌─ Glyphh v1.0.0 ──────────────────────────────────────────────────────────┐
│  <cat>   Chris Timmerman                                    latest release │
│          chris@glyphh.ai                                 v1.0.0 — chat TUI │
│          plan Pro  ·  812 credits                            api.glyphh.ai │
└───────────────────────────────────────────────────────────────────────────┘

  you
  refactor the auth module and add tests

  glyphh
  Done — split auth into bearer/session and added 12 tests.
  ⏱ 8.3s   ·   ◈ 4 credits

┌───────────────────────────────────────────────────────────────────────────┐
│ › now wire it into the CLI▍                                       Send ⏎    │
└───────────────────────────────────────────────────────────────────────────┘
 ◈ ask each time                                          rotor glyphh-coder
```

## Layout

- **Header** — a single-outline box with the version in the border (`Glyphh v1.x.x`).
  Left: the braille cat + the signed-in user & plan. Right: the latest release note.
- **Chat** — the streaming transcript. Each assistant turn streams token-by-token and
  closes with a `⏱ duration · ◈ credits` meta line.
- **Composer** — the input with a **Send** button pinned right.
- **Footer** — permission mode (bottom-left), selected rotor (bottom-right).

## Run

```sh
npm run dev          # develop against ~/.glyphh session + config
npm run build && node dist/main.js
```

Auth + server are shared with the `glyphh` CLI (`~/.glyphh/session.json`,
`~/.glyphh/config.json`). Sign in there first; the TUI picks it up.

Keys: **Enter** send · **Shift+Tab** cycle permission mode · **Ctrl+C** quit.

Env: `GLYPHH_SERVER_URL`, `GLYPHH_ROTOR`, `GLYPHH_HOME`.
