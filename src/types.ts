/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * types.ts — the TUI's view model. Chat is a list of messages; an assistant message
 * accrues text as the run streams and carries per-turn meta (credits + duration).
 */

export type Role = "user" | "assistant" | "system" | "command";

export type TurnStatus = "running" | "done" | "error";

export interface TurnMeta {
  status: TurnStatus;
  /** Credits consumed this turn (whole credits), once known. */
  credits: number | null;
  /** Wall-clock duration in ms. */
  durationMs: number | null;
}

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  /** Assistant-only: still streaming. */
  streaming?: boolean;
  /** Assistant-only: per-turn meta. */
  meta?: TurnMeta;
  /** A `└ …` continuation under a user/command line (a status or command output). */
  result?: string[];
}

export type PermissionMode = "ask" | "auto" | "plan" | "read-only";
