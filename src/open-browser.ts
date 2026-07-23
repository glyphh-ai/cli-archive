/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * open-browser.ts — best-effort "open this URL in the user's browser". Device login shows
 * a code + URL regardless; opening the browser is a convenience, so a failure here (no
 * DISPLAY, a locked-down box, an SSH session) is swallowed — the printed URL is the
 * fallback. Detached + unref'd so the opener never keeps the TUI alive.
 */

import { spawn } from "node:child_process";

/** The platform's URL opener: `open` (macOS), `start` (Windows), `xdg-open` (Linux). */
function opener(): { cmd: string; args: string[] } {
  if (process.platform === "darwin") return { cmd: "open", args: [] };
  if (process.platform === "win32") return { cmd: "cmd", args: ["/c", "start", ""] };
  return { cmd: "xdg-open", args: [] };
}

/** Open `url` in the default browser. Returns whether the opener spawned (not whether a
 *  browser actually appeared) — callers treat false as "show the URL and move on". */
export function openBrowser(url: string): boolean {
  try {
    const { cmd, args } = opener();
    const child = spawn(cmd, [...args, url], { stdio: "ignore", detached: true });
    child.on("error", () => {}); // a missing opener must not throw past this
    child.unref();
    return true;
  } catch {
    return false;
  }
}
