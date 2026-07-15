/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Header.tsx — the top chrome, two panels inside one outline whose TOP edge carries the
 * version ("Glyphh v1.2.3"). LEFT: the braille cat, and stacked beneath it (centered)
 * the signed-in user, plan + credits, organization, and working directory. RIGHT: the
 * "What's new" release notes. A single vertical rule divides them.
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
  notes: string[];
  server: string;
  cwd: string;
}

/** The hand-drawn top edge: `┌─ Glyphh v1.2.3 ─────────┐`, version in the outline. */
function TopEdge({ width, version }: { width: number; version: string }): React.ReactElement {
  const label = `Glyphh ${version}`;
  const inner = Math.max(0, width - 2);
  const trailing = Math.max(0, inner - 3 - label.length);
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

function LeftPanel({ account, cwd }: { account: Account | null; cwd: string }): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" paddingX={1}>
      <Text color={theme.white}>{CAT_ROWS.join("\n")}</Text>
      <Box flexDirection="column" alignItems="center" marginTop={1}>
        {account ? (
          <>
            <Text color={theme.white} bold>
              {account.name ?? account.email}
            </Text>
            <Text color={theme.gray}>
              <Text color={theme.purple}>{planLabel(account.tier)}</Text>
              {account.credits !== null ? ` plan · ${account.credits} credits` : " plan"}
            </Text>
            <Text color={theme.gray}>{account.email}'s Organization</Text>
            <Text color={theme.dim}>{cwd}</Text>
          </>
        ) : (
          <>
            <Text color={theme.gray}>not signed in</Text>
            <Text color={theme.dim}>run /login &lt;email&gt; to sign in</Text>
            <Text color={theme.dim}>{cwd}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

function NotesPanel({ notes }: { notes: string[] }): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={40}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderColor={theme.dim}
      paddingLeft={2}
      paddingRight={1}
    >
      <Text color={theme.purple} bold>
        What's new
      </Text>
      {notes.map((n, i) => (
        <Text key={i} color={i === 0 ? theme.white : theme.gray}>
          {n}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={theme.dim} italic>
          /release-notes for more
        </Text>
      </Box>
    </Box>
  );
}

export function Header({ width, version, account, notes, server, cwd }: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="column" width={width}>
      <TopEdge width={width} version={version} />
      <Box borderStyle="single" borderTop={false} borderColor={theme.dim} width={width}>
        <LeftPanel account={account} cwd={cwd} />
        <NotesPanel notes={notes.length ? notes : [server.replace(/^https?:\/\//, "")]} />
      </Box>
    </Box>
  );
}
