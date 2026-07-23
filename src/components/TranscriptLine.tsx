/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * TranscriptLine.tsx — one styled transcript line. Pure presentation: the line
 * model (lines.ts) decides content + style; this maps style → the Glyphh palette
 * (white + neutral grays + the ONE purple). Every line truncates, never wraps —
 * wrapping happened in the line model, so the viewport math stays exact.
 */

import React from "react";
import { Text } from "ink";
import { theme } from "../theme.js";
import type { Line } from "../lines.js";

export function TranscriptLine({ line }: { line: Line }): React.ReactElement {
  if (line.style === "blank") return <Text> </Text>;
  if (line.style === "headSel") {
    return (
      <Text wrap="truncate-end" backgroundColor={theme.purple} color="black" bold>
        {line.text}
      </Text>
    );
  }
  if (line.style === "head" || line.style === "headErr") {
    const glyph = line.text.slice(0, 2);
    return (
      <Text wrap="truncate-end">
        <Text color={line.style === "headErr" ? "red" : theme.purple}>{glyph}</Text>
        <Text color={theme.white} bold>
          {line.text.slice(2)}
        </Text>
      </Text>
    );
  }
  if (line.style === "answer" && line.text.trimStart().startsWith("●")) {
    const i = line.text.indexOf("●");
    return (
      <Text wrap="truncate-end">
        {line.text.slice(0, i)}
        <Text color={theme.purple}>● </Text>
        <Text color={theme.white}>{line.text.slice(i + 2)}</Text>
      </Text>
    );
  }
  if ((line.style === "user" || line.style === "command") && line.text.startsWith("▌")) {
    return (
      <Text wrap="truncate-end">
        <Text color={theme.purple} bold>
          ▌{" "}
        </Text>
        <Text color={line.style === "command" ? theme.purple : theme.white}>{line.text.slice(2)}</Text>
      </Text>
    );
  }
  if (line.style === "detail" || line.style === "hint") {
    // Dim gutter rule, gray body — the line is chrome, the text is content.
    const i = line.text.indexOf("│");
    if (i >= 0) {
      return (
        <Text wrap="truncate-end" italic={line.style === "hint"}>
          <Text color={theme.dim}>{line.text.slice(0, i + 1)}</Text>
          <Text color={theme.gray}>{line.text.slice(i + 1)}</Text>
        </Text>
      );
    }
  }
  if (line.style === "cardTitle") {
    const start = line.text.indexOf("─ ") + 2;
    const end = line.text.indexOf(" ─", start);
    return (
      <Text wrap="truncate-end">
        <Text color={theme.dim}>{line.text.slice(0, start)}</Text>
        <Text color={theme.purple} bold>
          {line.text.slice(start, end)}
        </Text>
        <Text color={theme.dim}>{line.text.slice(end)}</Text>
      </Text>
    );
  }
  if (line.style === "cardBody") {
    // Dim box edges, white body between them.
    const first = line.text.indexOf("│");
    const last = line.text.lastIndexOf("│");
    if (first >= 0 && last > first) {
      return (
        <Text wrap="truncate-end">
          <Text color={theme.dim}>{line.text.slice(0, first + 1)}</Text>
          <Text color={theme.white}>{line.text.slice(first + 1, last)}</Text>
          <Text color={theme.dim}>{line.text.slice(last)}</Text>
        </Text>
      );
    }
  }
  const color =
    line.style === "user" || line.style === "answer"
      ? theme.white
      : line.style === "command"
        ? theme.purple
        : line.style === "result"
          ? theme.gray
          : line.style === "meta" || line.style === "note" || line.style === "cardEdge"
            ? theme.dim
            : theme.gray;
  return (
    <Text wrap="truncate-end" color={color}>
      {line.text}
    </Text>
  );
}
