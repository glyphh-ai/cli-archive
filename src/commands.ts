/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * commands.ts — the TUI's slash commands. A leading `/` routes here instead of to the
 * rotor. Each command runs against the SDK (never its own API) and returns the lines to
 * show as a `└ …` result under the typed command. Kept small; the full `glyphh` CLI
 * remains the exhaustive surface — these are the in-chat conveniences.
 */

import type { Client } from "@glyphh/client";
import { loadAccount, type Account } from "./glyphh.js";

export interface CommandCtx {
  client: Client;
  account: Account | null;
  rotor: string;
  version: string;
  server: string;
  setAccount: (a: Account | null) => void;
  setRotor: (r: string) => void;
  clearChat: () => void;
  quit: () => void;
  /** Update the running command's `└ …` lines mid-flight (e.g. the login code + URL). */
  emit: (lines: string[]) => void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string;
  run: (ctx: CommandCtx, args: string[]) => Promise<string[]> | string[];
}

function planLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

const COMMANDS: SlashCommand[] = [
  {
    name: "login",
    aliases: ["auth", "signin"],
    summary: "sign in from this terminal (approve in a browser)",
    async run(ctx) {
      // Device authorization grant: show a code + URL, then poll until approved.
      ctx.emit(["starting device login…"]);
      await ctx.client.auth.deviceLogin({
        onPrompt: (p) =>
          ctx.emit([`open  ${p.verificationUri}`, `enter code  ${p.userCode}`, "waiting for approval…"]),
      });
      const account = await loadAccount(ctx.client);
      ctx.setAccount(account);
      return ["Login successful", account ? `signed in as ${account.email}` : ""];
    },
  },
  {
    name: "logout",
    aliases: ["signout"],
    summary: "sign out and clear the local session",
    async run(ctx) {
      try {
        await ctx.client.auth.signOut();
      } catch {
        /* best-effort */
      }
      ctx.setAccount(null);
      return ["Signed out"];
    },
  },
  {
    name: "status",
    aliases: ["whoami"],
    summary: "show the signed-in account, plan, and server",
    async run(ctx) {
      if (!ctx.account) return ["Not signed in · run /login <email>"];
      const a = ctx.account;
      return [
        `signed in as ${a.email}`,
        `plan ${planLabel(a.tier)}${a.credits !== null ? ` · ${a.credits} credits` : ""}`,
        `rotor ${ctx.rotor}  ·  ${ctx.server.replace(/^https?:\/\//, "")}`,
      ];
    },
  },
  {
    name: "rotor",
    summary: "show or switch the selected rotor",
    usage: "/rotor [name]",
    run(ctx, args) {
      const name = args[0];
      if (!name) return [`current rotor: ${ctx.rotor}`];
      ctx.setRotor(name);
      return [`rotor set to ${name}`];
    },
  },
  {
    name: "clear",
    summary: "clear the transcript",
    run(ctx) {
      ctx.clearChat();
      return [];
    },
  },
  {
    name: "release-notes",
    aliases: ["releasenotes", "whatsnew"],
    summary: "show the latest release notes",
    run() {
      return RELEASE_NOTES;
    },
  },
  {
    name: "help",
    aliases: ["?"],
    summary: "list the slash commands",
    run() {
      return COMMANDS.map((c) => `/${c.name}${c.usage ? c.usage.slice(c.name.length + 1) : ""} — ${c.summary}`);
    },
  },
  {
    name: "quit",
    aliases: ["exit"],
    summary: "leave the TUI",
    run(ctx) {
      ctx.quit();
      return ["bye"];
    },
  },
];

/** The "What's new" panel copy (also shown by `/release-notes`). */
export const RELEASE_NOTES: string[] = [
  "Full-screen chat TUI over @glyphh/client",
  "Per-turn credits + duration on every answer",
  "Slash commands: /login /status /rotor /help",
  "Shift+Tab cycles the permission mode",
];

const BY_NAME = new Map<string, SlashCommand>();
for (const c of COMMANDS) {
  BY_NAME.set(c.name, c);
  for (const a of c.aliases ?? []) BY_NAME.set(a, c);
}

/** Parse + run a `/command args` line. Returns the result lines (or an error line). */
export async function runSlash(ctx: CommandCtx, line: string): Promise<string[]> {
  const [head, ...rest] = line.replace(/^\//, "").trim().split(/\s+/);
  const cmd = head ? BY_NAME.get(head.toLowerCase()) : undefined;
  if (!cmd) return [`unknown command: /${head ?? ""} — try /help`];
  try {
    return await cmd.run(ctx, rest);
  } catch (err) {
    return [`/${cmd.name} failed: ${(err as Error).message}`];
  }
}

export const SLASH_NAMES = COMMANDS.map((c) => c.name);
