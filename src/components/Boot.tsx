/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Boot.tsx — the startup gate. It resolves the two things that must be settled before the
 * chat can open — a session and a theme — then hands off to the App:
 *
 *   loading → (no session) login → (first run) theme → chat
 *
 * A returning, signed-in user with a saved theme falls straight through to chat. The saved
 * theme is applied before anything paints, so even the login screen wears the user's colors.
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
import { resetAgentAuth } from "../agent.js";
import { startMachineHost, stopMachineHost } from "../machine-host.js";

export interface BootProps {
  client: Client;
  version: string;
  server: string;
  cwd: string;
  loop: string;
  /** The late-bound box main.tsx gave the client's onSignedOut — Boot registers the
   *  reaction here: when the refresh chain dies MID-SESSION, drop to the login gate. */
  authLost?: { handler?: () => void };
  /** `--thread <id>` — the chat resumes this saved server thread. */
  resumeThreadId?: string;
}

type Phase = "loading" | "login" | "theme" | "chat";

export function Boot({ client, version, server, cwd, loop, authLost, resumeThreadId }: BootProps): React.ReactElement {
  // Apply the saved theme once, synchronously on first render, so nothing paints in the
  // wrong palette. Chat/login/theme all read the same shared `theme` object.
  const [, force] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [account, setAccount] = useState<Account | null>(null);
  // Bumped on every re-auth: keys the App so a new session starts a FRESH chat —
  // the old transcript belonged to a dead session and its caches (models, ids) with it.
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
  }, [client, afterAuth]);

  // Session death (expired/revoked refresh) → the login gate, from anywhere.
  useEffect(() => {
    if (!authLost) return;
    authLost.handler = () => {
      resetAgentAuth(); // the /mcp grant + interceptor bearer died with the session
      stopMachineHost();
      setAccount(null);
      setPhase("login");
    };
    return () => {
      delete authLost.handler;
    };
  }, [authLost]);

  const onAuthed = useCallback(() => {
    resetAgentAuth(); // fresh session → fresh grant on the next turn
    void loadAccount(client).then((a) => {
      setAccount(a);
      if (a) startMachineHost(client, server, version);
      setEpoch((e) => e + 1);
      setPhase(afterAuth());
    });
  }, [client, afterAuth]);

  // /login (user-initiated) → the same login gate a dead session drops to. On
  // success onAuthed bumps the epoch, so the App remounts on the fresh session.
  const onRelogin = useCallback(() => {
    resetAgentAuth();
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
      loop={loop}
      initialAccount={account}
      onRelogin={onRelogin}
      {...(resumeThreadId ? { resumeThreadId } : {})}
    />
  );
}
