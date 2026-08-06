/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * App.tsx — the TUI root. One scroll surface over a sticky bottom strip: the
 * banner is the transcript's first content (it scrolls away; the cat renders
 * only when the terminal is wide enough), and a
 * LINE-MODEL transcript filling the middle, then the status strip + composer +
 * footer pinned at the bottom.
 *
 * The transcript is a list of ITEMS flattened to styled lines every render
 * (lines.ts), so the viewport owns scrolling as exact array math: wheel/arrows
 * scroll; tool receipts are collapsed by default and ctrl+o toggles them all
 * open (retroactively, because lines regenerate from items).
 * A leading `/` runs a slash command; plain text runs ONE HARNESS TURN
 * (harness.ts) on this session's pod — the machine's local one, or the Glyphh
 * cloud runtime when there is no local harness. Tool calls land as collapsible
 * receipts, the answer streams into the `●` line, and a parked approval/ask
 * takes the keyboard until it's answered.
 * All capability comes from the SDK — nothing here talks to an API directly.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import type { Client } from "@glyphh/sdk";
import { runHarnessTurn, type ApprovalRequest, type AskRequest } from "../harness.js";
// Live model switches (/use) audit + layer in via the SDK override store.
import { sessionOverrides } from "@glyphh/sdk/runtime";
import { readPrefs, writePrefs, selectionsFor } from "../prefs.js";
import { CAT_ROWS } from "../banner.js";
import { InputBar } from "./InputBar.js";
import { Footer, type FooterSlot } from "./Footer.js";
import { SubFooter } from "./SubFooter.js";
import { TranscriptLine } from "./TranscriptLine.js";
import { theme, applyTheme } from "../theme.js";
import { loadAccount, type Account } from "../glyphh.js";
import { runSlash, RELEASE_NOTES, type CommandCtx } from "../commands.js";
import { headerLines,
  answerLines,
  cardLines,
  commandLines,
  metaLines,
  noteLines,
  sectionLines,
  userLines,
  type Line,
} from "../lines.js";
import { ThreadSync, mintThreadId, conversationOf, THREAD_ID_RE } from "../threads.js";
import type { ChatTurn, Item, PermissionMode, TurnStep } from "../types.js";

const MODES: PermissionMode[] = ["ask", "auto", "plan", "read-only"];

/** The rotating work verbs — one pair per turn (✽ Verbing… / ✻ Verbed for Ns). */
const VERBS: Array<{ ing: string; past: string }> = [
  { ing: "Cooking", past: "Cooked" },
  { ing: "Cogitating", past: "Cogitated" },
  { ing: "Crunching", past: "Crunched" },
  { ing: "Brewing", past: "Brewed" },
  { ing: "Noodling", past: "Noodled" },
  { ing: "Simmering", past: "Simmered" },
  { ing: "Churning", past: "Churned" },
];

/** Most recent turns sent to the model — bounds the wire, not the transcript. */
const HISTORY_CAP = 40;

/** A tool receipt label: the pod classifies each call and sends a human title
 *  ("Run npm test"); the bare tool name is the fallback. */
export function toolLabel(name: string, title?: string): string {
  const t = (title ?? "").trim();
  if (!t) return name;
  return t.length > 76 ? `${t.slice(0, 75)}…` : t;
}

/** What the strip is blocked on — the pod PARKED the run until the user
 *  answers (an `approval` or `ask` frame). */
type Pending =
  | { kind: "approval"; req: ApprovalRequest; answer: (allow: boolean) => void }
  | { kind: "ask"; req: AskRequest; index: number; answers: string[]; answer: (answers: string[]) => void };

/** A governed connection that isn't authorized comes back as a raw tool error
 *  ("No access/refresh token", "not authorized", …). Detect it so the TUI can
 *  say what to actually do instead of surfacing the raw failure. */
const CONN_AUTH_RE = /(access|refresh)[\s/]{0,3}(token|credential)|token (is )?(expired|missing|invalid|revoked)|not authori[sz]ed|unauthori[sz]ed|reconnect|connect (your |the )?[\w ]+ account/i;
export function connectionAuthHint(toolName: string, content: string): string | null {
  if (!CONN_AUTH_RE.test(content)) return null;
  const svc = toolName.startsWith("conn__")
    ? (toolName.split("__")[1] || "that connection").replace(/[-_]/g, " ")
    : "that connection";
  return `${svc} isn't connected. Connect it in the Glyphh app (Connections), then retry.`;
}

/** Omit that distributes over a union (plain Omit collapses discriminants). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface AppProps {
  client: Client;
  version: string;
  server: string;
  cwd: string;
  loop: string;
  /** The session already resolved by the boot gate — seeds the header without a flash. */
  initialAccount?: Account | null;
  /** Drop back to the interactive login screen — /login reuses the boot flow so it
   *  gets the same "press enter to open the browser" UX (and Google option). */
  onRelogin?: () => void;
  /** Resume a server thread (`glyphh --thread <id>`): its messages seed the transcript
   *  and new turns keep appending to the SAME thread. */
  resumeThreadId?: string;
}

export function App({ client, version, server, cwd, loop: initialLoop, initialAccount, onRelogin, resumeThreadId }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [cols, setCols] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);
  const [account, setAccount] = useState<Account | null>(initialAccount ?? null);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ChatTurn | undefined>(undefined);
  const [verb, setVerb] = useState(VERBS[0]!);
  const [elapsed, setElapsed] = useState(0);
  /** Tool receipts are collapsed by default; ctrl+o toggles them all open
   *  (the Claude Code model — no modal browse mode, no per-receipt cursor). */
  const [expanded, setExpanded] = useState(false);
  /** Lines scrolled up from the tail; 0 = follow mode. */
  const [scroll, setScroll] = useState(0);
  const [chromeH, setChromeH] = useState({ strip: 6 });
  // Permission mode + the selected loop are per-device prefs (~/.glyphh/config.json).
  const [mode, setMode] = useState<PermissionMode>(() => readPrefs().permissionMode ?? "ask");
  const [loop, setLoopState] = useState(() => readPrefs().loop ?? initialLoop);
  // Footer status: the loop's resolved model slots (empty while loading / offline).
  const [slots, setSlots] = useState<FooterSlot[]>([]);
  const [configVersion, setConfigVersion] = useState(0); // bump to reload after a pick
  // Setter-only: calling it re-renders the tree so render-time reads of the mutated
  // `theme` palette repaint. The value itself is never read.
  const [, setThemeVersion] = useState(0);

  const nextId = useRef(0);
  const turnStartedAt = useRef(0);
  /** Aborts the in-flight turn (Esc). Null when no turn is running. */
  const turnAbort = useRef<AbortController | null>(null);
  const inputRef = useRef("");
  const stripBox = useRef<DOMElement | null>(null);
  // The loop's resolved primary model (bare id), cached per loop.
  const modelRef = useRef<{ loop: string | null; id: string | null }>({ loop: null, id: null });
  // The conversation the model sees — user/assistant turns, capped for the wire.
  const history = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  /** The run is parked on an approval or a question — the strip owns the
   *  screen until it's answered (approval: y/a/n; ask: type and Enter). */
  const [pending, setPending] = useState<Pending | null>(null);
  /** Action kinds ("edit", "command", …) the user answered "a"lways for —
   *  auto-allowed for the rest of this session. */
  const allowedKinds = useRef<Set<string>>(new Set());
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // A stable per-process id so a mid-session model switch's overrides + audit key together.
  const sessionId = useRef<string>(`cli-${Date.now().toString(36)}-${process.pid}`);

  useEffect(() => {
    const onResize = () => {
      setCols(stdout.columns || 80);
      setRows(stdout.rows || 24);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    void loadAccount(client).then(setAccount);
  }, [client]);

  // Apply the saved theme on mount — the boot gate sets it too, but this keeps the App
  // self-contained (e.g. launched directly in a test) and never paints the wrong palette.
  useEffect(() => {
    applyTheme(readPrefs().theme);
    setThemeVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed((Date.now() - turnStartedAt.current) / 1000), 250);
    return () => clearInterval(t);
  }, [busy]);

  // Real chrome heights each frame — the viewport height is exact, not guessed.
  useEffect(() => {
    const strip = stripBox.current ? measureElement(stripBox.current).height : chromeH.strip;
    if (strip !== chromeH.strip) setChromeH({ strip });
  });

  // The selected loop's resolved model slots → footer. One call (`loops.roles`) both the
  // footer and the run read, so a chip can't show a model the turn won't use.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const roles = await client.loops.roles(loop, selectionsFor(loop));
        if (cancelled) return;
        setSlots(
          roles.map((r) => ({
            label: r.label || r.name,
            // The catalog's display name for the resolved model, else its bare id.
            model: r.modelId ? (r.choices.find((c) => c.id === r.modelId)?.name ?? r.modelId.split("::").pop() ?? r.modelId) : null,
          })),
        );
      } catch {
        if (!cancelled) setSlots([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, loop, configVersion]);

  const push = useCallback((item: DistributiveOmit<Item, "id">): string => {
    const id = `i${++nextId.current}`;
    setItems((l) => [...l, { ...item, id } as Item]);
    return id;
  }, []);

  const patchItem = useCallback((id: string, fn: (item: Item) => Item) => {
    setItems((l) => l.map((it) => (it.id === id ? fn(it) : it)));
  }, []);

  const editInput = useCallback((fn: (v: string) => string) => {
    inputRef.current = fn(inputRef.current);
    setInput(inputRef.current);
  }, []);

  // ── The server thread: every chat lives in the SAME store web + desktop render
  //    (/api/sessions/threads). Minted up front; pushed at each turn end; a server
  //    that's away warns once and the next turn's push carries the backlog. ──
  const syncEvents = useMemo(
    () => ({ onOffline: (text: string) => push({ kind: "note", text }) }),
    [push],
  );
  const threadSync = useRef<ThreadSync | null>(null);
  if (threadSync.current === null) {
    // A resumed thread starts BLOCKED (awaitSeed) — pushing before the server's
    // copy lands would replace-set the thread down to just the new turns.
    threadSync.current = resumeThreadId
      ? new ThreadSync(client, resumeThreadId, syncEvents, { awaitSeed: true })
      : new ThreadSync(client, mintThreadId(), syncEvents);
  }

  /** Seed the transcript + model history from a loaded thread's plain turns. */
  const seedConversation = useCallback(
    (msgs: Array<{ role: "user" | "assistant"; text: string }>) => {
      history.current = [...msgs.map((m) => ({ role: m.role, content: m.text })), ...history.current];
      for (const m of msgs) push(m.role === "user" ? { kind: "user", text: m.text } : { kind: "answer", text: m.text });
    },
    [push],
  );

  // `--thread <id>`: load the thread's messages, seed the TUI, keep appending to it.
  useEffect(() => {
    if (!resumeThreadId) return;
    let cancelled = false;
    void (async () => {
      const sync = threadSync.current;
      try {
        const t = await client.sessions.thread(resumeThreadId);
        if (cancelled || !sync) return;
        sync.seedResumed(t);
        seedConversation(conversationOf(t.messages));
        push({ kind: "meta", text: `* Resumed "${t.title}" · ${t.messages.length} message${t.messages.length === 1 ? "" : "s"}` });
      } catch (err) {
        if (cancelled || !sync) return;
        // Unreadable (offline / not yours / gone) — re-aim at a FRESH id so a
        // later push can never clobber a thread we never read.
        sync.failResume(mintThreadId());
        push({ kind: "note", text: `Couldn't load thread ${resumeThreadId} (${(err as Error).message}) — starting a fresh chat.` });
      }
    })();
    return () => { cancelled = true; };
  }, [client, resumeThreadId, push, seedConversation]);

  /** `/threads <id>` — swap this chat for a saved one, in place. */
  const resumeThread = useCallback(
    async (id: string): Promise<string[]> => {
      if (!THREAD_ID_RE.test(id)) throw new Error(`bad thread id: ${id}`);
      const t = await client.sessions.thread(id); // throws → the command surface reports it
      history.current = [];
      setItems([]);
      setExpanded(false);
      setScroll(0);
      setLast(undefined);
      const sync = new ThreadSync(client, id, syncEvents, { awaitSeed: true });
      sync.seedResumed(t);
      threadSync.current = sync;
      const convo = conversationOf(t.messages);
      seedConversation(convo);
      push({ kind: "meta", text: `* Resumed "${t.title}" · ${t.messages.length} message${t.messages.length === 1 ? "" : "s"}` });
      return [`resumed "${t.title}"`];
    },
    [client, push, seedConversation, syncEvents],
  );

  const setLoop = useCallback((l: string) => {
    modelRef.current = { loop: null, id: null }; // re-resolve for the new loop
    setLoopState(l);
    writePrefs({ loop: l });
  }, []);

  const setTheme = useCallback((name: string) => {
    applyTheme(name);
    writePrefs({ theme: name });
    setThemeVersion((v) => v + 1); // repaint the whole tree in the new palette
  }, []);

  // Resolve a VALID loop on mount. The default slug ("default") — or a stale
  // saved pref — often isn't one this account actually has, so every turn would
  // fail with a server "loop not found" and no model would ever bind. Fetch the
  // account's loops and, if the current one isn't among them, fall back to the
  // first available (or say there are none).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { loops } = await client.loops.list();
        if (cancelled) return;
        if (!loops?.length) {
          push({ kind: "note", text: "No loops available for this account — create one in the Glyphh platform, then restart." });
          return;
        }
        if (!loops.some((l) => l.slug === loop)) {
          const next = loops[0]!.slug;
          setLoop(next);
          push({ kind: "note", text: `Loop "${loop}" isn't available — switched to "${next}".` });
        }
      } catch {
        /* offline / server error — leave the loop as-is; a turn will report it */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Welcome card — mount-only by design. Greets the signed-in user (the boot gate has
  // already resolved the session) inside a bordered card at the top of the transcript.
  useEffect(() => {
    const who = account?.name ?? account?.email?.split("@")[0];
    push({
      kind: "card",
      title: who ? `Welcome back, ${who}` : "Welcome to Glyphh",
      body: [
        "The Glyphh agent — the same engine as the desktop, in your terminal. Answers stream live; tool calls (files, shell, the web, your platform) land as receipts.",
        "ctrl+o expands/collapses tool output · ↑/↓ scrolls · shift+tab cycles permission mode",
        "/help for commands · /theme to restyle · /loop to switch loops",
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runTurn = useCallback(
    async (prompt: string) => {
      const startedAt = Date.now();
      turnStartedAt.current = startedAt;
      setElapsed(0);
      setVerb(VERBS[nextId.current % VERBS.length]!);
      push({ kind: "user", text: prompt });
      const turn: ChatTurn = {
        id: `t${nextId.current}`,
        text: "",
        status: "running",
        tokensUp: 0,
        tokensDown: 0,
        credits: null,
        stubbed: false,
        degraded: false,
      };
      setLast({ ...turn });
      setBusy(true);
      const abort = new AbortController();
      turnAbort.current = abort;
      try {
        // THE DESKTOP'S PATH, exactly: the model comes from `loops.roles` (the same
        // call the footer chip reads, so the chip and the run agree by construction),
        // and the turn STREAMS over the gateway's Messages edge with the caller's
        // bearer — token deltas render as they arrive. This device's per-loop picks
        // layer in as selections; a live `/use` switch wins.
        if (modelRef.current.loop !== loop) {
          let effective = loop;
          let roles;
          try {
            roles = await client.loops.roles(effective, {
              ...selectionsFor(effective),
              ...sessionOverrides(sessionId.current, effective),
            });
          } catch {
            // The selected loop isn't available for this account — fall back to
            // the first loop it actually has so a turn never dies on "loop not
            // found", and remember the choice.
            const list = await client.loops.list().catch(() => ({ loops: [] as Array<{ slug: string }> }));
            const first = list.loops[0]?.slug;
            if (!first) throw new Error("no loops are available for this account — create one in the Glyphh platform");
            effective = first;
            setLoop(first);
            roles = await client.loops.roles(effective, {
              ...selectionsFor(effective),
              ...sessionOverrides(sessionId.current, effective),
            });
          }
          const id = roles.find((r) => r.modelId)?.modelId ?? null;
          modelRef.current = { loop: effective, id: id ? (id.includes("::") ? id.slice(id.indexOf("::") + 2) : id) : null };
        }
        if (!modelRef.current.id) {
          turn.status = "error";
          turn.text = "No model available for this loop — pick one with /use, or switch loops with /loop.";
          push({ kind: "note", text: turn.text });
        } else {
          // CHRONOLOGICAL segments: text streams into the item at the BOTTOM of
          // the transcript; every tool receipt closes the segment, so post-tool
          // text opens a fresh ● below the receipts — work reads in order.
          let segId: string | null = null;
          let segText = "";
          let text = "";
          // A tool's start receipt, keyed by name, so its result folds into the
          // SAME receipt (parallel calls queue per name).
          const toolItems = new Map<string, string[]>();
          /** The transcript sink the frame stream paints through. */
          const sink = {
            delta: (t: string) => {
              text += t;
              if (!segId) {
                segText = t.replace(/^\s+/, "");
                if (!segText) return; // a bare separator between turns — wait for content
                segId = push({ kind: "answer", text: segText });
                return;
              }
              segText += t;
              const id = segId;
              patchItem(id, (it) => ({ ...it, text: segText }) as Item);
            },
            // A tool call lands as a ⏺ receipt; its result folds into it.
            toolStart: (name: string, title?: string) => {
              segId = null; // next text lands BELOW this receipt
              const id = push({ kind: "section", step: { label: toolLabel(name, title), ok: true, details: [] } });
              const queue = toolItems.get(name) ?? [];
              queue.push(id);
              toolItems.set(name, queue);
            },
            toolDone: (name: string, r: { failed: boolean; denied: boolean; preview: string }) => {
              segId = null;
              // An unauthorized connection surfaces as a tool failure — turn it
              // into an actionable note rather than a raw error receipt.
              const hint = r.failed ? connectionAuthHint(name, r.preview) : null;
              if (hint) push({ kind: "note", text: hint });
              const details = r.preview ? r.preview.split("\n").slice(0, 200) : [];
              const error = r.denied ? "denied" : r.failed ? "tool error" : undefined;
              const id = toolItems.get(name)?.shift();
              if (id) {
                patchItem(id, (it) => {
                  const step = (it as { step: TurnStep }).step;
                  return { ...it, step: { ...step, ok: !r.failed, details, ...(error ? { error } : {}) } } as Item;
                });
                return;
              }
              push({
                kind: "section",
                step: { label: `${name} → ${r.failed ? "error" : "result"}`, ok: !r.failed, details, ...(error ? { error } : {}) },
              });
            },
            progress: (up: number, down: number) => {
              turn.tokensUp = up;
              turn.tokensDown = down;
              setLast({ ...turn });
            },
          };

          const result = await runHarnessTurn(
            {
              client,
              server,
              model: modelRef.current.id,
              threadId: threadSync.current?.id ?? "",
              history: history.current.slice(-HISTORY_CAP),
              prompt,
              cwd: process.cwd(),
              permission: modeRef.current,
              signal: abort.signal,
            },
            {
              onDelta: sink.delta,
              onToolStart: sink.toolStart,
              onToolDone: sink.toolDone,
              onProgress: sink.progress,
              onCredits: (credits) => {
                turn.credits = credits;
                setLast({ ...turn });
              },
              // The pod PARKED the run: the strip takes the keyboard until the
              // user answers, and `answer` resumes the pod-side loop.
              onApproval: (req, answer) => {
                if (allowedKinds.current.has(req.kind)) {
                  answer(true);
                  return;
                }
                setPending({ kind: "approval", req, answer });
              },
              onAsk: (req, answer) => setPending({ kind: "ask", req, index: 0, answers: [], answer }),
              onNote: (note) => push({ kind: "note", text: note }),
            },
          );
          text = result.text || text;
          turn.text = text;
          const stopped = result.stopped || abort.signal.aborted;
          if (result.error) {
            turn.status = "error";
            push({ kind: "note", text: result.error });
          }
          if (stopped) push({ kind: "note", text: "⏹ Stopped." });
          else if (!result.error && !text.trim()) push({ kind: "note", text: "(no answer text — the run ended after tool calls)" });
          // A stopped turn's partial answer still belongs in the history so a
          // follow-up ("continue") has the context.
          history.current.push({ role: "user", content: prompt });
          history.current.push({ role: "assistant", content: text || "…" });
          // Mirror the turn into the server thread (CodeMsg-shaped, verbatim) and
          // push the replace-set — ONE push per completed turn, never per token.
          // `push` never throws: offline goes quiet and retries at the next turn.
          const sync = threadSync.current;
          if (sync) {
            sync.append({ role: "user", text: prompt, at: startedAt });
            sync.append({ role: "assistant", text: text || "…", at: Date.now() });
            void sync.push();
          }
          if (turn.status !== "error") turn.status = stopped ? "stopped" : "done";
        }
        turn.durationMs = Date.now() - startedAt;
        setLast({ ...turn });
        // The settle line under the answer: `* Verbed for 3.1s` (+ credits when known).
        const settleVerb =
          turn.status === "error" ? "Stalled" : turn.status === "stopped" ? "Stopped" : VERBS[nextId.current % VERBS.length]!.past;
        const parts = [
          settleVerb,
          `for ${(turn.durationMs / 1000).toFixed(1)}s`,
        ];
        if (turn.credits !== null) parts.push(`· ◈ ${turn.credits} credit${turn.credits === 1 ? "" : "s"}`);
        push({ kind: "meta", text: `* ${parts.join(" ")}` });
      } catch (err) {
        // The pod wouldn't start / went away mid-turn: ONE honest line in the
        // transcript, never a crash and never a fabricated answer.
        turn.status = "error";
        turn.text = `Harness unavailable — ${(err as Error).message}`;
        turn.durationMs = Date.now() - startedAt;
        push({ kind: "note", text: turn.text });
        setLast({ ...turn });
      } finally {
        turnAbort.current = null;
        setPending(null); // a parked ask/approval dies with its run
        setBusy(false);
      }
    },
    [client, loop, push],
  );

  /** Stop the in-flight turn (Esc). The agent subprocess is torn down; the partial
   *  answer already streamed stays on screen. */
  const stopTurn = useCallback(() => {
    turnAbort.current?.abort();
  }, []);

  const runCommand = useCallback(
    async (line: string) => {
      const id = push({ kind: "command", text: line });
      const ctx: CommandCtx = {
        client,
        account,
        loop,
        version,
        server,
        setAccount,
        setLoop,
        setTheme,
        clearChat: () => {
          history.current = [];
          setItems([]);
          setExpanded(false);
          setScroll(0);
          setLast(undefined);
          // A cleared transcript is a NEW conversation — pushing the old thread's
          // replace-set from an empty transcript would wipe it, so re-aim first.
          threadSync.current = new ThreadSync(client, mintThreadId(), syncEvents);
        },
        quit: () => exit(),
        ...(onRelogin ? { relogin: onRelogin } : {}),
        emit: (lines) => patchItem(id, (it) => ({ ...it, result: lines }) as Item),
        refreshConfig: () => setConfigVersion((v) => v + 1),
        sessionId: sessionId.current,
        invalidateModels: () => {
          modelRef.current = { loop: null, id: null };
        },
        threadId: threadSync.current?.id ?? "",
        resumeThread,
      };
      const result = await runSlash(ctx, line);
      patchItem(id, (it) => ({ ...it, result }) as Item);
    },
    [account, client, exit, patchItem, push, loop, server, setLoop, setTheme, version, onRelogin, resumeThread, syncEvents],
  );

  const submit = useCallback(() => {
    const raw = inputRef.current.trim();
    if (!raw || busy) return;
    editInput(() => "");
    if (raw.startsWith("/")) return void runCommand(raw);
    if (!account) {
      push({ kind: "user", text: raw });
      push({ kind: "note", text: "Not logged in · run /login to sign in" });
      return;
    }
    void runTurn(raw);
  }, [account, busy, editInput, push, runCommand, runTurn]);

  // ── The line model — regenerated from items, so a fold toggle is retroactive
  //    (ctrl+o re-renders every receipt at the new expansion). ──
  const width = Math.max(20, cols - 4);
  const lines = useMemo(() => {
    const out: Line[] = [];
    // The banner is scrollback, not chrome — it scrolls away like any other
    // content, and the cat only renders when the terminal is wide enough.
    out.push(...headerLines(width, CAT_ROWS, {
      version,
      name: account ? (account.name ?? account.email) : null,
      plan: account
        ? `${account.tier.charAt(0).toUpperCase()}${account.tier.slice(1)}${account.credits !== null ? ` · ${account.credits} credits` : ""}`
        : null,
      email: account?.email ?? null,
      cwd,
      notes: RELEASE_NOTES.length ? RELEASE_NOTES : [server.replace(/^https?:\/\//, "")],
    }));
    if (items.length === 0) {
      out.push({ text: "Ask Glyphh anything, or type /help. Ctrl+C to quit.", style: "hint" });
    }
    for (const item of items) {
      if (item.kind === "user") out.push(...userLines(item.text, width));
      else if (item.kind === "command") out.push(...commandLines(item.text, item.result, width));
      else if (item.kind === "section") out.push(...sectionLines(item.step, expanded));
      else if (item.kind === "answer") out.push(...answerLines(item.text, width));
      else if (item.kind === "meta") out.push(...metaLines(item.text));
      else if (item.kind === "card") out.push(...cardLines(item.title, item.body, width));
      else out.push(...noteLines(item.text));
    }
    return out;
  }, [items, expanded, width, version, account, cwd, server]);

  const paneH = Math.max(3, rows - 1 - chromeH.strip);
  const maxScroll = Math.max(0, lines.length - paneH);
  const clampedScroll = Math.min(scroll, maxScroll);
  const start = Math.max(0, lines.length - paneH - clampedScroll);
  const visible = lines.slice(start, start + paneH);

  const scrollBy = useCallback(
    (d: number) => setScroll((s) => Math.max(0, Math.min(Math.max(0, lines.length - paneH), s + d))),
    [lines.length, paneH],
  );

  /** Answer the ask the strip is showing (Enter). A bare Enter skips the
   *  question — the pod reads an empty answer as "proceed on best judgment". */
  const answerAsk = useCallback(() => {
    setPending((p) => {
      if (p?.kind !== "ask") return p;
      const raw = inputRef.current.trim();
      editInput(() => "");
      const q = p.req.questions[p.index]!;
      const options = q.options ?? [];
      const pick = /^[1-9]$/.test(raw) ? options[Number(raw) - 1] : undefined;
      const value = pick ?? raw;
      push({ kind: "meta", text: `* ${q.question} → ${value || "(skipped)"}` });
      const answers = [...p.answers, value];
      if (answers.length >= p.req.questions.length) {
        p.answer(answers);
        return null;
      }
      return { ...p, index: p.index + 1, answers };
    });
  }, [editInput, push]);

  useInput((ch, key) => {
    // A parked approval owns the keyboard: y allows once, a allows that ACTION
    // KIND for the session, n/esc refuses. Everything else is swallowed.
    if (pending?.kind === "approval") {
      if (ch === "y" || key.return) pending.answer(true);
      else if (ch === "a") {
        allowedKinds.current.add(pending.req.kind);
        pending.answer(true);
      } else if (ch === "n" || key.escape) pending.answer(false);
      else return;
      setPending(null);
      return;
    }
    // A parked ask types into the composer like any prompt; Enter submits it.
    if (pending?.kind === "ask" && key.return) {
      answerAsk();
      return;
    }
    // Esc stops the RUNNING turn (the pod aborts its agent, keeps the partial
    // answer). Ctrl+C still quits the whole app — Esc is the "stop this, stay here".
    if (busy && key.escape) {
      stopTurn();
      return;
    }
    // ctrl+o toggles ALL tool receipts open/collapsed (Claude Code's model —
    // one key, no mode to enter). Folding re-renders from items, retroactive.
    if (key.ctrl && ch === "o") {
      setExpanded((e) => !e);
      return;
    }
    if (key.ctrl && ch === "c") {
      exit();
      return;
    }
    // shift+tab cycles the permission mode (persisted per-device). "[Z" is the
    // raw sequence after ink strips the ESC prefix on some terminals.
    if ((key.tab && key.shift) || ch === "[Z") {
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
      setMode(next);
      writePrefs({ permissionMode: next });
      return;
    }
    if (key.tab || ch === "\t") return; // no browse mode — bare tab is inert
    // The scroll surface: wheel arrives as arrows (alternate-scroll), plus
    // paging keys. Follow mode is offset 0 — any new content snaps the tail.
    if (key.upArrow) {
      scrollBy(1);
      return;
    }
    if (key.downArrow) {
      scrollBy(-1);
      return;
    }
    if (key.pageUp || (key.ctrl && ch === "u")) {
      scrollBy(paneH - 1);
      return;
    }
    if (key.pageDown || (key.ctrl && ch === "d")) {
      scrollBy(-(paneH - 1));
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.backspace || key.delete) {
      editInput((v) => v.slice(0, -1));
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      // Pasted text can carry a newline — take the text before it, then submit.
      const nl = ch.search(/[\r\n]/);
      if (nl >= 0) {
        const before = ch.slice(0, nl);
        if (before) editInput((v) => v + before);
        submit();
        return;
      }
      if (ch >= " ") editInput((v) => v + ch);
    }
  });

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* ONE scroll surface — the banner is its first content, so the whole
          page above the strip scrolls. minHeight={0} is load-bearing: a
          flexGrow child defaults to min-height:auto (its content size), so
          without this it refuses to shrink and PUSHES the footer past the
          terminal — the "footer scrolls away" bug. With it, the box clips
          (overflow hidden) and the footer stays pinned no matter how long
          the transcript grows. */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} paddingX={1} overflow="hidden">
        {visible.map((l, i) => <TranscriptLine key={`${start + i}`} line={l} />)}
      </Box>
      {clampedScroll > 0 ? (
        <Text color={theme.faint}>{`  ↓ ${clampedScroll} lines below · ↑/↓ scrolls · pgdn returns`}</Text>
      ) : null}
      <Box flexDirection="column" flexShrink={0} ref={stripBox}>
        <SubFooter width={cols} busy={busy} elapsed={elapsed} last={last} verb={verb} />
        {pending?.kind === "approval" ? (
          <Box flexDirection="column">
            <Text color={theme.accent} wrap="truncate-end">
              {`  ⏸ ${pending.req.title}${pending.req.detail ? `  ${pending.req.detail.split("\n")[0]}` : ""}`}
            </Text>
            <Text color={theme.faint} wrap="truncate-end">
              {`     allow? (y)es once · (a)lways ${pending.req.kind} this session · (n)o`}
            </Text>
          </Box>
        ) : null}
        {pending?.kind === "ask" ? (
          <Box flexDirection="column">
            <Text color={theme.accent} wrap="truncate-end">
              {`  ⏸ ${pending.req.questions[pending.index]?.question ?? ""}${
                pending.req.questions.length > 1 ? `  (${pending.index + 1}/${pending.req.questions.length})` : ""
              }`}
            </Text>
            {(pending.req.questions[pending.index]?.options ?? []).map((o, i) => (
              <Text key={o} color={theme.faint} wrap="truncate-end">{`     ${i + 1}) ${o}`}</Text>
            ))}
            <Text color={theme.faint} wrap="truncate-end">
              {"     type an answer (or its number) and press enter · empty skips"}
            </Text>
          </Box>
        ) : null}
        <InputBar width={cols} value={input} busy={busy} />
        <Footer width={cols} permissionMode={mode} loop={loop} slots={slots} />
      </Box>
    </Box>
  );
}
