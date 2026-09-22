/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * prefs.ts — this device's TUI preferences (~/.glyphh/config.json, 0600): the
 * permission chip, the picked model, the theme, the prompt history. The
 * `server` key belongs to the CLI profile and is preserved, never owned here.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { permissionModeOf, type PermissionMode } from "./types.js";

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
  /** The last prompts typed, oldest first (↑ recalls them). */
  history?: string[];
  /** Folders the user said they trust the files in (the first-run question). */
  trustedFolders?: string[];
}

/** How many prompts the history keeps. */
export const HISTORY_MAX = 100;

export function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    // Older files spelled the chip ask/auto/read-only; every spelling maps.
    const mode = permissionModeOf(typeof raw.permissionMode === "string" ? raw.permissionMode : undefined);
    const out: Prefs = {};
    if (typeof raw.server === "string") out.server = raw.server;
    if (mode) out.permissionMode = mode;
    if (typeof raw.model === "string" && raw.model) out.model = raw.model;
    if (typeof raw.theme === "string") out.theme = raw.theme;
    if (Array.isArray(raw.history)) out.history = raw.history.filter((h): h is string => typeof h === "string").slice(-HISTORY_MAX);
    if (Array.isArray(raw.trustedFolders)) out.trustedFolders = raw.trustedFolders.filter((f): f is string => typeof f === "string");
    return out;
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

/** Remember a prompt (deduplicated against the newest, capped). */
export function rememberPrompt(text: string): string[] {
  const cur = readPrefs().history ?? [];
  const next = cur[cur.length - 1] === text ? cur : [...cur, text].slice(-HISTORY_MAX);
  writePrefs({ history: next });
  return next;
}

/** Is this folder one the user trusts? Exact, or under a trusted parent. */
export function folderTrusted(folder: string): boolean {
  const list = readPrefs().trustedFolders ?? [];
  return list.some((t) => folder === t || folder.startsWith(t.endsWith("/") ? t : `${t}/`));
}

/** Remember a trusted folder. */
export function trustFolder(folder: string): void {
  const list = readPrefs().trustedFolders ?? [];
  if (!list.includes(folder)) writePrefs({ trustedFolders: [...list, folder] });
}
