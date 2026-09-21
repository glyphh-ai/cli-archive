/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * prefs.ts — this device's TUI preferences (~/.glyphh/config.json, 0600): the
 * permission chip, the picked model, the theme. The `server` key belongs to
 * the CLI profile and is preserved, never owned here.
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
  /** The CLI profile's server — preserved, not owned here. */
  server?: string;
  permissionMode?: PermissionMode;
  /** The model turns run on (a gateway model name). Absent = the org's default. */
  model?: string;
  /** The chosen theme's name (see theme.ts). Absent = never picked → the picker runs. */
  theme?: string;
}

export function readPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Prefs;
  } catch {
    return {};
  }
}

/** A patch: a value sets the key, null removes it (back to the default). */
export type PrefsPatch = { [K in keyof Prefs]?: Prefs[K] | null };

/** Merge + persist (0600). Best-effort — a read-only home never breaks the TUI. */
export function writePrefs(patch: PrefsPatch): void {
  try {
    const next: Record<string, unknown> = { ...readPrefs() };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else if (v !== undefined) next[k] = v;
    }
    mkdirSync(home(), { recursive: true });
    writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}
