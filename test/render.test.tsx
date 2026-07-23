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
import { Header } from "../src/components/Header.js";
import { InputBar } from "../src/components/InputBar.js";
import { Footer } from "../src/components/Footer.js";
import { SubFooter } from "../src/components/SubFooter.js";
import { TranscriptLine } from "../src/components/TranscriptLine.js";
import { ThemePicker } from "../src/components/ThemePicker.js";
import { theme, applyTheme, themeByName, THEMES, DEFAULT_THEME } from "../src/theme.js";
import { openBrowser } from "../src/open-browser.js";
import { CAT_ROWS } from "../src/banner.js";
import { answerLines, commandLines, sectionLines, userLines } from "../src/lines.js";
import type { ChatTurn, TurnStep } from "../src/types.js";

const account = { email: "chris@glyphh.ai", name: "Chris", tier: "pro", credits: 812 };
const notes = ["Full-screen chat TUI", "Slash commands: /login /status"];

describe("TUI layout", () => {
  it("header: version in the outline, cat, stacked account, and What's new panel", () => {
    // 120 cols → the 1/4 left panel (~30) fits the account lines without truncation.
    const { lastFrame } = render(
      <Header width={120} version="v1.0.0" account={account} notes={notes} server="https://api.glyphh.ai" cwd="~/development/yo" />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Glyphh v1.0.0"); // version in the border
    expect(frame).toContain("┌─"); // the hand-drawn outline
    expect(frame).toContain(CAT_ROWS[1]!.trim().slice(0, 2)); // some cat braille rendered
    expect(frame).toContain("Chris");
    expect(frame).toContain("Pro"); // plan, title-cased
    expect(frame).toContain("812 credits");
    expect(frame).toContain("~/development/yo"); // cwd under the account
    expect(frame).toContain("What's new"); // right panel header
    expect(frame).toContain("Full-screen chat TUI"); // a release note
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
        permissionMode="auto"
        loop="default"
        slots={[{ label: "default", model: "claude-sonnet-5" }]}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("auto-approve"); // permission (far left)
    expect(frame).toContain("claude-sonnet-5"); // resolved model slot
    expect(frame).toContain("loop default"); // loop (far right)
    // Order: permission before model before loop.
    expect(frame.indexOf("auto-approve")).toBeLessThan(frame.indexOf("claude-sonnet-5"));
    expect(frame.indexOf("claude-sonnet-5")).toBeLessThan(frame.indexOf("loop default"));
  });

  it("footer labels each slot when a loop declares more than one", () => {
    const { lastFrame } = render(
      <Footer
        width={100}
        permissionMode="ask"
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

  it("TranscriptLine renders a selected head inverted and a detail with its gutter", () => {
    const sel = render(<TranscriptLine line={{ text: "▸ step", style: "headSel" }} />).lastFrame()!;
    expect(sel).toContain("▸ step");
    const detail = render(<TranscriptLine line={{ text: "  │ → a.ts", style: "detail" }} />).lastFrame()!;
    expect(detail).toContain("│ → a.ts");
  });
});

describe("status strip", () => {
  it("a settled turn shows the verb, duration, tokens and credits", () => {
    const last: ChatTurn = {
      id: "t1", text: "done", status: "done", durationMs: 2300,
      tokensUp: 120, tokensDown: 480, credits: 3, stubbed: false, degraded: false,
    };
    const frame = render(
      <SubFooter width={80} busy={false} elapsed={0} last={last} verb={{ ing: "Brewing", past: "Brewed" }} />,
    ).lastFrame()!;
    expect(frame).toContain("Brewed for 2.3s");
    expect(frame).toContain("120↑ 480↓ tok");
    expect(frame).toContain("◈ 3 credits");
  });

  it("a stubbed turn warns that no model is bound", () => {
    const last: ChatTurn = {
      id: "t1", text: "", status: "done", durationMs: 100,
      tokensUp: 0, tokensDown: 0, credits: null, stubbed: true, degraded: false,
    };
    const frame = render(
      <SubFooter width={100} busy={false} elapsed={0} last={last} verb={{ ing: "Brewing", past: "Brewed" }} />,
    ).lastFrame()!;
    expect(frame).toContain("stub answered");
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
