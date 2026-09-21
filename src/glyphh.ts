/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * glyphh.ts — the TUI's single seam onto @glyphh/sdk. Builds a client bound to the
 * CLI's OWN on-disk session (~/.glyphh/session.json — the desktop keeps its own;
 * a 15-minute access token with a rotating refresh is not something two
 * processes can share), loads who-am-I, and hands the client to the loop.
 * Every capability the TUI shows is an SDK call — the TUI is a thin view.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createClient, type Client, type Identity } from "@glyphh/sdk";
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

/** A client sharing the CLI's persisted session. `onSignedOut` fires when the
 *  refresh chain dies (expired/revoked) — the TUI drops to the login gate. */
export function makeClient(opts: { onSignedOut?: () => void } = {}): Client {
  return createClient({
    url: serverUrl(),
    tokenStore: new FileTokenStore(join(glyphhHome(), "session.json")),
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
