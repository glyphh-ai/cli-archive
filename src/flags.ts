/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * flags.ts — the command line. What the desktop passes when it opens the Glyphh
 * loop in a terminal card, and what a person types. Pure, so it is tested.
 */

import type { PermissionMode } from "./types.js";

export interface Flags {
  model?: string;
  permission?: PermissionMode;
  bridgeUrl?: string;
  prompt?: string;
}

/** The permission words every Glyphh surface uses → this TUI's chip. acceptEdits
 *  has no chip of its own: it lands on ask (edits then ask like anything else). */
export function permissionFlag(raw: string): PermissionMode | undefined {
  switch (raw) {
    case "plan": return "plan";
    case "auto": return "auto";
    case "ask": case "acceptEdits": return "ask";
    case "read-only": case "readonly": return "read-only";
    default: return undefined;
  }
}

/** Parse argv. Unknown `--flags` are refused with a usage line; bare words are the prompt. */
export function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--model") { const v = argv[++i]; if (v) out.model = v; continue; }
    if (a.startsWith("--model=")) { out.model = a.slice(8); continue; }
    if (a === "--permission") { const p = permissionFlag(argv[++i] ?? ""); if (p) out.permission = p; continue; }
    if (a.startsWith("--permission=")) { const p = permissionFlag(a.slice(13)); if (p) out.permission = p; continue; }
    if (a === "--bridge") { out.bridgeUrl = process.env.GLYPHH_BRIDGE_URL ?? "http://127.0.0.1:4747"; continue; }
    if (a.startsWith("--")) {
      process.stderr.write(`glyphh: unknown flag ${a}\nusage: glyphh [--model <id>] [--permission ask|plan|acceptEdits|auto] [--bridge] [prompt…]\n`);
      process.exit(2);
    }
    words.push(a);
  }
  const prompt = words.join(" ").trim();
  if (prompt) out.prompt = prompt;
  return out;
}
