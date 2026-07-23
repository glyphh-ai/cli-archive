/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * stream.ts — parse an Anthropic Messages SSE response into typed events. The
 * gateway relays the provider stream verbatim (`client.gateway.messages` returns
 * the RAW Response), so this is the same wire the desktop agent streams over —
 * the CLI just renders it in a terminal.
 */

export interface MessageStreamHandlers {
  /** A text delta — append to the live answer. */
  onText: (text: string) => void;
  /** Usage facts as they arrive (message_start carries input, message_delta output). */
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number }) => void;
  /** A provider-reported error event. */
  onError?: (message: string) => void;
}

/** Consume an SSE `Response` from the Messages edge, dispatching handlers.
 *  Resolves when the stream ends. Throws on a non-OK status with the body text. */
export async function consumeMessageStream(res: Response, h: MessageStreamHandlers): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gateway ${res.status}: ${body.slice(0, 300) || res.statusText}`);
  }
  if (!res.body) throw new Error("gateway returned no body");

  const decoder = new TextDecoder();
  let buf = "";
  const dispatch = (raw: string): void => {
    // One SSE event: `event: X` + one or more `data:` lines.
    const dataLines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(dataLines.join("")) as Record<string, unknown>;
    } catch {
      return; // keep-alives / non-JSON data
    }
    const type = ev.type as string;
    if (type === "content_block_delta") {
      const delta = ev.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) h.onText(delta.text);
    } else if (type === "message_start") {
      const usage = (ev.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
      if (usage?.input_tokens) h.onUsage?.({ inputTokens: usage.input_tokens });
    } else if (type === "message_delta") {
      const usage = (ev as { usage?: { output_tokens?: number } }).usage;
      if (usage?.output_tokens) h.onUsage?.({ outputTokens: usage.output_tokens });
    } else if (type === "error") {
      const err = (ev.error as { message?: string } | undefined)?.message ?? "stream error";
      h.onError?.(err);
    }
  };

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      dispatch(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) dispatch(buf);
}
