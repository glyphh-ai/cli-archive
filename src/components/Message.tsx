/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Message.tsx — one chat row. `you` prompts are purple; `glyphh` answers are white and,
 * while running, lead with a spinner. A finished assistant turn shows a dim meta line:
 * duration + credits consumed.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { theme } from "../theme.js";
import type { ChatMessage } from "../types.js";

function fmtDuration(ms: number | null): string | null {
  if (ms === null) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function MetaLine({ message }: { message: ChatMessage }): React.ReactElement | null {
  const meta = message.meta;
  if (!meta) return null;
  const parts: string[] = [];
  const dur = fmtDuration(meta.durationMs);
  if (dur) parts.push(`⏱ ${dur}`);
  if (meta.credits !== null) parts.push(`◈ ${meta.credits} credit${meta.credits === 1 ? "" : "s"}`);
  if (meta.status === "error") parts.push("failed");
  if (parts.length === 0) return null;
  return (
    <Text color={meta.status === "error" ? theme.purple : theme.dim}>{parts.join("   ·   ")}</Text>
  );
}

export function Message({ message }: { message: ChatMessage }): React.ReactElement {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const label = isUser ? "you" : isSystem ? "" : "glyphh";
  const labelColor = isUser ? theme.purple : theme.gray;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {message.streaming ? (
          <Text color={theme.purple}>
            <Spinner type="dots" />{" "}
          </Text>
        ) : null}
        {label ? <Text color={labelColor} bold={isUser}>{label}</Text> : null}
      </Box>
      <Text color={isSystem ? theme.dim : theme.white}>{message.text || (message.streaming ? "…" : "")}</Text>
      <MetaLine message={message} />
    </Box>
  );
}
