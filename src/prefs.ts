/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * prefs.ts — per-device CLIENT preferences, in `~/.glyphh/config.json` (shared with the
 * CLI profile's `server`). These are interaction defaults that don't belong on the server:
 * the permission mode, the last-selected LOOP, and this device's per-loop model picks.
 * Governance — which models a caller MAY choose — stays on the control plane; a selection
 * here only says which allowed model fills a slot, resolved server-side by `loops.roles`.
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

/** This device's model picks, per loop: `{ [loopSlug]: { [role]: modelId } }`. Mirrors the
 *  desktop composer — a "coder" pick in one loop must not rebind another loop's "coder". */
export type LoopSelections = Record<string, Record<string, string>>;

export interface Prefs {
  /** The CLI profile's server (written by the `glyphh` CLI) — preserved, not owned here. */
  server?: string;
  permissionMode?: PermissionMode;
  /** The selected loop's slug. */
  loop?: string;
  loopSelections?: LoopSelections;
  /** The chosen theme's name (see theme.ts). Absent = never picked → the picker runs. */
  theme?: string;
}

/** Raw on-disk shape, including the pre-rename `rotor` key we migrate on read. */
interface StoredPrefs extends Prefs {
  /** @deprecated superseded by `loop` — read once, then rewritten as `loop`. */
  rotor?: string;
}

export function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as StoredPrefs;
    // Migrate the pre-rename key: an older `rotor` becomes `loop` unless `loop` already won.
    if (raw.loop === undefined && raw.rotor !== undefined) raw.loop = raw.rotor;
    delete raw.rotor;
    return raw;
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

/** This device's stored picks for one loop (empty when none set). */
export function selectionsFor(loop: string): Record<string, string> {
  return readPrefs().loopSelections?.[loop] ?? {};
}

/**
 * Bind a loop slot to a model on this device. A null model CLEARS the pick, handing the
 * slot back to the loop's own default — the CLI equivalent of the picker's "Auto".
 */
export function setSelection(loop: string, role: string, modelId: string | null): void {
  const all = readPrefs().loopSelections ?? {};
  const forLoop = { ...(all[loop] ?? {}) };
  if (modelId) forLoop[role] = modelId;
  else delete forLoop[role];
  writePrefs({ loopSelections: { ...all, [loop]: forLoop } });
}
