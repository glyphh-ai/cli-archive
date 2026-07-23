/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * InputBar.tsx — the composer. A single-outline box holds the prompt + typed text with a
 * block cursor, and a Send button pinned to the far right. The border and button glow
 * purple when there's something to send, and dim while a turn is in flight.
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
  const accent = busy ? theme.faint : hasText ? theme.accent : theme.muted;
  const button = busy ? "  …  " : " Send ⏎ ";

  return (
    <Box
      width={width}
      borderStyle="single"
      borderColor={busy ? theme.faint : hasText ? theme.accent : theme.muted}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box>
        <Text color={theme.accent}>{"› "}</Text>
        {value ? <Text color={theme.text}>{value}</Text> : <Text color={theme.faint}>type a message</Text>}
        {!busy ? <Text color={theme.accent}>▍</Text> : null}
      </Box>
      <Text backgroundColor={accent} color={theme.text}>
        {button}
      </Text>
    </Box>
  );
}
