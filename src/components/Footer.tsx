/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Footer.tsx — the status line beneath the composer, mirroring the desktop agent: the
 * permission mode sits far LEFT, and the right cluster carries the loop's resolved model
 * slots followed by the loop itself, furthest right. Chrome, not content — quiet by
 * design. Everything shown is resolved server-side (`loops.roles`) and rendered verbatim,
 * so the chip and the run can't disagree.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { PermissionMode } from "../types.js";

/** One resolved model slot: its label and the model that will fill it (null = unset). */
export interface FooterSlot {
  label: string;
  model: string | null;
}

export interface FooterProps {
  width: number;
  permissionMode: PermissionMode;
  /** The selected loop's slug. */
  loop: string;
  /** The loop's model slots, resolved for this caller (empty while loading/offline). */
  slots: FooterSlot[];
}

const MODE_GLYPH: Record<PermissionMode, string> = {
  ask: "◈ ask each time",
  auto: "⏵ auto-approve",
  plan: "✎ plan only",
  "read-only": "◎ read-only",
};

/** One slot chip. A single-slot loop shows just its model; a multi-slot loop prefixes
 *  each with its label so "planner" and "coder" stay distinguishable. */
function Slot({ slot, solo }: { slot: FooterSlot; solo: boolean }): React.ReactElement {
  const set = slot.model !== null;
  return (
    <Text>
      {solo ? null : <Text color={theme.muted}>{slot.label} </Text>}
      <Text color={set ? theme.accent : theme.faint}>{slot.model ?? "not set"}</Text>
    </Text>
  );
}

export function Footer({ width, permissionMode, loop, slots }: FooterProps): React.ReactElement {
  const solo = slots.length === 1;
  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Text color={theme.muted}>{MODE_GLYPH[permissionMode]}</Text>
      <Box>
        {slots.length === 0 ? (
          <Text color={theme.faint}>no model</Text>
        ) : (
          slots.map((s, i) => (
            <React.Fragment key={s.label}>
              {i > 0 ? <Text color={theme.faint}> · </Text> : null}
              <Slot slot={s} solo={solo} />
            </React.Fragment>
          ))
        )}
        <Text color={theme.faint}>{"   ·   "}</Text>
        <Text color={theme.muted}>loop </Text>
        <Text color={theme.accent}>{loop}</Text>
      </Box>
    </Box>
  );
}
