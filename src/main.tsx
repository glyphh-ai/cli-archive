#!/usr/bin/env node
/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * main.tsx — `glyphh`: the Glyphh loop in your terminal. Boots the SDK client on
 * the CLI's own session, then the full-screen TUI. Flags are what the desktop
 * passes when it opens this loop in a terminal card, and what a person types:
 *
 *   glyphh [prompt…]                 an opening prompt (sent once signed in)
 *   --model <id>                     the gateway model this session runs on
 *   --permission default|acceptEdits|plan|bypass   the permission chip
 *   --resume <chatId> | --continue   open a conversation from the shared store
 *   --bridge                         Bridge Mode banner (app/docs/BRIDGE-MODE.md §9)
 */

import "./env.js"; // MUST be first — loads .env before anything reads the environment
import { homedir } from "node:os";
import { render } from "ink";
import { Boot } from "./components/Boot.js";
import { makeClient, serverUrl } from "./glyphh.js";
import { parseFlags } from "./flags.js";

const VERSION = process.env.npm_package_version ?? "1.0.0";

/** The working directory, with $HOME collapsed to `~`. */
function displayCwd(): string {
  const cwd = process.cwd();
  const home = homedir();
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * SYNCHRONIZED OUTPUT (his report, 2026-09-21: "flickers constantly"). Ink 5
 * redraws its whole frame on every render — erase the previous lines, write
 * the new ones — and a terminal that paints between the two shows a blank
 * flash. DEC mode 2026 brackets each write so the terminal paints the frame
 * as one unit; iTerm2, kitty, WezTerm, Ghostty and xterm.js honour it, and
 * the others ignore the two sequences.
 */
function synchronizedStdout(): NodeJS.WriteStream {
  const real = process.stdout;
  return new Proxy(real, {
    get(target, key, receiver) {
      if (key === "write") {
        return (chunk: string | Uint8Array, ...rest: unknown[]): boolean =>
          (target.write as (c: string | Uint8Array, ...r: unknown[]) => boolean).call(target, typeof chunk === "string" ? `\u001b[?2026h${chunk}\u001b[?2026l` : chunk, ...rest);
      }
      const v = Reflect.get(target, key, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function enterFullScreen(): void {
  process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen + hide cursor
}
function leaveFullScreen(): void {
  process.stdout.write("\x1b[?25h\x1b[?1049l"); // show cursor + restore screen
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
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
      authLost={authLost}
      {...(flags.bridgeUrl ? { bridgeUrl: flags.bridgeUrl } : {})}
      {...(flags.model ? { initialModel: flags.model } : {})}
      {...(flags.permission ? { initialMode: flags.permission } : {})}
      {...(flags.prompt ? { initialPrompt: flags.prompt } : {})}
      {...(flags.resume ? { resumeId: flags.resume } : {})}
      {...(flags.continueLast ? { continueLast: true } : {})}
    />,
    { stdout: synchronizedStdout() },
  );
  waitUntilExit()
    .then(restore)
    .catch((e) => {
      restore();
      process.stderr.write(`glyphh: ${(e as Error).message}\n`);
      process.exit(1);
    });
}

main();
