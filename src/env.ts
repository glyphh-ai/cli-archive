/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * env.ts — load a dev `.env` BEFORE anything reads the environment. Import this first in
 * main so `GLYPHH_SERVER_URL` (point the TUI at a local server) and friends are set in
 * time. Node's `loadEnvFile` does not override already-set vars, so an explicit env or
 * `~/.glyphh` config still wins. A missing/malformed `.env` is silently ignored.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function tryLoad(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    (process as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(path);
    return true;
  } catch {
    return false; // malformed .env — ignore, fall back to real env
  }
}

const here = dirname(fileURLToPath(import.meta.url));
// Package root (dist/../.env and src/../.env when run via tsx), then the cwd.
tryLoad(join(here, "..", ".env")) ||
  tryLoad(join(here, "..", "..", ".env")) ||
  tryLoad(join(process.cwd(), ".env"));
