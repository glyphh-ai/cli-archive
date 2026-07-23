/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * glyphh.ts — the TUI's single seam onto @glyphh/client. Builds a client bound to the
 * SAME on-disk session the `glyphh` CLI uses (~/.glyphh/session.json), loads who-am-I,
 * and opens a loop session to stream turns. Every capability the TUI shows is an SDK
 * call — the TUI is a thin view, never its own API client.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createClient, staticTokenProvider, type Client, type Identity } from "@glyphh/client";
import { FileTokenStore } from "@glyphh/client/storage/file";

export interface Account {
  email: string;
  name: string | null;
  tier: string;
  credits: number | null;
}

function glyphhHome(): string {
  return process.env.GLYPHH_HOME ?? join(homedir(), ".glyphh");
}

/** Server URL: env override, else the CLI profile, else the public control plane. */
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

/** Load the signed-in account (identity + credit balance), or null if signed out. */
export async function loadAccount(client: Client): Promise<Account | null> {
  let identity: Identity;
  try {
    identity = await client.me();
  } catch {
    return null;
  }
  let credits: number | null = null;
  try {
    credits = (await client.billing.balance()).credits;
  } catch {
    /* balance is best-effort chrome */
  }
  return { email: identity.email, name: identity.name, tier: identity.tier, credits };
}

export { staticTokenProvider };
