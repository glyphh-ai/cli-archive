/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * App.tsx — the TUI root. Owns the transcript, the composer buffer, and the live turn.
 * Header (cat + account) / Chat (streaming transcript) / InputBar (composer + Send) /
 * Footer (permission mode + rotor). Every turn goes through the SDK: provision a rotor
 * session once, then stream `session.turn()` events into the assistant message, closing
 * with a duration + credits meta line.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, useInput, useStdout } from "ink";
import type { Client } from "@glyphh/client";
import { staticTokenProvider } from "@glyphh/client";
import type { Session } from "@glyphh/client";
import { Header } from "./Header.js";
import { Chat } from "./Chat.js";
import { InputBar } from "./InputBar.js";
import { Footer } from "./Footer.js";
import { loadAccount, type Account } from "../glyphh.js";
import { isWireEvent } from "@glyphh/client";
import type { ChatMessage, PermissionMode, TurnMeta } from "../types.js";

const MODES: PermissionMode[] = ["ask", "auto", "plan", "read-only"];

export interface AppProps {
  client: Client;
  version: string;
  server: string;
  release: string;
  rotor: string;
}

/** Monotonic id source that doesn't touch Date.now/Math.random (kept deterministic-friendly). */
function useIds(): () => string {
  const n = useRef(0);
  return useCallback(() => `m${++n.current}`, []);
}

export function App({ client, version, server, release, rotor }: AppProps): React.ReactElement {
  const { stdout } = useStdout();
  const nextId = useIds();

  const [cols, setCols] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);
  const [account, setAccount] = useState<Account | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<PermissionMode>("ask");

  const sessionRef = useRef<Session | null>(null);

  // Track the terminal size so the layout fills the screen and reflows on resize.
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

  // Who's signed in (for the header).
  useEffect(() => {
    void loadAccount(client).then(setAccount);
  }, [client]);

  const pushSystem = useCallback(
    (text: string) => setMessages((m) => [...m, { id: nextId(), role: "system", text }]),
    [nextId],
  );

  /** Lazily provision one rotor session for the whole conversation. */
  const ensureSession = useCallback(async (): Promise<Session> => {
    if (sessionRef.current) return sessionRef.current;
    const { session, runtimeToken } = await client.sessions.create({ rotor });
    if (!session.runtimeUrl) throw new Error("runtime is not ready");
    const s = client.session({ url: session.runtimeUrl, token: staticTokenProvider(runtimeToken), rotor });
    sessionRef.current = s;
    return s;
  }, [client, rotor]);

  const patch = useCallback(
    (id: string, fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((list) => list.map((m) => (m.id === id ? fn(m) : m))),
    [],
  );

  const runTurn = useCallback(
    async (prompt: string) => {
      const answerId = nextId();
      const startedAt = Date.now();
      const creditsBefore = account?.credits ?? null;
      const meta: TurnMeta = { status: "running", credits: null, durationMs: null };
      setMessages((m) => [
        ...m,
        { id: nextId(), role: "user", text: prompt },
        { id: answerId, role: "assistant", text: "", streaming: true, meta },
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
        // Credits: re-read the balance and diff (usage is metered server-side).
        let credits: number | null = null;
        try {
          const bal = await client.billing.balance();
          if (creditsBefore !== null) credits = Math.max(0, creditsBefore - bal.credits);
          setAccount((a) => (a ? { ...a, credits: bal.credits } : a));
        } catch {
          /* balance best-effort */
        }
        const status = result.status === "error" || result.error ? "error" : "done";
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

  const submit = useCallback(() => {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setInput("");
    if (!account) {
      pushSystem("You're not signed in. Run `glyphh auth` in another shell, then restart.");
      return;
    }
    void runTurn(prompt);
  }, [account, busy, input, pushSystem, runTurn]);

  useInput((ch, key) => {
    if (key.tab && key.shift) {
      setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]!);
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    // Printable input only — ignore control chars and escape sequences.
    if (ch && !key.ctrl && !key.meta && !key.escape) setInput((v) => v + ch);
  });

  // Height budget: header is the cat (9) + 2 borders + 1 title ≈ 12; input 3; footer 1.
  const headerH = 12;
  const chatH = Math.max(3, rows - headerH - 3 - 1);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header width={cols} version={version} account={account} release={release} server={server} />
      <Chat messages={messages} height={chatH} />
      <InputBar width={cols} value={input} busy={busy} />
      <Footer width={cols} permissionMode={mode} rotor={rotor} />
    </Box>
  );
}
