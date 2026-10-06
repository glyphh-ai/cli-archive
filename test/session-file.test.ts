/**
 * session-file.test.ts — the CLI signs in as the machine does (his order,
 * 2026-10-07): the desktop's session file, by the desktop's own naming rule;
 * a CLI that signed in before reads its old file once and moves over.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SharedSessionStore, sessionFileOf } from "../src/glyphh.js";

const session = (t: string) => ({ accessToken: t, refreshToken: `r-${t}`, expiresAt: 1 }) as unknown as Parameters<SharedSessionStore["save"]>[0];

describe("sessionFileOf — the desktop's rule", () => {
  it("the public control plane keeps the plain name; any other server gets its host", () => {
    expect(sessionFileOf("/h/.glyphh", "https://api.glyphh.ai")).toBe("/h/.glyphh/.session");
    expect(sessionFileOf("/h/.glyphh", "http://localhost:4000")).toBe("/h/.glyphh/.session.localhost_4000");
    expect(sessionFileOf("/h/.glyphh", "https://dev.glyphh.app/x")).toBe("/h/.glyphh/.session.dev.glyphh.app");
  });
});

describe("SharedSessionStore", () => {
  it("reads the desktop's session when the desktop is signed in", async () => {
    const home = mkdtempSync(join(tmpdir(), "glyphh-cli-sess-"));
    writeFileSync(join(home, ".session"), JSON.stringify(session("desk")), { mode: 0o600 });
    const store = new SharedSessionStore(join(home, ".session"), join(home, "session.json"));
    expect((await store.load())?.accessToken).toBe("desk");
  });
  it("falls back to the CLI's old file once, and the next save moves it over", async () => {
    const home = mkdtempSync(join(tmpdir(), "glyphh-cli-sess-"));
    writeFileSync(join(home, "session.json"), JSON.stringify(session("old")), { mode: 0o600 });
    const store = new SharedSessionStore(join(home, ".session"), join(home, "session.json"));
    expect((await store.load())?.accessToken).toBe("old");
    await store.save(session("fresh"));
    expect(JSON.parse(readFileSync(join(home, ".session"), "utf8")).accessToken).toBe("fresh");
    expect(existsSync(join(home, "session.json"))).toBe(false);
    expect((await store.load())?.accessToken).toBe("fresh");
  });
  it("clear signs the machine out of both files; nothing signed in reads null", async () => {
    const home = mkdtempSync(join(tmpdir(), "glyphh-cli-sess-"));
    const store = new SharedSessionStore(join(home, ".session"), join(home, "session.json"));
    expect(await store.load()).toBeNull();
    await store.save(session("x"));
    await store.clear();
    expect(await store.load()).toBeNull();
    expect(existsSync(join(home, ".session"))).toBe(false);
  });
});
