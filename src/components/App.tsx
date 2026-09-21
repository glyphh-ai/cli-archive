/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * App.tsx — the full-screen chat. ONE scroll surface (logo, identity card,
 * transcript) above a pinned strip (status, a parked approval, the slash menu,
 * the composer, the footer). A turn is the Glyphh loop itself (loop.ts) running
 * in this process on the gateway: text streams live, tool calls land as
 * collapsible receipts, and a permission ask parks the run on the strip.
 *
 * Keys, the way every agent CLI has them: enter sends; ↑/↓ recall prompts;
 * ←/→ move the cursor (ctrl+a/e home/end, ctrl+w or alt+backspace deletes a
 * word, ctrl+u clears the line); shift+tab cycles the permission chip; esc
 * stops the turn; ctrl+o expands tool output; pgup/pgdn scroll; ctrl+c clears
 * the line, twice quits. "/" opens the command menu.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import type { Client } from "@glyphh/sdk";
import { runLoopTurn, type ApprovalRequest } from "../loop.js";
import { defaultModel } from "../models.js";
import { readPrefs, writePrefs, rememberPrompt } from "../prefs.js";
import { logoRows } from "../banner.js";
import { InputBar } from "./InputBar.js";
import { Footer, type FooterSlot } from "./Footer.js";
import { SubFooter } from "./SubFooter.js";
import { SlashMenu } from "./SlashMenu.js";
import { TranscriptLine } from "./TranscriptLine.js";
import { theme, applyTheme } from "../theme.js";
import { loadAccount, type Account } from "../glyphh.js";
import { runSlash, matchCommands, RELEASE_NOTES, type CommandCtx, type SessionCost } from "../commands.js";
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
import { PERMISSION_CYCLE, PERMISSION_LABEL, type ChatTurn, type Item, type PermissionMode, type TurnStep } from "../types.js";

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

/** Most recent turns handed to the loop as its seed — bounds the wire, not the transcript. */
const HISTORY_CAP = 40;

/** A second ctrl+c within this window quits. */
const QUIT_WINDOW_MS = 2000;

/** A tool receipt label: the loop names each call ("bash npm test"); long titles clip. */
export function toolLabel(name: string, title?: string): string {
  const t = (title ?? "").trim();
  if (!t) return name;
  return t.length > 76 ? `${t.slice(0, 75)}…` : t;
}

/** What the strip is blocked on — the loop PARKED the run until the user answers. */
type Pending = { kind: "approval"; req: ApprovalRequest; answer: (allow: boolean) => void };

/** A governed connection that isn't authorized comes back as a raw tool error —
 *  turn it into the one line that says what to do. */
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

/** A fresh conversation id — the loop keeps its messages under it. */
const mintChatId = (): string => `cli-${Date.now().toString(36)}-${process.pid}`;

/** The composer's text as code points, so the cursor never splits a glyph. */
const cps = (s: string): string[] => [...s];

/** Delete the word before `at` (a ctrl+w / alt+backspace). */
export function deleteWordBefore(value: string, at: number): { value: string; cursor: number } {
  const chars = cps(value);
  let i = Math.min(at, chars.length);
  while (i > 0 && chars[i - 1] === " ") i--;
  while (i > 0 && chars[i - 1] !== " ") i--;
  return { value: [...chars.slice(0, i), ...chars.slice(Math.min(at, chars.length))].join(""), cursor: i };
}

export interface AppProps {
  client: Client;
  version: string;
  server: string;
  cwd: string;
  /** The session already resolved by the boot gate — seeds the header without a flash. */
  initialAccount?: Account | null;
  /** Drop back to the interactive login screen — /login reuses the boot flow. */
  onRelogin?: () => void;
  /** `--bridge`: this TUI fronts the Glyphh bridge at this URL (Claude Desktop's gateway and issuer). */
  bridgeUrl?: string;
  /** `--model`: the gateway model this session runs on (a session pick, not persisted). */
  initialModel?: string;
  /** `--permission`: the chip to start on, for this launch. */
  initialMode?: PermissionMode;
  /** An opening prompt from the command line — sent once, on mount. */
  initialPrompt?: string;
}

export function App({ client, version, server, cwd, initialAccount, onRelogin, bridgeUrl, initialModel, initialMode, initialPrompt }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [cols, setCols] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);
  const [account, setAccount] = useState<Account | null>(initialAccount ?? null);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ChatTurn | undefined>(undefined);
  const [verb, setVerb] = useState(VERBS[0]!);
  const [elapsed, setElapsed] = useState(0);
  /** Tool receipts are collapsed by default; ctrl+o toggles them all open. */
  const [expanded, setExpanded] = useState(false);
  /** Lines scrolled up from the tail; 0 = follow mode. */
  const [scroll, setScroll] = useState(0);
  const [chromeH, setChromeH] = useState({ strip: 6 });
  // The permission chip is a per-device pref (~/.glyphh/config.json); a flag wins for this launch.
  const [mode, setMode] = useState<PermissionMode>(() => initialMode ?? readPrefs().permissionMode ?? "default");
  // THE MODEL: the device's persisted pick (/model), a session pick (--model, /use)
  // over it, and the org's default underneath when neither names one.
  const [pickedModel, setPickedModel] = useState<string | null>(() => readPrefs().model ?? null);
  const [sessionModel, setSessionModel] = useState<string | null>(initialModel ?? null);
  const [orgDefault, setOrgDefault] = useState<string | null>(null);
  /** The composer's transient hint (ctrl+c once). */
  const [hint, setHint] = useState<string | null>(null);
  /** Slash menu selection while the line starts with "/". */
  const [slashSel, setSlashSel] = useState(0);
  // Setter-only: calling it re-renders the tree so render-time reads of the mutated
  // `theme` palette repaint. The value itself is never read.
  const [, setThemeVersion] = useState(0);

  const nextId = useRef(0);
  const turnStartedAt = useRef(0);
  /** Aborts the in-flight turn (Esc). Null when no turn is running. */
  const turnAbort = useRef<AbortController | null>(null);
  const inputRef = useRef("");
  const cursorRef = useRef(0);
  const stripBox = useRef<DOMElement | null>(null);
  // The conversation the loop was seeded with — user/assistant turns, capped for the wire.
  const history = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  // This conversation's id; /clear mints a new one so the loop starts fresh.
  const chatId = useRef(mintChatId());
  /** Prompt history (↑/↓): the device's saved prompts plus this session's. */
  const prompts = useRef<string[]>(readPrefs().history ?? []);
  /** Where ↑/↓ is in the history; prompts.length = the live line. */
  const histIdx = useRef<number>(prompts.current.length);
  /** The live line stashed while browsing history. */
  const stash = useRef("");
  /** The run is parked on an approval — the strip owns the keyboard until y/a/n. */
  const [pending, setPending] = useState<Pending | null>(null);
  /** Action kinds ("edit", "command", …) the user answered "a"lways for — auto-allowed for the session. */
  const allowedKinds = useRef<Set<string>>(new Set());
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const modelRef = useRef<{ picked: string | null; session: string | null }>({ picked: pickedModel, session: sessionModel });
  modelRef.current = { picked: pickedModel, session: sessionModel };
  /** What this session has spent (/cost). */
  const cost = useRef<SessionCost>({ turns: 0, tokensUp: 0, tokensDown: 0, durationMs: 0, startedAt: Date.now() });
  /** The last ctrl+c, for the double-press quit. */
  const lastCtrlC = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // The org's default model → the footer chip when nothing is picked (the same
  // answer a turn falls back to, so the chip never shows a model a turn won't use).
  useEffect(() => {
    let cancelled = false;
    void defaultModel(client).then((m) => { if (!cancelled) setOrgDefault(m || null); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [client, account]);

  const push = useCallback((item: DistributiveOmit<Item, "id">): string => {
    const id = `i${++nextId.current}`;
    setItems((l) => [...l, { ...item, id } as Item]);
    return id;
  }, []);

  const patchItem = useCallback((id: string, fn: (item: Item) => Item) => {
    setItems((l) => l.map((it) => (it.id === id ? fn(it) : it)));
  }, []);

  /** Set the composer's text and cursor together (refs for the key handler, state for paint). */
  const setLine = useCallback((value: string, at?: number) => {
    inputRef.current = value;
    cursorRef.current = Math.max(0, Math.min(at ?? cps(value).length, cps(value).length));
    setInput(value);
    setCursor(cursorRef.current);
    setSlashSel(0);
  }, []);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), QUIT_WINDOW_MS);
  }, []);

  const setModel = useCallback((id: string | null, opts: { session?: boolean } = {}) => {
    if (opts.session) {
      setSessionModel(id);
      return;
    }
    setSessionModel(null);
    setPickedModel(id);
    writePrefs({ model: id ?? null });
  }, []);

  const setPermission = useCallback((next: PermissionMode) => {
    setMode(next);
    writePrefs({ permissionMode: next });
  }, []);

  const setTheme = useCallback((name: string) => {
    applyTheme(name);
    writePrefs({ theme: name });
    setThemeVersion((v) => v + 1); // repaint the whole tree in the new palette
  }, []);

  // Welcome card — mount-only by design.
  useEffect(() => {
    const who = account?.name ?? account?.email?.split("@")[0];
    push({
      kind: "card",
      title: who ? `Welcome back, ${who}` : "Welcome to Glyphh",
      body: [
        "The Glyphh loop — the same engine as the desktop, in your terminal, on any model your organization runs on the gateway. Answers stream live; tool calls (files, shell, your connected apps) land as receipts.",
        `permissions: ${PERMISSION_LABEL[mode]} — shift+tab cycles, /permissions sets`,
        "/help for commands · / opens the menu · ↑ recalls prompts · ctrl+o expands tool output",
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runTurn = useCallback(
    async (prompt: string) => {
      const startedAt = Date.now();
      turnStartedAt.current = startedAt;
      setElapsed(0);
      // ONE verb per turn: the strip's "Verbing…" and the settle line's "Verbed"
      // are the same pair (they disagreed when another item landed in between).
      const v = VERBS[nextId.current % VERBS.length]!;
      setVerb(v);
      push({ kind: "user", text: prompt });
      const turn: ChatTurn = { id: `t${nextId.current}`, text: "", status: "running", tokensUp: 0, tokensDown: 0 };
      setLast({ ...turn });
      setBusy(true);
      const abort = new AbortController();
      turnAbort.current = abort;
      try {
        // THE MODEL, in order: this session's pick, the device's pick, the org's
        // default. None → say so; the loop never guesses a model.
        const model = modelRef.current.session ?? modelRef.current.picked ?? (await defaultModel(client).catch(() => ""));
        if (!model) {
          turn.status = "error";
          turn.text = "No model — your organization has none allowed on the gateway yet, or its lane is off. Pick one with /model once an admin allows some.";
          push({ kind: "note", text: turn.text });
        } else {
          if (model !== orgDefault && !modelRef.current.session && !modelRef.current.picked) setOrgDefault(model);
          // CHRONOLOGICAL segments: text streams into the item at the BOTTOM of
          // the transcript; every tool receipt closes the segment, so post-tool
          // text opens a fresh ● below the receipts — work reads in order.
          let segId: string | null = null;
          let segText = "";
          let text = "";
          const toolItems = new Map<string, string[]>();
          const sink = {
            delta: (t: string) => {
              text += t;
              if (!segId) {
                segText = t.replace(/^\s+/, "");
                if (!segText) return;
                segId = push({ kind: "answer", text: segText });
                return;
              }
              segText += t;
              const id = segId;
              patchItem(id, (it) => ({ ...it, text: segText }) as Item);
            },
            toolStart: (name: string, title?: string) => {
              segId = null;
              const id = push({ kind: "section", step: { label: toolLabel(name, title), ok: true, details: [] } });
              const queue = toolItems.get(name) ?? [];
              queue.push(id);
              toolItems.set(name, queue);
            },
            toolDone: (name: string, r: { failed: boolean; denied: boolean; preview: string }) => {
              segId = null;
              const authHint = r.failed ? connectionAuthHint(name, r.preview) : null;
              if (authHint) push({ kind: "note", text: authHint });
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
              push({ kind: "section", step: { label: `${name} → ${r.failed ? "error" : "result"}`, ok: !r.failed, details, ...(error ? { error } : {}) } });
            },
            progress: (up: number, down: number) => {
              turn.tokensUp = up;
              turn.tokensDown = down;
              setLast({ ...turn });
            },
          };

          const result = await runLoopTurn(
            {
              client,
              model,
              chatId: chatId.current,
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
              // The loop PARKED the run: the strip takes the keyboard until the
              // user answers, and `answer` resumes the loop.
              onApproval: (req, answer) => {
                if (allowedKinds.current.has(req.kind)) {
                  answer(true);
                  return;
                }
                setPending({ kind: "approval", req, answer });
              },
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
          history.current.push({ role: "user", content: prompt });
          history.current.push({ role: "assistant", content: text || "…" });
          if (turn.status !== "error") turn.status = stopped ? "stopped" : "done";
        }
        turn.durationMs = Date.now() - startedAt;
        setLast({ ...turn });
        cost.current.turns++;
        cost.current.tokensUp += turn.tokensUp;
        cost.current.tokensDown += turn.tokensDown;
        cost.current.durationMs += turn.durationMs;
        // The settle line under the answer: `* Verbed for 3.1s · 120↑ 480↓`.
        const settleVerb = turn.status === "error" ? "Stalled" : turn.status === "stopped" ? "Stopped" : v.past;
        const parts = [settleVerb, `for ${(turn.durationMs / 1000).toFixed(1)}s`];
        if (turn.tokensUp || turn.tokensDown) parts.push(`· ${turn.tokensUp}↑ ${turn.tokensDown}↓`);
        push({ kind: "meta", text: `* ${parts.join(" ")}` });
      } catch (err) {
        turn.status = "error";
        turn.text = `Glyphh loop unavailable — ${(err as Error).message}`;
        turn.durationMs = Date.now() - startedAt;
        push({ kind: "note", text: turn.text });
        setLast({ ...turn });
      } finally {
        turnAbort.current = null;
        setPending(null); // a parked approval dies with its run
        setBusy(false);
      }
    },
    [client, orgDefault, patchItem, push],
  );

  /** Stop the in-flight turn (Esc). The loop aborts; the partial answer stays on screen. */
  const stopTurn = useCallback(() => {
    turnAbort.current?.abort();
  }, []);

  const runCommand = useCallback(
    async (line: string) => {
      const id = push({ kind: "command", text: line });
      const ctx: CommandCtx = {
        client,
        account,
        version,
        server,
        cwd,
        model: sessionModel ?? pickedModel,
        permission: mode,
        chatId: chatId.current,
        cost: cost.current,
        setAccount,
        setModel,
        setPermission,
        setTheme,
        clearChat: () => {
          history.current = [];
          chatId.current = mintChatId(); // a cleared transcript is a NEW conversation
          setItems([]);
          setExpanded(false);
          setScroll(0);
          setLast(undefined);
        },
        quit: () => exit(),
        ...(onRelogin ? { relogin: onRelogin } : {}),
        emit: (lines) => patchItem(id, (it) => ({ ...it, result: lines }) as Item),
        note: (text) => { push({ kind: "note", text }); },
      };
      const result = await runSlash(ctx, line);
      patchItem(id, (it) => ({ ...it, result }) as Item);
    },
    [account, client, cwd, exit, mode, patchItem, push, server, setModel, setPermission, setTheme, version, onRelogin, sessionModel, pickedModel],
  );

  const submit = useCallback(() => {
    const raw = inputRef.current.trim();
    if (!raw || busy) return;
    setLine("");
    prompts.current = rememberPrompt(raw);
    histIdx.current = prompts.current.length;
    if (raw.startsWith("/")) return void runCommand(raw);
    if (!account) {
      push({ kind: "user", text: raw });
      push({ kind: "note", text: "Not logged in · run /login to sign in" });
      return;
    }
    void runTurn(raw);
  }, [account, busy, push, runCommand, runTurn, setLine]);

  // An opening prompt from the command line (the desktop's terminal card seeds
  // one): sent once, after the welcome card, when signed in.
  const openingSent = useRef(false);
  useEffect(() => {
    if (!initialPrompt || openingSent.current || !account) return;
    openingSent.current = true;
    void runTurn(initialPrompt);
  }, [initialPrompt, account, runTurn]);

  // ── The line model — regenerated from items, so a fold toggle is retroactive. ──
  const width = Math.max(20, cols - 4);
  const effectiveModel = sessionModel ?? pickedModel ?? orgDefault;
  const lines = useMemo(() => {
    const out: Line[] = [];
    out.push(...headerLines(width, logoRows(width), {
      version,
      name: account ? (account.name ?? account.email) : null,
      plan: account ? `${account.tier.charAt(0).toUpperCase()}${account.tier.slice(1)}` : null,
      email: account?.email ?? null,
      cwd,
      model: effectiveModel,
      server: server.replace(/^https?:\/\//, ""),
      notes: bridgeUrl
        ? [`bridge mode · Claude Desktop → ${bridgeUrl}`, "gateway + issuer URL for Claude Desktop", ...RELEASE_NOTES.slice(0, 1)]
        : RELEASE_NOTES,
    }));
    if (items.length === 0) {
      out.push({ text: "Ask Glyphh anything, or type / for commands.", style: "hint" });
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
  }, [items, expanded, width, version, account, cwd, server, bridgeUrl, effectiveModel]);

  // ONE ROW SHORT OF THE TERMINAL, always (his report, 2026-09-21: "twitchy,
  // flickering even when the user types"). Ink clears the WHOLE screen before
  // every frame once the output is as tall as the terminal, and a full-screen
  // root box is exactly that tall — so every keystroke wiped and redrew. Below
  // that line Ink diffs and rewrites only the rows that changed.
  const frameH = Math.max(4, rows - 1);
  const paneH = Math.max(3, frameH - 1 - chromeH.strip);
  const maxScroll = Math.max(0, lines.length - paneH);
  const clampedScroll = Math.min(scroll, maxScroll);
  const start = Math.max(0, lines.length - paneH - clampedScroll);
  const visible = lines.slice(start, start + paneH);

  const scrollBy = useCallback(
    (d: number) => setScroll((s) => Math.max(0, Math.min(Math.max(0, lines.length - paneH), s + d))),
    [lines.length, paneH],
  );

  // The slash menu: open while the line is a lone "/word" (no space yet).
  const slashPrefix = /^\/(\S*)$/.exec(input)?.[1];
  const slashItems = slashPrefix !== undefined && !busy ? matchCommands(slashPrefix) : [];
  const slashOpen = slashItems.length > 0;
  const slashSelected = Math.min(slashSel, Math.max(0, slashItems.length - 1));

  /** Recall a prompt from history (↑ older, ↓ newer); past the newest restores the live line. */
  const recall = useCallback((dir: -1 | 1) => {
    const list = prompts.current;
    if (!list.length) return;
    if (histIdx.current === list.length) stash.current = inputRef.current;
    const next = Math.max(0, Math.min(list.length, histIdx.current + dir));
    if (next === histIdx.current) return;
    histIdx.current = next;
    setLine(next === list.length ? stash.current : (list[next] ?? ""));
  }, [setLine]);

  useInput((ch, key) => {
    // A parked approval owns the keyboard: y allows once, a allows that ACTION
    // KIND for the session, n/esc refuses. Everything else is swallowed.
    if (pending) {
      if (ch === "y" || key.return) pending.answer(true);
      else if (ch === "a") {
        allowedKinds.current.add(pending.req.kind);
        pending.answer(true);
      } else if (ch === "n" || key.escape) pending.answer(false);
      else return;
      setPending(null);
      return;
    }
    // ctrl+c: stop a running turn; clear a typed line; twice on an empty line quits.
    if (key.ctrl && ch === "c") {
      const now = Date.now();
      if (busy) { stopTurn(); return; }
      if (inputRef.current) { setLine(""); return; }
      if (now - lastCtrlC.current < QUIT_WINDOW_MS) { exit(); return; }
      lastCtrlC.current = now;
      showHint("press ctrl+c again to quit");
      return;
    }
    // Esc: stop the RUNNING turn (keeps the partial answer); idle, it clears the line / closes the menu.
    if (key.escape) {
      if (busy) stopTurn();
      else if (inputRef.current) setLine("");
      return;
    }
    // ctrl+o toggles ALL tool receipts open/collapsed.
    if (key.ctrl && ch === "o") {
      setExpanded((e) => !e);
      return;
    }
    // shift+tab cycles the permission chip (persisted per-device). "[Z" is the
    // raw sequence after ink strips the ESC prefix on some terminals.
    if ((key.tab && key.shift) || ch === "[Z") {
      const i = PERMISSION_CYCLE.indexOf(mode);
      setPermission(PERMISSION_CYCLE[(i + 1) % PERMISSION_CYCLE.length]!);
      return;
    }
    // The slash menu owns ↑/↓/tab while open.
    if (slashOpen) {
      if (key.upArrow) { setSlashSel((s) => (s + slashItems.length - 1) % slashItems.length); return; }
      if (key.downArrow) { setSlashSel((s) => (s + 1) % slashItems.length); return; }
      if (key.tab) { setLine(`/${slashItems[slashSelected]!.name} `); return; }
      if (key.return) {
        const pick = slashItems[slashSelected]!;
        // Enter on the menu runs the highlighted command; an exact typed name runs itself.
        if (`/${pick.name}` !== inputRef.current.trim()) setLine(`/${pick.name}`);
        submit();
        return;
      }
    }
    if (key.tab) return; // no browse mode — bare tab is inert
    // ↑/↓: prompt history. Scrolling is pgup/pgdn (and the mouse wheel on most terminals).
    if (key.upArrow) { recall(-1); return; }
    if (key.downArrow) { recall(1); return; }
    if (key.pageUp) { scrollBy(paneH - 1); return; }
    if (key.pageDown) { scrollBy(-(paneH - 1)); return; }
    // The cursor.
    if (key.leftArrow) { setLine(inputRef.current, cursorRef.current - 1); return; }
    if (key.rightArrow) { setLine(inputRef.current, cursorRef.current + 1); return; }
    if (key.ctrl && ch === "a") { setLine(inputRef.current, 0); return; }
    if (key.ctrl && ch === "e") { setLine(inputRef.current); return; }
    if (key.ctrl && ch === "u") { setLine(""); return; }
    if ((key.ctrl && ch === "w") || (key.meta && (key.backspace || key.delete))) {
      const r = deleteWordBefore(inputRef.current, cursorRef.current);
      setLine(r.value, r.cursor);
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.backspace || key.delete) {
      const chars = cps(inputRef.current);
      const at = cursorRef.current;
      if (at === 0) return;
      setLine([...chars.slice(0, at - 1), ...chars.slice(at)].join(""), at - 1);
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      // Pasted text can carry a newline — take the text before it, then submit.
      const nl = ch.search(/[\r\n]/);
      const insert = (s: string): void => {
        const chars = cps(inputRef.current);
        const at = cursorRef.current;
        setLine([...chars.slice(0, at), s, ...chars.slice(at)].join(""), at + cps(s).length);
      };
      if (nl >= 0) {
        const before = ch.slice(0, nl);
        if (before) insert(before);
        submit();
        return;
      }
      if (ch >= " ") { insert(ch); histIdx.current = prompts.current.length; }
    }
  });

  // The footer's one slot: the model the next turn runs on.
  const slots: FooterSlot[] = [{ label: "model", model: effectiveModel }];

  return (
    <Box flexDirection="column" width={cols} height={frameH}>
      {/* ONE scroll surface — the banner is its first content, so the whole
          page above the strip scrolls. minHeight={0} is load-bearing: a
          flexGrow child defaults to min-height:auto, so without it the box
          refuses to shrink and PUSHES the footer past the terminal. */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} paddingX={1} overflow="hidden">
        {visible.map((l, i) => <TranscriptLine key={`${start + i}`} line={l} />)}
      </Box>
      {clampedScroll > 0 ? (
        <Text color={theme.faint}>{`  ↓ ${clampedScroll} lines below · pgup/pgdn scrolls`}</Text>
      ) : null}
      <Box flexDirection="column" flexShrink={0} ref={stripBox}>
        <SubFooter width={cols} busy={busy} elapsed={elapsed} last={last} verb={verb} />
        {pending ? (
          <Box flexDirection="column">
            <Text color={theme.accent} wrap="truncate-end">
              {`  ⏸ ${pending.req.title}${pending.req.detail ? `  ${pending.req.detail.split("\n")[0]}` : ""}`}
            </Text>
            <Text color={theme.faint} wrap="truncate-end">
              {`     allow? (y)es once · (a)lways ${pending.req.kind} this session · (n)o`}
            </Text>
          </Box>
        ) : null}
        {slashOpen ? <SlashMenu width={cols} items={slashItems} selected={slashSelected} /> : null}
        <InputBar width={cols} value={input} cursor={cursor} busy={busy} {...(hint ? { hint } : {})} />
        <Footer width={cols} permissionMode={mode} loop="glyphh" slots={slots} />
      </Box>
    </Box>
  );
}
