/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * App.tsx — the TUI root. A full-screen fixed layout that fills the terminal: Header
 * pinned at top, the transcript filling the middle (newest turns anchored to the bottom),
 * and the composer + footer pinned at the bottom. The transcript renders only the turns
 * that FIT — sliced from newest, never overflowing — so a long conversation never
 * overlaps itself. A leading `/` runs a slash command; plain text streams a rotor turn.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Client, Session } from "@glyphh/client";
import { staticTokenProvider, isWireEvent } from "@glyphh/client";
import { Header } from "./Header.js";
import { Message } from "./Message.js";
import { InputBar } from "./InputBar.js";
import { Footer } from "./Footer.js";
import { theme } from "../theme.js";
import { loadAccount, type Account } from "../glyphh.js";
import { runSlash, RELEASE_NOTES, type CommandCtx } from "../commands.js";
import type { ChatMessage, PermissionMode, TurnMeta } from "../types.js";

const MODES: PermissionMode[] = ["ask", "auto", "plan", "read-only"];
/** Rows the header + composer + footer occupy; the rest is transcript. */
const CHROME_ROWS = 20;

function useIds(): () => string {
  const n = useRef(0);
  return useCallback(() => `m${++n.current}`, []);
}

/** Approx line height of a message so the tail can be sliced without overflowing. */
function lineHeight(m: ChatMessage, cols: number): number {
  const w = Math.max(1, cols - 6);
  const wrap = (s: string) => Math.max(1, Math.ceil([...s].length / w));
  let n = wrap(m.text || "…");
  if (m.result) n += m.result.length;
  if (m.role === "assistant" && m.meta && m.meta.status !== "running") n += 1;
  return n + 1; // trailing gap
}

/** The newest messages that fit within `budget` rows. */
function fitTail(msgs: ChatMessage[], budget: number, cols: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const h = lineHeight(msgs[i]!, cols);
    if (used + h > budget && out.length > 0) break;
    out.unshift(msgs[i]!);
    used += h;
  }
  return out;
}

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
  const nextId = useIds();

  const [cols, setCols] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);
  const [account, setAccount] = useState<Account | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<PermissionMode>("ask");
  const [rotor, setRotorState] = useState(initialRotor);

  const sessionRef = useRef<Session | null>(null);

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

  const patch = useCallback(
    (id: string, fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((list) => list.map((m) => (m.id === id ? fn(m) : m))),
    [],
  );

  const setRotor = useCallback((r: string) => {
    sessionRef.current = null; // re-provision on the next turn
    setRotorState(r);
  }, []);

  const ensureSession = useCallback(async (): Promise<Session> => {
    if (sessionRef.current) return sessionRef.current;
    const { session, runtimeToken } = await client.sessions.create({ rotor });
    if (!session.runtimeUrl) throw new Error("runtime is not ready");
    const s = client.session({ url: session.runtimeUrl, token: staticTokenProvider(runtimeToken), rotor });
    sessionRef.current = s;
    return s;
  }, [client, rotor]);

  const runTurn = useCallback(
    async (prompt: string) => {
      const answerId = nextId();
      const startedAt = Date.now();
      const creditsBefore = account?.credits ?? null;
      setMessages((m) => [
        ...m,
        { id: nextId(), role: "user", text: prompt },
        { id: answerId, role: "assistant", text: "", streaming: true, meta: { status: "running", credits: null, durationMs: null } },
      ]);
      setBusy(true);
      try {
        const session = await ensureSession();
        const run = session.turn(prompt);
        let buffer = "";
        for await (const ev of run.events) {
          if (!isWireEvent(ev)) continue;
          if (ev.kind === "step" && ev.frames.length) {
            buffer += ev.frames.join("");
            patch(answerId, (m) => ({ ...m, text: buffer }));
          } else if (ev.kind === "answer") {
            buffer = ev.text;
            patch(answerId, (m) => ({ ...m, text: buffer }));
          } else if (ev.kind === "error") {
            patch(answerId, (m) => ({ ...m, text: m.text || ev.detail }));
          }
        }
        const result = await run.done;
        const durationMs = Date.now() - startedAt;
        let credits: number | null = null;
        try {
          const bal = await client.billing.balance();
          if (creditsBefore !== null) credits = Math.max(0, creditsBefore - bal.credits);
          setAccount((a) => (a ? { ...a, credits: bal.credits } : a));
        } catch {
          /* balance best-effort */
        }
        const status: TurnMeta["status"] = result.status === "error" || result.error ? "error" : "done";
        patch(answerId, (m) => ({ ...m, streaming: false, meta: { status, credits, durationMs } }));
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        patch(answerId, (m) => ({
          ...m,
          streaming: false,
          text: m.text || `couldn't reach the runtime: ${(err as Error).message}`,
          meta: { status: "error", credits: null, durationMs },
        }));
      } finally {
        setBusy(false);
      }
    },
    [account, client, ensureSession, nextId, patch],
  );

  const runCommand = useCallback(
    async (line: string) => {
      const id = nextId();
      setMessages((m) => [...m, { id, role: "command", text: line }]);
      const ctx: CommandCtx = {
        client,
        account,
        rotor,
        version,
        server,
        setAccount,
        setRotor,
        clearChat: () => setMessages([]),
        quit: () => exit(),
        emit: (lines) => patch(id, (m) => ({ ...m, result: lines })),
      };
      const result = await runSlash(ctx, line);
      patch(id, (m) => ({ ...m, result }));
    },
    [account, client, exit, nextId, patch, rotor, server, setRotor, version],
  );

  const submit = useCallback(() => {
    const raw = input.trim();
    if (!raw || busy) return;
    setInput("");
    if (raw.startsWith("/")) return void runCommand(raw);
    if (!account) {
      setMessages((m) => [...m, { id: nextId(), role: "user", text: raw, result: ["Not logged in · Please run /login"] }]);
      return;
    }
    void runTurn(raw);
  }, [account, busy, input, nextId, runCommand, runTurn]);

  useInput((ch, key) => {
    if (key.tab && key.shift) {
      setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]!);
      return;
    }
    if (key.return) return submit();
    if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
    if (ch && !key.ctrl && !key.meta && !key.escape) setInput((v) => v + ch);
  });

  const budget = Math.max(1, rows - CHROME_ROWS);
  const shown = fitTail(messages, budget, cols);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header width={cols} version={version} account={account} notes={RELEASE_NOTES} server={server} cwd={cwd} />
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Box flexGrow={1} />
        {shown.length === 0 ? (
          <Text color={theme.dim}>Ask Glyphh anything, or type /help. Ctrl+C to quit.</Text>
        ) : (
          shown.map((m) => <Message key={m.id} message={m} />)
        )}
      </Box>
      <InputBar width={cols} value={input} busy={busy} />
      <Footer width={cols} permissionMode={mode} rotor={rotor} />
    </Box>
  );
}
