/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * harness.ts — THE CLI'S TURN ENGINE: one harness, several hosts.
 *
 * A chat turn is not an Agent SDK loop inside this process. It runs on a
 * HARNESS POD — rrotor in `ROTOR_MODE=harness` — and the CLI is a renderer over
 * that pod's frame stream. Two hosts, decided ONCE per session ({@link resolveHarnessHost}):
 *
 *   LOCAL  the machine's own pod (auth off, loopback-bound), started/attached by
 *          the SDK's runtime supervisor. Its cwd is the USER'S OWN FOLDER, and
 *          each run carries the user's access token as `runtimeToken` so every
 *          model call rides `${server}/api/gateway` — metered, never a personal
 *          Anthropic login.
 *   CLOUD  a provisioned shared runtime (`sessions.create` → `runtimeUrl` +
 *          `runtimeToken`), exactly as the web opens one. Auth is ON, so the
 *          pod carries its OWN gateway credential and we send neither
 *          `runtimeToken` nor `gatewayUrl`. It runs in a cloud sandbox — NOT
 *          the user's folder — and the transcript says so, once.
 *
 * Same wire either way: `.start(body)` → frames (WS, or polled when the socket
 * can't carry a bearer) → `.answer(id, …)` for a parked ask/approval, `.stop()`
 * to abort. Only the address and those two body fields differ.
 *
 * Persistence is NOT here: threads.ts still owns the server thread store (one
 * push per completed turn). This module only turns a prompt into frames.
 */

import { ensureLocalHarnessPod } from "@glyphh/sdk/runtime";
import { staticTokenProvider } from "@glyphh/sdk";
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

/** Frame polling when the socket path is unavailable (no global `WebSocket`, or
 *  an auth-ON pod that rejects a header-less upgrade). Tight on loopback,
 *  easier on a cloud pod we'd otherwise hammer. */
const POLL_MS = { local: 120, cloud: 400 } as const;

/** How long to wait for a freshly provisioned cloud runtime to come up. */
const READY_POLL_MS = 1000;
const READY_POLL_TRIES = 45;

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
  /** Use THIS host instead of resolving one (tests; also lets a caller pin a host). */
  host?: HarnessHost;
  /** Start/attach the local pod (default: the SDK's `ensureLocalHarnessPod`). */
  ensurePod?: () => Promise<{ url: string }>;
  /** Open the pod client (default: `client.harness({url, token})`). */
  openHarness?: (host: HarnessHost) => HarnessClient;
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

/** WHERE a turn runs. Decided once per session by {@link resolveHarnessHost}. */
export interface HarnessHost {
  kind: "local" | "cloud";
  /** The pod's base URL. */
  url: string;
  /** The pod's bearer. Absent for LOCAL (auth off); the provisioned
   *  `runtimeToken` for CLOUD (auth on, introspected server-side). */
  token?: string;
  /** The provisioned session id (cloud only). */
  sessionId?: string;
}

/** The session's host, once chosen. A rejected attempt is NOT cached — the next
 *  turn re-tries, because "offline for a moment" must not poison the session. */
let hostChoice: Promise<HarnessHost> | null = null;
/** True once the transcript has been told which host is running this session. */
let hostAnnounced = false;

/** Forget the chosen host (a new sign-in gets a fresh runtime + a fresh line). */
export function resetHarnessHost(): void {
  hostChoice = null;
  hostAnnounced = false;
}

/**
 * WHERE THIS SESSION RUNS — local pod if one is running or can be started,
 * otherwise the shared cloud runtime. Decided ONCE and remembered: a session
 * never switches engines mid-flight, and a machine without rrotor pays the
 * supervisor's start timeout exactly once, not once per turn.
 */
export async function resolveHarnessHost(opts: HarnessTurnOptions): Promise<HarnessHost> {
  if (opts.host) return opts.host;
  if (!hostChoice) {
    hostChoice = pickHost(opts).catch((err: unknown) => {
      hostChoice = null; // transient: let the next turn try again
      throw err;
    });
  }
  return hostChoice;
}

async function pickHost(opts: HarnessTurnOptions): Promise<HarnessHost> {
  let localErr: unknown;
  try {
    const pod = opts.ensurePod ? await opts.ensurePod() : await ensureLocalHarnessPod();
    return { kind: "local", url: pod.url };
  } catch (err) {
    localErr = err;
  }
  try {
    return await provisionCloudPod(opts);
  } catch (cloudErr) {
    throw new Error(
      `no Glyphh harness is available — local: ${(localErr as Error).message}; cloud: ${(cloudErr as Error).message}`,
    );
  }
}

/** Provision the shared cloud runtime, exactly as the web does: create, then
 *  poll until it is `ready` and has a url. */
async function provisionCloudPod(opts: HarnessTurnOptions): Promise<HarnessHost> {
  const provisioned = await opts.client.sessions.create({ rotor: "default" });
  const token = provisioned.runtimeToken;
  let session = provisioned.session;
  if (!token || !session?.id) throw new Error("provisioning returned no runtime");
  for (let i = 0; session.status === "provisioning" && i < READY_POLL_TRIES; i++) {
    await sleep(READY_POLL_MS);
    session = await opts.client.sessions.get(session.id);
  }
  if (session.status !== "ready" || !session.runtimeUrl) {
    throw new Error(`runtime ${session.status}${session.runtimeUrl ? "" : " (no runtime url)"}`);
  }
  return { kind: "cloud", url: session.runtimeUrl, token, sessionId: session.id };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Say — ONCE per session, and only when it changes what the user should expect
 *  — that this session is cloud-backed and its files are not in their folder. */
function announceHost(host: HarnessHost, h: HarnessTurnHandlers): void {
  if (hostAnnounced || host.kind === "local") {
    hostAnnounced = true;
    return;
  }
  hostAnnounced = true;
  h.onNote?.(
    "Running on the Glyphh cloud runtime — no local harness found. Work happens in a cloud sandbox, so files it creates are NOT in this folder.",
  );
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
 * The CLI's system prompt — HONEST ABOUT WHERE IT IS, because that changes what
 * the agent may promise. A LOCAL run is anchored at the user's own shell
 * directory (`workdir`), so "here" is their folder. A CLOUD run is in a remote
 * sandbox that cannot see that folder at all, and saying otherwise would make
 * the agent claim files the user will never find.
 */
export function cliSystemPrompt(kind: HarnessHost["kind"], cwd?: string, tools = true): string {
  const parts = [
    kind === "local"
      ? "You are Glyphh, the user's agent, running on the user's OWN MACHINE and rendered in their terminal."
      : "You are Glyphh, the user's agent, running in a Glyphh CLOUD SANDBOX and rendered in their terminal.",
    kind === "local"
      ? cwd
        ? `Your working directory IS the user's shell directory, ${cwd} — "here", "this project", and every relative path resolve there. It is their real folder, not a scratch sandbox: treat it with care.`
        : "You are in the user's own working directory — relative paths resolve there."
      : `Your working directory is a REMOTE sandbox, not the user's machine${cwd ? ` (their terminal is in ${cwd}, which you cannot read or write)` : ""}. Files you create live only in the sandbox — never claim you changed something on their computer, and say so plainly if they ask you to.`,
    "You have Bash (shell), Read/Write/Edit (files), Glob/Grep (search) and WebFetch/WebSearch (the web). USE them to do the work — create the files, run the commands, read the pages. Never tell the user to paste a command into a terminal themselves; you are already in one.",
  ];
  if (tools) {
    parts.push("You also have the user's Glyphh tools (mcp__platform__*): their apps, loops, skills, agents and governed connections.");
  }
  parts.push(
    "Use ask_user when a decision is genuinely the user's. When a tool errors, read the message and adapt rather than giving up.",
    "Answer directly and concisely.",
  );
  return parts.join(" ");
}

/** Cached pod clients, keyed by pod URL — one per process, not per turn. */
const clients = new Map<string, HarnessClient>();

function podClient(opts: HarnessTurnOptions, host: HarnessHost): HarnessClient {
  if (opts.openHarness) return opts.openHarness(host);
  const hit = clients.get(host.url);
  if (hit) return hit;
  // LOCAL needs no bearer (auth off — that is why it loopback-binds). CLOUD
  // authorizes every request with the provisioned runtime token; its WS upgrade
  // can't carry a header, so that path settles into polling the frames endpoint.
  const made = opts.client.harness({
    url: host.url,
    ...(host.token ? { token: staticTokenProvider(host.token) } : {}),
    run: { pollMs: POLL_MS[host.kind] },
  });
  clients.set(host.url, made);
  return made;
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
async function lentToolSurface(
  opts: HarnessTurnOptions,
  host: HarnessHost,
  h: HarnessTurnHandlers,
): Promise<HarnessMcpServerRef[]> {
  const base = opts.server.replace(/\/+$/, "");
  if (!reachableFromPod(base, host)) {
    // A remote pod dialing "127.0.0.1" would reach ITSELF, not our server —
    // lending that would hand the run a surface that silently fails.
    h.onNote?.("(your Glyphh tools aren't available on the cloud runtime: this control plane is only reachable from your machine)");
    return [];
  }
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

/** Can the POD reach our control plane? A local pod shares the machine, so
 *  anything goes; a cloud pod needs a publicly routable host. */
export function reachableFromPod(server: string, host: HarnessHost): boolean {
  if (host.kind === "local") return true;
  let parsed: URL;
  try {
    parsed = new URL(server);
  } catch {
    return false;
  }
  const h = parsed.hostname;
  return !(
    h === "localhost" ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /\.local$/.test(h)
  );
}

/**
 * Run ONE turn on this session's harness pod. Streams through `h`; resolves with the
 * terminal result. Throws only when the pod itself is unreachable — an `error`
 * FRAME resolves normally with `error` set (the run happened, and failed).
 */
export async function runHarnessTurn(opts: HarnessTurnOptions, h: HarnessTurnHandlers): Promise<HarnessTurnResult> {
  const host = await resolveHarnessHost(opts);
  announceHost(host, h);
  const harness = podClient(opts, host);
  const mcpServers = await lentToolSurface(opts, host, h);
  const local = host.kind === "local";

  const run = harness.start({
    prompt: opts.prompt,
    threadId: opts.threadId,
    mode: opts.mode ?? "code",
    model: opts.model,
    permission: harnessPermission(opts.permission),
    system: cliSystemPrompt(host.kind, opts.cwd, mcpServers.length > 0),
    history: opts.history,
    ...(mcpServers.length ? { mcpServers } : {}),
    // LOCAL: the pod shares this machine, so anchor the run at the user's shell
    // directory and lend it OUR gateway credential (it has none of its own).
    // CLOUD: `workdir` is refused (400) and the pod carries its own gateway
    // credential — so send neither and let the provisioned runtime be itself.
    ...(local && opts.cwd ? { workdir: opts.cwd } : {}),
    ...(local
      ? { gatewayUrl: `${opts.server.replace(/\/+$/, "")}/api/gateway`, runtimeToken: await opts.client.token() }
      : {}),
    ...(host.sessionId ? { sessionId: host.sessionId } : {}),
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
