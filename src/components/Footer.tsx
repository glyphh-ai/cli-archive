/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Footer.tsx — the status line beneath the composer, showing the three things the CLI
 * sets: the permission mode (per-device pref), the base model bound to the rotor (from
 * the control plane), and the selected rotor with a configured indicator. Chrome, not
 * content — quiet by design.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { PermissionMode } from "../types.js";

export interface FooterProps {
  width: number;
  permissionMode: PermissionMode;
  /** The model bound to the rotor's primary role (or "not set"). */
  model: string;
  /** All of the rotor's roles are bound. */
  configured: boolean;
  rotor: string;
}

const MODE_GLYPH: Record<PermissionMode, string> = {
  ask: "◈ ask each time",
  auto: "⏵ auto-approve",
  plan: "✎ plan only",
  "read-only": "◎ read-only",
};

export function Footer({ width, permissionMode, model, configured, rotor }: FooterProps): React.ReactElement {
  const set = model !== "not set";
  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Text color={theme.gray}>{MODE_GLYPH[permissionMode]}</Text>
      <Box>
        <Text color={theme.gray}>model </Text>
        <Text color={set ? theme.purple : theme.dim}>{model}</Text>
        <Text color={theme.dim}>{"   ·   "}</Text>
        <Text color={configured ? theme.purple : theme.dim}>{configured ? "✓" : "○"}</Text>
        <Text color={theme.gray}> rotor </Text>
        <Text color={theme.purple}>{rotor}</Text>
      </Box>
    </Box>
  );
}
