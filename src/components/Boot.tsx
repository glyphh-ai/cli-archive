/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Boot.tsx — the gate in front of the App: resolve the saved session, else the
 * device login; pick a theme on first run; then the chat. A session that dies
 * mid-flight (expired / revoked refresh) drops back here from anywhere, and the
 * loop's conversations and credential die with it.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Client } from "@glyphh/sdk";
import { App } from "./App.js";
import { Login } from "./Login.js";
import { ThemePicker } from "./ThemePicker.js";
import { readPrefs, writePrefs } from "../prefs.js";
import { applyTheme, theme } from "../theme.js";
import { loadAccount, type Account } from "../glyphh.js";
import { resetLoop } from "../loop.js";
import { startMachineHost, stopMachineHost } from "../machine-host.js";
import type { PermissionMode } from "../types.js";

export interface BootProps {
  client: Client;
  version: string;
  server: string;
  cwd: string;
  /** The late-bound box main.tsx gave the client's onSignedOut — Boot registers the
   *  reaction here: when the refresh chain dies MID-SESSION, drop to the login gate. */
  authLost?: { handler?: () => void };
  /** `--bridge` — the bridge URL Claude Desktop points at, shown in the banner. */
  bridgeUrl?: string;
  /** `--model` — the gateway model this session runs on. */
  initialModel?: string;
  /** `--permission` — the permission chip to start on. */
  initialMode?: PermissionMode;
  /** An opening prompt from the command line — sent once the chat is up. */
  initialPrompt?: string;
}

type Phase = "loading" | "login" | "theme" | "chat";

export function Boot({ client, version, server, cwd, authLost, bridgeUrl, initialModel, initialMode, initialPrompt }: BootProps): React.ReactElement {
  // Apply the saved theme once, synchronously on first render, so nothing paints in the
  // wrong palette. Chat/login/theme all read the same shared `theme` object.
  const [, force] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [account, setAccount] = useState<Account | null>(null);
  // Bumped on every re-auth: keys the App so a new session starts a FRESH chat —
  // the old transcript belonged to a dead session and its caches with it.
  const [epoch, setEpoch] = useState(0);

  // Where to go once a session exists: the theme picker on first run, else straight to chat.
  const afterAuth = useCallback((): Phase => (readPrefs().theme ? "chat" : "theme"), []);

  useEffect(() => {
    applyTheme(readPrefs().theme);
    let cancelled = false;
    void loadAccount(client).then((a) => {
      if (cancelled) return;
      setAccount(a);
      if (a) startMachineHost(client, server, version);
      setPhase(a ? afterAuth() : "login");
    });
    return () => {
      cancelled = true;
    };
  }, [client, afterAuth, server, version]);

  // Session death (expired/revoked refresh) → the login gate, from anywhere.
  useEffect(() => {
    if (!authLost) return;
    authLost.handler = () => {
      resetLoop(); // the conversations and the gateway credential died with the session
      stopMachineHost();
      setAccount(null);
      setPhase("login");
    };
    return () => {
      delete authLost.handler;
    };
  }, [authLost]);

  const onAuthed = useCallback(() => {
    resetLoop(); // fresh session → a fresh credential on the next turn
    void loadAccount(client).then((a) => {
      setAccount(a);
      if (a) startMachineHost(client, server, version);
      setEpoch((e) => e + 1);
      setPhase(afterAuth());
    });
  }, [client, afterAuth, server, version]);

  // /login (user-initiated) → the same login gate a dead session drops to. On
  // success onAuthed bumps the epoch, so the App remounts on the fresh session.
  const onRelogin = useCallback(() => {
    resetLoop();
    stopMachineHost();
    setAccount(null);
    setPhase("login");
  }, []);

  const onPickTheme = useCallback((name: string) => {
    applyTheme(name);
    writePrefs({ theme: name });
    force((n) => n + 1);
    setPhase("chat");
  }, []);

  if (phase === "loading") {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Text color={theme.faint}>starting Glyphh…</Text>
      </Box>
    );
  }
  if (phase === "login") return <Login client={client} onAuthed={onAuthed} />;
  if (phase === "theme") return <ThemePicker current={readPrefs().theme} onPick={onPickTheme} />;
  return (
    <App
      key={epoch}
      client={client}
      version={version}
      server={server}
      cwd={cwd}
      initialAccount={account}
      onRelogin={onRelogin}
      {...(bridgeUrl ? { bridgeUrl } : {})}
      {...(initialModel ? { initialModel } : {})}
      {...(initialMode ? { initialMode } : {})}
      {...(initialPrompt && epoch === 0 ? { initialPrompt } : {})}
    />
  );
}
