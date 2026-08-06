/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * mcp-grant.ts — the CLI's ticket to the server's GOVERNED TOOL SURFACE
 * (`/mcp`: platform tools, the user's connections, the attached desktop's
 * reach). The endpoint speaks OAuth 2.1, so the CLI mints an `gy_mt_` grant
 * headlessly with the user's session — register → consent → code → exchange,
 * PKCE throughout. The redirect is never followed: the consent response hands
 * the code back in JSON.
 *
 * ONE grant per process per server, cached — and dropped by {@link resetMcpGrant}
 * when the session dies or rotates, because a grant outlives nothing.
 *
 * Both turn engines use it: the embedded loop wires it into its own `query()`,
 * and the harness path LENDS it to the pod as an HTTP MCP server so a run on
 * the local pod reaches exactly the same tools.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Client } from "@glyphh/sdk";

let grantCache: { server: string; token: string } | null = null;

/** The `/mcp` bearer for `server`, minted once per process and cached. */
export async function mintMcpGrant(client: Client, server: string): Promise<string> {
  if (grantCache?.server === server) return grantCache.token;
  const base = server.replace(/\/+$/, "");
  const redirect = "http://127.0.0.1:1/callback"; // never followed — the code comes back in JSON
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const reg = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Glyphh CLI", redirect_uris: [redirect] }),
  }).then((r) => r.json() as Promise<{ client_id: string }>);

  const consent = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await client.token()}` },
    body: JSON.stringify({
      client_id: reg.client_id,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
    }),
  }).then((r) => r.json() as Promise<{ data?: { redirectTo?: string } }>);
  const redirectTo = consent.data?.redirectTo;
  const code = redirectTo ? new URL(redirectTo).searchParams.get("code") : null;
  if (!code) throw new Error("mcp grant: consent returned no code");

  const tok = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: reg.client_id,
      code_verifier: verifier,
    }),
  }).then((r) => r.json() as Promise<{ access_token?: string }>);
  if (!tok.access_token) throw new Error("mcp grant: token exchange failed");

  grantCache = { server, token: tok.access_token };
  return tok.access_token;
}

/** Drop the cached grant (call when the session dies / rotates). */
export function resetMcpGrant(): void {
  grantCache = null;
}
