/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * harness.ts — THE CLI'S TURN ENGINE: one harness, everywhere.
 *
 * A chat turn no longer runs an Agent SDK loop inside this process. It runs on
 * the MACHINE'S LOCAL HARNESS POD — rrotor in `ROTOR_MODE=harness`, auth off,
 * loopback-bound — the same pod the desktop drives and the same engine the
 * cloud provisions per session. The CLI is a renderer over the pod's frame
 * stream:
 *
 *   ensureLocalHarnessPod()  → the machine's one pod (singleton lock/discovery/
 *                              detached spawn; the SDK's runtime supervisor)
 *   client.harness({url})    → the `glyphh.harness/v1` client
 *   .start(body)             → POST /run, then frames over WS (or polled)
 *   .answer(id, …)/.stop()   → resume a parked ask/approval; abort the run
 *
 * The pod is LOCAL and auth-off, so it needs no bearer of its own: each run
 * carries the user's control-plane access token as `runtimeToken`, and every
 * model call inside the pod rides `${server}/api/gateway` with it — the metered
 * path, never a personal Anthropic login.
 *
 * Persistence is NOT here: threads.ts still owns the server thread store (one
 * push per completed turn). This module only turns a prompt into frames.
 */

import { ensureLocalHarnessPod } from "@glyphh/sdk/runtime";
import type {
  Client,
  HarnessAskQuestion,
  HarnessChatTurn,
  HarnessClient,
  HarnessMcpServerRef,
  HarnessMode,
  HarnessPermission,
  HarnessWireFrame,
} from "@glyphh/sdk";
import { mintMcpGrant } from "./mcp-grant.js";
import type { PermissionMode } from "./types.js";

/** Loopback frame polling when this Node has no global `WebSocket` (< 21) —
 *  tight, because the pod is on this machine. With a socket it never polls. */
const POLL_MS = 120;

/** Micro-credits → whole credits (the server's `microToCredits`). */
const MICRO = 1_000_000;

/** The name the server's `/mcp` surface is lent under (`glyphh` is reserved by
 *  the pod for its own ask_user server). Tools arrive as `mcp__platform__*`. */
const LENT_SERVER = "platform";

/** Strip any MCP server prefix so a receipt reads `list_loops`, not
 *  `mcp__platform__list_loops`. (The pod already strips its own.) */
export const bareToolName = (name: string): string => name.replace(/^mcp__[a-z0-9_-]+__/i, "");

/** A tool call as the transcript wants it. */
export interface ToolDone {
  failed: boolean;
  denied: boolean;
  preview: string;
}

/** A parked approval — the pod is BLOCKED until `answer` resolves it. */
export interface ApprovalRequest {
  id: string;
  kind: string;
  title: string;
  detail: string;
}

/** A parked ask (the pod's `ask_user`) — also blocking. */
export interface AskRequest {
  id: string;
  questions: HarnessAskQuestion[];
}

export interface HarnessTurnHandlers {
  /** Streamed answer text — append. */
  onDelta: (text: string) => void;
  /** A tool began. `title` is the pod's human phrasing ("Run npm test"). */
  onToolStart: (name: string, title?: string) => void;
  /** A tool finished (with its capped preview / failure state). */
  onToolDone: (name: string, result: ToolDone) => void;
  /** Live token accounting for the status strip. */
  onProgress?: (up: number, down: number) => void;
  /** Metered price so far, in WHOLE credits (pod v1 never emits this). */
  onCredits?: (credits: number) => void;
  /** The run is PARKED on an approval; call `answer` to resume it. */
  onApproval?: (req: ApprovalRequest, answer: (allow: boolean) => void) => void;
  /** The run is PARKED on a question; call `answer` to resume it. */
  onAsk?: (req: AskRequest, answer: (answers: string[]) => void) => void;
  /** Anything the pod says out of band (setup phases) — a transcript note. */
  onNote?: (text: string) => void;
}

export interface HarnessTurnOptions {
  client: Client;
  /** Control-plane base URL — the pod's gateway is `${server}/api/gateway`. */
  server: string;
  /** Bare model id the loop resolved. */
  model: string;
  /** The CLI's thread id (threads.ts) — scopes the pod-side transcript too. */
  threadId: string;
  /** Prior turns, oldest first. */
  history: HarnessChatTurn[];
  prompt: string;
  /** The user's shell directory. The pod ANCHORS the run here (`workdir` on
   *  POST /run, honored because the pod is local) — its preset tools operate on
   *  the real folder, so a relative path means what the user thinks it means. */
  cwd?: string;
  /** The TUI's permission chip. */
  permission: PermissionMode;
  /** Session mode; `code` gets the sandbox toolset + `ask_user`. */
  mode?: HarnessMode;
  /** Esc — aborts the run (routed to the pod's `POST /runs/:id/stop`). */
  signal?: AbortSignal;
  // ── test seams ─────────────────────────────────────────────────────────────
  /** Resolve the pod (default: the SDK's `ensureLocalHarnessPod`). */
  ensurePod?: () => Promise<{ url: string }>;
  /** Open the pod client (default: `client.harness({url})`). */
  openHarness?: (url: string) => HarnessClient;
  /** Mint the `/mcp` bearer (default: the cached process-wide grant). */
  mintGrant?: () => Promise<string>;
}

export interface HarnessTurnResult {
  /** Every `delta`, concatenated. */
  text: string;
  /** True when the user (or the pod) aborted the run. */
  stopped: boolean;
  /** Set when the run terminated with an `error` frame. */
  error?: string;
}

/**
 * Is the local-harness chat path ON? DEFAULT OFF — flip with
 * `GLYPHH_LOCAL_ROTOR=1`.
 *
 * The BEHAVIOURAL blockers are gone (both verified live against a real model):
 * the pod's permission gate enforces — `plan` denies a Write with the model
 * re-planning and nothing on disk, `ask` PARKS on an `approval` frame that
 * (y)es runs and (n)o refuses — and a run is anchored at the user's own shell
 * directory (`workdir`), so a relative-path edit lands in their folder, not the
 * pod's sandbox. The server's governed tool surface is lent back to the pod
 * ({@link lentToolSurface}), so no capability is lost either.
 *
 * WHAT STILL BLOCKS THE FLIP: PACKAGING. Nothing ships `rrotor` to someone who
 * installed this CLI from npm — `@glyphh/rrotor` is not on the registry (404),
 * and the supervisor's fallbacks are `$GLYPHH_LOCAL_ROTOR_CMD`, `$GLYPHH_ROTOR_BIN`,
 * then `rrotor` on PATH. Defaulting to ON today turns EVERY turn into "the local
 * Glyphh harness couldn't start" for anyone outside this monorepo. Ship the pod
 * with the CLI (publish it, bundle it, or have the desktop installer put it on
 * PATH), then default this to on and delete agent.ts — nothing else is in the way.
 */
export function localHarnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GLYPHH_LOCAL_ROTOR === "1";
}

/** The TUI's four-mode chip → the harness's permission vocabulary. Both
 *  "plan" and "read-only" map to the pod's read-only `plan` gate. */
export function harnessPermission(mode: PermissionMode): HarnessPermission {
  switch (mode) {
    case "auto":
      return "auto";
    case "plan":
    case "read-only":
      return "plan";
    default:
      return "ask";
  }
}

/**
 * The CLI's system prompt. The run is ANCHORED at the user's shell directory
 * (the body's `workdir`), so "here" and every relative path already resolve
 * where the user expects — this just tells the agent that, and that it is
 * expected to do the work rather than dictate commands.
 */
export function cliSystemPrompt(cwd?: string): string {
  return [
    "You are Glyphh, the user's agent, running on the user's OWN MACHINE and rendered in their terminal.",
    cwd
      ? `Your working directory IS the user's shell directory, ${cwd} — "here", "this project", and every relative path resolve there. It is their real folder, not a scratch sandbox: treat it with care.`
      : "You are in the user's own working directory — relative paths resolve there.",
    "You have Bash (shell), Read/Write/Edit (files), Glob/Grep (search) and WebFetch/WebSearch (the web). USE them to do the work — create the files, run the commands, read the pages. Never tell the user to paste a command into a terminal themselves; you are already in one.",
    "You also have the user's Glyphh tools (mcp__platform__*): their apps, loops, skills, agents and governed connections.",
    "Use ask_user when a decision is genuinely the user's. When a tool errors, read the message and adapt rather than giving up.",
    "Answer directly and concisely.",
  ].join(" ");
}

/** Cached pod clients, keyed by pod URL — one per process, not per turn. */
const clients = new Map<string, HarnessClient>();

function podClient(opts: HarnessTurnOptions, url: string): HarnessClient {
  if (opts.openHarness) return opts.openHarness(url);
  const hit = clients.get(url);
  if (hit) return hit;
  // No token: the LOCAL pod runs with auth off (it loopback-binds itself for
  // exactly that reason). The gateway credential rides each run instead.
  const made = opts.client.harness({ url, run: { pollMs: POLL_MS } });
  clients.set(url, made);
  return made;
}

/** Start (or attach to) the machine's harness pod. Failure is REPORTED, never
 *  thrown raw: the caller turns it into one honest transcript line. */
async function resolvePod(opts: HarnessTurnOptions): Promise<string> {
  try {
    const pod = opts.ensurePod ? await opts.ensurePod() : await ensureLocalHarnessPod();
    return pod.url;
  } catch (err) {
    throw new Error(
      `the local Glyphh harness couldn't start (${(err as Error).message}). Install rrotor, or point GLYPHH_LOCAL_ROTOR_CMD at a local build.`,
    );
  }
}

/**
 * LEND the run the server's governed tool surface (`/mcp`: platform tools, the
 * user's connections, the attached desktop's reach) as an HTTP MCP server —
 * the same surface the embedded loop wires into its own `query()`, so moving
 * the loop into the pod costs no capability. Every lent tool still passes the
 * pod's gate per call.
 *
 * Best-effort by design: if the grant can't be minted the turn RUNS with the
 * sandbox toolset and says so once, rather than failing over a tool the user
 * may not even need.
 */
async function lentToolSurface(opts: HarnessTurnOptions, h: HarnessTurnHandlers): Promise<HarnessMcpServerRef[]> {
  const base = opts.server.replace(/\/+$/, "");
  try {
    const grant = opts.mintGrant ? await opts.mintGrant() : await mintMcpGrant(opts.client, base);
    // NOT "glyphh" — the pod reserves that name for its own ask_user server and
    // 400s the run if a lent server claims it.
    return [{ name: LENT_SERVER, url: `${base}/mcp`, headers: { authorization: `Bearer ${grant}` } }];
  } catch (err) {
    h.onNote?.(
      `(your Glyphh tools — apps, loops, connections — aren't available this turn: ${(err as Error).message})`,
    );
    return [];
  }
}

/**
 * Run ONE turn on the local harness pod. Streams through `h`; resolves with the
 * terminal result. Throws only when the pod itself is unreachable — an `error`
 * FRAME resolves normally with `error` set (the run happened, and failed).
 */
export async function runHarnessTurn(opts: HarnessTurnOptions, h: HarnessTurnHandlers): Promise<HarnessTurnResult> {
  const url = await resolvePod(opts);
  const harness = podClient(opts, url);
  const runtimeToken = await opts.client.token();
  const mcpServers = await lentToolSurface(opts, h);

  const run = harness.start({
    prompt: opts.prompt,
    threadId: opts.threadId,
    mode: opts.mode ?? "code",
    model: opts.model,
    permission: harnessPermission(opts.permission),
    system: cliSystemPrompt(opts.cwd),
    history: opts.history,
    // The pod is LOCAL, so it honors a host path: anchor the run at the user's
    // shell directory instead of the pod's per-session sandbox workspace.
    ...(opts.cwd ? { workdir: opts.cwd } : {}),
    ...(mcpServers.length ? { mcpServers } : {}),
    gatewayUrl: `${opts.server.replace(/\/+$/, "")}/api/gateway`,
    runtimeToken,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const unsubscribe = run.on((frame: HarnessWireFrame) => {
    try {
      route(frame, run, h);
    } catch {
      /* a renderer fault never takes the run down */
    }
  });

  try {
    const result = await run.done;
    return {
      text: result.text,
      stopped: result.stopped,
      ...(result.error ? { error: result.error } : {}),
    };
  } finally {
    unsubscribe();
  }
}

/** THE FRAME → TUI MAP. Every pod frame has exactly one transcript meaning. */
function route(
  frame: HarnessWireFrame,
  run: { answer: (id: string, reply: { allow?: boolean; answers?: string[] }) => Promise<void> },
  h: HarnessTurnHandlers,
): void {
  switch (frame.type) {
    case "delta":
      h.onDelta(frame.delta);
      return;
    case "tool":
      if (frame.phase === "start") h.onToolStart(bareToolName(frame.name), frame.thought ?? frame.title);
      else {
        h.onToolDone(bareToolName(frame.name), {
          failed: Boolean(frame.failed),
          denied: Boolean(frame.denied),
          preview: frame.preview ?? "",
        });
      }
      return;
    case "progress":
      h.onProgress?.(frame.inTokens, frame.outTokens);
      return;
    case "credits":
      h.onCredits?.(Math.round(frame.creditsMicro / MICRO));
      return;
    case "approval":
      // The run is PARKED pod-side. If nothing can answer, deny immediately
      // rather than leaving the user staring at a stalled spinner.
      if (!h.onApproval) {
        void run.answer(frame.id, { allow: false });
        return;
      }
      h.onApproval({ id: frame.id, kind: frame.kind, title: frame.title, detail: frame.detail }, (allow) => {
        void run.answer(frame.id, { allow });
      });
      return;
    case "ask":
      if (!h.onAsk) {
        void run.answer(frame.id, { answers: [] });
        return;
      }
      h.onAsk({ id: frame.id, questions: frame.questions }, (answers) => {
        void run.answer(frame.id, { answers });
      });
      return;
    case "setup":
      h.onNote?.(`setup: ${String(frame.phase)}`);
      return;
    default:
      return; // done/error settle `run.done` — handled by the caller
  }
}
