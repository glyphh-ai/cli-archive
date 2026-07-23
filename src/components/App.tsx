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
 * A leading `/` runs a slash command; plain text streams a rotor turn whose
 * steps land as collapsible receipts and whose answer lands as the `●` line.
 * All capability comes from the SDK — nothing here talks to an API directly.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import type { Client } from "@glyphh/client";
import type { BasicModelsOptions } from "rrotor";
import { localTurn } from "../local-runtime.js";
// The governed model bridge lives in the SDK — every client resolves the same way.
import { resolveModels, sessionOverrides } from "@glyphh/client/runtime";
import { readPrefs, writePrefs } from "../prefs.js";
import { Header } from "./Header.js";
import { InputBar } from "./InputBar.js";
import { Footer } from "./Footer.js";
import { SubFooter } from "./SubFooter.js";
import { TranscriptLine } from "./TranscriptLine.js";
import { theme } from "../theme.js";
import { loadAccount, type Account } from "../glyphh.js";
import { runSlash, RELEASE_NOTES, type CommandCtx } from "../commands.js";
import { stepDetails } from "../receipts.js";
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

/** Omit that distributes over a union (plain Omit collapses discriminants). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface AppProps {
  client: Client;
  version: string;
  server: string;
  cwd: string;
  rotor: string;
}

export function App({ client, version, server, cwd, rotor: initialRotor }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [cols, setCols] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);
  const [account, setAccount] = useState<Account | null>(null);
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
  // Permission mode + the selected rotor are per-device prefs (~/.glyphh/config.json).
  const [mode, setMode] = useState<PermissionMode>(() => readPrefs().permissionMode ?? "ask");
  const [rotor, setRotorState] = useState(() => readPrefs().rotor ?? initialRotor);
  // Footer status: the base rotor's bound model + whether all its roles are bound.
  const [modelLabel, setModelLabel] = useState<string>("not set");
  const [configured, setConfigured] = useState(false);
  const [configVersion, setConfigVersion] = useState(0); // bump to reload after /bind

  const nextId = useRef(0);
  const lastStepAt = useRef(0);
  const turnStartedAt = useRef(0);
  const inputRef = useRef("");
  const headerBox = useRef<DOMElement | null>(null);
  const stripBox = useRef<DOMElement | null>(null);
  // The resolved model registry, cached per rotor (re-resolved when the rotor changes).
  const modelsCache = useRef<BasicModelsOptions | undefined>(undefined);
  const modelsForRotor = useRef<string | null>(null);
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

  // The selected rotor's model binding → footer (base model + configured status).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [r, b] = await Promise.all([client.rotorConfig.rotor(rotor), client.rotorConfig.binding(rotor)]);
        if (cancelled) return;
        const bound = new Map(b.roles.map((x) => [x.role, x]));
        const primaryRole = r.roles[0]?.role;
        const primary = primaryRole ? bound.get(primaryRole) : undefined;
        setModelLabel(
          primary ? `${primary.modelId.split("::").pop()}${primary.transport === "local" ? " (local)" : ""}` : "not set",
        );
        setConfigured(r.roles.length > 0 && r.roles.every((role) => bound.has(role.role)));
      } catch {
        if (!cancelled) {
          setModelLabel("not set");
          setConfigured(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, rotor, configVersion]);

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

  const setRotor = useCallback((r: string) => {
    modelsForRotor.current = null; // re-resolve the binding for the new rotor
    setRotorState(r);
    writePrefs({ rotor: r });
  }, []);

  // Welcome card — mount-only by design.
  useEffect(() => {
    push({
      kind: "card",
      title: "Glyphh",
      body: [
        "Every line you type is one full rotor turn: deterministic steps, streamed live as receipts.",
        "tab browses/unfolds steps · ctrl+o unfolds all · shift+tab cycles permission mode",
        "/help for commands · /login to sign in · /rotor to switch loops",
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runTurn = useCallback(
    async (prompt: string) => {
      const startedAt = Date.now();
      turnStartedAt.current = startedAt;
      lastStepAt.current = startedAt;
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
        // Resolve the rotor's role→model binding once per rotor (gateway models get the
        // caller's bearer; local models are served on demand by llama). Unbound → stub.
        if (modelsForRotor.current !== rotor) {
          try {
            modelsCache.current = await resolveModels(client, {
              rotorSlug: rotor,
              token: await client.token(),
              overrides: sessionOverrides(sessionId.current, rotor),
            });
          } catch {
            modelsCache.current = undefined;
          }
          modelsForRotor.current = rotor;
        }
        // Run against the ONE local runtime, in-process (openrotor linked as a library;
        // memory in the shared SQLite stator). Remote sessions are a separate path.
        const run = localTurn(
          prompt,
          modelsCache.current ? { models: modelsCache.current, session: sessionId.current } : { session: sessionId.current },
        );
        for await (const ev of run.events) {
          if (ev.kind === "step") {
            const now = Date.now();
            const secs = (now - lastStepAt.current) / 1000;
            lastStepAt.current = now;
            const up = ev.usage?.input ?? 0;
            const down = ev.usage?.output ?? 0;
            const step: TurnStep = {
              label: ev.display?.label ?? ev.step_id,
              ok: !ev.error && ev.status !== "failed",
              ...(secs >= 0.1 ? { secs } : {}),
              ...(up + down > 0 ? { tokens: { up, down } } : {}),
              details: stepDetails(ev.output),
              ...(ev.error ? { error: ev.error } : {}),
            };
            turn.tokensUp += up;
            turn.tokensDown += down;
            turn.stubbed = turn.stubbed || ev.frames.includes("stub");
            turn.degraded = turn.degraded || ev.frames.includes("degrade");
            setLast({ ...turn });
            push({ kind: "section", step });
          } else if (ev.kind === "answer") {
            turn.text = ev.text;
            if (ev.text) push({ kind: "answer", text: ev.text });
          } else if (ev.kind === "error") {
            turn.text = `${ev.code}: ${ev.detail}`;
            turn.status = "error";
            push({ kind: "answer", text: turn.text });
          }
        }
        const result = await run.done;
        if (turn.status !== "error") {
          turn.status = result.status === "error" || result.error ? "error" : result.status === "refused" ? "refused" : "done";
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
    [client, rotor, push],
  );

  const runCommand = useCallback(
    async (line: string) => {
      const id = push({ kind: "command", text: line });
      const ctx: CommandCtx = {
        client,
        account,
        rotor,
        version,
        server,
        setAccount,
        setRotor,
        clearChat: () => {
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
          modelsForRotor.current = null;
        },
      };
      const result = await runSlash(ctx, line);
      patchItem(id, (it) => ({ ...it, result }) as Item);
    },
    [account, client, exit, patchItem, push, rotor, server, setRotor, version],
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
          <Text color={theme.dim}>Ask Glyphh anything, or type /help. Ctrl+C to quit.</Text>
        ) : (
          visible.map((l, i) => <TranscriptLine key={`${start + i}`} line={l} />)
        )}
      </Box>
      {clampedScroll > 0 ? (
        <Text color={theme.dim}>{`  ↓ ${clampedScroll} lines below · ↑/↓ scrolls · pgdn returns`}</Text>
      ) : null}
      <Box flexDirection="column" ref={stripBox}>
        <SubFooter width={cols} busy={busy} elapsed={elapsed} last={last} verb={verb} />
        <InputBar width={cols} value={input} busy={busy} />
        <Footer width={cols} permissionMode={mode} rotor={rotor} model={modelLabel} configured={configured} />
      </Box>
    </Box>
  );
}
