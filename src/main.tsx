#!/usr/bin/env node
/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * main.tsx — the `glyphh-tui` entry. Renders INLINE (no alternate screen) so the header
 * and finished turns flow into the terminal's native scrollback while the composer stays
 * pinned at the bottom. All app capability comes from the SDK client built in glyphh.ts.
 */

import { homedir } from "node:os";
import { render } from "ink";
import { App } from "./components/App.js";
import { makeClient, SERVER_URL } from "./glyphh.js";

const VERSION = process.env.npm_package_version ?? "1.0.0";
const ROTOR = process.env.GLYPHH_ROTOR ?? "default";

/** The working directory, with $HOME collapsed to `~`. */
function displayCwd(): string {
  const cwd = process.cwd();
  const home = homedir();
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function main(): void {
  const client = makeClient();
  const { waitUntilExit } = render(
    <App client={client} version={VERSION} server={SERVER_URL} cwd={displayCwd()} rotor={ROTOR} />,
  );
  waitUntilExit().catch((e) => {
    process.stderr.write(`glyphh-tui: ${(e as Error).message}\n`);
    process.exit(1);
  });
}

main();
