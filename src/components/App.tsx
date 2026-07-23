/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * App.tsx — the TUI root. Full-screen fixed layout: Header pinned at top, a
 * LINE-MODEL transcript filling the middle, then the status strip + composer +
 * footer pinned at the bottom.
 *
 * The transcript is a list of ITEMS flattened to styled lines every render
 * (lines.ts), so the viewport owns scrolling as exact array math: wheel/arrows
 * scroll, tab enters BROWSE mode (walk step receipts, enter unfolds one,
 * ctrl+o unfolds all — retroactively, because lines regenerate from items).
 * A leading `/` runs a slash command; plain text runs ONE AGENT TURN (the
 * desktop's engine): tool calls land as collapsible receipts, the answer
 * streams into the `●` line.
 * All capability comes from the SDK — nothing here talks to an API directly.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import type { Client } from "@glyphh/client";
import { runAgentTurn } from "../agent.js";
// Live model switches (/use) audit + layer in via the SDK override store.
import { sessionOverrides } from "@glyphh/client/runtime";
import { readPrefs, writePrefs, selectionsFor } from "../prefs.js";
import { Header } from "./Header.js";
import { InputBar } from "./InputBar.js";
import { Footer, type FooterSlot } from "./Footer.js";
import { SubFooter } from "./SubFooter.js";
import { TranscriptLine } from "./TranscriptLine.js";
import { theme, applyTheme } from "../theme.js";
import { loadAccount, type Account } from "../glyphh.js";
import { runSlash, RELEASE_NOTES, type CommandCtx } from "../commands.js";
import {
  answerLines,
  cardLines,
  commandLines,
  metaLines,
  noteLines,
  sectionLines,
  userLines,
  type Line,
} from "../lines.js";
import type { ChatTurn, Item, PermissionMode } from "../types.js";

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

/** Read-only tools — no side effects, so they never prompt. Covers the local
 *  built-ins that only observe plus the Glyphh MCP read tools. EXPORTED so the
 *  permission classification (the safety-critical bit) is unit-tested. */
export const READ_BUILTINS = new Set([
  "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "NotebookRead", "TodoWrite",
  "desktop_panels_list", "desktop_native_apps_list",
]);
export const READ_PREFIX = /^(list|get|read|find|search|status|browse)/; // Glyphh MCP reads
export const isReadOnlyTool = (tool: string): boolean =>
  READ_BUILTINS.has(tool) || READ_PREFIX.test(tool);

/** A tool receipt label with its key argument inlined, so the transcript reads
 *  like actions ("Write index.html", "Bash mkdir -p …") instead of bare names. */
function toolLabel(name: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const arg =
    s(o.command) || s(o.file_path) || s(o.path) || s(o.url) || s(o.pattern) || s(o.query) || "";
  if (!arg) return name;
  const short = arg.length > 72 ? `${arg.slice(0, 71)}…` : arg;
  return `${name}  ${short}`;
}

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
}

export function App({ client, version, server, cwd, loop: initialLoop, initialAccount }: AppProps): React.ReactElement {
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
  /** Global expansion default; per-section overrides in `folds`. */
  const [expanded, setExpanded] = useState(false);
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  /** `compose` types into the input; `browse` walks section heads (tab flips). */
  const [uiMode, setUiMode] = useState<"compose" | "browse">("compose");
  const [selId, setSelId] = useState<string | null>(null);
  /** Lines scrolled up from the tail; 0 = follow mode. */
  const [scroll, setScroll] = useState(0);
  const [chromeH, setChromeH] = useState({ header: 9, strip: 6 });
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
  const inputRef = useRef("");
  const headerBox = useRef<DOMElement | null>(null);
  const stripBox = useRef<DOMElement | null>(null);
  // The loop's resolved primary model (bare id), cached per loop.
  const modelRef = useRef<{ loop: string | null; id: string | null }>({ loop: null, id: null });
  // The conversation the model sees — user/assistant turns, capped for the wire.
  const history = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  /** A pending tool approval (ask mode): the strip prompts, y/n/a answers. */
  const [gatePending, setGatePending] = useState<{ tool: string; preview: string } | null>(null);
  const gateResolve = useRef<((ok: boolean) => void) | null>(null);
  /** Tools the user answered "a"lways for — auto-allowed for this session. */
  const sessionAllowed = useRef<Set<string>>(new Set());
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
    const header = headerBox.current ? measureElement(headerBox.current).height : chromeH.header;
    const strip = stripBox.current ? measureElement(stripBox.current).height : chromeH.strip;
    if (header !== chromeH.header || strip !== chromeH.strip) setChromeH({ header, strip });
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

  // Welcome card — mount-only by design. Greets the signed-in user (the boot gate has
  // already resolved the session) inside a bordered card at the top of the transcript.
  useEffect(() => {
    const who = account?.name ?? account?.email?.split("@")[0];
    push({
      kind: "card",
      title: who ? `Welcome back, ${who}` : "Welcome to Glyphh",
      body: [
        "The Glyphh agent — the same engine as the desktop, in your terminal. Answers stream live; tool calls (apps, connections, your desktop) land as receipts.",
        "tab browses/unfolds receipts · ctrl+o unfolds all · shift+tab cycles permission mode",
        "/help for commands · /theme to restyle · /loop to switch loops",
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Short human preview of what a mutating tool will do, for the approval strip:
   *  the bash command, the file path, the fetched url, etc. */
  const gatePreview = (input: unknown): string => {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const s = (v: unknown): string => (typeof v === "string" ? v : "");
    const pick = s(o.command) || s(o.file_path) || s(o.path) || s(o.url) || s(o.pattern) || "";
    return pick ? (pick.length > 96 ? `${pick.slice(0, 95)}…` : pick) : "";
  };

  /** The permission gate, per the mode chip. Read-only tools always pass (no
   *  prompt) except in plan mode; mutating/exec tools (Bash, Write, Edit,
   *  create_*, deploy_*, connection + desktop control) prompt in ask mode,
   *  auto-run in auto, and are refused in read-only/plan. */
  const gateTool = useCallback((tool: string, input: unknown): Promise<boolean> => {
    const m = modeRef.current;
    const ro = isReadOnlyTool(tool);
    if (m === "plan") return Promise.resolve(ro);        // explore to plan, never mutate
    if (m === "read-only") return Promise.resolve(ro);
    if (ro) return Promise.resolve(true);                // reads never prompt
    if (m === "auto") return Promise.resolve(true);      // auto: run mutations unprompted
    if (sessionAllowed.current.has(tool)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {           // ask: prompt for this mutation
      gateResolve.current = (ok) => {
        gateResolve.current = null;
        setGatePending(null);
        resolve(ok);
      };
      setGatePending({ tool, preview: gatePreview(input) });
    });
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
      try {
        // THE DESKTOP'S PATH, exactly: the model comes from `loops.roles` (the same
        // call the footer chip reads, so the chip and the run agree by construction),
        // and the turn STREAMS over the gateway's Messages edge with the caller's
        // bearer — token deltas render as they arrive. This device's per-loop picks
        // layer in as selections; a live `/use` switch wins.
        if (modelRef.current.loop !== loop) {
          const roles = await client.loops.roles(loop, {
            ...selectionsFor(loop),
            ...sessionOverrides(sessionId.current, loop),
          });
          const id = roles.find((r) => r.modelId)?.modelId ?? null;
          modelRef.current = { loop, id: id ? (id.includes("::") ? id.slice(id.indexOf("::") + 2) : id) : null };
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
          let pendingTool: string | null = null;
          const finalText = await runAgentTurn(
            {
              client,
              server,
              model: modelRef.current.id,
              history: history.current.slice(-HISTORY_CAP),
              prompt,
              cwd: process.cwd(),
              gate: (tool, input) => gateTool(tool, input),
            },
            {
              onDelta: (t) => {
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
              // A tool call lands as a ⏺ receipt; its result folds in beneath.
              onTool: (name, input) => {
                segId = null; // next text lands BELOW this receipt
                pendingTool = name;
                push({ kind: "section", step: { label: toolLabel(name, input), ok: true, details: [] } });
              },
              onToolResult: (content, isError) => {
                segId = null;
                const label = pendingTool ?? "tool";
                pendingTool = null;
                // An unauthorized connection surfaces as an error — turn it into
                // an actionable note rather than a raw failure receipt.
                const hint = isError ? connectionAuthHint(label, content) : null;
                if (hint) {
                  push({ kind: "note", text: hint });
                  return;
                }
                if (content || isError) {
                  push({
                    kind: "section",
                    step: {
                      label: `${label} → ${isError ? "error" : "result"}`,
                      ok: !isError,
                      details: content ? content.split("\n").slice(0, 12) : [],
                      ...(isError ? { error: "tool error" } : {}),
                    },
                  });
                }
              },
              onProgress: (tokens) => {
                turn.tokensDown = tokens;
                setLast({ ...turn });
              },
            },
          );
          text = finalText || text;
          turn.text = text;
          if (!text.trim()) push({ kind: "note", text: "(no answer text — the run ended after tool calls)" });
          history.current.push({ role: "user", content: prompt });
          history.current.push({ role: "assistant", content: text || "…" });
          if (turn.status !== "error") turn.status = "done";
        }
        turn.durationMs = Date.now() - startedAt;
        setLast({ ...turn });
        // The settle line under the answer: `* Verbed for 3.1s` (+ credits when known).
        const parts = [
          turn.status === "error" ? "Stalled" : VERBS[nextId.current % VERBS.length]!.past,
          `for ${(turn.durationMs / 1000).toFixed(1)}s`,
        ];
        if (turn.credits !== null) parts.push(`· ◈ ${turn.credits} credit${turn.credits === 1 ? "" : "s"}`);
        push({ kind: "meta", text: `* ${parts.join(" ")}` });
      } catch (err) {
        turn.status = "error";
        turn.text = `local runtime error: ${(err as Error).message}`;
        turn.durationMs = Date.now() - startedAt;
        push({ kind: "answer", text: turn.text });
        setLast({ ...turn });
      } finally {
        setBusy(false);
      }
    },
    [client, loop, push],
  );

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
          setFolds({});
          setSelId(null);
          setScroll(0);
          setLast(undefined);
        },
        quit: () => exit(),
        emit: (lines) => patchItem(id, (it) => ({ ...it, result: lines }) as Item),
        refreshConfig: () => setConfigVersion((v) => v + 1),
        sessionId: sessionId.current,
        invalidateModels: () => {
          modelRef.current = { loop: null, id: null };
        },
      };
      const result = await runSlash(ctx, line);
      patchItem(id, (it) => ({ ...it, result }) as Item);
    },
    [account, client, exit, patchItem, push, loop, server, setLoop, setTheme, version],
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

  // ── The line model — regenerated from items, so folding is retroactive.
  //    Anchors record each section head's id + line index for browse/scroll. ──
  const width = Math.max(20, cols - 4);
  const { lines, anchors } = useMemo(() => {
    const out: Line[] = [];
    const anchors: Array<{ id: string; line: number; foldable: boolean }> = [];
    for (const item of items) {
      if (item.kind === "user") out.push(...userLines(item.text, width));
      else if (item.kind === "command") out.push(...commandLines(item.text, item.result, width));
      else if (item.kind === "section") {
        anchors.push({ id: item.id, line: out.length, foldable: item.step.details.length > 3 });
        const open = folds[item.id] ?? expanded;
        out.push(...sectionLines(item.step, open, uiMode === "browse" && selId === item.id));
      } else if (item.kind === "answer") out.push(...answerLines(item.text, width));
      else if (item.kind === "meta") out.push(...metaLines(item.text));
      else if (item.kind === "card") out.push(...cardLines(item.title, item.body, width));
      else out.push(...noteLines(item.text));
    }
    return { lines: out, anchors };
  }, [items, expanded, folds, width, uiMode, selId]);

  const paneH = Math.max(3, rows - 1 - chromeH.header - chromeH.strip);
  const maxScroll = Math.max(0, lines.length - paneH);
  const clampedScroll = Math.min(scroll, maxScroll);
  const start = Math.max(0, lines.length - paneH - clampedScroll);
  const visible = lines.slice(start, start + paneH);

  const scrollBy = useCallback(
    (d: number) => setScroll((s) => Math.max(0, Math.min(Math.max(0, lines.length - paneH), s + d))),
    [lines.length, paneH],
  );

  /** Scroll so a line index sits inside the viewport (either direction). */
  const ensureVisible = useCallback(
    (line: number) => {
      setScroll((s) => {
        const maxS = Math.max(0, lines.length - paneH);
        const cur = Math.min(s, maxS);
        const st = Math.max(0, lines.length - paneH - cur);
        if (line < st) return Math.min(maxS, lines.length - paneH - line);
        if (line >= st + paneH) return Math.max(0, lines.length - paneH - (line - paneH + 1));
        return cur;
      });
    },
    [lines.length, paneH],
  );

  // Folding changes geometry AFTER the keypress — re-anchor the selection with
  // fresh line indices (setScroll bails when unchanged, so no loops).
  useEffect(() => {
    if (uiMode !== "browse" || !selId) return;
    const a = anchors.find((x) => x.id === selId);
    if (a) ensureVisible(a.line);
  }, [folds, selId, uiMode, anchors, ensureVisible]);

  useInput((ch, key) => {
    // A pending tool approval owns the keyboard: y allows once, a allows the
    // tool for the session, n/esc refuses. Everything else is swallowed.
    if (gatePending) {
      if (ch === "y" || key.return) gateResolve.current?.(true);
      else if (ch === "a") {
        sessionAllowed.current.add(gatePending.tool);
        gateResolve.current?.(true);
      } else if (ch === "n" || key.escape) gateResolve.current?.(false);
      return;
    }
    if (key.ctrl && ch === "o") {
      setExpanded((e) => !e);
      setFolds({});
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
    if (key.tab || ch === "\t" || (uiMode === "browse" && key.escape)) {
      if (uiMode === "compose") {
        const lastFoldable = [...anchors].reverse().find((a) => a.foldable);
        const startSel = lastFoldable?.id ?? (anchors.length ? anchors[anchors.length - 1]!.id : null);
        setSelId(startSel);
        if (startSel) {
          const a = anchors.find((x) => x.id === startSel);
          if (a) ensureVisible(a.line);
        }
        setUiMode(startSel ? "browse" : "compose");
      } else {
        setUiMode("compose");
        setScroll(0);
      }
      return;
    }
    if (uiMode === "browse") {
      const idx = anchors.findIndex((a) => a.id === selId);
      if (key.upArrow || key.downArrow) {
        const next = anchors[Math.max(0, Math.min(anchors.length - 1, idx + (key.upArrow ? -1 : 1)))];
        if (next) {
          setSelId(next.id);
          ensureVisible(next.line);
        }
        return;
      }
      if (key.return || ch === " ") {
        if (selId) {
          setFolds((f) => ({ ...f, [selId]: !(f[selId] ?? expanded) }));
          const a = anchors.find((x) => x.id === selId);
          if (a) ensureVisible(a.line);
        }
        return;
      }
      if (key.pageUp || key.pageDown) {
        scrollBy(key.pageUp ? paneH - 1 : -(paneH - 1));
        return;
      }
      if (ch && (ch >= " " || /[\r\n]/.test(ch))) {
        // Typing means the user wants the composer back — switch and let the
        // shared handling below process this same keystroke.
        setUiMode("compose");
        setScroll(0);
      } else {
        return;
      }
    }
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
      <Box flexDirection="column" ref={headerBox}>
        <Header width={cols} version={version} account={account} notes={RELEASE_NOTES} server={server} cwd={cwd} />
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
        {visible.length === 0 ? (
          <Text color={theme.faint}>Ask Glyphh anything, or type /help. Ctrl+C to quit.</Text>
        ) : (
          visible.map((l, i) => <TranscriptLine key={`${start + i}`} line={l} />)
        )}
      </Box>
      {clampedScroll > 0 ? (
        <Text color={theme.faint}>{`  ↓ ${clampedScroll} lines below · ↑/↓ scrolls · pgdn returns`}</Text>
      ) : null}
      <Box flexDirection="column" ref={stripBox}>
        <SubFooter width={cols} busy={busy} elapsed={elapsed} last={last} verb={verb} />
        {gatePending ? (
          <Box flexDirection="column">
            <Text color={theme.accent} wrap="truncate-end">
              {`  ⏸ ${gatePending.tool}${gatePending.preview ? `  ${gatePending.preview}` : ""}`}
            </Text>
            <Text color={theme.faint} wrap="truncate-end">
              {"     allow? (y)es once · (a)lways this session · (n)o"}
            </Text>
          </Box>
        ) : null}
        <InputBar width={cols} value={input} busy={busy} />
        <Footer width={cols} permissionMode={mode} loop={loop} slots={slots} />
      </Box>
    </Box>
  );
}
