/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * flags.ts — the command line. What the desktop passes when it opens the Glyphh
 * loop in a terminal card, and what a person types. Pure, so it is tested.
 */

import { permissionModeOf, type PermissionMode } from "./types.js";

export interface Flags {
  model?: string;
  permission?: PermissionMode;
  prompt?: string;
  /** `--resume <chatId>`: open that chat from the shared store. */
  resume?: string;
  /** `--continue`: open the most recent Glyphh-loop chat. */
  continueLast?: boolean;
  /** `--trust`: this folder is trusted — skip the question (the desktop chose it). */
  trust?: boolean;
  /** `glyphh remote-control`: start with remote control on for this folder. */
  remoteControl?: boolean;
}

export const USAGE = "usage: glyphh [remote-control] [--model <id>] [--permission default|acceptEdits|plan|bypass] [--resume <chatId> | --continue] [--trust] [prompt…]";

/** The permission words every Glyphh surface uses → this TUI's chip. */
export function permissionFlag(raw: string): PermissionMode | undefined {
  return permissionModeOf(raw);
}

/** Parse argv. Unknown `--flags` are refused with a usage line; bare words are the prompt. */
export function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--model") { const v = argv[++i]; if (v) out.model = v; continue; }
    if (a.startsWith("--model=")) { out.model = a.slice(8); continue; }
    if (a === "--permission" || a === "--permission-mode") { const p = permissionFlag(argv[++i] ?? ""); if (p) out.permission = p; continue; }
    if (a.startsWith("--permission=") || a.startsWith("--permission-mode=")) { const p = permissionFlag(a.slice(a.indexOf("=") + 1)); if (p) out.permission = p; continue; }
    if (a === "--dangerously-skip-permissions") { out.permission = "bypass"; continue; }
    if (a === "--resume" || a === "-r") { const v = argv[++i]; if (v && /^[A-Za-z0-9_-]{1,64}$/.test(v)) out.resume = v; continue; }
    if (a.startsWith("--resume=")) { const v = a.slice(9); if (/^[A-Za-z0-9_-]{1,64}$/.test(v)) out.resume = v; continue; }
    if (a === "--continue" || a === "-c") { out.continueLast = true; continue; }
    if (a === "--trust") { out.trust = true; continue; }
    if (a.startsWith("--")) {
      process.stderr.write(`glyphh: unknown flag ${a}\n${USAGE}\n`);
      process.exit(2);
    }
    // `glyphh remote-control` — a subcommand only as the FIRST word; later it is prose.
    if (a === "remote-control" && words.length === 0 && !out.remoteControl) { out.remoteControl = true; continue; }
    words.push(a);
  }
  const prompt = words.join(" ").trim();
  if (prompt) out.prompt = prompt;
  return out;
}
