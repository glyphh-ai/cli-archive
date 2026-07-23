/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * receipts.ts — turn a step's wire OUTPUT into human receipts (ported from the
 * rrotor TUI): `→ path (N bytes)`, `→ exit 0 · PASS`, `$ command`, plan bullets.
 * Bounded on purpose — a receipt summarizes; the fold shows the rest.
 */

/** Style one body line: `→` file paths, `$` commands, `-` plan bullets. */
function styleLine(l: string): string {
  const file = /^FILE:\s*(.+)$/.exec(l);
  if (file) return `→ ${file[1]}`;
  const test = /^TEST:\s*(.+)$/.exec(l);
  if (test) return `$ ${test[1]}`;
  if (/^PLAN:\s*$/.test(l)) return "plan:";
  const num = /^\s*\d+\.\s+(.+)$/.exec(l);
  if (num) return `- ${num[1]}`;
  return l;
}

const cap = (l: string): string => (l.length > 100 ? `${l.slice(0, 99)}…` : l);

/** Facts a step's wire output contributes beneath its row (bounded), rendered
 *  as human receipts: `→ path (N bytes)`, `→ exit 0 · PASS`, `$ command`. */
export function stepDetails(output?: Record<string, unknown>): string[] {
  if (!output) return [];
  const lines: string[] = [];
  for (const key of Object.keys(output).sort()) {
    if (key === "usage") continue;
    const v = output[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o.path === "string" && o.bytes_written !== undefined) {
        lines.push(`→ ${o.path} (${o.bytes_written} bytes)`);
        continue;
      }
      if (o.exit_code !== undefined) {
        const out = typeof o.stdout === "string" ? (o.stdout.split("\n").find((x) => x.trim()) ?? "") : "";
        lines.push(cap(`→ exit ${o.exit_code}${o.timed_out ? " · timed out" : ""}${out ? ` · ${out}` : ""}`));
        const errLine = typeof o.stderr === "string" ? (o.stderr.split("\n").find((x) => x.trim()) ?? "") : "";
        if (errLine) lines.push(cap(`✗ ${errLine}`));
        continue;
      }
    }
    if (typeof v === "string" && (key === "text" || v.includes("\n") || v.length > 100)) {
      const body = v.replace(/\n+$/, "").split("\n");
      for (const l of body.slice(0, 40)) lines.push(cap(styleLine(l)));
      if (body.length > 40) lines.push(`… (+${body.length - 40} more lines)`);
      continue;
    }
    if (key === "lane_notes" && Array.isArray(v)) {
      for (const n of v as string[]) lines.push(cap(`✗ ${n}`));
      continue;
    }
    if (key === "served" && typeof v === "string") {
      lines.push(`served ${v}`);
      continue;
    }
    if (typeof v === "string" && (key === "file" || key === "path")) {
      lines.push(cap(`→ ${v}`));
      continue;
    }
    if (typeof v === "string" && (key === "test_cmd" || key === "command" || key === "cmd")) {
      lines.push(cap(`$ ${v}`));
      continue;
    }
    const img = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
    if (!img || img === "[]" || img === "{}") continue;
    lines.push(cap(`${key} ${img.length > 100 ? `${img.slice(0, 99)}…` : img}`));
  }
  return lines.slice(0, 60);
}
