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
  bridgeUrl?: string;
  prompt?: string;
}

export const USAGE = "usage: glyphh [--model <id>] [--permission default|acceptEdits|plan|bypass] [--bridge] [prompt…]";

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
    if (a === "--bridge") { out.bridgeUrl = process.env.GLYPHH_BRIDGE_URL ?? "http://127.0.0.1:4747"; continue; }
    if (a.startsWith("--")) {
      process.stderr.write(`glyphh: unknown flag ${a}\n${USAGE}\n`);
      process.exit(2);
    }
    words.push(a);
  }
  const prompt = words.join(" ").trim();
  if (prompt) out.prompt = prompt;
  return out;
}
