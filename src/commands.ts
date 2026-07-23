/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * commands.ts — the TUI's slash commands. A leading `/` routes here instead of to the
 * loop. Each command runs against the SDK (never its own API) and returns the lines to
 * show as a `└ …` result under the typed command. Kept small; the full `glyphh` CLI
 * remains the exhaustive surface — these are the in-chat conveniences.
 *
 * Model picks mirror the desktop composer: a loop declares model SLOTS, and a pick binds
 * one to a model on THIS device (`setSelection`). Resolution — pick → loop default →
 * platform default → first allowed — happens server-side (`loops.roles`), so what the
 * footer shows and what a turn runs cannot drift apart.
 */

import type { Client } from "@glyphh/client";
import { detectHardware, recommendModel, LOCAL_MODELS, ensureLocalModel } from "@glyphh/client/models";
import { switchModel } from "@glyphh/client/runtime";
import { loadAccount, type Account } from "./glyphh.js";
import { openBrowser } from "./open-browser.js";
import { readPrefs, selectionsFor, setSelection } from "./prefs.js";
import { THEMES, DEFAULT_THEME } from "./theme.js";

export interface CommandCtx {
  client: Client;
  account: Account | null;
  loop: string;
  version: string;
  server: string;
  setAccount: (a: Account | null) => void;
  setLoop: (l: string) => void;
  /** Apply + persist a theme by name (repaints the whole tree). */
  setTheme: (name: string) => void;
  clearChat: () => void;
  quit: () => void;
  /** Update the running command's `└ …` lines mid-flight (e.g. the login code + URL). */
  emit: (lines: string[]) => void;
  /** Reload the footer's model slots (after a selection change). */
  refreshConfig?: () => void;
  /** The per-process session id — anchors a mid-session model switch's overrides + audit. */
  sessionId: string;
  /** Drop the cached model registry so the next turn re-resolves (after a selection switch). */
  invalidateModels?: () => void;
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

/** Strip a catalog id's `provider::` prefix down to the bare model id for display. */
function bareId(modelId: string): string {
  return modelId.split("::").pop() ?? modelId;
}

const COMMANDS: SlashCommand[] = [
  {
    name: "login",
    aliases: ["auth", "signin"],
    summary: "sign in from this terminal (approve in a browser)",
    async run(ctx) {
      // Device authorization grant — SAME flow as the boot login screen: open the
      // browser straight to the approval page (code embedded in the URL), and show
      // the code + URL only as the fallback for a box that can't open a browser.
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
    summary: "show the signed-in account, plan, and server",
    async run(ctx) {
      if (!ctx.account) return ["Not signed in · run /login <email>"];
      const a = ctx.account;
      return [
        `signed in as ${a.email}`,
        `plan ${planLabel(a.tier)}${a.credits !== null ? ` · ${a.credits} credits` : ""}`,
        `loop ${ctx.loop}  ·  ${ctx.server.replace(/^https?:\/\//, "")}`,
      ];
    },
  },
  {
    name: "loop",
    aliases: ["loops"],
    summary: "show or switch the selected loop",
    usage: "/loop [slug]",
    async run(ctx, args) {
      const slug = args[0];
      if (!slug) {
        const { loops } = await ctx.client.loops.list().catch(() => ({ loops: [] }));
        const lines = [`current loop: ${ctx.loop}`];
        if (loops.length) {
          lines.push("available:");
          for (const l of loops) lines.push(`  ${l.slug}${l.slug === ctx.loop ? "  ← selected" : ""}  — ${l.name}`);
          lines.push("switch:  /loop <slug>");
        }
        return lines;
      }
      ctx.setLoop(slug);
      return [`loop set to ${slug}`];
    },
  },
  {
    name: "configure",
    aliases: ["config", "models"],
    summary: "show the selected loop's model slots + how each resolves",
    async run(ctx) {
      const roles = await ctx.client.loops.roles(ctx.loop, selectionsFor(ctx.loop)).catch(() => null);
      if (!roles) return [`loop "${ctx.loop}" is not in the library`];
      const lines = [`${ctx.loop} — ${roles.length} slot(s):`];
      for (const r of roles) {
        const model = r.modelId ? `${bareId(r.modelId)} (${r.source})` : "— none —";
        lines.push(`  ${r.name}: ${model}${r.description ? `  · ${r.description}` : ""}`);
      }
      lines.push("pick a model:  /model <modelId>[:local]    slot:  /bind <slot>=<modelId>");
      return lines;
    },
  },
  {
    name: "bind",
    summary: "pick a model for a loop slot on this device: /bind <slot>=<modelId> …",
    async run(ctx, args) {
      if (args.length === 0) return ["usage: /bind <slot>=<modelId> …  (this device's pick; resolved server-side)"];
      const picks = args.map((p) => {
        const [role, modelId] = p.split("=");
        if (!role || !modelId) throw new Error(`bad pair: ${p}`);
        return { role, modelId };
      });
      for (const { role, modelId } of picks) setSelection(ctx.loop, role, modelId);
      ctx.invalidateModels?.(); // next turn re-resolves with the new picks
      ctx.refreshConfig?.();
      return ["selection saved", ...picks.map((p) => `  ${p.role} → ${bareId(p.modelId)}`)];
    },
  },
  {
    name: "model",
    summary: "list models, or pick the loop's primary model: /model <modelId>[:local]",
    async run(ctx, args) {
      const roles = await ctx.client.loops.roles(ctx.loop, selectionsFor(ctx.loop)).catch(() => []);
      const primary = roles[0]?.name ?? "default";
      if (args.length === 0) {
        const models = await ctx.client.catalog.models();
        const lines = [`available models (fills "${primary}"):`];
        for (const m of models) lines.push(`  ${m.id}  (${m.kind === "open_weight" ? "local" : "hosted"})`);
        lines.push("pick:  /model <modelId>        local:  /model <modelId>:local");
        return lines;
      }
      const raw = args[0]!;
      const local = raw.endsWith(":local");
      const modelId = local ? raw.slice(0, -6) : raw;
      setSelection(ctx.loop, primary, modelId);
      ctx.invalidateModels?.();
      ctx.refreshConfig?.();
      return [`${primary} → ${bareId(modelId)}${local ? " (local)" : ""}`];
    },
  },
  {
    name: "use",
    aliases: ["switch"],
    summary: "switch a model for THIS session only (transient, audited): /use <modelId> [slot]",
    async run(ctx, args) {
      if (args.length === 0) return ["usage: /use <modelId> [slot]  — switch a model for this session (audited; /model persists it)"];
      const to = args[0]!;
      const roles = await ctx.client.loops.roles(ctx.loop, selectionsFor(ctx.loop)).catch(() => []);
      const role = args[1] ?? roles[0]?.name ?? "default";
      // The slot's current resolved model → the from→to audit trail.
      const from = roles.find((r) => r.name === role)?.modelId;
      await switchModel(ctx.client, {
        sessionId: ctx.sessionId,
        rotorSlug: ctx.loop,
        role,
        to,
        ...(from ? { from } : {}),
        surface: "cli",
      });
      ctx.invalidateModels?.(); // next turn re-resolves with the override
      return [`switched ${role} → ${to} for this session (audited)`, from ? `  was ${bareId(from)} · durable pick unchanged (/model persists)` : "  durable pick unchanged (/model persists)"];
    },
  },
  {
    name: "install",
    summary: "install a local model (opt-in): /install [modelId]",
    async run(ctx, args) {
      const hw = detectHardware();
      if (args.length === 0) {
        const rec = recommendModel(hw);
        const lines = [
          `this machine: ${hw.totalRamGB}GB RAM${hw.appleSilicon ? " · Apple Silicon" : ""}`,
          `recommended: ${rec.id} (${rec.name})`,
          "installable:",
          ...LOCAL_MODELS.map((m) => `  ${m.id}  ${m.name}  (needs ${m.minRamGB}GB)`),
          "install:  /install <id>    then use it:  /model <id>:local",
        ];
        return lines;
      }
      const id = args[0]!;
      ctx.emit([`installing ${id} — downloading weights, this can take a while…`]);
      const server = await ensureLocalModel(id, {
        onProgress: (phase, r) => ctx.emit([`${phase} ${Math.round(r * 100)}%`]),
      });
      return [`installed ${id}`, `serving at ${server.url}`, `use it:  /model ${id}:local`];
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
  "Slash commands: /login /status /loop /help",
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
