/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * ada.ts — THIS MACHINE AS AN ADA DEVICE (his order, 2026-10-01). An org's
 * "local" Ada model keeps its records on a registered device; the server runs
 * the kernel and reads them over the attach relay. This machine holds those
 * records and nothing else: no kernel, no model config.
 *
 *   glyphh ada register [name]   register this machine (the signed-in member's)
 *   glyphh ada host              attach and serve its models' records, nothing more
 *
 * The device id and the record store sit beside the desktop's, in ~/.glyphh,
 * so the CLI and the desktop are the same device on one machine. With remote
 * control on, the same ada.* handlers ride its socket.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Client } from "@glyphh/sdk";
import { openAdaStore, startAttachHost, type AttachHandler, type AttachHost } from "@glyphh/sdk/runtime";

const HOME = process.env.GLYPHH_HOME || join(homedir(), ".glyphh");
export const DEVICE_FILE = join(HOME, "ada-device.json");
export const RECORDS_FILE = join(HOME, "ada-records.db");

export interface AdaDevice { device_id: string; name: string }

export function adaDevice(file = DEVICE_FILE): AdaDevice | null {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as Partial<AdaDevice>;
    return typeof d.device_id === "string" && /^dev_[0-9a-f]{12}$/.test(d.device_id) ? { device_id: d.device_id, name: String(d.name ?? "") } : null;
  } catch {
    return null;
  }
}

/** Register this machine with the signed-in member's org; kept for the next start. */
export async function registerAdaDevice(client: Client, name = hostname(), file = DEVICE_FILE): Promise<AdaDevice> {
  const existing = adaDevice(file);
  if (existing) return existing;
  const dev = await client.ada.registerDevice(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(dev, null, 2), { mode: 0o600 });
  return dev;
}

/** The ada.* handlers over this machine's record store, or none when it is not a device. */
export async function adaHandlers(file = RECORDS_FILE): Promise<Record<string, AttachHandler>> {
  if (!adaDevice()) return {};
  mkdirSync(dirname(file), { recursive: true });
  return openAdaStore(file);
}

/** `glyphh ada host`: attach as this device and serve its records until stopped. */
export async function hostAda(opts: { client: Client; server: string; version: string; start?: typeof startAttachHost }): Promise<AttachHost> {
  const dev = adaDevice();
  if (!dev) throw new Error("this machine is not an Ada device yet: run `glyphh ada register`");
  const handlers = await adaHandlers();
  return (opts.start ?? startAttachHost)({
    client: opts.client,
    server: opts.server,
    app: "glyphh-cli",
    version: opts.version,
    name: dev.name || hostname(),
    handlers,
    adaDevice: () => dev.device_id,
  });
}

export function adaDeviceExists(): boolean {
  return existsSync(DEVICE_FILE) && adaDevice() !== null;
}
