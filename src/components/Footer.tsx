/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Footer.tsx — the status line beneath the composer. Bottom-left: the permission mode
 * (cycled with shift+tab). Bottom-right: the selected rotor. Quiet by design — chrome,
 * not content.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { PermissionMode } from "../types.js";

export interface FooterProps {
  width: number;
  permissionMode: PermissionMode;
  rotor: string;
}

const MODE_GLYPH: Record<PermissionMode, string> = {
  ask: "◈ ask each time",
  auto: "⏵ auto-approve",
  plan: "✎ plan only",
  "read-only": "◎ read-only",
};

export function Footer({ width, permissionMode, rotor }: FooterProps): React.ReactElement {
  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Text color={theme.gray}>{MODE_GLYPH[permissionMode]}</Text>
      <Text color={theme.gray}>
        rotor <Text color={theme.purple}>{rotor}</Text>
      </Text>
    </Box>
  );
}
