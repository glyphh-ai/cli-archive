/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * App.tsx — the TUI root. The header + every finished turn flow into the terminal's
 * native scrollback via <Static> (printed once, never re-rendered — so a long transcript
 * never overlaps itself); only the in-flight answer, the composer, and the footer stay
 * dynamic at the bottom. A leading `/` runs a slash command; plain text runs a rotor turn,
 * streaming `session.turn()` events into the live answer and closing with a meta line.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
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

export interface AppProps {
  client: Client;
  version: string;
  server: string;
  cwd: string;
  rotor: string;
}

/** A scrollback item: the one-time header, or a committed message. */
type StaticItem = { key: "header" } | { key: string; msg: ChatMessage };

function useIds(): () => string {
  const n = useRef(0);
  return useCallback(() => `m${++n.current}`, []);
}

export function App({ client, version, server, cwd, rotor: initialRotor }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const nextId = useIds();

  const [cols, setCols] = useState(stdout.columns || 80);
  const [ready, setReady] = useState(false); // account resolved → safe to print the header
  const [account, setAccount] = useState<Account | null>(null);
  const [log, setLog] = useState<ChatMessage[]>([]); // committed, append-only (scrollback)
  const [live, setLive] = useState<ChatMessage | null>(null); // the streaming answer
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<PermissionMode>("ask");
  const [rotor, setRotorState] = useState(initialRotor);

  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    const onResize = () => setCols(stdout.columns || 80);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    void loadAccount(client).then((a) => {
      setAccount(a);
      setReady(true);
    });
  }, [client]);

  const commit = useCallback((m: ChatMessage) => setLog((l) => [...l, m]), []);

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
      commit({ id: nextId(), role: "user", text: prompt });
      const answerId = nextId();
      const startedAt = Date.now();
      const creditsBefore = account?.credits ?? null;
      let msg: ChatMessage = { id: answerId, role: "assistant", text: "", streaming: true, meta: { status: "running", credits: null, durationMs: null } };
      setLive(msg);
      setBusy(true);
      const update = (fn: (m: ChatMessage) => ChatMessage) => {
        msg = fn(msg);
        setLive(msg);
      };
      try {
        const session = await ensureSession();
        const run = session.turn(prompt);
        let buffer = "";
        for await (const ev of run.events) {
          if (!isWireEvent(ev)) continue;
          if (ev.kind === "step" && ev.frames.length) {
            buffer += ev.frames.join("");
            update((m) => ({ ...m, text: buffer }));
          } else if (ev.kind === "answer") {
            buffer = ev.text;
            update((m) => ({ ...m, text: buffer }));
          } else if (ev.kind === "error") {
            update((m) => ({ ...m, text: m.text || ev.detail }));
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
        update((m) => ({ ...m, streaming: false, meta: { status, credits, durationMs } }));
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        update((m) => ({
          ...m,
          streaming: false,
          text: m.text || `couldn't reach the runtime: ${(err as Error).message}`,
          meta: { status: "error", credits: null, durationMs },
        }));
      } finally {
        commit(msg); // move the finished answer into scrollback
        setLive(null);
        setBusy(false);
      }
    },
    [account, client, commit, ensureSession, nextId],
  );

  const runCommand = useCallback(
    async (line: string) => {
      const ctx: CommandCtx = {
        client,
        account,
        rotor,
        version,
        server,
        setAccount,
        setRotor,
        clearChat: () => setLog([]),
        quit: () => exit(),
      };
      const result = await runSlash(ctx, line);
      commit({ id: nextId(), role: "command", text: line, result });
    },
    [account, client, commit, exit, nextId, rotor, server, setRotor, version],
  );

  const submit = useCallback(() => {
    const raw = input.trim();
    if (!raw || busy) return;
    setInput("");
    if (raw.startsWith("/")) {
      void runCommand(raw);
      return;
    }
    if (!account) {
      commit({ id: nextId(), role: "user", text: raw, result: ["Not logged in · Please run /login"] });
      return;
    }
    void runTurn(raw);
  }, [account, busy, commit, input, nextId, runCommand, runTurn]);

  useInput((ch, key) => {
    if (key.tab && key.shift) {
      setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]!);
      return;
    }
    if (key.return) return submit();
    if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
    if (ch && !key.ctrl && !key.meta && !key.escape) setInput((v) => v + ch);
  });

  const items: StaticItem[] = ready ? [{ key: "header" }, ...log.map((m) => ({ key: m.id, msg: m }))] : [];

  return (
    <Box flexDirection="column" width={cols}>
      <Static items={items}>
        {(item) =>
          "msg" in item ? (
            <Box key={item.key} paddingX={1}>
              <Message message={item.msg} />
            </Box>
          ) : (
            <Header key="header" width={cols} version={version} account={account} notes={RELEASE_NOTES} server={server} cwd={cwd} />
          )
        }
      </Static>

      {live ? (
        <Box paddingX={1}>
          <Message message={live} />
        </Box>
      ) : log.length === 0 && ready ? (
        <Box paddingX={1}>
          <Text color={theme.dim}>Ask Glyphh anything, or type /help. Ctrl+C to quit.</Text>
        </Box>
      ) : null}

      <InputBar width={cols} value={input} busy={busy} />
      <Footer width={cols} permissionMode={mode} rotor={rotor} />
    </Box>
  );
}
