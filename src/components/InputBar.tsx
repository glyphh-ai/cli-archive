/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * InputBar.tsx — the composer. A single-line editor with a REAL cursor: the
 * text before it, an inverted cell at it, the text after. While a turn runs it
 * names the key that stops it.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

export interface InputBarProps {
  width: number;
  value: string;
  /** Cursor index into `value` (code points). Defaults to the end. */
  cursor?: number;
  busy: boolean;
  /** A one-line hint shown in place of the placeholder (e.g. "press ctrl+c again to quit"). */
  hint?: string;
}

export function InputBar({ width, value, cursor, busy, hint }: InputBarProps): React.ReactElement {
  const hasText = value.length > 0;
  const chars = [...value];
  const at = Math.max(0, Math.min(cursor ?? chars.length, chars.length));
  const before = chars.slice(0, at).join("");
  const under = chars[at] ?? " ";
  const after = chars.slice(at + 1).join("");
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
          <Text color={theme.faint}>{hint ?? "working… press Esc to stop"}</Text>
        ) : hasText ? (
          <Text>
            <Text color={theme.text}>{before}</Text>
            <Text inverse color={theme.text}>{under}</Text>
            <Text color={theme.text}>{after}</Text>
          </Text>
        ) : (
          <Text>
            <Text inverse color={theme.text}>{" "}</Text>
            <Text color={theme.faint}>{hint ?? "type a message, or / for commands"}</Text>
          </Text>
        )}
      </Box>
      <Text backgroundColor={accent} color={theme.text}>
        {button}
      </Text>
    </Box>
  );
}
