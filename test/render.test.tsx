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
import { Chat } from "../src/components/Chat.js";
import { CAT_ROWS } from "../src/banner.js";
import type { ChatMessage } from "../src/types.js";

const account = { email: "chris@glyphh.ai", name: "Chris", tier: "pro", credits: 812 };

describe("TUI layout", () => {
  it("header carries the version in the outline + the cat + account + release", () => {
    const { lastFrame } = render(
      <Header width={80} version="v1.0.0" account={account} release="v1.0.0 — chat TUI" server="https://api.glyphh.ai" />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Glyphh v1.0.0"); // version in the border
    expect(frame).toContain("┌─"); // the hand-drawn outline
    expect(frame).toContain(CAT_ROWS[0]!.trim().slice(0, 2)); // some cat braille rendered
    expect(frame).toContain("Chris");
    expect(frame).toContain("Pro"); // plan, title-cased
    expect(frame).toContain("812 credits");
    expect(frame).toContain("chat TUI"); // release note
    expect(frame).toContain("api.glyphh.ai");
  });

  it("input bar shows the typed text and a Send button", () => {
    const { lastFrame } = render(<InputBar width={60} value="hello there" busy={false} />);
    const frame = lastFrame()!;
    expect(frame).toContain("hello there");
    expect(frame).toContain("Send");
    expect(frame).toContain("›");
  });

  it("footer shows permission mode (left) and rotor (right)", () => {
    const { lastFrame } = render(<Footer width={60} permissionMode="auto" rotor="glyphh-coder" />);
    const frame = lastFrame()!;
    expect(frame).toContain("auto-approve");
    expect(frame).toContain("rotor");
    expect(frame).toContain("glyphh-coder");
  });

  it("chat renders the streaming meta (duration + credits)", () => {
    const messages: ChatMessage[] = [
      { id: "1", role: "user", text: "hi" },
      {
        id: "2",
        role: "assistant",
        text: "hello!",
        meta: { status: "done", credits: 3, durationMs: 2300 },
      },
    ];
    const { lastFrame } = render(<Chat messages={messages} height={12} />);
    const frame = lastFrame()!;
    expect(frame).toContain("you");
    expect(frame).toContain("glyphh");
    expect(frame).toContain("hello!");
    expect(frame).toContain("2.3s");
    expect(frame).toContain("3 credits");
  });

  it("chat shows an empty-state hint", () => {
    const { lastFrame } = render(<Chat messages={[]} height={12} />);
    expect(lastFrame()!).toContain("Ask Glyphh anything.");
  });
});
