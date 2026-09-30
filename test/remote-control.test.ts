/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * remote-control.test.ts — the table a phone can reach, over a real temp folder
 * and a scripted engine: the granted folder is the whole world (no `..`, no
 * symlink out), the chat store is the desktop's, a turn streams wire frames
 * and lands in the store, a sub-agent's feed stays home, a Code turn without a
 * folder is refused, and `glyphh remote-control` parses as the subcommand.
 */

import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import type { LoopEmit, LoopTurn } from "@glyphh/sdk/loop";
import type { Client } from "@glyphh/sdk";
import { inGranted, remoteHandlers } from "../src/remote-control.js";
import type { LoopEngine } from "../src/loop.js";
import { parseFlags } from "../src/flags.js";

class ScriptedEngine implements LoopEngine {
  turns: LoopTurn[] = [];
  stops: string[] = [];
  constructor(private readonly events: Array<Parameters<LoopEmit>[0]>) {}
  async run(turn: LoopTurn, emit: LoopEmit): Promise<{ runId: string }> {
    this.turns.push(turn);
    for (const e of this.events) emit(e);
    return { runId: "r1" };
  }
  stop(chatId: string): boolean { this.stops.push(chatId); return true; }
  respondApproval(): boolean { return true; }
  forgetAll(): void { /* none */ }
}

const client = { models: { available: async () => [] }, plans: { gates: async () => ({ defaultModel: "" }) } } as unknown as Client;
const tick = () => new Promise((r) => setTimeout(r, 0));

let root: string;
let granted: string;
let store: string;
let pushed: Array<{ channel: string; data: Record<string, unknown> }>;

function table(engine: LoopEngine = new ScriptedEngine([])) {
  return remoteHandlers({
    client, server: "https://api.glyphh.test", version: "t", sessionsFile: store, folder: granted, engine,
    folders: () => [granted], push: (channel, data) => pushed.push({ channel, data: data as Record<string, unknown> }),
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "glyphh-rc-")));
  granted = join(root, "code");
  mkdirSync(join(granted, "app", ".git"), { recursive: true });
  writeFileSync(join(granted, "app", ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "secret"));
  store = join(root, "agent-sessions.json");
  pushed = [];
});

describe("remote control — folders", () => {
  it("is inside the granted folder only: no sibling prefix, no .., no symlink out", () => {
    symlinkSync(join(root, "secret"), join(granted, "escape"));
    expect(inGranted(join(granted, "app"), [granted])).toBe(true);
    expect(inGranted(granted, [granted])).toBe(true);
    expect(inGranted(`${granted}-other`, [granted])).toBe(false);
    expect(inGranted(join(granted, "..", "secret"), [granted])).toBe(false);
    expect(inGranted(join(granted, "escape"), [granted])).toBe(false);
    expect(inGranted(join(granted, "not-yet"), [granted])).toBe(true);
  });

  it("browses from the granted roots down, and never above them", async () => {
    const t = table();
    const roots = (await t["fs.list"]!({})) as { parent: null; entries: Array<{ path: string }> };
    expect(roots.parent).toBeNull();
    expect(roots.entries.map((e) => e.path)).toEqual([granted]);
    const inside = (await t["fs.list"]!({ path: granted })) as { parent: string | null; entries: Array<{ name: string; git: boolean }> };
    expect(inside.parent, "the granted folder is a root").toBeNull();
    expect(inside.entries).toEqual([expect.objectContaining({ name: "app", git: true })]);
    expect(await t["fs.gitInfo"]!({ path: join(granted, "app") })).toEqual({ isRepo: true, branch: "main" });
    await expect(t["fs.list"]!({ path: root })).rejects.toThrow(/not one this machine granted/);
    await expect(t["fs.mkdir"]!({ path: granted, name: "../x" })).rejects.toThrow(/a folder name/);
    expect(await t["fs.mkdir"]!({ path: granted, name: "new" })).toEqual({ path: join(granted, "new") });
  });

  it("offers nothing a phone may not ask for", () => {
    expect(Object.keys(table()).sort()).toEqual([
      "agent.answer", "agent.permission", "agent.run", "agent.stop",
      "fs.gitInfo", "fs.list", "fs.mkdir", "relay.ping",
      "sessions.delete", "sessions.get", "sessions.list", "sessions.put",
    ]);
  });
});

describe("remote control — a turn", () => {
  it("streams wire frames, keeps a sub-agent's feed home, and writes both sides to the shared store", async () => {
    const engine = new ScriptedEngine([
      { type: "setup", phase: "ready", model: "m", loop: "glyphh", runId: "x" },
      { type: "delta", delta: "Hel", runId: "x" },
      { type: "delta", delta: "swarm", runId: "x", agent: { id: "a1", name: "helper" } as never },
      { type: "delta", delta: "lo", runId: "x" },
      { type: "done", stopped: false, runId: "x" },
    ]);
    const t = table(engine);
    expect(await t["agent.run"]!({ runId: "rl-1", threadId: "c1", prompt: "hi", mode: "code", workdir: join(granted, "app"), model: "m", permission: "auto" })).toEqual({ runId: "rl-1", started: true });
    await tick();
    const types = pushed.map((p) => p.data.type);
    expect(types).toEqual(["prompt", "setup", "delta", "delta", "done"]);
    expect(pushed.every((p) => p.channel === "run:rl-1")).toBe(true);
    expect(pushed.map((p) => p.data.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(engine.turns[0]).toMatchObject({ chatId: "c1", text: "hi", model: "m", space: "code", permission: "auto", workdir: join(granted, "app") });

    const saved = JSON.parse(readFileSync(store, "utf-8")) as { chats: Array<{ id: string; workdir: string; messages: Array<{ role: string; text: string }> }> };
    expect(saved.chats[0]).toMatchObject({ id: "c1", workdir: join(granted, "app") });
    expect(saved.chats[0]!.messages.map((m) => [m.role, m.text])).toEqual([["user", "hi"], ["assistant", "Hello"]]);

    const list = (await t["sessions.list"]!({})) as { sessions: Array<{ id: string; messageCount: number; source: { path: string } }> };
    expect(list.sessions[0]).toMatchObject({ id: "c1", messageCount: 2, source: { path: join(granted, "app") } });
    const got = (await t["sessions.get"]!({ id: "c1" })) as { session: { messages: unknown[] } };
    expect(got.session.messages).toEqual([{ role: "user", text: "hi" }, { role: "assistant", text: "Hello" }]);
    await t["sessions.put"]!({ id: "c1", title: "Renamed" });
    expect(((await t["sessions.list"]!({})) as { sessions: Array<{ title: string }> }).sessions[0]!.title).toBe("Renamed");
    expect(await t["sessions.delete"]!({ id: "c1" })).toEqual({ deleted: true });
    expect(((await t["sessions.list"]!({})) as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it("refuses a Code turn with no folder, or one outside the grant; a Work turn needs none", async () => {
    const engine = new ScriptedEngine([{ type: "done", stopped: false, runId: "x" }]);
    const t = table(engine);
    await expect(t["agent.run"]!({ prompt: "hi", mode: "code" })).rejects.toThrow(/NO_WORKDIR/);
    await expect(t["agent.run"]!({ prompt: "hi", mode: "code", workdir: join(root, "secret") })).rejects.toThrow(/not one this machine granted/);
    expect(engine.turns).toEqual([]);
    await t["agent.run"]!({ runId: "rl-w", threadId: "w1", prompt: "what's up", mode: "work", model: "m" });
    await tick();
    expect(engine.turns[0]).toMatchObject({ space: "work" });
    expect(engine.turns[0]!.workdir).toBeUndefined();
  });

  it("stops the chat the run belongs to", async () => {
    let release: () => void = () => {};
    const engine = new ScriptedEngine([]);
    engine.run = async (turn) => { engine.turns.push(turn); await new Promise<void>((r) => { release = r; }); return { runId: "r" }; };
    const t = table(engine);
    await t["agent.run"]!({ runId: "rl-s", threadId: "c9", prompt: "long", mode: "work", model: "m" });
    expect(await t["agent.stop"]!({ runId: "rl-s" })).toEqual({ stopped: true });
    expect(engine.stops).toEqual(["c9"]);
    expect(await t["agent.stop"]!({ runId: "nope" })).toEqual({ stopped: false });
    release();
  });
});

describe("glyphh remote-control", () => {
  it("is the subcommand as the first word, and prose anywhere else", () => {
    expect(parseFlags(["remote-control"])).toEqual({ remoteControl: true });
    expect(parseFlags(["remote-control", "--model", "m"])).toEqual({ remoteControl: true, model: "m" });
    expect(parseFlags(["explain", "remote-control"])).toEqual({ prompt: "explain remote-control" });
  });
});
