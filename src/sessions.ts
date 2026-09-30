/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * sessions.ts — ONE HISTORY WITH THE DESKTOP (his report, 2026-09-21: "the cli
 * has a different session state than the agent view"). The desktop keeps its
 * chats in `~/.glyphh/users/<userId>/agent-sessions.json`, merged by chat id
 * with the newer `updatedAt` winning, so several writers can share it. This
 * TUI is one more writer: it opens a chat from that file (`--resume <id>`,
 * `--continue`, /resume), appends its turns after every answer, and the
 * desktop's rail and Agent panel pick them up (main watches the file). A
 * standalone terminal writes the same file, so its chats appear in the
 * desktop later; the desktop points us at the file explicitly when it
 * launches us (GLYPHH_APP_SESSIONS).
 *
 * The shape is the desktop's CodeChat, written field-for-field so the panel
 * renders a terminal's chat like its own.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PermissionMode } from "./types.js";

export interface StoredMsg { role: "user" | "assistant"; text: string; at: number; kind?: string }
export interface StoredChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  messages: StoredMsg[];
  workdir?: string;
  loop?: string;
  mode?: "chat" | "cowork" | "code";
  source?: { kind: "local"; path: string } | { kind: string; [k: string]: unknown };
  /** The desktop's permission words: ask | plan | acceptEdits | auto. */
  permission?: string;
  cliSessionIds?: Record<string, string>;
  [k: string]: unknown;
}

interface Snapshot { chats: StoredChat[]; currentId: string | null }

function home(): string {
  return process.env.GLYPHH_HOME ?? join(homedir(), ".glyphh");
}

/** The store file: the desktop's when it launched us, else this user's own copy of the same path. */
export function storeFile(userId: string): string {
  return process.env.GLYPHH_APP_SESSIONS || join(home(), "users", userId, "agent-sessions.json");
}

export function loadStore(file: string): Snapshot {
  try {
    const j = JSON.parse(readFileSync(file, "utf-8")) as Partial<Snapshot>;
    return { chats: Array.isArray(j.chats) ? (j.chats as StoredChat[]).filter((c) => c && typeof c.id === "string") : [], currentId: typeof j.currentId === "string" ? j.currentId : null };
  } catch {
    return { chats: [], currentId: null };
  }
}

/** When a chat was last touched: its stamp, else its last message, else its birth. */
export function touchedAt(c: StoredChat): number {
  const last = c.messages?.length ? c.messages[c.messages.length - 1]!.at : 0;
  return Math.max(c.updatedAt ?? 0, last || 0, c.createdAt || 0);
}

export function findChat(file: string, id: string): StoredChat | null {
  return loadStore(file).chats.find((c) => c.id === id) ?? null;
}

/** The Glyphh loop's chats, newest first (/resume, --continue). */
export function listGlyphhChats(file: string, limit = 20): StoredChat[] {
  return loadStore(file).chats
    .filter((c) => c.loop === "glyphh" && Array.isArray(c.messages) && c.messages.length > 0)
    .sort((a, b) => touchedAt(b) - touchedAt(a))
    .slice(0, limit);
}

/** Save ONE chat the desktop's way: merge by id, the newer updatedAt wins, order
 *  kept. Launched by the desktop, this terminal is the seat the user is looking
 *  at, so the store's CURRENT chat follows it — the hop back opens this chat. */
export function saveChat(file: string, chat: StoredChat, opts: { current?: boolean } = {}): void {
  try {
    const have = loadStore(file);
    const cur = have.chats.find((c) => c.id === chat.id);
    if (cur && (cur.updatedAt ?? 0) > (chat.updatedAt ?? 0)) return; // the desktop wrote something newer
    const chats = cur ? have.chats.map((c) => (c.id === chat.id ? chat : c)) : [chat, ...have.chats];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ chats, currentId: opts.current ? chat.id : have.currentId }), "utf-8");
  } catch {
    /* a failed save loses nothing but the shared recents — the transcript stands */
  }
}

function writeStore(file: string, snap: Snapshot): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(snap), "utf-8");
}

/** Append ONE message to a chat, making the chat when a remote turn is its first
 *  (remote control, 2026-09-30). A repeat of the last message is not written twice. */
export function appendMessage(file: string, chatId: string, msg: { role: "user" | "assistant"; text: string }, seed: { workdir?: string; mode?: "work" | "code" } = {}): void {
  const text = msg.text.trim();
  if (!chatId || !text) return;
  try {
    const have = loadStore(file);
    const now = Date.now();
    let chat = have.chats.find((c) => c.id === chatId);
    if (!chat) {
      chat = {
        id: chatId, title: titleOf(msg.role === "user" ? text : ""), createdAt: now, updatedAt: now, messages: [], loop: "glyphh",
        mode: seed.mode === "work" ? "chat" : "code",
        ...(seed.workdir ? { workdir: seed.workdir, source: { kind: "local", path: seed.workdir } } : {}),
      };
      have.chats.unshift(chat);
    } else if (seed.workdir && !chat.workdir) {
      chat.workdir = seed.workdir;
      chat.source = { kind: "local", path: seed.workdir };
    }
    const last = chat.messages[chat.messages.length - 1];
    if (last && last.role === msg.role && last.text.trim() === text) return;
    chat.messages.push({ role: msg.role, text, at: now });
    chat.updatedAt = now;
    writeStore(file, have);
  } catch {
    /* a failed save loses the shared recents entry, never the run */
  }
}

/** Name a chat (or make an empty one): the phone's rename and its first-send stamp. */
export function putChat(file: string, chatId: string, patch: { title?: string; workdir?: string; mode?: "work" | "code" }): StoredChat {
  const have = loadStore(file);
  const now = Date.now();
  let chat = have.chats.find((c) => c.id === chatId);
  if (!chat) {
    chat = {
      id: chatId, title: patch.title?.trim() || "New session", createdAt: now, updatedAt: now, messages: [], loop: "glyphh",
      mode: patch.mode === "work" ? "chat" : "code",
      ...(patch.workdir ? { workdir: patch.workdir, source: { kind: "local", path: patch.workdir } } : {}),
    };
    have.chats.unshift(chat);
  } else {
    if (patch.title?.trim()) chat.title = patch.title.trim();
    if (patch.workdir && !chat.workdir) { chat.workdir = patch.workdir; chat.source = { kind: "local", path: patch.workdir }; }
    chat.updatedAt = now;
  }
  writeStore(file, have);
  return chat;
}

export function deleteChat(file: string, chatId: string): boolean {
  const have = loadStore(file);
  const chats = have.chats.filter((c) => c.id !== chatId);
  if (chats.length === have.chats.length) return false;
  writeStore(file, { chats, currentId: have.currentId === chatId ? null : have.currentId });
  return true;
}

/** A chat id in the desktop's own style (client-minted, sortable). */
export const mintChatId = (): string => `c${Date.now().toString(36)}`;

/** The desktop's permission word for our chip. */
export function desktopPermission(mode: PermissionMode): string {
  return mode === "bypass" ? "auto" : mode === "default" ? "ask" : mode;
}

/** A fresh chat in this folder, as the desktop would have made it. */
export function newChat(cwd: string, mode: PermissionMode, id: string = mintChatId()): StoredChat {
  const now = Date.now();
  return {
    id, title: "New session", createdAt: now, updatedAt: now, messages: [],
    workdir: cwd, loop: "glyphh", mode: "code", source: { kind: "local", path: cwd }, permission: desktopPermission(mode),
    cliSessionIds: { glyphh: id },
  };
}

/** The chat's title: the first user line, first line only, bounded. */
export function titleOf(firstUserText: string): string {
  const line = firstUserText.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "New session";
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/** The plain user/assistant turns of a chat — what seeds the transcript and the loop. */
export function conversationOf(chat: StoredChat): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const m of chat.messages ?? []) {
    if ((m.role !== "user" && m.role !== "assistant") || m.kind) continue;
    if (!m.text?.trim()) continue;
    out.push({ role: m.role, text: m.text });
  }
  return out;
}

/** Compact "how long ago" for a list (epoch ms → `3h ago`). */
export function agoLabel(atMs: number, now: number = Date.now()): string {
  const s = Math.max(0, (now - atMs) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
