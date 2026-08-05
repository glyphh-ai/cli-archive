/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * threads.ts — the CLI's seam onto the SERVER thread store (`/api/sessions/threads`),
 * the SAME durable conversations web and desktop render: one store, three renderers.
 * A chat mints an app-style id (`c<ts36>`), and each completed turn pushes the whole
 * message set (LWW replace-set, `updatedAt = Date.now()`) — at turn end, never per
 * token. The store is best-effort chrome: a server that's away never blocks or
 * crashes a turn — the sync goes quiet (one warning), keeps accruing locally, and
 * the next turn's push carries everything that piled up.
 */

import type { Client, SessionThread, SessionThreadMessage } from "@glyphh/sdk";

/** Mint a thread id in the app's `newChat` style (`c<ts36>` — client-minted, not a uuid). */
export function mintThreadId(now: number = Date.now()): string {
  return `c${now.toString(36)}`;
}

/** Server-side id law (`^[A-Za-z0-9_-]{1,64}$`) — gate `--thread` input before a request. */
export const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The thread's title: the first user line, first line only, bounded. */
export function threadTitle(firstUserText: string): string {
  const line = firstUserText.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "New session";
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/** The plain user/assistant turns of a stored thread — what seeds the TUI transcript
 *  and the model's history. Receipt-ish messages (tool/decline/connect kinds) and
 *  textless entries are display artifacts of other surfaces; skip them. */
export function conversationOf(messages: SessionThreadMessage[]): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (typeof m["kind"] === "string") continue;
    const text = typeof m["text"] === "string" ? m["text"] : "";
    if (!text.trim()) continue;
    out.push({ role: m.role, text });
  }
  return out;
}

/** The server stores at most 500 messages per push — keep the newest. */
const MESSAGE_CAP = 500;

export interface ThreadSyncEvents {
  /** Fired ONCE per outage when a push fails — the TUI's one quiet warning. */
  onOffline?: (message: string) => void;
}

/**
 * One chat's server mirror. `append` records CodeMsg-shaped turns; `push` upserts
 * the replace-set (serialized — a slow push absorbs later calls into one retry).
 * A RESUMED thread starts BLOCKED: until `seedResumed` lands the server's copy,
 * a push would replace-set the thread with only the new turns and wipe the rest —
 * so pushes defer, and `failResume` re-aims at a fresh id if the load never lands.
 */
export class ThreadSync {
  private threadId: string;
  private title: string | null = null;
  private msgs: SessionThreadMessage[] = [];
  private seeded: boolean;
  private dirty = false;
  private pushing = false;
  private warned = false;

  constructor(
    private readonly client: Client,
    id: string,
    private readonly events: ThreadSyncEvents = {},
    opts: { awaitSeed?: boolean } = {},
  ) {
    this.threadId = id;
    this.seeded = !opts.awaitSeed;
  }

  get id(): string {
    return this.threadId;
  }

  get messages(): readonly SessionThreadMessage[] {
    return this.msgs;
  }

  /** Land the server's copy of a resumed thread: its messages come FIRST, anything
   *  already appended this session stays after them, and pushes unblock. */
  seedResumed(thread: SessionThread): void {
    this.msgs = [...thread.messages, ...this.msgs];
    this.title = thread.title || this.title;
    this.seeded = true;
  }

  /** The resume load failed — re-aim at a fresh id so a push can never clobber the
   *  thread we couldn't read. Turns recorded while waiting carry over, and the
   *  fresh thread titles from THEIR first user line. */
  failResume(freshId: string): void {
    this.threadId = freshId;
    const firstUser = this.msgs.find((m) => m.role === "user" && typeof m["text"] === "string");
    this.title = firstUser ? threadTitle(firstUser["text"] as string) : null;
    this.seeded = true;
  }

  /** Record one CodeMsg-shaped turn (`{role, text, at}` — stored verbatim). */
  append(msg: SessionThreadMessage): void {
    this.msgs.push(msg);
    if (this.title === null && msg.role === "user" && typeof msg["text"] === "string") {
      this.title = threadTitle(msg["text"]);
    }
  }

  /**
   * Upsert the thread — call at turn end (debounce by construction: one push per
   * completed turn). Never throws; a failure marks the sync dirty, warns once per
   * outage, and the NEXT turn's push retries with everything accrued since.
   */
  async push(): Promise<void> {
    this.dirty = true;
    if (!this.seeded || this.pushing) return; // blocked or in flight — the tail call drains it
    this.pushing = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        await this.client.sessions.pushThread(this.threadId, {
          title: this.title ?? "New session",
          mode: "chat",
          source: { surface: "cli" },
          messages: this.msgs.slice(-MESSAGE_CAP),
          updatedAt: Date.now(),
        });
        this.warned = false; // synced — a NEW outage warns again
      }
    } catch (err) {
      this.dirty = true; // retry at the next turn end
      if (!this.warned) {
        this.warned = true;
        this.events.onOffline?.(
          `(offline — this chat isn't syncing to your Glyphh threads: ${(err as Error).message}. It keeps working; sync retries next turn.)`,
        );
      }
    } finally {
      this.pushing = false;
    }
  }
}
