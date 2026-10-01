/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * This machine as an Ada device: registered once with the member's org, then
 * announced in every hello with a records-only handler table.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const home = mkdtempSync(join(tmpdir(), "glyphh-ada-"));
process.env.GLYPHH_HOME = home;
const ada = await import("../src/ada.js");

function client(): { client: never; registered: string[] } {
  const registered: string[] = [];
  const c = { ada: { registerDevice: async (name: string) => { registered.push(name); return { device_id: "dev_0123456789ab", name }; } } };
  return { client: c as never, registered };
}

describe("the Ada device", () => {
  it("is not a device until registered, and hosting says so", async () => {
    expect(ada.adaDevice()).toBeNull();
    expect(await ada.adaHandlers()).toEqual({});
    await expect(ada.hostAda({ client: client().client, server: "https://s", version: "1" })).rejects.toThrow("glyphh ada register");
  });

  it("registers once, keeps the id beside the desktop's, and hosts only records", async () => {
    const c = client();
    const dev = await ada.registerAdaDevice(c.client, "pat-laptop");
    expect(dev).toEqual({ device_id: "dev_0123456789ab", name: "pat-laptop" });
    expect(JSON.parse(readFileSync(join(home, "ada-device.json"), "utf8")).device_id).toBe("dev_0123456789ab");
    await ada.registerAdaDevice(c.client, "again");
    expect(c.registered).toEqual(["pat-laptop"]);

    const opened: Array<Record<string, unknown>> = [];
    const start = ((opts: Record<string, unknown>) => { opened.push(opts); return { stop: () => undefined }; }) as never;
    await ada.hostAda({ client: c.client, server: "https://s", version: "1", start });
    const opts = opened[0]!;
    expect((opts.adaDevice as () => string)()).toBe("dev_0123456789ab");
    expect(Object.keys(opts.handlers as object).sort()).toEqual(["ada.append", "ada.delete", "ada.drop", "ada.page", "ada.rows", "ada.update"]);
  });
});
