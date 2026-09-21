/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * types.ts — the TUI's own shapes: a turn, a transcript item, the permission chip.
 */

export type TurnStatus = "running" | "done" | "error" | "stopped";

/** One tool/model step of a running turn, rendered as a collapsible receipt. */
export interface TurnStep {
  label: string;
  ok: boolean;
  /** Client-observed arrival spacing (s), when ≥ 0.1. */
  secs?: number;
  tokens?: { up: number; down: number };
  /** Summarized output facts / body lines tabbed under the step. */
  details: string[];
  error?: string;
}

/** The newest assistant turn (running or settled) — drives the status strip. */
export interface ChatTurn {
  id: string;
  text: string;
  status: TurnStatus;
  durationMs?: number;
  tokensUp: number;
  tokensDown: number;
}

/** One transcript item (flattened to lines at render time). */
export type Item =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "command"; text: string; result?: string[] }
  | { id: string; kind: "section"; step: TurnStep }
  | { id: string; kind: "answer"; text: string }
  | { id: string; kind: "note"; text: string };

/** THE PERMISSION MODES — the same four every agent CLI speaks (his order,
 *  2026-09-21): default asks before edits and commands, acceptEdits edits
 *  freely and asks for commands, plan reads only, bypass runs everything.
 *  shift+tab cycles the first three; bypass is asked for by name. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"];
/** The chip's cycle (shift+tab) — bypass stays out of it, like every other CLI. */
export const PERMISSION_CYCLE: readonly PermissionMode[] = ["default", "acceptEdits", "plan"];

/** Every spelling the flag, the desktop and other CLIs use → our word. */
export function permissionModeOf(raw: string | undefined): PermissionMode | undefined {
  switch ((raw ?? "").trim()) {
    case "default": case "ask": return "default";
    case "acceptEdits": case "accept-edits": case "accept": return "acceptEdits";
    case "plan": case "read-only": case "readonly": return "plan";
    case "bypass": case "bypassPermissions": case "bypass-permissions": case "auto": case "yolo": return "bypass";
    default: return undefined;
  }
}

/** The chip's label, as the footer and /permissions print it. */
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: "default · asks before edits and commands",
  acceptEdits: "accept edits · asks before commands",
  plan: "plan · read-only",
  bypass: "bypass permissions · runs everything",
};
