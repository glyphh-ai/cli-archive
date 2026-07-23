/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * SubFooter.tsx — the status strip pinned between the transcript and the
 * composer. While a turn runs it carries the LIVE signal (spinner · verbing ·
 * elapsed · token burn); when idle it holds exactly one line — the last turn's
 * cost (✻ Verbed for Ns · tokens · ◈ credits). The transcript stays pure
 * content while "what's happening right now" always sits in the same place.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { theme } from "../theme.js";
import type { ChatTurn } from "../types.js";

export interface SubFooterProps {
  width: number;
  busy: boolean;
  /** Live elapsed seconds for the running turn. */
  elapsed: number;
  /** The newest assistant turn (running or settled), if any. */
  last?: ChatTurn | undefined;
  /** This turn's working verb pair (✽ Verbing… / ✻ Verbed for Ns). */
  verb: { ing: string; past: string };
}

export function SubFooter({ width, busy, elapsed, last, verb }: SubFooterProps): React.ReactElement {
  if (busy && last) {
    const burn = last.tokensUp + last.tokensDown > 0 ? ` · ${last.tokensUp}↑ ${last.tokensDown}↓ tok` : "";
    return (
      <Box width={width} paddingX={1} flexDirection="column">
        <Text>
          <Text color={theme.purple}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.gray}> {verb.ing}… </Text>
          <Text color={theme.dim}>
            ({elapsed.toFixed(1)}s{burn})
          </Text>
        </Text>
      </Box>
    );
  }
  if (last && last.status !== "running") {
    const cost: string[] = [];
    if (last.durationMs !== undefined) cost.push(`${verb.past} for ${(last.durationMs / 1000).toFixed(1)}s`);
    if (last.tokensUp + last.tokensDown > 0) cost.push(`${last.tokensUp}↑ ${last.tokensDown}↓ tok`);
    if (last.credits !== null) cost.push(`◈ ${last.credits} credit${last.credits === 1 ? "" : "s"}`);
    if (last.status === "refused") cost.push("refused");
    if (last.status === "error") cost.push("failed");
    return (
      <Box width={width} paddingX={1} flexDirection="column">
        <Text color={theme.dim} wrap="truncate-end">
          ✻ {cost.join(" · ")}
          {last.stubbed ? "  ⚠ no model bound — stub answered (/configure)" : ""}
          {last.degraded ? "  ⚠ lane degraded (unfold the step detail)" : ""}
        </Text>
      </Box>
    );
  }
  return <Box width={width} paddingX={1} />;
}
