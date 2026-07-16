/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * render.test.tsx — layout verification without a TTY. ink-testing-library renders each
 * region to a plain-text frame we can assert on: the version in the header outline, the
 * cat, the account, the streaming meta, the Send button, the permission mode, the rotor.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../src/components/Header.js";
import { InputBar } from "../src/components/InputBar.js";
import { Footer } from "../src/components/Footer.js";
import { Message } from "../src/components/Message.js";
import { CAT_ROWS } from "../src/banner.js";
import type { ChatMessage } from "../src/types.js";

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

  it("footer shows permission mode, base model, and rotor with config status", () => {
    const { lastFrame } = render(
      <Footer width={80} permissionMode="auto" model="claude-sonnet-5" configured rotor="base" />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("auto-approve"); // permission (left)
    expect(frame).toContain("model claude-sonnet-5"); // base model
    expect(frame).toContain("✓"); // configured
    expect(frame).toContain("rotor base"); // rotor (right)
  });

  it("message: user input bar, answer bullet, and the duration + credits meta", () => {
    const user: ChatMessage = { id: "1", role: "user", text: "hi" };
    const answer: ChatMessage = { id: "2", role: "assistant", text: "hello!", meta: { status: "done", credits: 3, durationMs: 2300 } };
    expect(render(<Message message={user} />).lastFrame()!).toContain("▌ hi");
    const frame = render(<Message message={answer} />).lastFrame()!;
    expect(frame).toContain("● hello!"); // assistant bullet
    expect(frame).toContain("2.3s"); // duration
    expect(frame).toContain("3 credits");
  });

  it("message: a slash command shows its └ result", () => {
    const cmd: ChatMessage = {
      id: "1",
      role: "command",
      text: "/login chris@glyphh.ai",
      result: ["Login successful", "signed in as chris@glyphh.ai"],
    };
    const frame = render(<Message message={cmd} />).lastFrame()!;
    expect(frame).toContain("/login chris@glyphh.ai");
    expect(frame).toContain("└ Login successful");
    expect(frame).toContain("signed in as chris@glyphh.ai");
  });
});
