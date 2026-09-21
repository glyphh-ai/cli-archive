#!/usr/bin/env node
/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * main.tsx — the `glyphh-tui` entry. Takes over the FULL screen (alternate screen +
 * hidden cursor), renders the fixed-height chat, and restores the terminal cleanly on
 * exit (Ctrl+C / SIGTERM / crash). All app capability comes from the SDK client in
 * glyphh.ts.
 */

import "./env.js"; // MUST be first — loads .env before anything reads the environment
import { homedir } from "node:os";
import { render } from "ink";
import { Boot } from "./components/Boot.js";
import { makeClient, serverUrl } from "./glyphh.js";
import { THREAD_ID_RE } from "./threads.js";

const VERSION = process.env.npm_package_version ?? "1.0.0";
// The loop to open with. `GLYPHH_ROTOR` is honored for back-compat; the built-in
// "default" loop is the general catch-all when nothing is set.
const LOOP = process.env.GLYPHH_LOOP ?? process.env.GLYPHH_ROTOR ?? "default";

/** The working directory, with $HOME collapsed to `~`. */
function displayCwd(): string {
  const cwd = process.cwd();
  const home = homedir();
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function enterFullScreen(): void {
  process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen + hide cursor
}
function leaveFullScreen(): void {
  process.stdout.write("\x1b[?25h\x1b[?1049l"); // show cursor + restore screen
}

/** `--thread <id>` — resume a saved server thread (see `/threads` in-app, or
 *  `glyphh threads list`). Validated BEFORE the alternate screen takes over so a
 *  typo'd id fails loudly instead of opening a chat that silently forked. */
function parseThreadArg(argv: string[]): string | undefined {
  const i = argv.indexOf("--thread");
  if (i < 0) return undefined;
  const id = argv[i + 1];
  if (!id || !THREAD_ID_RE.test(id)) {
    process.stderr.write("glyphh: --thread needs a thread id (see /threads in the app, or `glyphh threads list`)\n");
    process.exit(2);
  }
  return id;
}

/** `--bridge` — the TUI is the face of Bridge Mode (app/docs/BRIDGE-MODE.md §9):
 *  the desktop app runs the bridge and opens this in a terminal panel with
 *  GLYPHH_BRIDGE_URL set, so the banner names the URL Claude Desktop points at. */
function parseBridgeArg(argv: string[]): string | undefined {
  if (!argv.includes("--bridge")) return undefined;
  return process.env.GLYPHH_BRIDGE_URL ?? "http://127.0.0.1:4747";
}

function main(): void {
  const resumeThreadId = parseThreadArg(process.argv.slice(2));
  const bridgeUrl = parseBridgeArg(process.argv.slice(2));
  // The sign-out handler is LATE-BOUND: the client must exist before Boot renders,
  // but Boot owns the reaction (drop to the login gate). Boot registers into this box.
  const authLost: { handler?: () => void } = {};
  const client = makeClient({ onSignedOut: () => authLost.handler?.() });
  enterFullScreen();
  let restored = false;
  const restore = () => {
    if (!restored) {
      restored = true;
      leaveFullScreen();
    }
  };
  process.on("exit", restore);

  const { waitUntilExit } = render(
    <Boot
      client={client}
      version={VERSION}
      server={serverUrl()}
      cwd={displayCwd()}
      loop={LOOP}
      authLost={authLost}
      {...(resumeThreadId ? { resumeThreadId } : {})}
      {...(bridgeUrl ? { bridgeUrl } : {})}
    />,
  );
  waitUntilExit()
    .then(restore)
    .catch((e) => {
      restore();
      process.stderr.write(`glyphh-tui: ${(e as Error).message}\n`);
      process.exit(1);
    });
}

main();
