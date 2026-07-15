#!/usr/bin/env node
/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * main.tsx — the `glyphh-tui` entry. Enters the alternate screen, hides the cursor,
 * renders the full-screen chat, and restores the terminal cleanly on exit (including
 * Ctrl+C / SIGTERM). All app capability comes from the SDK client built in glyphh.ts.
 */

import { render } from "ink";
import { App } from "./components/App.js";
import { makeClient, SERVER_URL } from "./glyphh.js";

const VERSION = process.env.npm_package_version ?? "1.0.0";
const RELEASE = "v1.0.0 — chat TUI";
const ROTOR = process.env.GLYPHH_ROTOR ?? "default";

function enterAltScreen(): void {
  process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen + hide cursor
}
function leaveAltScreen(): void {
  process.stdout.write("\x1b[?25h\x1b[?1049l"); // show cursor + restore screen
}

function main(): void {
  const client = makeClient();
  enterAltScreen();

  const { waitUntilExit } = render(
    <App client={client} version={VERSION} server={SERVER_URL} release={RELEASE} rotor={ROTOR} />,
    { exitOnCtrlC: true },
  );

  const restore = () => leaveAltScreen();
  process.on("exit", restore);

  waitUntilExit()
    .then(restore)
    .catch((e) => {
      restore();
      process.stderr.write(`glyphh-tui: ${(e as Error).message}\n`);
      process.exit(1);
    });
}

main();
