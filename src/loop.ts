/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * loop.ts — THE CLI'S TURN ENGINE: the Glyphh loop itself (`@glyphh/sdk/loop`),
 * in this process, on the gateway. One engine, several hosts — the desktop's
 * Agent panel runs the same class; this file is the terminal's seat.
 *
 *   • The credential is the member's own gateway key (the SDK's token exchange),
 *     so the org's allow-list, budgets and prompt caching apply and every turn
 *     lands in Usage. No vendor login, no pod, no cloud sandbox: the run works
 *     in the user's shell directory with the loop's built-in files + shell tools.
 *   • Lent MCP servers: the gateway's connection tools (mcp_tool_search /
 *     mcp_tool_call) on the same key; and, when the desktop launched us
 *     (GLYPHH_APP_MCP_URL / GLYPHH_APP_MCP_TOKEN), the app's own glyphh_* tools.
 *   • A permission ask PARKS the run on an approval until the strip answers.
 *
 * Persistence is not here: the transcript is the process's; the engine keeps the
 * model-side conversation for the chat id it was given.
 */

import type { Client } from "@glyphh/sdk";
import { GlyphhLoop, type LoopEmit, type LoopGateway, type LoopMcpServer, type LoopPermission, type LoopTurn } from "@glyphh/sdk/loop";
import type { PermissionMode } from "./types.js";

/** A tool call as the transcript wants it. */
export interface ToolDone {
  failed: boolean;
  denied: boolean;
  preview: string;
}

/** A parked approval — the loop is BLOCKED until `answer` resolves it. */
export interface ApprovalRequest {
  id: string;
  kind: string;
  title: string;
  detail: string;
}

export interface LoopTurnHandlers {
  /** Streamed answer text — append. */
  onDelta: (text: string) => void;
  /** A tool began. `title` names the work ("bash npm test"). */
  onToolStart: (name: string, title?: string) => void;
  /** A tool finished (with its capped preview / failure state). */
  onToolDone: (name: string, result: ToolDone) => void;
  /** Live token accounting for the status strip. */
  onProgress?: (up: number, down: number) => void;
  /** The run is PARKED on an approval; call `answer` to resume it. */
  onApproval?: (req: ApprovalRequest, answer: (allow: boolean) => void) => void;
  /** Anything worth a transcript note (a lent server that would not connect). */
  onNote?: (text: string) => void;
}

/** What the turn needs of an engine — the SDK's loop, or a scripted one in tests. */
export interface LoopEngine {
  run(turn: LoopTurn, emit: LoopEmit): Promise<{ runId: string }>;
  stop(chatId: string): boolean;
  respondApproval(id: string, allow: boolean): boolean;
  forgetAll(): void;
  /** /mcp — the tool names the chat carries (empty before its first turn). */
  toolNames?(chatId: string): string[];
  /** /compact — fold the conversation so far into a summary, now. */
  compactNow?(chatId: string, emit?: LoopEmit): Promise<{ ok: boolean; error?: string }>;
}

export interface LoopTurnOptions {
  client: Client;
  /** Bare model id the TUI resolved (/model, --model, or the org's default). */
  model: string;
  /** This conversation's id — the engine keeps its messages under it; /clear mints a new one. */
  chatId: string;
  /** Prior turns, oldest first — seeds a conversation the engine has not seen. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  prompt: string;
  /** The user's shell directory; the loop anchors file and shell tools here. */
  cwd?: string;
  /** The TUI's permission chip. */
  permission: PermissionMode;
  /** Esc — aborts the run. */
  signal?: AbortSignal;
  /** Use THIS engine instead of the process's (tests). */
  engine?: LoopEngine;
}

export interface LoopTurnResult {
  /** Every delta, concatenated. */
  text: string;
  /** True when the user stopped the run. */
  stopped: boolean;
  /** Set when the run ended on an error event. */
  error?: string;
}

/** The chip → the loop's permission vocabulary: default asks, acceptEdits
 *  edits freely, plan reads only, bypass runs everything. */
export function loopPermission(mode: PermissionMode): LoopPermission {
  switch (mode) {
    case "bypass":
      return "auto";
    case "plan":
      return "plan";
    case "acceptEdits":
      return "acceptEdits";
    default:
      return "ask";
  }
}

// ── the process's engine ─────────────────────────────────────────────────────

let engine: GlyphhLoop | null = null;
let engineClient: Client | null = null;
let gatewayCache: LoopGateway | null = null;

/** The member's gateway credential, or null when the org's lane is off (the
 *  engine then refuses in its own words). Cached for the process: the exchange
 *  is idempotent and the key is the same every session. */
async function gatewayFor(client: Client): Promise<LoopGateway | null> {
  if (gatewayCache) return gatewayCache;
  const r = await client.gateway.token().catch(() => null);
  if (!r?.baseUrl || !r.token || r.gateway === false) return null;
  gatewayCache = { baseUrl: r.baseUrl, token: r.token };
  return gatewayCache;
}

/** The servers this terminal lends a run. */
async function mcpServersFor(client: Client): Promise<LoopMcpServer[]> {
  const out: LoopMcpServer[] = [];
  const appUrl = process.env.GLYPHH_APP_MCP_URL;
  const appToken = process.env.GLYPHH_APP_MCP_TOKEN;
  if (appUrl && appToken) out.push({ name: "glyphh-app", url: appUrl, headers: { Authorization: `Bearer ${appToken}` }, tag: "Glyphh" });
  const gw = await gatewayFor(client);
  if (gw) out.push({ name: "glyphh-gateway", url: `${gw.baseUrl.replace(/\/+$/, "")}/mcp`, headers: { Authorization: `Bearer ${gw.token}` }, tag: "connection" });
  return out;
}

/** The engine for this client (built once; a new client builds a new one). */
export function engineFor(client: Client, warn?: (text: string) => void): GlyphhLoop {
  if (engine && engineClient === client) return engine;
  engine?.forgetAll();
  engine = new GlyphhLoop({
    host: "terminal",
    gateway: () => gatewayFor(client),
    mcpServers: () => mcpServersFor(client),
    ...(warn ? { warn } : {}),
  });
  engineClient = client;
  return engine;
}

/** Sign-out / re-auth: the conversations and the credential die with the session. */
export function resetLoop(): void {
  engine?.forgetAll();
  engine = null;
  engineClient = null;
  gatewayCache = null;
}

// ── one turn ─────────────────────────────────────────────────────────────────

export async function runLoopTurn(opts: LoopTurnOptions, h: LoopTurnHandlers): Promise<LoopTurnResult> {
  const eng: LoopEngine = opts.engine ?? engineFor(opts.client, h.onNote);
  let text = "";
  let stopped = false;
  let error: string | undefined;

  const emit: LoopEmit = (ev) => {
    try {
      switch (ev.type) {
        case "delta":
          text += ev.delta;
          h.onDelta(ev.delta);
          return;
        case "tool":
          if (ev.phase === "start") h.onToolStart(ev.name, ev.title);
          else h.onToolDone(ev.name, { failed: ev.failed, denied: ev.preview === "not permitted in this mode", preview: ev.preview });
          return;
        case "progress":
          h.onProgress?.(ev.inTokens, ev.outTokens);
          return;
        case "approval":
          // The run is PARKED engine-side. If nothing can answer, deny at once
          // rather than leaving the user staring at a stalled spinner.
          if (!h.onApproval) {
            eng.respondApproval(ev.id, false);
            return;
          }
          h.onApproval({ id: ev.id, kind: ev.kind, title: ev.title, detail: ev.detail }, (allow) => {
            eng.respondApproval(ev.id, allow);
          });
          return;
        case "done":
          stopped = ev.stopped;
          return;
        case "error":
          error = ev.error;
          return;
        default:
          return; // setup / permission — nothing the transcript shows
      }
    } catch {
      /* a renderer fault never takes the run down */
    }
  };

  const onAbort = (): void => { eng.stop(opts.chatId); };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await eng.run({
      chatId: opts.chatId,
      text: opts.prompt,
      model: opts.model,
      permission: loopPermission(opts.permission),
      ...(opts.cwd ? { workdir: opts.cwd } : {}),
      history: opts.history.map((m) => ({ role: m.role, text: m.content })),
    }, emit);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  // A stop is the user's, not an error — the engine reports both on the same
  // settle; an aborted run that also errored reads as stopped.
  if (stopped && opts.signal?.aborted) error = undefined;
  return { text, stopped: stopped || !!opts.signal?.aborted, ...(error ? { error } : {}) };
}

// ── the slash commands' seams ────────────────────────────────────────────────

/** /mcp: the chat's tool names, split into the loop's own and the lent ones. */
export function toolsFor(client: Client, chatId: string): { builtin: string[]; lent: string[] } {
  const names = engineFor(client).toolNames(chatId);
  const own = new Set(["read_file", "write_file", "edit_file", "list_dir", "glob", "grep", "bash"]);
  return { builtin: names.filter((n) => own.has(n)), lent: names.filter((n) => !own.has(n)) };
}

/** /compact: fold the conversation now. Deltas (the "compacted" note) reach `onDelta`. */
export function compactChat(client: Client, chatId: string, onDelta?: (text: string) => void): Promise<{ ok: boolean; error?: string }> {
  return engineFor(client).compactNow(chatId, (ev) => { if (ev.type === "delta") onDelta?.(ev.delta); });
}
