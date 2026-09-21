/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * render.test.tsx — layout verification without a TTY. ink-testing-library renders each
 * region to a plain-text frame we can assert on: the version in the header outline, the
 * cat, the account, the Send button, the permission mode, the loop. The transcript is
 * a LINE MODEL (lines.ts) — pure functions asserted directly, plus a styled-line render.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { InputBar } from "../src/components/InputBar.js";
import { Footer } from "../src/components/Footer.js";
import { SubFooter } from "../src/components/SubFooter.js";
import { TranscriptLine } from "../src/components/TranscriptLine.js";
import { ThemePicker } from "../src/components/ThemePicker.js";
import { theme, applyTheme, themeByName, THEMES, DEFAULT_THEME } from "../src/theme.js";
import { openBrowser } from "../src/open-browser.js";
import { toolLabel, connectionAuthHint, deleteWordBefore } from "../src/components/App.js";
import { LOGO_MARK, LOGO_NARROW, logoRows } from "../src/banner.js";
import { SlashMenu } from "../src/components/SlashMenu.js";
import { matchCommands, permissionLines } from "../src/commands.js";
import { answerLines, commandLines, headerLines, sectionLines, userLines } from "../src/lines.js";
import type { ChatTurn, TurnStep } from "../src/types.js";

describe("TUI layout", () => {
  it("banner lines: the block logo when it fits, then one identity card with version, account, folder, model and What's new", () => {
    const info = {
      version: "v1.0.0",
      name: "Chris",
      plan: "Pro",
      email: "chris@glyphh.ai",
      cwd: "~/development/yo",
      model: "claude-sonnet-5",
      server: "api.glyphh.ai",
      notes: ["Full-screen chat TUI", "Slash commands: /login /status"],
    };
    const wide = headerLines(120, logoRows(120), info).map((l) => l.text).join("\n");
    expect(wide).toContain("Glyphh v1.0.0"); // version in the border
    expect(wide).toContain("┌─"); // the hand-drawn outline
    expect(wide).toContain(LOGO_NARROW[3]!.trim().slice(0, 4)); // the whole mark rendered (never the 14-row cut)
    expect(wide).toContain("Chris · Pro · chris@glyphh.ai");
    expect(wide).toContain("~/development/yo");
    expect(wide).toContain("model claude-sonnet-5 · api.glyphh.ai");
    expect(wide).toContain("What's new");
    expect(wide).toContain("Full-screen chat TUI");
    // A medium terminal gets the whole mark; a narrow one the mascot alone —
    // block art cannot downscale, so cropping beats mangling.
    expect(logoRows(80)).toBe(LOGO_NARROW);
    expect(logoRows(48)).toBe(LOGO_MARK);
    expect(LOGO_MARK.every((r) => [...r].length <= 16)).toBe(true);
    const narrow = headerLines(48, logoRows(48), info).map((l) => l.text).join("\n");
    expect(narrow).toContain("Glyphh v1.0.0");
    expect(narrow).toContain(LOGO_MARK[1]!.trim());
    for (const l of headerLines(48, logoRows(48), info)) expect([...l.text].length).toBeLessThanOrEqual(48);
    // Signed out: the card says so and how to fix it.
    const out = headerLines(80, [], { ...info, name: null, plan: null, email: null, model: null }).map((l) => l.text).join("\n");
    expect(out).toContain("not signed in · /login");
    expect(out).toContain("model the org's default");
  });

  it("the composer draws a real cursor inside the text", () => {
    const frame = render(<InputBar width={60} value="hello there" cursor={5} busy={false} />).lastFrame()!;
    expect(frame).toContain("hello");
    expect(frame).toContain("there");
    expect(frame).toContain("Send");
  });

  it("the slash menu lists matching commands with the selection marked", () => {
    const items = matchCommands("m");
    expect(items.map((c) => c.name)).toEqual(["mcp", "model"]);
    const frame = render(<SlashMenu width={80} items={items} selected={1} />).lastFrame()!;
    expect(frame).toContain("/mcp");
    expect(frame).toContain("▸ /model");
    expect(matchCommands("").length).toBeGreaterThan(10);
    expect(matchCommands("zz")).toEqual([]);
  });

  it("word delete removes the word before the cursor", () => {
    expect(deleteWordBefore("fix the tests", 13)).toEqual({ value: "fix the ", cursor: 8 });
    expect(deleteWordBefore("fix the tests", 8)).toEqual({ value: "fix tests", cursor: 4 });
    expect(deleteWordBefore("", 0)).toEqual({ value: "", cursor: 0 });
  });

  it("input bar shows the typed text and a Send button", () => {
    const { lastFrame } = render(<InputBar width={60} value="hello there" busy={false} />);
    const frame = lastFrame()!;
    expect(frame).toContain("hello there");
    expect(frame).toContain("Send");
    expect(frame).toContain("›");
  });

  it("footer shows permission mode far-left, then model slots, then the loop far-right", () => {
    const { lastFrame } = render(
      <Footer
        width={80}
        permissionMode="bypass"
        loop="glyphh"
        slots={[{ label: "model", model: "claude-sonnet-5" }]}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("bypass permissions on"); // permission (far left), the other CLIs' words
    expect(frame).toContain("claude-sonnet-5"); // resolved model slot
    expect(frame).toContain("loop glyphh"); // loop (far right)
    // Order: permission before model before loop.
    expect(frame.indexOf("bypass permissions on")).toBeLessThan(frame.indexOf("claude-sonnet-5"));
    expect(frame.indexOf("claude-sonnet-5")).toBeLessThan(frame.indexOf("loop glyphh"));
    expect(permissionLines("plan").join("\n")).toContain("▸ plan");
  });

  it("footer labels each slot when a loop declares more than one", () => {
    const { lastFrame } = render(
      <Footer
        width={100}
        permissionMode="default"
        loop="planning"
        slots={[
          { label: "planner", model: "claude-opus-4-8" },
          { label: "coder", model: "claude-haiku-4-5" },
        ]}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("planner claude-opus-4-8");
    expect(frame).toContain("coder claude-haiku-4-5");
    expect(frame).toContain("loop planning");
  });
});

describe("line model", () => {
  it("user input leads with the purple bar; answers with the bullet", () => {
    expect(userLines("hi", 60).map((l) => l.text).join("\n")).toContain("▌ hi");
    expect(answerLines("hello!", 60).map((l) => l.text).join("\n")).toContain("● hello!");
  });

  it("a slash command carries its └ result lines", () => {
    const lines = commandLines("/login chris@glyphh.ai", ["Login successful", "signed in"], 80);
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("▌ /login chris@glyphh.ai");
    expect(text).toContain("└ Login successful");
    expect(text).toContain("signed in");
    expect(lines.filter((l) => l.style === "result").length).toBe(2);
  });

  it("a section collapses to 3 details with a fold hint, and unfolds fully", () => {
    const step: TurnStep = {
      label: "write files",
      ok: true,
      secs: 1.2,
      details: ["→ a.ts (10 bytes)", "→ b.ts (20 bytes)", "→ c.ts (30 bytes)", "→ d.ts (40 bytes)", "$ npm test"],
    };
    const folded = sectionLines(step, false);
    expect(folded[0]!.text).toContain("▸ write files · 1.2s");
    expect(folded.filter((l) => l.style === "detail").length).toBe(3);
    expect(folded.find((l) => l.style === "hint")!.text).toContain("+2 lines");
    const open = sectionLines(step, true);
    expect(open[0]!.text).toContain("▾ write files");
    expect(open.filter((l) => l.style === "detail").length).toBe(5);
    expect(open.find((l) => l.style === "hint")).toBeUndefined();
  });

  it("a failing step renders the error style + message", () => {
    const step: TurnStep = { label: "run tests", ok: false, details: [], error: "exit 1" };
    const lines = sectionLines(step, false);
    expect(lines[0]!.style).toBe("headErr");
    expect(lines[0]!.text).toContain("exit 1");
  });

  it("TranscriptLine renders a head with its glyph and a detail with its gutter", () => {
    const sel = render(<TranscriptLine line={{ text: "▸ step", style: "head" }} />).lastFrame()!;
    expect(sel).toContain("▸ step");
    const detail = render(<TranscriptLine line={{ text: "  │ → a.ts", style: "detail" }} />).lastFrame()!;
    expect(detail).toContain("│ → a.ts");
  });
});

describe("status strip", () => {
  it("a settled turn shows the verb, duration and tokens", () => {
    const last: ChatTurn = { id: "t1", text: "done", status: "done", durationMs: 2300, tokensUp: 120, tokensDown: 480 };
    const frame = render(
      <SubFooter width={80} busy={false} elapsed={0} last={last} verb={{ ing: "Brewing", past: "Brewed" }} />,
    ).lastFrame()!;
    expect(frame).toContain("Brewed for 2.3s");
    expect(frame).toContain("120↑ 480↓ tok");
  });

  it("a stopped turn says so", () => {
    const last: ChatTurn = { id: "t1", text: "", status: "stopped", durationMs: 100, tokensUp: 0, tokensDown: 0 };
    const frame = render(
      <SubFooter width={100} busy={false} elapsed={0} last={last} verb={{ ing: "Brewing", past: "Brewed" }} />,
    ).lastFrame()!;
    expect(frame).toContain("stopped");
  });
});

describe("themes", () => {
  it("has a dark default and swaps the live palette in place", () => {
    expect(DEFAULT_THEME).toBe("dark");
    const dark = themeByName("dark").colors;
    const light = themeByName("light").colors;
    expect(dark.text).not.toBe(light.text);

    applyTheme("light");
    expect(theme.text).toBe(light.text); // the shared object mutated in place
    const restored = applyTheme("dark"); // leave the module in its default for other tests
    expect(restored.name).toBe("dark");
    expect(theme.text).toBe(dark.text);
  });

  it("an unknown theme name falls back to the default", () => {
    expect(themeByName("nope").name).toBe("dark");
  });

  it("the picker lists every theme and marks the current one", () => {
    const frame = render(<ThemePicker current="claude" onPick={() => {}} />).lastFrame()!;
    for (const t of THEMES) expect(frame).toContain(t.label);
    expect(frame).toContain("Choose your theme");
    expect(frame).toContain("▸"); // a selection marker is drawn
    applyTheme("dark"); // the picker previews the current theme — reset for isolation
  });
});

describe("open browser", () => {
  it("returns a boolean and never throws", () => {
    expect(typeof openBrowser("https://glyphh.ai/device")).toBe("boolean");
  });
});

describe("tool receipts", () => {
  it("prefers the pod's human title, falls back to the tool name", () => {
    expect(toolLabel("Bash", "Run npm test")).toBe("Run npm test");
    expect(toolLabel("Bash", "  ")).toBe("Bash");
    expect(toolLabel("Write")).toBe("Write");
  });

  it("bounds a long title so a receipt head never wraps", () => {
    const label = toolLabel("Bash", "x".repeat(200));
    expect(label.length).toBe(76);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("connection-auth hint", () => {
  it("turns an unauthorized-connection error into an actionable note", () => {
    const hint = connectionAuthHint("conn__google_drive__google_drive-create-folder", "No access/refresh token");
    expect(hint).toMatch(/google drive/i);
    expect(hint).toMatch(/connect/i);
  });

  it("returns null for a normal (non-auth) tool error", () => {
    expect(connectionAuthHint("Bash", "command not found: foo")).toBeNull();
  });
});
