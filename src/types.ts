/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * types.ts — the TUI's view model, derived purely from wire events. The chat is a
 * list of ITEMS (user lines, step sections, answers, notes, cards, commands) that
 * flatten to styled lines at render time (lines.ts); a turn accrues step receipts
 * while it streams and settles with per-turn meta (duration + tokens + credits).
 */

export type TurnStatus = "running" | "done" | "refused" | "error";

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
  /** Credits consumed this turn (whole credits), once known. */
  credits: number | null;
  stubbed: boolean;
  degraded: boolean;
}

/** One transcript item (flattened to lines at render time). */
export type Item =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "command"; text: string; result?: string[] }
  | { id: string; kind: "section"; step: TurnStep }
  | { id: string; kind: "answer"; text: string }
  | { id: string; kind: "meta"; text: string }
  | { id: string; kind: "note"; text: string }
  | { id: string; kind: "card"; title: string; body: string[] };

export type PermissionMode = "ask" | "auto" | "plan" | "read-only";
