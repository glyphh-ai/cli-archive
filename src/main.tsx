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

function main(): void {
  const client = makeClient();
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
    <Boot client={client} version={VERSION} server={serverUrl()} cwd={displayCwd()} loop={LOOP} />,
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
