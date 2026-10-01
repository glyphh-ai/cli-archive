/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * remote-control.ts — REMOTE CONTROL (his order, 2026-09-30): this terminal
 * takes turns from mobile.glyphh.ai, inside the folder it was started in.
 *
 * Off unless the member asks: `glyphh remote-control` starts the TUI with it
 * on, `/remote-control on|off` flips it. While it is on, this process attaches
 * the same outbound socket the desktop does (nothing dials in) and answers
 * exactly the methods the server allows remotely:
 *
 *   relay.ping
 *   sessions.list / get / put / delete   the chat store shared with the desktop
 *   fs.list / fs.gitInfo / fs.mkdir      the phone's folder picker, granted folders only
 *   agent.run / answer / stop / permission   a turn on THIS process's Glyphh loop
 *
 * No shell, no file writes, no apps: the server refuses anything else, and this
 * table does not have it. A turn works in a granted folder (the loop's own
 * sandbox then keeps its file tools there); a Work turn has no folder. An org
 * admin who turned remote control off is told at start (attach.status) and at
 * the socket (4403) — the host stops and says so.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Client } from "@glyphh/sdk";
import type { LoopEmit, LoopPermission } from "@glyphh/sdk/loop";
import { startAttachHost, type AttachHandler, type AttachHost } from "@glyphh/sdk/runtime";
import { adaDevice, adaHandlers } from "./ada.js";
import { engineFor, type LoopEngine } from "./loop.js";
import { defaultModel } from "./models.js";
import { appendMessage, conversationOf, deleteChat, findChat, loadStore, putChat, touchedAt, type StoredChat } from "./sessions.js";

export interface RemoteControlOptions {
  client: Client;
  server: string;
  version: string;
  /** The shared chat store (sessions.ts storeFile). */
  sessionsFile: string;
  /** The granted folder — the one the CLI runs in. */
  folder: string;
  /** The server refused this machine after it started (the org turned it off). */
  onRefused?: (reason: string) => void;
  /** Tests: the engine and the host factory. */
  engine?: LoopEngine;
  start?: typeof startAttachHost;
}

let host: AttachHost | null = null;
let granted: string[] = [];

export function remoteControlState(): { on: boolean; folders: string[] } {
  return { on: !!host, folders: [...granted] };
}

/** Turn remote control on. Resolves with what to tell the person. */
export async function remoteControlOn(opts: RemoteControlOptions): Promise<{ ok: boolean; message: string }> {
  const st = await opts.client.attach.status().catch(() => null);
  if (st && st.allowed === false) return { ok: false, message: "remote control is off for your organization — an org admin can turn it on in the console" };
  remoteControlOff();
  granted = [realOr(resolve(opts.folder))];
  // A registered Ada device keeps serving its records on the same socket.
  const ada = await adaHandlers().catch(() => ({}));
  const device = adaDevice()?.device_id;
  host = (opts.start ?? startAttachHost)({
    client: opts.client,
    server: opts.server,
    app: "glyphh-cli",
    version: opts.version,
    name: hostname(),
    handlers: { ...remoteHandlers({ ...opts, folders: () => granted, push: (channel, data) => { host?.push(channel, data); } }), ...ada },
    folders: () => granted,
    ...(device ? { adaDevice: () => device } : {}),
    onRefused: (reason) => { host = null; granted = []; opts.onRefused?.(reason); },
  });
  return { ok: true, message: `remote control on · mobile.glyphh.ai can run turns in ${granted[0]}` };
}

export function remoteControlOff(): boolean {
  const was = !!host;
  host?.stop();
  host = null;
  granted = [];
  return was;
}

// ── folders ──────────────────────────────────────────────────────────────────

/** The real path, or the path itself when it does not exist yet. */
function realOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** Inside a granted folder, symlinks resolved (a link out of the folder is outside it). */
export function inGranted(path: string, folders: string[]): boolean {
  if (!path) return false;
  const abs = resolve(path);
  const real = existsSync(abs) ? realOr(abs) : join(realOr(dirname(abs)), basename(abs));
  return folders.some((f) => real === f || real.startsWith(f.endsWith(sep) ? f : f + sep));
}

function gitStateOf(dir: string): { isRepo: boolean; branch?: string } {
  const dot = join(dir, ".git");
  if (!existsSync(dot)) return { isRepo: false };
  try {
    const gitDir = statSync(dot).isDirectory() ? dot : join(dir, (readFileSync(dot, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1] ?? "").trim());
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return { isRepo: true, branch: ref?.[1] ?? head.slice(0, 7) };
  } catch {
    return { isRepo: true };
  }
}

// ── the handler table ────────────────────────────────────────────────────────

const str = (p: unknown, k: string): string => {
  const v = (p as Record<string, unknown> | null)?.[k];
  return typeof v === "string" ? v : "";
};

const PERMISSIONS: readonly LoopPermission[] = ["ask", "plan", "acceptEdits", "auto"];
function permissionOf(raw: unknown): LoopPermission | undefined {
  const v = raw === "bypass" ? "auto" : raw;
  return PERMISSIONS.includes(v as LoopPermission) ? (v as LoopPermission) : undefined;
}

function sessionMeta(c: StoredChat): Record<string, unknown> {
  return {
    id: c.id, title: c.title?.trim() || "New session",
    createdAt: c.createdAt ?? 0, updatedAt: touchedAt(c),
    mode: c.mode === "code" || c.mode === "cowork" || !c.mode ? "code" : "work",
    messageCount: c.messages?.length ?? 0,
    ...(c.workdir ? { source: { kind: "local", path: c.workdir } } : {}),
  };
}

export function remoteHandlers(opts: RemoteControlOptions & { folders: () => string[]; push: (channel: string, data: unknown) => void }): Record<string, AttachHandler> {
  const file = opts.sessionsFile;
  const engine = (): LoopEngine => opts.engine ?? engineFor(opts.client);
  const runs = new Map<string, string>(); // runId → chatId, for stop / permission
  const guard = (path: string): string => {
    if (!inGranted(path, opts.folders())) throw new Error("that folder is not one this machine granted for remote control");
    return realOr(resolve(path));
  };

  return {
    "relay.ping": async () => ({ pong: true, app: "glyphh-cli" }),

    "sessions.list": async () => ({
      sessions: loadStore(file).chats.map(sessionMeta).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)),
    }),
    "sessions.get": async (p) => {
      const id = str(p, "id");
      const c = id ? findChat(file, id) : null;
      if (!c) throw new Error(`no session ${id} on this machine`);
      return { session: { ...sessionMeta(c), messages: conversationOf(c).slice(-200) } };
    },
    "sessions.put": async (p) => {
      const id = str(p, "id");
      if (!id) throw new Error("sessions.put requires { id }");
      const workdir = str(p, "workdir");
      const chat = putChat(file, id, {
        title: str(p, "title"),
        mode: str(p, "mode") === "work" ? "work" : "code",
        ...(workdir ? { workdir: guard(workdir) } : {}),
      });
      return { session: sessionMeta(chat) };
    },
    "sessions.delete": async (p) => ({ deleted: deleteChat(file, str(p, "id")) }),

    "fs.list": async (p) => {
      const path = str(p, "path");
      if (!path) {
        // The granted folders ARE the roots — nothing above them is browsable.
        return { path: "", parent: null, entries: opts.folders().map((f) => ({ name: f.split(sep).pop() || f, path: f, dir: true, git: gitStateOf(f).isRepo })) };
      }
      const dir = guard(path);
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => { const full = join(dir, d.name); return { name: d.name, path: full, dir: true, git: existsSync(join(full, ".git")) }; })
        .sort((a, b) => a.name.localeCompare(b.name));
      const up = dirname(dir);
      return { path: dir, parent: opts.folders().includes(dir) || !inGranted(up, opts.folders()) ? null : up, entries };
    },
    "fs.gitInfo": async (p) => gitStateOf(guard(str(p, "path"))),
    "fs.mkdir": async (p) => {
      const name = str(p, "name").trim();
      if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new Error("a folder name, not a path");
      const parent = guard(str(p, "path") || opts.folders()[0] || "");
      const full = join(parent, name);
      mkdirSync(full);
      return { path: full };
    },

    "agent.run": async (p) => {
      const params = (p ?? {}) as Record<string, unknown>;
      const runId = str(params, "runId") || `rl-${Date.now().toString(36)}`;
      const chatId = str(params, "threadId") || runId;
      const text = str(params, "prompt").trim();
      if (!text) throw new Error("agent.run requires { prompt }");
      const space = str(params, "mode") === "work" ? "work" : "code";
      const workdir = str(params, "workdir") ? guard(str(params, "workdir")) : "";
      if (space === "code" && !workdir) throw new Error("NO_WORKDIR: pick a folder this machine granted for remote control");
      const model = str(params, "model") || (await defaultModel(opts.client));
      const history = conversationOf(findChat(file, chatId) ?? ({ messages: [] } as unknown as StoredChat));
      appendMessage(file, chatId, { role: "user", text }, { ...(workdir ? { workdir } : {}), mode: space });
      runs.set(runId, chatId);

      let seq = 0;
      let answer = "";
      const push = (frame: Record<string, unknown>): void => { opts.push(`run:${runId}`, { ...frame, seq: seq++, runId, at: Date.now() }); };
      push({ type: "prompt", text });
      const emit: LoopEmit = (ev) => {
        // A sub-agent's feed is its own; the phone has no swarm view yet.
        if (ev.agent || ev.type === "agent") return;
        const { runId: _r, ...rest } = ev as unknown as Record<string, unknown>;
        if (ev.type === "delta") answer += ev.delta;
        if (ev.type === "done") { appendMessage(file, chatId, { role: "assistant", text: answer }); runs.delete(runId); }
        push(rest);
      };
      const permission = permissionOf(params.permission);
      void engine().run({
        chatId, text, model, space,
        ...(permission ? { permission } : {}),
        ...(workdir ? { workdir } : {}),
        history: history.map((m) => ({ role: m.role, text: m.text })),
      }, emit).catch((err: unknown) => {
        push({ type: "error", error: err instanceof Error ? err.message : String(err) });
        push({ type: "done", stopped: true });
        runs.delete(runId);
      });
      return { runId, started: true };
    },
    "agent.answer": async (p) => ({ answered: engine().respondApproval(str(p, "id"), (p as { allow?: unknown } | null)?.allow === true) }),
    "agent.stop": async (p) => {
      const chatId = runs.get(str(p, "runId"));
      return { stopped: chatId ? engine().stop(chatId) : false };
    },
    "agent.permission": async (p) => {
      const chatId = runs.get(str(p, "runId"));
      const permission = permissionOf((p as { permission?: unknown } | null)?.permission);
      if (!permission) throw new Error("agent.permission requires { runId, permission }");
      const eng = engine() as LoopEngine & { setPermission?: (c: string, m: LoopPermission) => boolean };
      return { updated: chatId && eng.setPermission ? eng.setPermission(chatId, permission) : false };
    },
  };
}
