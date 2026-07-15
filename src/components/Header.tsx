/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Header.tsx — the top chrome: a single-line outline whose TOP edge carries the version
 * ("Glyphh v1.2.3") inside the border. Left: the braille cat + the signed-in user & plan.
 * Right: the latest release note. The top edge is hand-drawn so the version sits IN the
 * outline; the box below borrows single left/right/bottom borders that meet its corners.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { CAT_ROWS } from "../banner.js";
import type { Account } from "../glyphh.js";

export interface HeaderProps {
  width: number;
  version: string;
  account: Account | null;
  release: string;
  server: string;
}

/** The hand-drawn top edge: `┌─ Glyphh v1.2.3 ─────────┐`, version in the outline. */
function TopEdge({ width, version }: { width: number; version: string }): React.ReactElement {
  const label = `Glyphh ${version}`;
  const inner = Math.max(0, width - 2); // dashes-worth between the two corners
  const trailing = Math.max(0, inner - 3 - label.length); // "─ " + label + " " then fill
  return (
    <Text color={theme.dim}>
      {"┌─ "}
      <Text color={theme.purple} bold>
        {label}
      </Text>
      {" " + "─".repeat(trailing) + "┐"}
    </Text>
  );
}

function planLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export function Header({ width, version, account, release, server }: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="column" width={width}>
      <TopEdge width={width} version={version} />
      <Box
        borderStyle="single"
        borderTop={false}
        borderColor={theme.dim}
        width={width}
        paddingX={1}
        justifyContent="space-between"
      >
        {/* Left — the cat, then who's signed in. */}
        <Box>
          <Box flexDirection="column" marginRight={2}>
            {CAT_ROWS.map((row, i) => (
              <Text key={i} color={theme.white}>
                {row}
              </Text>
            ))}
          </Box>
          <Box flexDirection="column" justifyContent="center">
            {account ? (
              <>
                <Text color={theme.white}>{account.name ?? account.email}</Text>
                <Text color={theme.gray}>{account.email}</Text>
                <Box marginTop={1}>
                  <Text color={theme.gray}>plan </Text>
                  <Text color={theme.purple}>{planLabel(account.tier)}</Text>
                  {account.credits !== null ? (
                    <Text color={theme.gray}>{`  ·  ${account.credits} credits`}</Text>
                  ) : null}
                </Box>
              </>
            ) : (
              <>
                <Text color={theme.gray}>not signed in</Text>
                <Text color={theme.dim}>run `glyphh auth` to sign in</Text>
              </>
            )}
          </Box>
        </Box>

        {/* Right — the latest release note. */}
        <Box flexDirection="column" alignItems="flex-end" justifyContent="center">
          <Text color={theme.gray}>latest release</Text>
          <Text color={theme.white}>{release}</Text>
          <Box marginTop={1}>
            <Text color={theme.dim}>{server.replace(/^https?:\/\//, "")}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
