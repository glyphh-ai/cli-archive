/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * InputBar.tsx — the composer. A single-outline box holds the prompt + typed text with a
 * block cursor, and a button pinned to the far right. Idle it reads "Send ⏎"; while a turn
 * runs it becomes "Esc ✕ stop" — a terminal button can't be clicked, so it names the key
 * that acts on it. The border glows purple when there's something to send.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

export interface InputBarProps {
  width: number;
  value: string;
  busy: boolean;
}

export function InputBar({ width, value, busy }: InputBarProps): React.ReactElement {
  const hasText = value.trim().length > 0;
  // While busy the button is the STOP control: it names the key (Esc) because a
  // terminal button isn't clickable, and turns red so it reads as "interrupt".
  const accent = busy ? "red" : hasText ? theme.accent : theme.muted;
  const button = busy ? " Esc ✕ stop " : " Send ⏎ ";

  return (
    <Box
      width={width}
      borderStyle="single"
      borderColor={busy ? "red" : hasText ? theme.accent : theme.muted}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box>
        <Text color={theme.accent}>{"› "}</Text>
        {busy ? (
          <Text color={theme.faint}>working… press Esc to stop</Text>
        ) : value ? (
          <Text color={theme.text}>{value}</Text>
        ) : (
          <Text color={theme.faint}>type a message</Text>
        )}
        {!busy ? <Text color={theme.accent}>▍</Text> : null}
      </Box>
      <Text backgroundColor={accent} color={theme.text}>
        {button}
      </Text>
    </Box>
  );
}
