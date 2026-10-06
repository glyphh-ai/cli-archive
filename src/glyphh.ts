/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * glyphh.ts — the TUI's single seam onto @glyphh/sdk. Builds a client bound to
 * THE MACHINE'S session — the same file the desktop keeps (~/.glyphh/.session,
 * one per server), so a CLI the desktop opens in its terminal, or the web opens
 * on it over the relay, is signed in the moment the desktop is (his order,
 * 2026-10-07: it must not ask to sign in again). A CLI that signed in before
 * this rule (session.json) is read once and carried over. Loads who-am-I and
 * hands the client to the loop. Every capability the TUI shows is an SDK call.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createClient, type Client, type Identity, type StoredSession, type TokenStore } from "@glyphh/sdk";
import { FileTokenStore } from "@glyphh/sdk/storage/file";

export interface Account {
  userId: string;
  email: string;
  name: string | null;
  tier: string;
}

function glyphhHome(): string {
  return process.env.GLYPHH_HOME ?? join(homedir(), ".glyphh");
}

/** Server URL: env override (the desktop sets it when it launches us), else
 *  the CLI profile, else the public control plane. */
export function serverUrl(): string {
  if (process.env.GLYPHH_SERVER_URL) return process.env.GLYPHH_SERVER_URL;
  try {
    const cfg = JSON.parse(readFileSync(join(glyphhHome(), "config.json"), "utf8")) as { server?: string };
    if (cfg.server) return cfg.server;
  } catch {
    /* no profile yet */
  }
  return "https://api.glyphh.ai";
}

const DEFAULT_SERVER_URL = "https://api.glyphh.ai";

/** THE DESKTOP'S SESSION FILE, by the desktop's own rule (app/src/main/
 *  glyphh-client.ts): `.session` for the public control plane, `.session.<host>`
 *  for any other server, so a dev build on a child never overwrites the
 *  installed app's tokens. */
export function sessionFileOf(home: string, server: string): string {
  if (server === DEFAULT_SERVER_URL) return join(home, ".session");
  const host = server.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/[^a-z0-9.-]+/gi, "_");
  return join(home, `.session.${host}`);
}

/** The machine's one session: the desktop's file, read and written; the CLI's
 *  old `session.json` is read when the desktop's file is absent (a CLI signed
 *  in before this rule) and the next save lands in the shared file. */
export class SharedSessionStore implements TokenStore {
  private readonly shared: FileTokenStore;
  private readonly legacy: FileTokenStore;
  constructor(sharedFile: string, legacyFile: string) {
    this.shared = new FileTokenStore(sharedFile);
    this.legacy = new FileTokenStore(legacyFile);
  }
  async load(): Promise<StoredSession | null> {
    return (await this.shared.load()) ?? (await this.legacy.load());
  }
  async save(session: StoredSession): Promise<void> {
    await this.shared.save(session);
    await this.legacy.clear();
  }
  async clear(): Promise<void> {
    await this.shared.clear();
    await this.legacy.clear();
  }
}

/** A client on the machine's session. `onSignedOut` fires when the refresh
 *  chain dies (expired/revoked) — the TUI drops to the login gate. */
export function makeClient(opts: { onSignedOut?: () => void } = {}): Client {
  return createClient({
    url: serverUrl(),
    tokenStore: new SharedSessionStore(sessionFileOf(glyphhHome(), serverUrl()), join(glyphhHome(), "session.json")),
    ...(opts.onSignedOut ? { onSignedOut: opts.onSignedOut } : {}),
  });
}

/** Load the signed-in account, or null if signed out. */
export async function loadAccount(client: Client): Promise<Account | null> {
  let identity: Identity;
  try {
    identity = await client.me();
  } catch {
    return null;
  }
  return { userId: identity.userId, email: identity.email, name: identity.name, tier: identity.tier };
}
