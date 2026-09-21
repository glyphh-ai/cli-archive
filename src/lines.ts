/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * lines.ts — the transcript LINE MODEL (ported from rrotor's TUI). The viewport
 * owns scrolling, so every item flattens to styled lines: slicing a window of
 * lines is exact (no layout estimation), scrolling is array math, and ctrl+o
 * re-expansion is retroactive by construction — lines regenerate from items
 * every render.
 */

import type { TurnStep } from "./types.js";

export type LineStyle =
  | "logo"
  | "user"
  | "command"
  | "result"
  | "head"
  | "headErr"
  | "detail"
  | "hint"
  | "answer"
  | "meta"
  | "note"
  | "blank"
  | "cardEdge"
  | "cardTitle"
  | "cardBody";

export interface Line {
  text: string;
  style: LineStyle;
}

const COLLAPSED_LINES = 3;

/** Greedy word-wrap into `width` columns with a hanging indent. */
export function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    for (const word of raw.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if ([...candidate].length > width && line) {
        out.push(out.length === 0 ? line : indent + line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(out.length === 0 ? line : indent + line);
  }
  return out;
}

/** Typed input leads with the Glyphh purple bar `▌`. */
export function userLines(text: string, width: number): Line[] {
  const wrapped = wrap(`▌ ${text}`, width, "  ");
  return [{ text: "", style: "blank" }, ...wrapped.map((t) => ({ text: t, style: "user" as const }))];
}

/** A slash command + its `└ …` result lines (mutable mid-flight via patch). */
export function commandLines(text: string, result: string[] | undefined, width: number): Line[] {
  const out: Line[] = [{ text: "", style: "blank" }];
  for (const t of wrap(`▌ ${text}`, width, "  ")) out.push({ text: t, style: "command" });
  const results = (result ?? []).filter(Boolean);
  results.forEach((line, i) => {
    for (const w of wrap((i === 0 ? "  └ " : "    ") + line, width, "      ")) {
      out.push({ text: w, style: "result" });
    }
  });
  return out;
}

export function answerLines(text: string, width: number): Line[] {
  const wrapped = wrap(`● ${text}`, width - 2, "  ");
  return [
    { text: "", style: "blank" },
    ...wrapped.map((t) => ({ text: `  ${t}`, style: "answer" as const })),
  ];
}

/** The settle line under a finished turn: `* Verbed for 3.1s · ◈ $0.0120`. */
export function metaLines(text: string): Line[] {
  return [{ text: `  ${text}`, style: "meta" }];
}

export function sectionLines(step: TurnStep, expanded: boolean): Line[] {
  const meta: string[] = [];
  if (step.secs !== undefined) meta.push(`${step.secs.toFixed(1)}s`);
  if (step.tokens) meta.push(`${step.tokens.up}↑ ${step.tokens.down}↓`);
  if (step.error) meta.push(step.error);
  // Fold glyph: only sections with more to show get an affordance.
  const foldable = step.details.length > COLLAPSED_LINES;
  const fold = foldable ? (expanded ? "▾ " : "▸ ") : "⏺ ";
  const head = `${fold}${step.label}${meta.length ? ` · ${meta.join(" · ")}` : ""}`;
  const lines: Line[] = [{ text: head, style: step.ok ? "head" : "headErr" }];
  const body = expanded ? step.details : step.details.slice(0, COLLAPSED_LINES);
  for (const d of body) lines.push({ text: `  │ ${d}`, style: "detail" });
  const hidden = step.details.length - body.length;
  if (hidden > 0) lines.push({ text: `  │ … +${hidden} lines (ctrl+o to expand)`, style: "hint" });
  return lines;
}

export function noteLines(text: string): Line[] {
  return [{ text: `  ${text}`, style: "note" }];
}

/** A boxed card: `╭─ Title ─…─╮` edge, body rows, closing edge. The title row
 *  carries the accent; body rows wrap to the card's inner width. */

// ── The launch banner as SCROLLABLE lines ────────────────────────────────────
// The logo (banner.ts) leads, then ONE identity card: who, where, what runs the
// next turn, and what is new. As transcript lines it scrolls away naturally,
// and the logo renders only at a width that holds it intact.

export interface HeaderInfo {
  version: string;
  name: string | null;
  plan: string | null;
  email: string | null;
  cwd: string;
  /** The model the next turn runs on (null while unresolved). */
  model: string | null;
  /** The control plane, host only. */
  server: string;
  notes: string[];
}

/** Box + quadrant glyphs are single-width, so code-point length IS columns. */
const clen = (s: string): number => [...s].length;
const padCell = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - clen(s)));
const clipEnd = (s: string, w: number): string =>
  clen(s) <= w ? s : [...s].slice(0, Math.max(0, w - 1)).join("") + "…";
const clipStart = (s: string, w: number): string =>
  clen(s) <= w ? s : "…" + [...s].slice(clen(s) - (w - 1)).join("");

export function headerLines(width: number, logo: readonly string[], info: HeaderInfo): Line[] {
  const w = Math.max(30, Math.min(width, 100));
  const inner = w - 2;
  const out: Line[] = [];
  if (logo.length) {
    out.push({ text: "", style: "blank" });
    for (const row of logo) out.push({ text: `  ${row}`, style: "logo" });
    out.push({ text: "", style: "blank" });
  }
  const label = `Glyphh ${info.version}`;
  out.push({
    text: `┌─ ${clipEnd(label, inner - 5)} ${"─".repeat(Math.max(0, inner - clen(label) - 5))}─┐`,
    style: "cardTitle",
  });
  const row = (text: string): void => { out.push({ text: `│${padCell(clipEnd(text, inner), inner)}│`, style: "cardBody" }); };
  const who = info.name
    ? [` ${[info.name, info.plan ?? "", info.email ?? ""].filter(Boolean).join(" · ")}`]
    : [" not signed in · /login to sign in"];
  for (const t of who) row(t);
  row(` ${clipStart(info.cwd, inner - 2)}`);
  row(` model ${info.model ?? "the org's default"} · ${info.server}`);
  if (info.notes.length) {
    row("");
    row(" What's new");
    for (const t of info.notes) row(`   ${t}`);
  }
  row("");
  row(" /help for commands · ? shortcuts · shift+tab permissions");
  out.push({ text: `└${"─".repeat(inner)}┘`, style: "cardEdge" });
  out.push({ text: "", style: "blank" });
  return out;
}

export function cardLines(title: string, body: string[], width: number): Line[] {
  const inner = Math.max(20, Math.min(width, 100)) - 4;
  const top = `╭─ ${title} ${"─".repeat(Math.max(0, inner - title.length - 2))}╮`;
  const lines: Line[] = [{ text: "", style: "blank" }, { text: top, style: "cardTitle" }];
  for (const row of body) {
    for (const w of wrap(row, inner, "  ")) {
      lines.push({ text: `│ ${w}${" ".repeat(Math.max(0, inner - [...w].length + 1))}│`, style: "cardBody" });
    }
  }
  lines.push({ text: `╰${"─".repeat(inner + 2)}╯`, style: "cardEdge" });
  return lines;
}
