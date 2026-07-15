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
  const accent = busy ? theme.dim : hasText ? theme.purple : theme.gray;
  const button = busy ? "  …  " : " Send ⏎ ";

  return (
    <Box
      width={width}
      borderStyle="single"
      borderColor={busy ? theme.dim : hasText ? theme.purple : theme.gray}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box>
        <Text color={theme.purple}>{"› "}</Text>
        {value ? <Text color={theme.white}>{value}</Text> : <Text color={theme.dim}>type a message</Text>}
        {!busy ? <Text color={theme.purple}>▍</Text> : null}
      </Box>
      <Text backgroundColor={accent} color={theme.white}>
        {button}
      </Text>
    </Box>
  );
}
