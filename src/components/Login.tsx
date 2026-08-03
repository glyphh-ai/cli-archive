/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Login.tsx — the first screen when this terminal has no session. It runs the SDK device
 * grant, opens the browser straight to the APPROVAL page (the code already embedded in the
 * URL, like desktop), and shows the code as a fallback for anyone who has to open it by
 * hand. It resolves the moment the browser half is approved — the poll lives in the SDK.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import type { Client } from "@glyphh/sdk";
import { theme } from "../theme.js";
import { CAT_ROWS } from "../banner.js";
import { openBrowser } from "../open-browser.js";

interface Prompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
}

type Phase =
  | { kind: "starting" }
  | { kind: "prompt"; prompt: Prompt; opened: boolean }
  | { kind: "error"; message: string };

export function Login({ client, onAuthed }: { client: Client; onAuthed: () => void }): React.ReactElement {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);

  // One device grant per attempt; a re-key (retry) starts a fresh one. Cancelled on unmount
  // via AbortController so a resolved login doesn't poll into a torn-down tree.
  useEffect(() => {
    const ctrl = new AbortController();
    let done = false;
    void (async () => {
      try {
        setPhase({ kind: "starting" });
        await client.auth.deviceLogin({
          signal: ctrl.signal,
          onPrompt: (p) => {
            const url = p.verificationUriComplete || p.verificationUri;
            // Do NOT auto-open — hand the user the code first and let them press
            // enter to open the browser (or copy the URL). Some terminals steal
            // focus on an auto-launch; this keeps the code visible and in control.
            setPhase({
              kind: "prompt",
              prompt: { userCode: p.userCode, verificationUri: p.verificationUri, verificationUriComplete: url },
              opened: false,
            });
          },
        });
        done = true;
        onAuthed();
      } catch (err) {
        if (!ctrl.signal.aborted) setPhase({ kind: "error", message: (err as Error).message });
      }
    })();
    return () => {
      if (!done) ctrl.abort();
    };
  }, [client, onAuthed, attempt]);

  const reopen = useCallback(() => {
    setPhase((p) => (p.kind === "prompt" ? { ...p, opened: openBrowser(p.prompt.verificationUriComplete) } : p));
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
    if (phase.kind === "error" && (input === "r" || key.return)) setAttempt((a) => a + 1);
    if (phase.kind === "prompt" && (input === "o" || key.return)) reopen();
  });

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} paddingY={2}>
      <Text color={theme.text} bold>
        {CAT_ROWS.join("\n")}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.accent} bold>
          Sign in to Glyphh
        </Text>
      </Box>

      {phase.kind === "starting" ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.muted}> starting secure sign-in…</Text>
        </Box>
      ) : null}

      {phase.kind === "prompt" ? (
        <Box flexDirection="column" alignItems="center" marginTop={1}>
          <Text color={theme.muted}>
            {phase.opened
              ? "Opened your browser to approve this device."
              : "Press enter to open your browser — sign in with Google or email to approve."}
          </Text>
          <Box marginTop={1}>
            <Text color={theme.faint}>{phase.prompt.verificationUri}</Text>
          </Box>
          <Box
            marginTop={1}
            borderStyle="round"
            borderColor={theme.accent}
            paddingX={2}
            flexDirection="column"
            alignItems="center"
          >
            <Text color={theme.faint}>confirm this code matches</Text>
            <Text color={theme.accent} bold>
              {phase.prompt.userCode.split("").join(" ")}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.accent}>
              <Spinner type="dots" />
            </Text>
            <Text color={theme.muted}> waiting for approval…</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.faint} italic>
              {phase.opened ? "enter · re-open browser   ·   ctrl+c · quit" : "enter · open browser   ·   ctrl+c · quit"}
            </Text>
          </Box>
        </Box>
      ) : null}

      {phase.kind === "error" ? (
        <Box flexDirection="column" alignItems="center" marginTop={1}>
          <Text color="red">sign-in failed: {phase.message}</Text>
          <Box marginTop={1}>
            <Text color={theme.faint} italic>
              enter · try again   ·   ctrl+c · quit
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
