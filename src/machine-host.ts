/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * machine-host.ts — the CLI as a MACHINE HOST. On machines with no desktop app
 * (headless boxes, SSH sessions, servers), the CLI attaches the same outbound
 * socket the desktop does and offers the SDK's machine-reach layer — so the
 * agent (from any surface) can list + launch this machine's native apps
 * through the server's governed desktop tools.
 *
 * The desktop remains the richer host (panels, layouts, RPA); the server
 * dispatches to the most-recently-attached machine, so a running desktop
 * naturally takes precedence over this host when both are up.
 */

import type { Client } from "@glyphh/client";
import { startAttachHost, type AttachHost } from "@glyphh/client/runtime";
import { listInstalledApps, findInstalledApp, launchInstalledApp, openUrl } from "@glyphh/client/machine";

let host: AttachHost | null = null;

/** Start (or restart) the machine host — call once signed in. */
export function startMachineHost(client: Client, server: string, version: string): void {
  stopMachineHost();
  host = startAttachHost({
    client,
    server,
    app: "glyphh-cli",
    version,
    handlers: {
      "machine.appsList": async () => ({ apps: listInstalledApps().map((a) => a.name) }),
      "machine.appOpen": async (params) => {
        const ref = String((params as Record<string, unknown> | null)?.app ?? "");
        if (!ref) throw new Error("machine.appOpen requires { app }");
        const app = findInstalledApp(ref);
        if (!app) throw new Error(`no installed app matches '${ref}'`);
        launchInstalledApp(app);
        return { opened: app.name };
      },
      "machine.openUrl": async (params) => {
        const url = String((params as Record<string, unknown> | null)?.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new Error("machine.openUrl requires an http(s) { url }");
        return { opened: openUrl(url) };
      },
    },
  });
}

/** Tear down the machine host — call on sign-out / auth loss. Idempotent. */
export function stopMachineHost(): void {
  host?.stop();
  host = null;
}
