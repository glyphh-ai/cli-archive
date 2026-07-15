/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Chat.tsx — the center transcript. Grows to fill the space between header and input,
 * anchors the newest turns to the bottom, and clips older ones off the top. Shows a
 * quiet hint when the conversation is empty.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { Message } from "./Message.js";
import type { ChatMessage } from "../types.js";

export interface ChatProps {
  messages: readonly ChatMessage[];
  height: number;
}

export function Chat({ messages, height }: ChatProps): React.ReactElement {
  return (
    <Box flexDirection="column" height={height} paddingX={1} overflow="hidden">
      {/* Push content to the bottom so the latest turn is always in view. */}
      <Box flexGrow={1} />
      {messages.length === 0 ? (
        <Box flexDirection="column">
          <Text color={theme.gray}>Ask Glyphh anything.</Text>
          <Text color={theme.dim}>Type below and press Enter. Ctrl+C to quit.</Text>
        </Box>
      ) : (
        messages.map((m) => <Message key={m.id} message={m} />)
      )}
    </Box>
  );
}
