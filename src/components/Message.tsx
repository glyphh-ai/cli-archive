/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Message.tsx — one chat row, styled like the reference shell: typed input (you /
 * command) leads with a purple bar `▌`; a status or command output hangs under it as a
 * `└ …` line; answers lead with a `●` bullet and, while running, a spinner. A finished
 * turn closes with a dim `* <verb> for <duration> · ◈ <credits>` meta line.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { theme } from "../theme.js";
import type { ChatMessage } from "../types.js";

const VERBS = ["Cooked", "Cogitated", "Crunched", "Brewed", "Noodled", "Simmered", "Churned"];

function verbFor(id: string): string {
  const n = Number.parseInt(id.replace(/\D/g, ""), 10) || 0;
  return VERBS[n % VERBS.length]!;
}

function fmtDuration(ms: number | null): string | null {
  if (ms === null) return null;
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`;
}

function ResultLines({ result }: { result: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {result.filter(Boolean).map((line, i) => (
        <Text key={i} color={theme.gray}>
          {(i === 0 ? "  └ " : "    ") + line}
        </Text>
      ))}
    </Box>
  );
}

function Meta({ message }: { message: ChatMessage }): React.ReactElement | null {
  const meta = message.meta;
  if (!meta || meta.status === "running") return null;
  const parts: string[] = [];
  const dur = fmtDuration(meta.durationMs);
  parts.push(meta.status === "error" ? "Stalled" : verbFor(message.id));
  if (dur) parts.push(`for ${dur}`);
  const tail = meta.credits !== null ? `   ·   ◈ ${meta.credits} credit${meta.credits === 1 ? "" : "s"}` : "";
  return <Text color={theme.dim}>{`* ${parts.join(" ")}${tail}`}</Text>;
}

export function Message({ message }: { message: ChatMessage }): React.ReactElement {
  const { role } = message;
  const hasResult = message.result && message.result.length > 0;

  if (role === "assistant") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          {message.streaming ? (
            <Text color={theme.purple}>
              <Spinner type="dots" />{" "}
            </Text>
          ) : (
            <Text color={theme.purple}>{"● "}</Text>
          )}
          <Text color={theme.white}>{message.text || (message.streaming ? "…" : "")}</Text>
        </Box>
        <Meta message={message} />
      </Box>
    );
  }

  if (role === "system") {
    return (
      <Box marginBottom={1}>
        <Text color={theme.dim}>{message.text}</Text>
      </Box>
    );
  }

  // user + command: a bar-led input, with an optional `└ …` result beneath.
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.purple} bold>
          {"▌ "}
        </Text>
        <Text color={role === "command" ? theme.purple : theme.white}>{message.text}</Text>
      </Box>
      {hasResult ? <ResultLines result={message.result!} /> : null}
    </Box>
  );
}
