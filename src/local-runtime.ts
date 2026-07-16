/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * local-runtime.ts — run a turn against the ONE local runtime, in-process. The CLI links
 * openrotor as a library (no server, no port) and streams a rotor's `open → step* →
 * answer → done` events. Memory lives in a single shared SQLite stator file
 * (`$GLYPHH_HOME/stator.db`) opened once and reused, so memory carries across every turn
 * and every local client (WAL + busy_timeout make concurrent processes safe).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { runInProcess, openSqliteStator, type WireEvent, type Stator } from "openrotor";
import { DEFAULT_ROTOR } from "./default-rotor.js";

function glyphhHome(): string {
  return process.env.GLYPHH_HOME ?? join(homedir(), ".glyphh");
}

/** The one shared stator, opened lazily + once per process. */
let storePromise: Promise<Stator> | null = null;
function stator(): Promise<Stator> {
  if (!storePromise) {
    mkdirSync(glyphhHome(), { recursive: true });
    storePromise = openSqliteStator(join(glyphhHome(), "stator.db"));
  }
  return storePromise;
}

/** A finished run's terminal summary. */
export interface LocalResult {
  status: string;
  terminal: string;
  outputs: unknown;
  error?: { code: string; detail: string };
}

export interface LocalRun {
  events: AsyncIterable<WireEvent>;
  done: Promise<LocalResult>;
}

/** A minimal callback → async-iterable bridge, so `emit`-based openrotor drives a
 *  `for await` loop. */
class EventQueue implements AsyncIterable<WireEvent> {
  private readonly buf: WireEvent[] = [];
  private readonly waiters: ((r: IteratorResult<WireEvent>) => void)[] = [];
  private ended = false;

  push(ev: WireEvent): void {
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.buf.push(ev);
  }

  end(): void {
    this.ended = true;
    let w: ((r: IteratorResult<WireEvent>) => void) | undefined;
    while ((w = this.waiters.shift())) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<WireEvent> {
    return {
      next: (): Promise<IteratorResult<WireEvent>> => {
        const ev = this.buf.shift();
        if (ev) return Promise.resolve({ value: ev, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Run a turn in-process against the shared local runtime + stator. */
export function localTurn(prompt: string, session?: string): LocalRun {
  const queue = new EventQueue();
  let terminal: LocalResult = { status: "ok", terminal: "done", outputs: null };
  let errFrame: { code: string; detail: string } | undefined;

  const done = (async (): Promise<LocalResult> => {
    const store = await stator();
    try {
      await runInProcess(
        DEFAULT_ROTOR,
        { prompt },
        (ev) => {
          queue.push(ev);
          if (ev.kind === "done") terminal = { status: ev.status, terminal: ev.terminal, outputs: ev.outputs };
          if (ev.kind === "error") errFrame = { code: ev.code, detail: ev.detail };
        },
        { store, ...(session ? { session } : {}) },
      );
    } finally {
      queue.end();
    }
    return errFrame ? { ...terminal, status: "error", error: errFrame } : terminal;
  })();

  return { events: queue, done };
}
