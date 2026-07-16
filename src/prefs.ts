/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * prefs.ts — per-device CLIENT preferences, in `~/.glyphh/config.json` (shared with the
 * CLI profile's `server`). These are interaction defaults that don't belong on the server:
 * the permission mode and the last-selected rotor. The GOVERNED config — which model each
 * rotor role uses (bindings) — lives on the control plane, not here.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { PermissionMode } from "./types.js";

function home(): string {
  return process.env.GLYPHH_HOME ?? join(homedir(), ".glyphh");
}
function file(): string {
  return join(home(), "config.json");
}

export interface Prefs {
  /** The CLI profile's server (written by the `glyphh` CLI) — preserved, not owned here. */
  server?: string;
  permissionMode?: PermissionMode;
  rotor?: string;
}

export function readPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Prefs;
  } catch {
    return {};
  }
}

/** Merge + persist (0600). Best-effort — a read-only home never breaks the TUI. */
export function writePrefs(patch: Partial<Prefs>): void {
  try {
    const next = { ...readPrefs(), ...patch };
    mkdirSync(home(), { recursive: true });
    writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}
