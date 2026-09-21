/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * commands.ts — the slash commands. Each is a small, testable function over a
 * CommandCtx the App supplies: sign in/out, the model a turn runs on (the org's
 * gateway list), the theme, the transcript. The loop itself has no command —
 * this TUI IS the Glyphh loop; shift+tab is its permission chip.
 */

import type { Client } from "@glyphh/sdk";
import { loadAccount, type Account } from "./glyphh.js";
import { availableModels, type ModelChoice } from "./models.js";
import { openBrowser } from "./open-browser.js";
import { readPrefs } from "./prefs.js";
import { THEMES, DEFAULT_THEME } from "./theme.js";

export interface CommandCtx {
  client: Client;
  account: Account | null;
  version: string;
  server: string;
  /** The model turns run on; null = the org's default, resolved per turn. */
  model: string | null;
  setAccount: (a: Account | null) => void;
  /** Pick the model: persisted on this device, or for THIS session only. */
  setModel: (id: string | null, opts?: { session?: boolean }) => void;
  /** Apply + persist a theme by name (repaints the whole tree). */
  setTheme: (name: string) => void;
  clearChat: () => void;
  quit: () => void;
  /** Hand off to the interactive login screen (the boot flow) — same UX as first
   *  sign-in: confirm, press enter to open the browser, Google or email. */
  relogin?: () => void;
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

/** The model list as command output, the current pick marked. */
export function modelLines(models: ModelChoice[], current: string | null): string[] {
  if (!models.length) return ["no models are available to you on the gateway — an org admin allows them under Router Settings"];
  const lines = ["models your organization runs on the gateway:"];
  for (const m of models) {
    const mark = m.id === current ? "  ← current" : "";
    lines.push(`  ${m.id === m.name ? m.id : `${m.id}  (${m.name})`}${mark}`);
  }
  lines.push(current ? "pick:  /model <id>    org default:  /model default" : "pick:  /model <id>    (running on the org's default)");
  return lines;
}

const COMMANDS: SlashCommand[] = [
  {
    name: "login",
    aliases: ["auth", "signin"],
    summary: "sign in from this terminal (approve in a browser)",
    async run(ctx) {
      // Hand off to the full-screen login gate — the SAME interactive flow as first
      // sign-in: it shows the code, waits for "enter · open browser", and offers
      // Google (via the platform) or email. Falls back to an inline device grant on
      // the off chance the host didn't wire relogin.
      if (ctx.relogin) {
        ctx.relogin();
        return ["opening sign-in…"];
      }
      ctx.emit(["starting device login…"]);
      await ctx.client.auth.deviceLogin({
        onPrompt: (p) => {
          const url = p.verificationUriComplete || p.verificationUri;
          const opened = openBrowser(url);
          ctx.emit(
            opened
              ? ["browser opened — approve there to sign in", `code ${p.userCode} (if the page asks)`, "waiting for approval…"]
              : [`open  ${url}`, `enter code  ${p.userCode}`, "waiting for approval…"],
          );
        },
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
    summary: "show the signed-in account, plan, model and server",
    async run(ctx) {
      if (!ctx.account) return ["Not signed in · run /login"];
      const a = ctx.account;
      return [
        `signed in as ${a.email}`,
        `plan ${planLabel(a.tier)}`,
        `model ${ctx.model ?? "the org's default"}  ·  ${ctx.server.replace(/^https?:\/\//, "")}`,
      ];
    },
  },
  {
    name: "model",
    aliases: ["models"],
    summary: "list the gateway's models, or pick one for this device: /model <id> (or default)",
    usage: "/model [id|default]",
    async run(ctx, args) {
      const models = await availableModels(ctx.client);
      const pick = args[0];
      if (!pick) return modelLines(models, ctx.model);
      if (pick === "default") {
        ctx.setModel(null);
        return ["model → the org's default"];
      }
      if (models.length && !models.some((m) => m.id === pick)) return [`${pick} is not a model your organization runs on the gateway — /model lists them`];
      ctx.setModel(pick);
      return [`model → ${pick}`];
    },
  },
  {
    name: "use",
    aliases: ["switch"],
    summary: "switch the model for THIS session only: /use <id>",
    usage: "/use <id>",
    async run(ctx, args) {
      const pick = args[0];
      if (!pick) return ["usage: /use <id>  — switch the model for this session (/model persists it)"];
      const models = await availableModels(ctx.client);
      if (models.length && !models.some((m) => m.id === pick)) return [`${pick} is not a model your organization runs on the gateway — /model lists them`];
      ctx.setModel(pick, { session: true });
      return [`switched to ${pick} for this session · durable pick unchanged (/model persists)`];
    },
  },
  {
    name: "theme",
    summary: "list themes, or switch: /theme <name>",
    usage: "/theme [name]",
    run(ctx, args) {
      const name = args[0]?.toLowerCase();
      if (!name) {
        const cur = readPrefs().theme ?? DEFAULT_THEME;
        return [
          "themes:",
          ...THEMES.map((t) => `  ${t.name === cur ? "▸" : " "} ${t.name.padEnd(9)} ${t.description}`),
          "switch:  /theme <name>",
        ];
      }
      const match = THEMES.find((t) => t.name === name);
      if (!match) return [`unknown theme: ${name} — try ${THEMES.map((t) => t.name).join(", ")}`];
      ctx.setTheme(match.name);
      return [`theme set to ${match.label}`];
    },
  },
  {
    name: "clear",
    summary: "clear the transcript and start a new conversation",
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
  "The Glyphh loop runs right here, on any",
  "model your org serves on the gateway.",
  "/model picks one; shift+tab sets permission",
  "Files + shell work in this folder",
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
