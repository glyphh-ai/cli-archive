/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * agent.ts — THE DESKTOP AGENT, in CLI form. The same engine the desktop runs
 * (`glyphh-agent.ts`), re-hosted in a terminal process:
 *
 *   • the Claude Agent SDK drives the loop (streaming partials, tool turns)
 *   • every model call rides the SDK INTERCEPTOR → the metering gateway with the
 *     caller's bearer (`startInterceptor` — the exact seam the desktop uses)
 *   • the tool surface is the server's governed /mcp endpoint: platform tools,
 *     the user's connections, and the attached desktop's tools (open apps,
 *     layouts…) — the same surface, served by the same control plane
 *   • the subprocess gets an app-owned CLAUDE_CONFIG_DIR so it can never ride a
 *     personal ~/.claude login instead of the org's metered path
 *
 * The only thing that differs from the desktop is the renderer.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Client } from "@glyphh/client";
import { startInterceptor, type Interceptor } from "@glyphh/client/runtime";

/** App-owned config home for the agent subprocess (never ~/.claude). */
function agentConfigDir(): string {
  const dir = join(process.env.GLYPHH_HOME ?? join(homedir(), ".glyphh"), "agent-config");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── The interceptor: one per process, started lazily. ────────────────────────
let interceptor: Interceptor | null = null;
async function ensureInterceptor(client: Client): Promise<Interceptor> {
  if (!interceptor) interceptor = await startInterceptor({ client });
  return interceptor;
}

// ── The /mcp grant: an OAuth token (gy_mt_) minted headlessly with the user's
//    session — register → consent → code → exchange, PKCE throughout. ─────────
let grantCache: { server: string; token: string } | null = null;

async function mintMcpGrant(client: Client, server: string): Promise<string> {
  if (grantCache?.server === server) return grantCache.token;
  const base = server.replace(/\/+$/, "");
  const redirect = "http://127.0.0.1:1/callback"; // never followed — the code comes back in JSON
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const reg = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Glyphh CLI", redirect_uris: [redirect] }),
  }).then((r) => r.json() as Promise<{ client_id: string }>);

  const consent = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await client.token()}` },
    body: JSON.stringify({
      client_id: reg.client_id,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
    }),
  }).then((r) => r.json() as Promise<{ data?: { redirectTo?: string } }>);
  const redirectTo = consent.data?.redirectTo;
  const code = redirectTo ? new URL(redirectTo).searchParams.get("code") : null;
  if (!code) throw new Error("mcp grant: consent returned no code");

  const tok = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: reg.client_id,
      code_verifier: verifier,
    }),
  }).then((r) => r.json() as Promise<{ access_token?: string }>);
  if (!tok.access_token) throw new Error("mcp grant: token exchange failed");

  grantCache = { server, token: tok.access_token };
  return tok.access_token;
}

/** Drop cached auth material (call when the session dies / rotates). */
export function resetAgentAuth(): void {
  grantCache = null;
}

// ── The turn ─────────────────────────────────────────────────────────────────

export interface AgentTurnHandlers {
  /** A streamed text delta — append to the live answer. */
  onDelta: (text: string) => void;
  /** The model called a tool (name is the bare tool name, input its args). */
  onTool: (name: string, input: unknown) => void;
  /** A tool finished; `content` is its (string-flattened, capped) result. */
  onToolResult: (content: string, isError: boolean) => void;
  /** Live, ESTIMATED token progress for the spinner strip while the turn runs
   *  (input from the prompt, output from the streamed text so far). */
  onProgress?: (up: number, down: number) => void;
  /** REAL usage from the SDK result — replaces the estimate when the turn ends.
   *  `up` = input (incl. cache) tokens, `down` = output tokens. */
  onUsage?: (up: number, down: number, costUsd: number) => void;
}

export interface AgentTurnOptions {
  client: Client;
  server: string;
  /** Bare model id the loop resolved (the desktop's effectiveModel equivalent). */
  model: string;
  /** Prior turns, oldest first — assembled into the prompt like the desktop does. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  prompt: string;
  cwd?: string;
  /**
   * The PERMISSION GATE — the TUI's equivalent of the desktop's approval cards.
   * Called before every tool runs; resolve false to refuse it. Omitted = allow
   * (server-side governance still applies to every call).
   */
  gate?: (tool: string, input: unknown) => Promise<boolean>;
}

const SYSTEM = [
  "You are Glyphh, the user's coding agent, running in a terminal ON THE USER'S MACHINE in their current working directory. Answer directly and concisely.",
  "You have the full local toolset: Bash (run shell commands), Read/Write/Edit (files), Glob/Grep (search), and WebFetch/WebSearch (read the web). USE THEM to do real work here — create directories, write files, run commands, fetch pages. Do not tell the user to paste commands into a terminal themselves; you ARE in the terminal, so just do it.",
  "You also have Glyphh platform tools (apps, loops, skills, agents) and the user's governed connections (mcp__glyphh__*).",
  "The desktop_* tools reach a SEPARATE attached desktop app to control ITS windows/apps/layouts — use them ONLY to control that desktop, never for local work (to read a web page use WebFetch, not desktop_scrape_page; to make a file use Write, not the desktop).",
  "Prefer the simplest tool that does the job locally. When a tool errors, read its message and adapt rather than giving up.",
].join(" ");

/** Assemble the per-run prompt the way the desktop does (persistSession is off —
 *  each run carries its own recent history). */
function assemblePrompt(history: AgentTurnOptions["history"], prompt: string): string {
  if (!history.length) return prompt;
  const recent = history.slice(-20);
  const block = recent.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  return `<conversation so far>\n${block}\n</conversation so far>\n\n${prompt}`;
}

const cap = (s: string, n = 600): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Pretty-print a JSON string (object/array) so a tool result reads as many
 *  short lines — readable AND foldable — instead of one raw blob. Non-JSON
 *  (bash output, plain text) passes through untouched. */
function prettyJson(s: string): string {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return s;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return s; }
}

/** Flatten a tool_result content payload to displayable text. */
function flattenResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "object" && b && (b as { type?: string }).type === "text" ? ((b as { text?: string }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content, null, 2);
}

/**
 * Run ONE agent turn. Streams via handlers; resolves with the final text.
 * Throws on a run-level failure (auth, spawn, provider) with a clean message.
 */
export async function runAgentTurn(opts: AgentTurnOptions, h: AgentTurnHandlers): Promise<string> {
  const { client, server, model, history, prompt, cwd } = opts;
  const endpoint = await ensureInterceptor(client);
  const grant = await mintMcpGrant(client, server);

  let finalText = "";
  let sawPartials = false;
  let pendingSep = false;
  let runError = "";
  let lastProgressAt = 0;
  // Live INPUT estimate (~4 chars/token) so the strip shows a plausible ↑ while
  // the turn runs — real numbers land from the result's usage at the end.
  const assembled = assemblePrompt(history, prompt);
  const upEstimate = Math.ceil((assembled.length + SYSTEM.length) / 4);

  const q = query({
    prompt: assembled,
    options: {
      ...(cwd ? { cwd } : {}),
      model,
      systemPrompt: SYSTEM,
      settingSources: [],
      // The full Claude Code local toolset (Bash/Read/Write/Edit/Glob/Grep/
      // WebFetch/WebSearch) — the CLI runs ON the user's machine, so these are
      // exactly the tools that let it do real work. The Glyphh MCP surface
      // (platform + connections + desktop reach) is layered on top. Every call
      // still passes through canUseTool below, so nothing runs unapproved.
      tools: { type: "preset", preset: "claude_code" },
      mcpServers: {
        glyphh: { type: "http", url: `${server.replace(/\/+$/, "")}/mcp`, headers: { authorization: `Bearer ${grant}` } },
      },
      // The gate decides per call (ask/auto/read-only in the TUI); server-side
      // governance applies regardless. No gate = allow.
      canUseTool: async (tool, input) => {
        const ok = opts.gate ? await opts.gate(tool.replace(/^mcp__glyphh__/, ""), input) : true;
        return ok
          ? { behavior: "allow" as const, updatedInput: input }
          : { behavior: "deny" as const, message: "The user declined this tool call." };
      },
      permissionMode: "default",
      persistSession: false,
      includePartialMessages: true,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: endpoint.url,
        ANTHROPIC_API_KEY: endpoint.apiKey,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CONFIG_DIR: agentConfigDir(),
        CLAUDE_CODE_USE_BEDROCK: undefined,
        CLAUDE_CODE_USE_VERTEX: undefined,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
      },
    },
  });

  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === "stream_event") {
      const ev = (msg as unknown as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        sawPartials = true;
        if (pendingSep && finalText) {
          finalText += "\n\n";
          h.onDelta("\n\n");
        }
        pendingSep = false;
        finalText += ev.delta.text;
        h.onDelta(ev.delta.text);
        const now = Date.now();
        if (now - lastProgressAt > 400) {
          lastProgressAt = now;
          h.onProgress?.(upEstimate, Math.ceil(finalText.length / 4));
        }
      }
    } else if (msg.type === "assistant") {
      const blocks = msg.message.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      for (const b of blocks) {
        if (b.type === "tool_use" && b.name) {
          h.onTool(b.name.replace(/^mcp__glyphh__/, ""), b.input);
        }
      }
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("");
      if (text) {
        if (sawPartials) {
          pendingSep = true; // streamed already — next turn's first token gets the break
        } else {
          finalText = finalText ? `${finalText}\n\n${text}` : text;
          h.onDelta(finalText === text ? text : `\n\n${text}`);
        }
      }
    } else if (msg.type === "user") {
      // Tool results come back as user messages carrying tool_result blocks.
      const blocks = (msg as unknown as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks as Array<{ type?: string; content?: unknown; is_error?: boolean }>) {
          // Pretty-print JSON so results read as many short lines (foldable),
          // and allow a larger cap — collapsed to a few lines anyway, ctrl+o
          // expands. Non-JSON output passes through.
          if (b.type === "tool_result") h.onToolResult(cap(prettyJson(flattenResult(b.content)), 4000), Boolean(b.is_error));
        }
      }
    } else if (msg.type === "result") {
      const r = msg as {
        subtype: string;
        result?: string;
        total_cost_usd?: number;
        usage?: {
          input_tokens?: number; output_tokens?: number;
          cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
        };
      };
      // Real usage rides the result — the ↑ was pinned at 0 because nothing ever
      // read it. Input = prompt + both cache reads/writes; output = generated.
      const u = r.usage;
      if (u) {
        const up = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        h.onUsage?.(up, u.output_tokens ?? 0, r.total_cost_usd ?? 0);
      }
      if (r.subtype === "success") {
        if (!finalText && r.result) {
          finalText = r.result;
          h.onDelta(finalText);
        }
      } else {
        runError = `run ended: ${r.subtype.replaceAll("_", " ")}`;
      }
    }
  }
  if (runError) throw new Error(runError);
  return finalText;
}
