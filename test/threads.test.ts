/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * threads.test.ts — the server-thread mirror (threads.ts): id minting in the app's
 * style, title derivation, transcript seeding, and the LWW sync's safety rails —
 * one push per turn (replace-set), offline goes quiet with ONE warning then retries,
 * and a resumed thread can never be clobbered before (or without) its server copy.
 */

import { describe, it, expect } from "vitest";
import type { Client, SessionThread, SessionThreadMessage, PushThreadInput } from "@glyphh/sdk";
import { ThreadSync, mintThreadId, threadTitle, conversationOf, THREAD_ID_RE } from "../src/threads.js";
import { agoLabel } from "../src/commands.js";

/** A client stub exposing only what ThreadSync touches: sessions.pushThread. */
function fakeClient(behavior: (id: string, body: PushThreadInput) => Promise<unknown>) {
  const pushes: Array<{ id: string; body: PushThreadInput }> = [];
  const client = {
    sessions: {
      pushThread: (id: string, body: PushThreadInput) => {
        pushes.push({ id, body });
        return behavior(id, body);
      },
    },
  } as unknown as Client;
  return { client, pushes };
}

const ok = () => Promise.resolve({ applied: true });
const down = () => Promise.reject(new Error("fetch failed"));

describe("thread ids + titles", () => {
  it("mints app-style c<ts36> ids that satisfy the server's id law", () => {
    const id = mintThreadId(1754400000000);
    expect(id).toBe(`c${(1754400000000).toString(36)}`);
    expect(THREAD_ID_RE.test(id)).toBe(true);
    expect(THREAD_ID_RE.test(mintThreadId())).toBe(true);
  });

  it("titles from the FIRST line of the first user text, bounded", () => {
    expect(threadTitle("fix the login bug\nplease")).toBe("fix the login bug");
    expect(threadTitle("   ")).toBe("New session");
    const long = threadTitle(`${"x".repeat(100)}`);
    expect([...long].length).toBe(64);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("conversationOf", () => {
  it("keeps plain user/assistant turns; skips receipts (kind), empties, and foreign roles", () => {
    const msgs: SessionThreadMessage[] = [
      { role: "user", text: "hi", at: 1 },
      { role: "assistant", text: "hello!", at: 2 },
      { role: "assistant", text: "Bash npm test", at: 3, kind: "tool" },
      { role: "assistant", text: "", at: 4 },
      { role: "system", text: "nope" },
    ];
    expect(conversationOf(msgs)).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello!" },
    ]);
  });
});

describe("ThreadSync", () => {
  it("pushes the REPLACE-SET at turn end: title from the first user line, mode chat, cli source, epoch-ms stamp", async () => {
    const { client, pushes } = fakeClient(ok);
    const sync = new ThreadSync(client, "cabc");
    sync.append({ role: "user", text: "write me a haiku\nabout rain", at: 10 });
    sync.append({ role: "assistant", text: "sure — …", at: 20 });
    await sync.push();
    expect(pushes.length).toBe(1);
    expect(pushes[0]!.id).toBe("cabc");
    const body = pushes[0]!.body;
    expect(body.title).toBe("write me a haiku");
    expect(body.mode).toBe("chat");
    expect(body.source).toEqual({ surface: "cli" });
    expect(body.messages).toEqual([
      { role: "user", text: "write me a haiku\nabout rain", at: 10 },
      { role: "assistant", text: "sure — …", at: 20 },
    ]);
    expect(body.updatedAt).toBeGreaterThan(1700000000000);

    // The next turn pushes the WHOLE set again (replace-set semantics).
    sync.append({ role: "user", text: "another", at: 30 });
    sync.append({ role: "assistant", text: "ok", at: 40 });
    await sync.push();
    expect(pushes.length).toBe(2);
    expect(pushes[1]!.body.messages!.length).toBe(4);
    expect(pushes[1]!.body.title).toBe("write me a haiku"); // title stays the FIRST user line
  });

  it("offline: never throws, warns exactly ONCE per outage, retries with the backlog next turn", async () => {
    let up = false;
    const warnings: string[] = [];
    const { client, pushes } = fakeClient((id, body) => (up ? ok() : down()));
    const sync = new ThreadSync(client, "coff", { onOffline: (m) => warnings.push(m) });

    sync.append({ role: "user", text: "one", at: 1 });
    sync.append({ role: "assistant", text: "1", at: 2 });
    await sync.push(); // fails — one quiet warning
    sync.append({ role: "user", text: "two", at: 3 });
    sync.append({ role: "assistant", text: "2", at: 4 });
    await sync.push(); // still down — NO second warning
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/offline/i);

    up = true;
    sync.append({ role: "user", text: "three", at: 5 });
    sync.append({ role: "assistant", text: "3", at: 6 });
    await sync.push(); // back — the push carries EVERYTHING accrued
    const last = pushes[pushes.length - 1]!;
    expect(last.body.messages!.length).toBe(6);

    up = false;
    sync.append({ role: "user", text: "four", at: 7 });
    await sync.push(); // a NEW outage warns again
    expect(warnings.length).toBe(2);
  });

  it("a resumed thread DEFERS pushes until the server copy seeds, then prepends it", async () => {
    const { client, pushes } = fakeClient(ok);
    const sync = new ThreadSync(client, "cres", {}, { awaitSeed: true });
    sync.append({ role: "user", text: "continue", at: 100 });
    await sync.push(); // blocked — pushing now would wipe the unread thread
    expect(pushes.length).toBe(0);

    const stored: SessionThread = {
      id: "cres", title: "the old chat", mode: "chat", source: null,
      createdAt: 1, updatedAt: 2, messageCount: 2,
      messages: [
        { role: "user", text: "hi", at: 1 },
        { role: "assistant", text: "hello", at: 2 },
      ],
    };
    sync.seedResumed(stored);
    await sync.push(); // the deferred state drains
    expect(pushes.length).toBe(1);
    expect(pushes[0]!.body.messages!.map((m) => m["text"])).toEqual(["hi", "hello", "continue"]);
    expect(pushes[0]!.body.title).toBe("the old chat"); // the stored title survives
  });

  it("failResume re-aims at a FRESH id — the unreadable thread can never be clobbered", async () => {
    const { client, pushes } = fakeClient(ok);
    const sync = new ThreadSync(client, "cgone", {}, { awaitSeed: true });
    sync.append({ role: "user", text: "hello?", at: 1 });
    sync.append({ role: "assistant", text: "hi", at: 2 });
    sync.failResume("cfresh");
    await sync.push();
    expect(pushes.length).toBe(1);
    expect(pushes[0]!.id).toBe("cfresh");
    expect(pushes[0]!.body.title).toBe("hello?"); // retitled from this session's first user line
    expect(pushes[0]!.body.messages!.length).toBe(2);
  });

  it("caps a push at the newest 500 messages (the server's per-thread cap)", async () => {
    const { client, pushes } = fakeClient(ok);
    const sync = new ThreadSync(client, "cbig");
    for (let i = 0; i < 520; i++) sync.append({ role: i % 2 ? "assistant" : "user", text: `m${i}`, at: i });
    await sync.push();
    const sent = pushes[0]!.body.messages!;
    expect(sent.length).toBe(500);
    expect(sent[sent.length - 1]!["text"]).toBe("m519"); // newest kept
  });
});

describe("threads list chrome", () => {
  it("agoLabel renders compact relative times", () => {
    const now = 10_000_000_000_000;
    expect(agoLabel(now - 5_000, now)).toBe("just now");
    expect(agoLabel(now - 5 * 60_000, now)).toBe("5m ago");
    expect(agoLabel(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(agoLabel(now - 50 * 86_400_000, now)).toBe("50d ago");
  });
});
