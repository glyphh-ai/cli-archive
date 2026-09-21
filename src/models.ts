/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * models.ts — WHICH MODEL A TURN RUNS ON. The Glyphh loop takes any chat model
 * the org runs on the gateway: the list is the server's own answer for this
 * member (`models.available`), and the default is the org's — the model an
 * admin set for turns that picked none, else the org's router under Auto only.
 * Never an arbitrary first model (his rule, 2026-09-20).
 */

import type { Client } from "@glyphh/sdk";

export interface ModelChoice {
  /** The name the gateway serves it under — what a turn sends. */
  id: string;
  /** The catalog's display name. */
  name: string;
}

interface AvailableRow { id?: string; name?: string; modality?: string; autoRouter?: boolean }
interface Gates { gatewayAllowed?: boolean; defaultModel?: string }

/** The chat models this member may ask for. */
export async function availableModels(client: Client): Promise<ModelChoice[]> {
  const rows = (await client.models.available().catch(() => [])) as unknown as AvailableRow[];
  return rows
    .filter((m) => !m.modality || m.modality === "chat")
    .map((m) => ({ id: String(m.name ?? m.id ?? ""), name: String(m.name ?? m.id ?? "") }))
    .filter((m) => m.id);
}

/** The org's default: its set default when allowed, else its router, else "". */
export async function defaultModel(client: Client): Promise<string> {
  const [gates, rows] = await Promise.all([
    client.plans.gates().catch(() => ({})) as Promise<Gates>,
    (client.models.available().catch(() => []) as unknown) as Promise<AvailableRow[]>,
  ]);
  const chat = rows.filter((m) => !m.modality || m.modality === "chat");
  const orgDefault = String(gates.defaultModel ?? "").trim();
  if (orgDefault && chat.some((m) => m.name === orgDefault)) return orgDefault;
  return chat.find((m) => m.autoRouter)?.name ?? "";
}
