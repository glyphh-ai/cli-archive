/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * harness.test.ts — the turn engine over a FAKED pod. `runHarnessTurn` is the
 * whole chat path now (the embedded agent loop is gone), so the contract under
 * test is the frame→handler map: streamed deltas, tool receipts, the PARKED
 * ask/approval round trip, stop, error frames, and an unreachable pod turning
 * into one honest message instead of a crash.
 */

import { describe, it, expect } from "vitest";
import type { Client, HarnessClient, HarnessWireFrame } from "@glyphh/sdk";
import {
  runHarnessTurn,
  resolveHarnessHost,
  resetHarnessHost,
  reachableFromPod,
  harnessPermission,
  cliSystemPrompt,
  type HarnessHost,
  type HarnessTurnHandlers,
} from "../src/harness.js";

/** A scripted pod: frames are delivered in order, `answer`/`stop` are recorded.
 *  A frame may be a function — it receives the run so a test can drive the
 *  parked-then-resumed shape the real pod has. */
type Scripted = HarnessWireFrame | ((emit: (f: HarnessWireFrame) => void) => void | Promise<void>);

interface FakePod {
  client: HarnessClient;
  body: Record<string, unknown> | null;
  answers: Array<{ id: string; reply: { allow?: boolean; answers?: string[] } }>;
  stops: number;
  /** Resolves when `id` is answered — a script step awaits it to PARK, exactly
   *  as the pod's loop blocks inside `ask_user` / the approval gate. */
  answered: (id: string) => Promise<void>;
}

let seq = 0;
const frame = (f: Omit<HarnessWireFrame, "seq" | "runId" | "at">): HarnessWireFrame =>
  ({ ...f, seq: seq++, runId: "run-1", at: Date.now() }) as HarnessWireFrame;

function fakePod(script: Scripted[]): FakePod {
  const parks = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const park = (id: string): { promise: Promise<void>; resolve: () => void } => {
    const hit = parks.get(id);
    if (hit) return hit;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    const made = { promise, resolve };
    parks.set(id, made);
    return made;
  };
  const pod: FakePod = {
    client: null as unknown as HarnessClient,
    body: null,
    answers: [],
    stops: 0,
    answered: (id) => park(id).promise,
  };
  const subs = new Set<(f: HarnessWireFrame) => void>();
  const tape: HarnessWireFrame[] = [];
  let resolveDone: (r: { runId: string; stopped: boolean; text: string; error?: string }) => void;
  const done = new Promise<{ runId: string; stopped: boolean; text: string; error?: string }>((r) => {
    resolveDone = r;
  });
  let text = "";
  let settled = false;

  const emit = (f: HarnessWireFrame): void => {
    if (settled) return;
    tape.push(f);
    if (f.type === "delta") text += f.delta;
    for (const fn of subs) fn(f);
    if (f.type === "done" || f.type === "error") {
      settled = true;
      resolveDone({
        runId: "run-1",
        stopped: f.type === "done" ? f.stopped : false,
        text,
        ...(f.type === "error" ? { error: f.error } : {}),
      });
    }
  };

  const run = {
    done,
    on(fn: (f: HarnessWireFrame) => void) {
      for (const f of tape) fn(f);
      subs.add(fn);
      return () => subs.delete(fn);
    },
    async answer(id: string, reply: { allow?: boolean; answers?: string[] }) {
      pod.answers.push({ id, reply });
      park(id).resolve();
    },
    async stop() {
      pod.stops++;
      if (!settled) {
        settled = true;
        resolveDone({ runId: "run-1", stopped: true, text });
      }
    },
  };

  pod.client = {
    start(body: Record<string, unknown> & { signal?: AbortSignal }) {
      const { signal, ...rest } = body;
      pod.body = rest;
      signal?.addEventListener("abort", () => void run.stop(), { once: true });
      void (async () => {
        for (const step of script) {
          if (settled) break;
          if (typeof step === "function") await step(emit);
          else emit(step);
          await Promise.resolve(); // let handlers run between frames
        }
      })();
      return run;
    },
  } as unknown as HarnessClient;
  return pod;
}

const client = { token: async () => "gy_at_test" } as unknown as Client;

/** A control plane whose `sessions.create` provisions a ready cloud runtime. */
function cloudClient(over: { status?: string; runtimeUrl?: string | null } = {}): Client {
  const session = {
    id: "sess_1",
    status: over.status ?? "ready",
    runtimeUrl: over.runtimeUrl === undefined ? "https://pod-1.glyphh.run" : over.runtimeUrl,
  };
  return {
    token: async () => "gy_at_test",
    sessions: {
      create: async () => ({ session, runtimeToken: "gy_rk_cloud" }),
      get: async () => session,
    },
  } as unknown as Client;
}

function handlers(): { h: HarnessTurnHandlers; log: string[] } {
  const log: string[] = [];
  const h: HarnessTurnHandlers = {
    onDelta: (t) => log.push(`delta:${t}`),
    onToolStart: (name, title) => log.push(`tool.start:${name}:${title ?? ""}`),
    onToolDone: (name, r) => log.push(`tool.done:${name}:${r.failed ? "failed" : "ok"}:${r.preview}`),
    onProgress: (up, down) => log.push(`progress:${up}/${down}`),
    onUsd: (usd) => log.push(`usd:${usd}`),
    onNote: (n) => log.push(`note:${n}`),
  };
  return { h, log };
}

const turn = (pod: FakePod, h: HarnessTurnHandlers, over: Record<string, unknown> = {}) =>
  runHarnessTurn(
    {
      client,
      server: "http://127.0.0.1:3001",
      model: "claude-sonnet-5",
      threadId: "c123",
      history: [],
      prompt: "hi",
      cwd: "/tmp/work",
      permission: "ask",
      host: { kind: "local", url: "http://127.0.0.1:51234" } as HarnessHost,
      openHarness: () => pod.client,
      mintGrant: async () => "gy_mt_test",
      ...over,
    } as Parameters<typeof runHarnessTurn>[0],
    h,
  );

describe("harness turn", () => {
  it("streams deltas and resolves with the full answer", async () => {
    const pod = fakePod([
      frame({ type: "delta", delta: "he" }),
      frame({ type: "delta", delta: "llo" }),
      frame({ type: "done", stopped: false }),
    ]);
    const { h, log } = handlers();
    const res = await turn(pod, h);
    expect(log).toEqual(["delta:he", "delta:llo"]);
    expect(res).toEqual({ text: "hello", stopped: false });
  });

  it("sends the contract's run body (thread id, gateway, runtime token, model, permission)", async () => {
    const pod = fakePod([frame({ type: "done", stopped: false })]);
    const { h } = handlers();
    await turn(pod, h);
    expect(pod.body).toMatchObject({
      prompt: "hi",
      threadId: "c123",
      mode: "code",
      model: "claude-sonnet-5",
      permission: "ask",
      gatewayUrl: "http://127.0.0.1:3001/api/gateway",
      runtimeToken: "gy_at_test",
    });
    // The run is ANCHORED at the user's shell dir (a local pod honors
    // `workdir`), and the system prompt says so — without both, "this project"
    // would mean the pod's empty sandbox workspace.
    expect(pod.body!.workdir).toBe("/tmp/work");
    expect(String(pod.body!.system)).toContain("/tmp/work");
  });

  it("LENDS the server's governed tool surface to the pod", async () => {
    const pod = fakePod([frame({ type: "done", stopped: false })]);
    const { h } = handlers();
    await turn(pod, h);
    // NOT under the name "glyphh" — the pod reserves that for its own ask_user
    // server and 400s the whole run if a lent server claims it.
    expect(pod.body!.mcpServers).toEqual([
      { name: "platform", url: "http://127.0.0.1:3001/mcp", headers: { authorization: "Bearer gy_mt_test" } },
    ]);
  });

  it("strips the MCP server prefix so receipts name the tool, not the wire", async () => {
    const pod = fakePod([
      frame({ type: "tool", phase: "start", name: "mcp__platform__list_loops", thought: "list_loops" }),
      frame({ type: "tool", phase: "done", name: "mcp__platform__list_loops", failed: false, preview: "[]" }),
      frame({ type: "done", stopped: false }),
    ]);
    const { h, log } = handlers();
    await turn(pod, h);
    expect(log).toEqual(["tool.start:list_loops:list_loops", "tool.done:list_loops:ok:[]"]);
  });

  it("runs WITHOUT the lent surface (and says so once) when the grant fails", async () => {
    const pod = fakePod([frame({ type: "delta", delta: "still working" }), frame({ type: "done", stopped: false })]);
    const { h, log } = handlers();
    const res = await turn(pod, h, { mintGrant: () => Promise.reject(new Error("consent returned no code")) });
    expect(pod.body).not.toHaveProperty("mcpServers");
    expect(log.some((l) => l.startsWith("note:") && /aren't available this turn/.test(l))).toBe(true);
    expect(res.text).toBe("still working"); // the turn is NOT failed over a tool surface
  });

  it("omits workdir when the caller has no cwd — the pod keeps its sandbox", async () => {
    const pod = fakePod([frame({ type: "done", stopped: false })]);
    const { h } = handlers();
    await turn(pod, h, { cwd: undefined });
    expect(pod.body).not.toHaveProperty("workdir");
  });

  it("maps tool frames to start/done receipts and progress/dollars to the strip", async () => {
    const pod = fakePod([
      frame({ type: "tool", phase: "start", name: "Bash", thought: "Run npm test" }),
      frame({ type: "tool", phase: "done", name: "Bash", failed: false, preview: "ok" }),
      frame({ type: "progress", inTokens: 120, outTokens: 40 }),
      frame({ type: "credits", usd: 0.03 }),
      frame({ type: "done", stopped: false }),
    ]);
    const { h, log } = handlers();
    await turn(pod, h);
    expect(log).toEqual([
      "tool.start:Bash:Run npm test",
      "tool.done:Bash:ok:ok",
      "progress:120/40",
      "usd:0.03",
    ]);
  });

  it("ask PARKS the run and the answer resumes it", async () => {
    const holder: { pod?: FakePod } = {};
    const pod = fakePod([
      frame({ type: "ask", id: "ask-1", questions: [{ question: "which port?", options: ["3000", "8080"] }] }),
      () => holder.pod!.answered("ask-1"), // the pod BLOCKS here, like ask_user
      frame({ type: "delta", delta: "using 3000" }),
      frame({ type: "done", stopped: false }),
    ]);
    holder.pod = pod;
    const { h, log } = handlers();
    const res = await turn(pod, {
      ...h,
      onAsk: (req, answer) => {
        log.push(`ask:${req.questions[0]!.question}`);
        // The TUI answers only after the user types — resolve on a later tick
        // so a run that ignored the park would race ahead and fail the order.
        setTimeout(() => answer(["3000"]), 5);
      },
    });
    expect(pod.answers).toEqual([{ id: "ask-1", reply: { answers: ["3000"] } }]);
    expect(log).toEqual(["ask:which port?", "delta:using 3000"]); // parked, then resumed
    expect(res.text).toBe("using 3000");
  });

  it("an unanswerable ask/approval is refused rather than left hanging", async () => {
    const pod = fakePod([
      frame({ type: "approval", id: "apr-1", kind: "command", title: "Run rm -rf /", detail: "" }),
      frame({ type: "ask", id: "ask-1", questions: [{ question: "ok?" }] }),
      frame({ type: "done", stopped: false }),
    ]);
    const { h } = handlers(); // no onApproval / onAsk
    await turn(pod, h);
    expect(pod.answers).toEqual([
      { id: "apr-1", reply: { allow: false } },
      { id: "ask-1", reply: { answers: [] } },
    ]);
  });

  it("approval answers allow/deny through to the pod", async () => {
    const pod = fakePod([
      frame({ type: "approval", id: "apr-1", kind: "edit", title: "Edit a.ts", detail: "a.ts" }),
      frame({ type: "done", stopped: false }),
    ]);
    const { h } = handlers();
    await turn(pod, { ...h, onApproval: (_req, answer) => answer(true) });
    expect(pod.answers).toEqual([{ id: "apr-1", reply: { allow: true } }]);
  });

  it("Esc (an aborted signal) stops the run and keeps the partial answer", async () => {
    const ctrl = new AbortController();
    const pod = fakePod([
      frame({ type: "delta", delta: "partial" }),
      () => ctrl.abort(), // the user hits Esc mid-stream
      frame({ type: "delta", delta: " never" }),
    ]);
    const { h } = handlers();
    const res = await turn(pod, h, { signal: ctrl.signal });
    expect(pod.stops).toBe(1);
    expect(res.stopped).toBe(true);
    expect(res.text).toBe("partial");
  });

  it("an error frame resolves the turn (with the message) instead of throwing", async () => {
    const pod = fakePod([frame({ type: "error", error: "no credits" })]);
    const { h } = handlers();
    const res = await turn(pod, h);
    expect(res.error).toBe("no credits");
    expect(res.stopped).toBe(false);
  });

  it("NO host at all reports ONE actionable message naming both attempts", async () => {
    resetHarnessHost();
    const pod = fakePod([]);
    const { h } = handlers();
    const failing = {
      token: async () => "gy_at_test",
      sessions: { create: async () => { throw new Error("402 out of credits"); } },
    } as unknown as Client;
    await expect(
      turn(pod, h, {
        host: undefined,
        client: failing,
        ensurePod: () => Promise.reject(new Error("spawn rrotor ENOENT")),
      }),
    ).rejects.toThrow(/no Glyphh harness is available.*ENOENT.*402 out of credits/s);
    resetHarnessHost();
  });

  it("a renderer that throws never takes the run down", async () => {
    const pod = fakePod([frame({ type: "delta", delta: "x" }), frame({ type: "done", stopped: false })]);
    const { h } = handlers();
    const res = await turn(pod, {
      ...h,
      onDelta: () => {
        throw new Error("render blew up");
      },
    });
    expect(res.text).toBe("x");
  });
});

describe("host selection", () => {
  const base = {
    server: "https://api.glyphh.ai",
    model: "m",
    threadId: "c1",
    history: [],
    prompt: "hi",
    permission: "auto" as const,
  };

  it("prefers the LOCAL pod when one starts", async () => {
    resetHarnessHost();
    const host = await resolveHarnessHost({
      ...base,
      client,
      ensurePod: async () => ({ url: "http://127.0.0.1:1" }),
    });
    expect(host).toEqual({ kind: "local", url: "http://127.0.0.1:1" });
    resetHarnessHost();
  });

  it("falls to the CLOUD runtime when no local pod can start", async () => {
    resetHarnessHost();
    const host = await resolveHarnessHost({
      ...base,
      client: cloudClient(),
      ensurePod: () => Promise.reject(new Error("no rrotor")),
    });
    expect(host).toEqual({
      kind: "cloud",
      url: "https://pod-1.glyphh.run",
      token: "gy_rk_cloud",
      sessionId: "sess_1",
    });
    resetHarnessHost();
  });

  it("decides ONCE per session — the second turn never re-probes", async () => {
    resetHarnessHost();
    let probes = 0;
    const opts = {
      ...base,
      client: cloudClient(),
      ensurePod: () => {
        probes++;
        return Promise.reject(new Error("no rrotor"));
      },
    };
    const a = await resolveHarnessHost(opts);
    const b = await resolveHarnessHost(opts);
    expect(probes).toBe(1); // no retry-storm across turns
    expect(b).toEqual(a);
    resetHarnessHost();
  });

  it("does NOT cache a total failure — the next turn tries again", async () => {
    resetHarnessHost();
    let probes = 0;
    const dead = {
      token: async () => "t",
      sessions: { create: async () => { throw new Error("offline"); } },
    } as unknown as Client;
    const opts = {
      ...base,
      client: dead,
      ensurePod: () => {
        probes++;
        return Promise.reject(new Error("no rrotor"));
      },
    };
    await expect(resolveHarnessHost(opts)).rejects.toThrow(/no Glyphh harness/);
    await expect(resolveHarnessHost(opts)).rejects.toThrow(/no Glyphh harness/);
    expect(probes).toBe(2);
    resetHarnessHost();
  });

  it("waits for a provisioning runtime, and refuses one that never readies", async () => {
    resetHarnessHost();
    await expect(
      resolveHarnessHost({
        ...base,
        client: cloudClient({ status: "failed", runtimeUrl: null }),
        ensurePod: () => Promise.reject(new Error("no rrotor")),
      }),
    ).rejects.toThrow(/runtime failed/);
    resetHarnessHost();
  });
});

describe("the cloud path", () => {
  const cloud: HarnessHost = { kind: "cloud", url: "https://pod-1.glyphh.run", token: "gy_rk_cloud", sessionId: "sess_1" };

  it("sends NO workdir, NO gatewayUrl and NO runtimeToken — the pod is itself", async () => {
    const pod = fakePod([frame({ type: "done", stopped: false })]);
    const { h } = handlers();
    await turn(pod, h, { host: cloud, server: "https://api.glyphh.ai" });
    expect(pod.body).not.toHaveProperty("workdir");   // the cloud pod 400s a host path
    expect(pod.body).not.toHaveProperty("gatewayUrl"); // it carries its own
    expect(pod.body).not.toHaveProperty("runtimeToken");
    expect(pod.body).toMatchObject({ sessionId: "sess_1" });
  });

  it("says ONCE that the session is cloud-backed and the files aren't local", async () => {
    resetHarnessHost();
    const { h, log } = handlers();
    const over = { host: cloud, server: "https://api.glyphh.ai" };
    await turn(fakePod([frame({ type: "done", stopped: false })]), h, over);
    await turn(fakePod([frame({ type: "done", stopped: false })]), h, over);
    const notes = log.filter((l) => /Running on the Glyphh cloud runtime/.test(l));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/NOT in this folder/);
    resetHarnessHost();
  });

  it("stays SILENT for a local session — nothing changed for the user", async () => {
    resetHarnessHost();
    const { h, log } = handlers();
    await turn(fakePod([frame({ type: "done", stopped: false })]), h);
    expect(log.filter((l) => l.startsWith("note:"))).toEqual([]);
    resetHarnessHost();
  });

  it("won't lend a control plane the pod can't reach (and says why)", async () => {
    const pod = fakePod([frame({ type: "done", stopped: false })]);
    const { h, log } = handlers();
    await turn(pod, h, { host: cloud, server: "http://127.0.0.1:3001" });
    expect(pod.body).not.toHaveProperty("mcpServers");
    expect(log.some((l) => /only reachable from your machine/.test(l))).toBe(true);
  });

  it("DOES lend a public control plane to a cloud pod", async () => {
    const pod = fakePod([frame({ type: "done", stopped: false })]);
    const { h } = handlers();
    await turn(pod, h, { host: cloud, server: "https://api.glyphh.ai" });
    expect(pod.body!.mcpServers).toEqual([
      { name: "platform", url: "https://api.glyphh.ai/mcp", headers: { authorization: "Bearer gy_mt_test" } },
    ]);
  });

  it("knows which control planes a remote pod can dial", () => {
    const local: HarnessHost = { kind: "local", url: "http://127.0.0.1:1" };
    expect(reachableFromPod("http://127.0.0.1:3001", local)).toBe(true); // shares the machine
    expect(reachableFromPod("https://api.glyphh.ai", cloud)).toBe(true);
    for (const s of ["http://127.0.0.1:3001", "http://localhost:3001", "http://192.168.1.5:3001", "http://10.0.0.2", "http://mac.local"]) {
      expect(reachableFromPod(s, cloud)).toBe(false);
    }
  });
});

describe("permission mapping", () => {
  it("maps the TUI's chip onto the pod's gate vocabulary", () => {
    expect(harnessPermission("ask")).toBe("ask");
    expect(harnessPermission("auto")).toBe("auto");
    // Both read-only modes are the pod's read-only `plan` gate.
    expect(harnessPermission("plan")).toBe("plan");
    expect(harnessPermission("read-only")).toBe("plan");
  });

  it("the LOCAL system prompt says the cwd is the user's real folder", () => {
    const p = cliSystemPrompt("local", "/Users/me/project");
    expect(p).toContain("/Users/me/project");
    expect(p).toMatch(/relative path/i); // the run is anchored there
    expect(p).toMatch(/real folder/i);   // …and it's the user's own, not a sandbox
    expect(p).toMatch(/ask_user/);
  });

  it("the CLOUD system prompt refuses to pretend it can touch the user's machine", () => {
    const p = cliSystemPrompt("cloud", "/Users/me/project");
    expect(p).toMatch(/CLOUD SANDBOX/);
    expect(p).toMatch(/cannot read or write/i);   // their folder is out of reach
    expect(p).toMatch(/never claim you changed something on their computer/i);
  });

  it("omits the Glyphh tool line when no surface was lent", () => {
    expect(cliSystemPrompt("local", "/w", false)).not.toMatch(/mcp__platform__/);
    expect(cliSystemPrompt("local", "/w")).toMatch(/mcp__platform__/);
  });
});
