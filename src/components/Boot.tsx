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
import type { Client } from "@glyphh/client";
import { App } from "./App.js";
import { Login } from "./Login.js";
import { ThemePicker } from "./ThemePicker.js";
import { readPrefs, writePrefs } from "../prefs.js";
import { applyTheme, theme } from "../theme.js";
import { loadAccount, type Account } from "../glyphh.js";

export interface BootProps {
  client: Client;
  version: string;
  server: string;
  cwd: string;
  loop: string;
}

type Phase = "loading" | "login" | "theme" | "chat";

export function Boot({ client, version, server, cwd, loop }: BootProps): React.ReactElement {
  // Apply the saved theme once, synchronously on first render, so nothing paints in the
  // wrong palette. Chat/login/theme all read the same shared `theme` object.
  const [, force] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [account, setAccount] = useState<Account | null>(null);

  // Where to go once a session exists: the theme picker on first run, else straight to chat.
  const afterAuth = useCallback((): Phase => (readPrefs().theme ? "chat" : "theme"), []);

  useEffect(() => {
    applyTheme(readPrefs().theme);
    let cancelled = false;
    void loadAccount(client).then((a) => {
      if (cancelled) return;
      setAccount(a);
      setPhase(a ? afterAuth() : "login");
    });
    return () => {
      cancelled = true;
    };
  }, [client, afterAuth]);

  const onAuthed = useCallback(() => {
    void loadAccount(client).then((a) => {
      setAccount(a);
      setPhase(afterAuth());
    });
  }, [client, afterAuth]);

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
    <App client={client} version={version} server={server} cwd={cwd} loop={loop} initialAccount={account} />
  );
}
