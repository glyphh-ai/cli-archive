/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * App.tsx — the chat, drawn the way the other agent CLIs draw it: SETTLED
 * transcript is printed ONCE into the terminal's own scrollback (Ink's
 * <Static>), and only a small LIVE region redraws — the turn in flight and
 * the strip (status, a parked approval or selector, the slash menu, the
 * composer, the footer). That is the whole cure for flicker: Ink erases and
 * rewrites everything it manages on every frame, so what it manages must stay
 * small (his reports, 2026-09-21). No alternate screen; the terminal scrolls.
 * A turn is the Glyphh loop itself (loop.ts) running in this process on the
 * gateway: text streams live (batched), tool calls land as collapsible
 * receipts, and a permission ask parks the run.
 *
 * The conversation is SHARED WITH THE DESKTOP (sessions.ts): it opens from the
 * same store the Agent panel reads and every answer is written back to it.
 *
 * Keys, the way every agent CLI has them: enter sends; ↑/↓ recall prompts;
 * ←/→ move the cursor (ctrl+a/e, ctrl+w, ctrl+u); shift+tab cycles the
 * permission chip; esc stops the turn; ctrl+o expands tool output; ctrl+c
 * clears the line, twice quits; "/" opens the command menu;
 * "?" on an empty line shows the shortcuts.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import type { Client } from "@glyphh/sdk";
import { runLoopTurn, type ApprovalRequest } from "../loop.js";
import { defaultModel } from "../models.js";
import { readPrefs, writePrefs, rememberPrompt } from "../prefs.js";
import { LOGO_MARK } from "../banner.js";
import { InputBar } from "./InputBar.js";
import { Footer, type FooterSlot } from "./Footer.js";
import { SubFooter } from "./SubFooter.js";
import { SlashMenu } from "./SlashMenu.js";
import { Picker, type PickerSpec } from "./Picker.js";
import { TranscriptLine } from "./TranscriptLine.js";
import { theme, applyTheme } from "../theme.js";
import { loadAccount, type Account } from "../glyphh.js";
import { runSlash, matchCommands, RELEASE_NOTES, TIPS, type CommandCtx, type SessionCost } from "../commands.js";
import { conversationOf, findChat, listGlyphhChats, newChat, saveChat, storeFile, titleOf, desktopPermission, type StoredChat } from "../sessions.js";
import { headerLines,
  answerLines,
  commandLines,
  noteLines,
  sectionLines,
  userLines,
  type Line,
} from "../lines.js";
import { PERMISSION_CYCLE, type ChatTurn, type Item, type PermissionMode, type TurnStep } from "../types.js";

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

/** What the strip is blocked on: a parked approval, or a selector. */
type Pending =
  | { kind: "approval"; req: ApprovalRequest; answer: (allow: boolean) => void }
  | { kind: "picker"; spec: PickerSpec; selected: number };

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
  /** `--resume <id>`: open this chat from the shared store. */
  resumeId?: string;
  /** `--continue`: open the most recent Glyphh-loop chat. */
  continueLast?: boolean;
}

export function App({ client, version, server, cwd, initialAccount, onRelogin, bridgeUrl, initialModel, initialMode, initialPrompt, resumeId, continueLast }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [cols, setCols] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);
  const [account, setAccount] = useState<Account | null>(initialAccount ?? null);
  /** Printed once, never redrawn (Ink Static). The welcome card is item one. */
  const [settled, setSettled] = useState<Item[]>([]);
  /** The turn or command in flight — the only transcript Ink redraws. */
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ChatTurn | undefined>(undefined);
  const [verb, setVerb] = useState(VERBS[0]!);
  const [elapsed, setElapsed] = useState(0);
  /** Tool receipts are collapsed by default; ctrl+o opens them (live + future ones). */
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<PermissionMode>(() => initialMode ?? readPrefs().permissionMode ?? "default");
  // THE MODEL: the device's persisted pick (/model), a session pick (--model, s
  // in the selector) over it, and the org's default underneath.
  const [pickedModel, setPickedModel] = useState<string | null>(() => readPrefs().model ?? null);
  const [sessionModel, setSessionModel] = useState<string | null>(initialModel ?? null);
  const [orgDefault, setOrgDefault] = useState<string | null>(null);
  /** The composer's transient hint (ctrl+c once). */
  const [hint, setHint] = useState<string | null>(null);
  /** Slash menu selection while the line starts with "/". */
  const [slashSel, setSlashSel] = useState(0);
  /** The shared store's chat this transcript IS. */
  const [chat, setChat] = useState<StoredChat>(() => newChat(cwd, initialMode ?? readPrefs().permissionMode ?? "default"));
  const [, setThemeVersion] = useState(0);

  const nextId = useRef(0);
  const turnStartedAt = useRef(0);
  const turnAbort = useRef<AbortController | null>(null);
  const inputRef = useRef("");
  const cursorRef = useRef(0);
  const history = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const prompts = useRef<string[]>(readPrefs().history ?? []);
  const histIdx = useRef<number>(prompts.current.length);
  const stash = useRef("");
  const [pending, setPending] = useState<Pending | null>(null);
  const allowedKinds = useRef<Set<string>>(new Set());
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const modelRef = useRef<{ picked: string | null; session: string | null }>({ picked: pickedModel, session: sessionModel });
  modelRef.current = { picked: pickedModel, session: sessionModel };
  const cost = useRef<SessionCost>({ turns: 0, tokensUp: 0, tokensDown: 0, durationMs: 0, startedAt: Date.now() });
  const lastCtrlC = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionsFile = account ? storeFile(account.userId) : null;

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

  useEffect(() => {
    applyTheme(readPrefs().theme);
    setThemeVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed((Date.now() - turnStartedAt.current) / 1000), 250);
    return () => clearInterval(t);
  }, [busy]);

  // The org's default model → the footer chip when nothing is picked.
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

  /** The live transcript is finished: print it into scrollback for good. */
  const settle = useCallback(() => {
    setItems((live) => {
      if (live.length) setSettled((s) => [...s, ...live]);
      return [];
    });
  }, []);

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
    setThemeVersion((v) => v + 1);
  }, []);

  /** Show a stored chat: transcript + the loop's seed. */
  /** Wipe the terminal, scrollback included, so a new conversation starts clean
   *  (Static items already printed cannot be un-printed any other way). */
  const clearScreen = useCallback(() => {
    stdout.write("\u001b[2J\u001b[3J\u001b[H");
    setSettled([]);
    setItems([]);
    setExpanded(false);
    setLast(undefined);
    headerShown.current = false;
  }, [stdout]);

  const showChat = useCallback((c: StoredChat) => {
    const convo = conversationOf(c);
    history.current = convo.map((m) => ({ role: m.role, content: m.text }));
    clearScreen();
    setChat(c);
    chatRef.current = c;
    // The earlier turns print once, straight into scrollback.
    const seeded: Item[] = convo.map((m, i) => (m.role === "user" ? { id: `s${i}`, kind: "user", text: m.text } : { id: `s${i}`, kind: "answer", text: m.text }));
    setSettled(seeded);
  }, [clearScreen]);

  /** /resume <id> and --resume: the chat from the shared store, or why not. */
  const resumeChat = useCallback(async (id: string): Promise<string[]> => {
    if (!sessionsFile) return ["sign in first — conversations are stored per account"];
    const c = findChat(sessionsFile, id);
    if (!c) return [`no conversation ${id} in this account's store`];
    showChat(c);
    return [`resumed "${c.title}" · ${c.messages.length} message${c.messages.length === 1 ? "" : "s"}`];
  }, [sessionsFile, showChat]);

  // --resume / --continue, once the account (and so the store) is known.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !sessionsFile) return;
    opened.current = true;
    const target = resumeId ? findChat(sessionsFile, resumeId) : continueLast ? listGlyphhChats(sessionsFile, 1)[0] ?? null : null;
    if (target) showChat(target);
    else if (resumeId) push({ kind: "note", text: `no conversation ${resumeId} in this account's store — starting fresh` });
  }, [sessionsFile, resumeId, continueLast, showChat, push]);

  // THE WELCOME CARD prints once, when the model is known (or after a beat), so
  // it is right the one time it is drawn.
  const headerShown = useRef(false);
  const [headerReady, setHeaderReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setHeaderReady(true), 1200);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (orgDefault !== null) setHeaderReady(true);
  }, [orgDefault]);
  useEffect(() => {
    if (!headerReady || headerShown.current) return;
    headerShown.current = true;
    setSettled((s) => [{ id: `h${Date.now().toString(36)}`, kind: "header" }, ...s]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerReady]);

  const openPicker = useCallback((spec: PickerSpec) => {
    const cur = Math.max(0, spec.options.findIndex((o) => o.current));
    setPending({ kind: "picker", spec, selected: cur });
  }, []);

  const runTurn = useCallback(
    async (prompt: string) => {
      const startedAt = Date.now();
      turnStartedAt.current = startedAt;
      setElapsed(0);
      const v = VERBS[nextId.current % VERBS.length]!;
      setVerb(v);
      push({ kind: "user", text: prompt });
      const turn: ChatTurn = { id: `t${nextId.current}`, text: "", status: "running", tokensUp: 0, tokensDown: 0 };
      setLast({ ...turn });
      setBusy(true);
      const abort = new AbortController();
      turnAbort.current = abort;
      try {
        const model = modelRef.current.session ?? modelRef.current.picked ?? (await defaultModel(client).catch(() => ""));
        if (!model) {
          turn.status = "error";
          turn.text = "No model — your organization has none allowed on the gateway yet, or its lane is off. Pick one with /model once an admin allows some.";
          push({ kind: "note", text: turn.text });
        } else {
          if (model !== orgDefault && !modelRef.current.session && !modelRef.current.picked) setOrgDefault(model);
          let segId: string | null = null;
          let segText = "";
          let text = "";
          const toolItems = new Map<string, string[]>();
          // Deltas paint in BATCHES (~25 fps): a frame per token is a redraw per
          // token, and redraws are what flicker.
          let pendingDelta = "";
          let flushTimer: ReturnType<typeof setTimeout> | null = null;
          const flushDelta = (): void => {
            flushTimer = null;
            const t = pendingDelta;
            pendingDelta = "";
            if (!t) return;
            if (!segId) {
              segText = t.replace(/^\s+/, "");
              if (!segText) return;
              segId = push({ kind: "answer", text: segText });
              return;
            }
            segText += t;
            const id = segId;
            patchItem(id, (it) => ({ ...it, text: segText }) as Item);
          };
          const sink = {
            delta: (t: string) => {
              text += t;
              pendingDelta += t;
              if (!flushTimer) flushTimer = setTimeout(flushDelta, 40);
            },
            toolStart: (name: string, title?: string) => {
              if (flushTimer) { clearTimeout(flushTimer); flushDelta(); }
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
              chatId: chatRef.current.id,
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
          if (flushTimer) { clearTimeout(flushTimer); flushDelta(); }
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
          // THE SHARED STORE: this turn lands in the same file the desktop reads,
          // so its rail and Agent panel show it and can pick the chat up.
          const c = chatRef.current;
          const now = Date.now();
          const next: StoredChat = {
            ...c,
            title: c.messages.length ? c.title : titleOf(prompt),
            messages: [...c.messages, { role: "user", text: prompt, at: startedAt }, { role: "assistant", text: text || "…", at: now }],
            updatedAt: now,
            workdir: c.workdir ?? cwd,
            permission: desktopPermission(modeRef.current),
          };
          setChat(next);
          chatRef.current = next;
          if (sessionsFile) saveChat(sessionsFile, next);
        }
        turn.durationMs = Date.now() - startedAt;
        setLast({ ...turn });
        cost.current.turns++;
        cost.current.tokensUp += turn.tokensUp;
        cost.current.tokensDown += turn.tokensDown;
        cost.current.durationMs += turn.durationMs;
      } catch (err) {
        turn.status = "error";
        turn.text = `Glyphh loop unavailable — ${(err as Error).message}`;
        turn.durationMs = Date.now() - startedAt;
        push({ kind: "note", text: turn.text });
        setLast({ ...turn });
      } finally {
        turnAbort.current = null;
        setPending((p) => (p?.kind === "approval" ? null : p)); // a parked approval dies with its run
        setBusy(false);
        settle(); // the turn is history now — printed once, redrawn never
      }
    },
    [client, cwd, orgDefault, patchItem, push, sessionsFile, settle],
  );

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
        chatId: chatRef.current.id,
        cost: cost.current,
        setAccount,
        setModel,
        setPermission,
        setTheme,
        clearChat: () => {
          history.current = [];
          const fresh = newChat(cwd, modeRef.current);
          setChat(fresh);
          chatRef.current = fresh;
          clearScreen();
        },
        quit: () => exit(),
        ...(onRelogin ? { relogin: onRelogin } : {}),
        emit: (lines) => patchItem(id, (it) => ({ ...it, result: lines }) as Item),
        note: (text) => { push({ kind: "note", text }); },
        openPicker,
        sessionsFile,
        resumeChat,
      };
      const result = await runSlash(ctx, line);
      patchItem(id, (it) => ({ ...it, result }) as Item);
      settle();
    },
    [account, client, cwd, exit, mode, patchItem, push, server, setModel, setPermission, setTheme, version, onRelogin, sessionModel, pickedModel, openPicker, sessionsFile, resumeChat, clearScreen, settle],
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
      settle();
      return;
    }
    void runTurn(raw);
  }, [account, busy, push, runCommand, runTurn, setLine, settle]);

  const openingSent = useRef(false);
  useEffect(() => {
    if (!initialPrompt || openingSent.current || !account) return;
    openingSent.current = true;
    void runTurn(initialPrompt);
  }, [initialPrompt, account, runTurn]);

  // ── Lines per item. Settled items render ONCE (Static); live ones every frame. ──
  const width = Math.max(20, cols - 4);
  const effectiveModel = sessionModel ?? pickedModel ?? orgDefault;
  const linesFor = useCallback((item: Item, open: boolean): Line[] => {
    if (item.kind === "header") {
      return headerLines(width, LOGO_MARK, {
        version,
        name: account ? (account.name ?? account.email) : null,
        plan: account ? `${account.tier.charAt(0).toUpperCase()}${account.tier.slice(1)}` : null,
        email: account?.email ?? null,
        cwd,
        model: effectiveModel,
        server: server.replace(/^https?:\/\//, ""),
        tips: TIPS,
        notes: bridgeUrl ? [`bridge mode · Claude Desktop → ${bridgeUrl}`, ...RELEASE_NOTES.slice(0, 2)] : RELEASE_NOTES,
      });
    }
    if (item.kind === "user") return userLines(item.text, width);
    if (item.kind === "command") return commandLines(item.text, item.result, width);
    if (item.kind === "section") return sectionLines(item.step, open);
    if (item.kind === "answer") return answerLines(item.text, width);
    return noteLines(item.text);
  }, [width, version, account, cwd, effectiveModel, server, bridgeUrl]);

  // THE LIVE WINDOW stays well under the terminal's height: past that Ink
  // clears the whole screen every frame. A long streaming answer shows its
  // tail; the whole of it prints when the turn settles.
  const liveLines = useMemo(() => items.flatMap((it) => linesFor(it, expanded)), [items, linesFor, expanded]);
  const liveMax = Math.max(4, rows - 14);
  const hiddenLive = Math.max(0, liveLines.length - liveMax);
  const liveVisible = hiddenLive ? liveLines.slice(hiddenLive) : liveLines;

  const slashPrefix = /^\/(\S*)$/.exec(input)?.[1];
  const slashItems = slashPrefix !== undefined && !busy && !pending ? matchCommands(slashPrefix) : [];
  const slashOpen = slashItems.length > 0;
  const slashSelected = Math.min(slashSel, Math.max(0, slashItems.length - 1));

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
    // A selector owns the keyboard: ↑/↓, a digit jumps, enter picks, the
    // secondary key picks for the session, esc cancels.
    if (pending?.kind === "picker") {
      const { spec } = pending;
      const n = spec.options.length;
      const pick = (secondary: boolean): void => {
        const o = spec.options[pending.selected];
        setPending(null);
        if (o) spec.onPick(o.id, secondary);
      };
      if (key.upArrow) setPending({ ...pending, selected: (pending.selected + n - 1) % n });
      else if (key.downArrow) setPending({ ...pending, selected: (pending.selected + 1) % n });
      else if (/^[1-9]$/.test(ch) && Number(ch) <= n) setPending({ ...pending, selected: Number(ch) - 1 });
      else if (key.return) pick(false);
      else if (spec.secondary && ch === spec.secondary.key) pick(true);
      else if (key.escape || (key.ctrl && ch === "c")) { setPending(null); spec.onCancel?.(); }
      return;
    }
    if (key.ctrl && ch === "c") {
      const now = Date.now();
      if (busy) { stopTurn(); return; }
      if (inputRef.current) { setLine(""); return; }
      if (now - lastCtrlC.current < QUIT_WINDOW_MS) { exit(); return; }
      lastCtrlC.current = now;
      showHint("press ctrl+c again to quit");
      return;
    }
    if (key.escape) {
      if (busy) stopTurn();
      else if (inputRef.current) setLine("");
      return;
    }
    if (key.ctrl && ch === "o") {
      setExpanded((e) => !e);
      return;
    }
    if ((key.tab && key.shift) || ch === "[Z") {
      const i = PERMISSION_CYCLE.indexOf(mode);
      setPermission(PERMISSION_CYCLE[(i + 1) % PERMISSION_CYCLE.length]!);
      return;
    }
    if (slashOpen) {
      if (key.upArrow) { setSlashSel((s) => (s + slashItems.length - 1) % slashItems.length); return; }
      if (key.downArrow) { setSlashSel((s) => (s + 1) % slashItems.length); return; }
      if (key.tab) { setLine(`/${slashItems[slashSelected]!.name} `); return; }
      if (key.return) {
        const picked = slashItems[slashSelected]!;
        if (`/${picked.name}` !== inputRef.current.trim()) setLine(`/${picked.name}`);
        submit();
        return;
      }
    }
    if (key.tab) return;
    if (key.upArrow) { recall(-1); return; }
    if (key.downArrow) { recall(1); return; }
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
    // "?" on an empty line: the shortcuts, the way the other CLIs answer it.
    if (ch === "?" && !inputRef.current && !busy) { void runCommand("/help"); return; }
    if (ch && !key.ctrl && !key.meta) {
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

  const slots: FooterSlot[] = [{ label: "model", model: effectiveModel }];

  return (
    <Box flexDirection="column" width={cols}>
      {/* SETTLED: printed once into scrollback; Ink never touches these lines again. */}
      <Static items={settled}>
        {(item) => (
          <Box key={item.id} flexDirection="column" paddingX={1}>
            {linesFor(item, expanded).map((l, i) => <TranscriptLine key={`${item.id}-${i}`} line={l} />)}
          </Box>
        )}
      </Static>
      {/* LIVE: the turn in flight, bounded, then the strip. */}
      <Box flexDirection="column" paddingX={1}>
        {hiddenLive ? <Text color={theme.faint}>{`  … ${hiddenLive} earlier lines of this turn (they print in full when it finishes)`}</Text> : null}
        {liveVisible.map((l, i) => <TranscriptLine key={`live-${hiddenLive + i}`} line={l} />)}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        <SubFooter width={cols} busy={busy} elapsed={elapsed} last={last} verb={verb} />
        {pending?.kind === "approval" ? (
          <Box flexDirection="column" paddingX={1}>
            <Text color={theme.accent} wrap="truncate-end">
              {`⏸ ${pending.req.title}${pending.req.detail ? `  ${pending.req.detail.split("\n")[0]}` : ""}`}
            </Text>
            <Text color={theme.faint} wrap="truncate-end">
              {`   allow? (y)es once · (a)lways ${pending.req.kind} this session · (n)o`}
            </Text>
          </Box>
        ) : null}
        {pending?.kind === "picker" ? <Picker width={cols} spec={pending.spec} selected={pending.selected} /> : null}
        {slashOpen ? <SlashMenu width={cols} items={slashItems} selected={slashSelected} /> : null}
        <InputBar width={cols} value={input} cursor={cursor} busy={busy} {...(hint ? { hint } : {})} />
        <Footer width={cols} permissionMode={mode} loop="glyphh" slots={slots} />
      </Box>
    </Box>
  );
}
