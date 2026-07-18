/**
 * llmClient.ts
 * Transport layer for the airgapped vLLM gateway.
 *
 * Replaces the original always-resolve, always-buffered `callLLM`. What changed:
 *   - SSE streaming (`stream: true`) with a per-token callback, and an automatic
 *     fallback to a buffered request when the gateway or a reverse proxy won't stream.
 *   - Real cancellation via AbortSignal (the Stop button), distinguished from timeouts.
 *   - Typed errors that reject, instead of a `{ error: string }` field callers forget to check.
 *   - Token accounting captured from `usage`, which the context budgeter needs later.
 *
 * NO external/cloud calls are ever made — only the configured internal base URL.
 */

import * as https from "https";
import * as http from "http";
import { LLMSpec, getLLM, LLM_REGISTRY, ChatMessage } from "./llmRegistry";
import { getBaseUrl, getTimeout, getStreamingMode } from "./config";

export type LlmErrorKind =
  | "unknown_model"
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "parse"
  | "context_overflow"
  | "stream_unsupported";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly llmName: string;
  readonly status?: number;
  readonly body?: string;
  readonly elapsedMs: number;
  /** Populated for `context_overflow`: the model's real maximum, per the gateway. */
  readonly maxContextTokens?: number;

  constructor(
    kind: LlmErrorKind,
    llmName: string,
    message: string,
    opts: { status?: number; body?: string; elapsedMs?: number; maxContextTokens?: number } = {}
  ) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.llmName = llmName;
    this.status = opts.status;
    this.body = opts.body;
    this.elapsedMs = opts.elapsedMs ?? 0;
    this.maxContextTokens = opts.maxContextTokens;
  }
}

export interface CallOptions {
  /** Abort mid-generation. Surfaces as an `aborted` LlmError. */
  signal?: AbortSignal;
  /** Called for each token as it arrives. Only fires when the response actually streams. */
  onToken?: (delta: string) => void;
  /** Overrides the model's registry default. */
  maxTokens?: number;
  temperature?: number;
  /** Force streaming on/off for this call, ignoring the user setting (used by probes). */
  stream?: boolean;
  /** Overrides the configured request timeout, in ms (used by probes). */
  timeoutMs?: number;
}

export interface CallResult {
  text: string;
  llmUsed: string;
  elapsedMs: number;
  /** Retained so existing callers keep compiling; "" on success. Prefer catching LlmError. */
  error: string;
  /** True only if the body actually arrived incrementally as SSE. */
  streamed: boolean;
  /** ms to first content token — the number that matters for perceived latency. */
  firstTokenMs?: number;
  /** Number of SSE data events seen. A "streaming" response with 1 chunk is a buffering proxy. */
  chunkCount: number;
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
  contentType?: string;
}

/** vLLM answers an oversized prompt with the real limit in the error body. Worth capturing. */
function parseContextOverflow(body: string): number | undefined {
  const m = /maximum context length is (\d+)/i.exec(body);
  return m ? parseInt(m[1], 10) : undefined;
}

function isAbortError(e: any): boolean {
  return e && (e.name === "AbortError" || e.code === "ABORT_ERR");
}

/**
 * One request against one model. `stream` decides SSE vs buffered; callers use
 * `callChat` rather than this directly so they get the fallback behaviour.
 */
function requestChat(
  spec: LLMSpec,
  messages: ChatMessage[],
  opts: CallOptions,
  stream: boolean
): Promise<CallResult> {
  return new Promise<CallResult>((resolve, reject) => {
    const baseUrl = getBaseUrl();
    const fullUrl = new URL(`${baseUrl}${spec.path}/chat/completions`);
    const isHttps = fullUrl.protocol === "https:";
    const transport = isHttps ? https : http;

    const body: Record<string, unknown> = {
      model: spec.model,
      messages,
      max_tokens: opts.maxTokens ?? spec.maxTokens,
      temperature: opts.temperature ?? spec.temperature,
    };
    if (stream) {
      body.stream = true;
      // Ask vLLM to emit a final usage chunk. Harmless if the gateway ignores it.
      body.stream_options = { include_usage: true };
    }
    const payload = JSON.stringify(body);

    const options: https.RequestOptions = {
      hostname: fullUrl.hostname,
      port: fullUrl.port || (isHttps ? 443 : 80),
      // Preserve any query string on the configured base URL.
      path: fullUrl.pathname + fullUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Accept: stream ? "text/event-stream" : "application/json",
        Authorization: "Bearer EMPTY",
      },
      timeout: opts.timeoutMs ?? getTimeout(),
      // Internal CA chains on airgapped networks are often self-signed; if your
      // gateway uses a trusted internal CA, set this to true and configure
      // NODE_EXTRA_CA_CERTS instead.
      rejectUnauthorized: false,
    };

    const t0 = Date.now();
    let settled = false;
    let firstTokenMs: number | undefined;
    let chunkCount = 0;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    const req = transport.request(options, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers["content-type"] ?? "");
      const sse = contentType.includes("text/event-stream");

      // Non-200: drain the body so the error message is useful, then reject.
      if (status !== 200) {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const elapsedMs = Date.now() - t0;
          const overflow = parseContextOverflow(raw);
          if (overflow !== undefined) {
            finish(() =>
              reject(
                new LlmError("context_overflow", spec.name, `Prompt exceeds ${overflow} tokens`, {
                  status,
                  body: raw.slice(0, 500),
                  elapsedMs,
                  maxContextTokens: overflow,
                })
              )
            );
            return;
          }
          // A gateway that rejects `stream:true` outright — let callChat retry buffered.
          if (stream && (status === 400 || status === 404 || status === 501)) {
            finish(() =>
              reject(
                new LlmError("stream_unsupported", spec.name, `Gateway rejected streaming (HTTP ${status})`, {
                  status,
                  body: raw.slice(0, 500),
                  elapsedMs,
                })
              )
            );
            return;
          }
          finish(() =>
            reject(
              new LlmError("http", spec.name, `HTTP ${status}: ${raw.slice(0, 300)}`, {
                status,
                body: raw.slice(0, 500),
                elapsedMs,
              })
            )
          );
        });
        return;
      }

      // Asked to stream but got a plain JSON body: a buffering proxy or a gateway
      // that silently ignored `stream`. Parse it as a normal response and report
      // streamed:false so the UI doesn't pretend tokens arrived incrementally.
      if (stream && !sse) {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const elapsedMs = Date.now() - t0;
          try {
            const data = JSON.parse(raw);
            const text = data.choices?.[0]?.message?.content ?? "";
            finish(() =>
              resolve({
                text,
                llmUsed: spec.name,
                elapsedMs,
                error: "",
                streamed: false,
                chunkCount: 1,
                promptTokens: data.usage?.prompt_tokens,
                completionTokens: data.usage?.completion_tokens,
                finishReason: data.choices?.[0]?.finish_reason,
                contentType,
              })
            );
          } catch (e: any) {
            finish(() =>
              reject(
                new LlmError("parse", spec.name, `Parse error: ${e.message}`, {
                  body: raw.slice(0, 500),
                  elapsedMs,
                })
              )
            );
          }
        });
        return;
      }

      // ---- Streaming path (SSE) ----
      if (stream && sse) {
        let buf = "";
        let text = "";
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let finishReason: string | undefined;

        res.setEncoding("utf8");

        // SSE events are separated by a blank line. Consume whole events only and
        // leave any partial tail in `buf` for the next chunk.
        const consumeEvents = () => {
          const SEP = /\r?\n\r?\n/;
          let m: RegExpExecArray | null;
          while ((m = SEP.exec(buf)) !== null) {
            const rawEvent = buf.slice(0, m.index);
            buf = buf.slice(m.index + m[0].length);
            handleEvent(rawEvent);
          }
        };

        const handleEvent = (rawEvent: string) => {
          for (const line of rawEvent.split(/\r?\n/)) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data) continue;
              if (data === "[DONE]") continue;
              chunkCount++;
              try {
                const j = JSON.parse(data);
                const delta = j.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta.length > 0) {
                  if (firstTokenMs === undefined) firstTokenMs = Date.now() - t0;
                  text += delta;
                  opts.onToken?.(delta);
                }
                const fr = j.choices?.[0]?.finish_reason;
                if (fr) finishReason = fr;
                if (j.usage) {
                  promptTokens = j.usage.prompt_tokens ?? promptTokens;
                  completionTokens = j.usage.completion_tokens ?? completionTokens;
                }
              } catch {
                // A partial or non-JSON keepalive line; ignore and keep reading.
              }
          }
        };

        res.on("data", (chunk: string) => {
          buf += chunk;
          consumeEvents();
        });

        res.on("end", () => {
          // Some gateways omit the trailing blank line on the final event.
          if (buf.trim()) handleEvent(buf);
          finish(() =>
            resolve({
              text,
              llmUsed: spec.name,
              elapsedMs: Date.now() - t0,
              error: "",
              streamed: true,
              firstTokenMs,
              chunkCount,
              promptTokens,
              completionTokens,
              finishReason,
              contentType,
            })
          );
        });
        return;
      }

      // ---- Buffered path ----
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        const elapsedMs = Date.now() - t0;
        try {
          const data = JSON.parse(raw);
          const text = data.choices?.[0]?.message?.content ?? "";
          finish(() =>
            resolve({
              text,
              llmUsed: spec.name,
              elapsedMs,
              error: "",
              streamed: false,
              chunkCount: 1,
              promptTokens: data.usage?.prompt_tokens,
              completionTokens: data.usage?.completion_tokens,
              finishReason: data.choices?.[0]?.finish_reason,
              contentType,
            })
          );
        } catch (e: any) {
          finish(() =>
            reject(
              new LlmError("parse", spec.name, `Parse error: ${e.message}`, {
                body: raw.slice(0, 500),
                elapsedMs,
              })
            )
          );
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      finish(() =>
        reject(new LlmError("timeout", spec.name, "Request timed out", { elapsedMs: Date.now() - t0 }))
      );
    });

    req.on("error", (e: any) => {
      if (isAbortError(e) || (opts.signal?.aborted && settled === false)) {
        finish(() =>
          reject(new LlmError("aborted", spec.name, "Cancelled", { elapsedMs: Date.now() - t0 }))
        );
        return;
      }
      finish(() =>
        reject(new LlmError("network", spec.name, e.message, { elapsedMs: Date.now() - t0 }))
      );
    });

    // Cancellation: destroy the socket. Whether that frees the server-side slot is
    // gateway-dependent — the diagnostics probe reports on it.
    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy();
        finish(() => reject(new LlmError("aborted", spec.name, "Cancelled", { elapsedMs: 0 })));
        return;
      }
      onAbort = () => {
        req.destroy();
        finish(() =>
          reject(new LlmError("aborted", spec.name, "Cancelled", { elapsedMs: Date.now() - t0 }))
        );
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    req.write(payload);
    req.end();
  });
}

/**
 * Call one model. Throws LlmError on failure.
 *
 * Streaming is attempted per the `techmind.streaming` setting (or `opts.stream`).
 * In "auto" mode a gateway that rejects SSE transparently falls back to a buffered
 * request, and the result reports `streamed: false` so the UI can be honest about it.
 */
export async function callChat(
  llmName: string,
  messages: ChatMessage[],
  opts: CallOptions = {}
): Promise<CallResult> {
  const spec = getLLM(llmName);
  if (!spec) throw new LlmError("unknown_model", llmName, `Unknown model: ${llmName}`);

  const mode = getStreamingMode();
  const wantStream = opts.stream ?? (mode !== "off");

  if (!wantStream) return requestChat(spec, messages, opts, false);

  try {
    return await requestChat(spec, messages, opts, true);
  } catch (e) {
    const err = e as LlmError;
    const explicitStream = opts.stream === true || mode === "on";
    if (err.kind === "stream_unsupported" && !explicitStream) {
      // Retry once without streaming.
      return requestChat(spec, messages, opts, false);
    }
    throw err;
  }
}

/**
 * Back-compat wrapper: never throws, reports failure via `error`.
 * @deprecated Prefer `callChat` and catch `LlmError`.
 */
export async function callLLM(
  llmName: string,
  messages: ChatMessage[],
  overrideTokens?: number
): Promise<CallResult> {
  try {
    return await callChat(llmName, messages, { maxTokens: overrideTokens });
  } catch (e) {
    const err = e as LlmError;
    return {
      text: "",
      llmUsed: llmName,
      elapsedMs: err.elapsedMs ?? 0,
      error: err.message || String(e),
      streamed: false,
      chunkCount: 0,
    };
  }
}

export interface FallbackResult extends CallResult {
  /** Set when the primary model failed and a fallback answered. */
  fellBackFrom?: string;
  /** Why the primary failed — surfaced in the UI instead of being swallowed. */
  fallbackReason?: string;
}

/**
 * Tries the primary model, then the enabled registry in priority order.
 *
 * Unlike the original, the reason for falling back is carried in its own field
 * rather than stuffed into `error` (which made a success look like a failure),
 * and an abort stops the chain instead of cascading through every model.
 */
export async function callWithFallback(
  primaryLlm: string,
  messages: ChatMessage[],
  enabledModels: Set<string>,
  opts: CallOptions = {}
): Promise<FallbackResult> {
  let firstError: LlmError | undefined;

  if (enabledModels.has(primaryLlm)) {
    try {
      return await callChat(primaryLlm, messages, opts);
    } catch (e) {
      const err = e as LlmError;
      if (err.kind === "aborted") throw err;
      firstError = err;
    }
  }

  const sorted = [...LLM_REGISTRY].sort((a, b) => a.priority - b.priority);
  for (const spec of sorted) {
    if (spec.name === primaryLlm || !enabledModels.has(spec.name)) continue;
    try {
      const result = await callChat(spec.name, messages, opts);
      return {
        ...result,
        fellBackFrom: primaryLlm,
        fallbackReason: firstError?.message ?? "primary model disabled",
      };
    } catch (e) {
      const err = e as LlmError;
      if (err.kind === "aborted") throw err;
      if (!firstError) firstError = err;
    }
  }

  throw new LlmError(
    firstError?.kind ?? "network",
    primaryLlm,
    `All enabled models failed, starting from ${primaryLlm}${firstError ? `: ${firstError.message}` : ""}`
  );
}

export interface HealthResult {
  ok: boolean;
  detail: string;
  /** vLLM reports the model's real context window here when it exposes it. */
  maxModelLen?: number;
  elapsedMs: number;
}

/** GET {base}{path}/models — health plus, when the gateway exposes it, the real context window. */
export function checkHealth(llmName: string, timeoutMs = 8000): Promise<HealthResult> {
  return new Promise((resolve) => {
    const spec = getLLM(llmName);
    if (!spec) {
      resolve({ ok: false, detail: "Unknown model", elapsedMs: 0 });
      return;
    }
    const baseUrl = getBaseUrl();
    const fullUrl = new URL(`${baseUrl}${spec.path}/models`);
    const isHttps = fullUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const t0 = Date.now();

    const req = transport.request(
      {
        hostname: fullUrl.hostname,
        port: fullUrl.port || (isHttps ? 443 : 80),
        path: fullUrl.pathname + fullUrl.search,
        method: "GET",
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const elapsedMs = Date.now() - t0;
          const ok = res.statusCode === 200;
          let maxModelLen: number | undefined;
          if (ok) {
            try {
              const j = JSON.parse(raw);
              const entry = Array.isArray(j.data)
                ? j.data.find((d: any) => d.id === spec.model) ?? j.data[0]
                : undefined;
              const len = entry?.max_model_len;
              if (typeof len === "number") maxModelLen = len;
            } catch {
              // Health is still valid even if the body isn't the shape we expect.
            }
          }
          resolve({ ok, detail: `HTTP ${res.statusCode}`, maxModelLen, elapsedMs });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, detail: "Timeout", elapsedMs: Date.now() - t0 });
    });
    req.on("error", (e) => resolve({ ok: false, detail: e.message, elapsedMs: Date.now() - t0 }));
    req.end();
  });
}
