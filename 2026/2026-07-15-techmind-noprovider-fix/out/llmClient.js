"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlmError = void 0;
exports.callChat = callChat;
exports.callLLM = callLLM;
exports.callWithFallback = callWithFallback;
exports.checkHealth = checkHealth;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const llmRegistry_1 = require("./llmRegistry");
const config_1 = require("./config");
class LlmError extends Error {
    constructor(kind, llmName, message, opts = {}) {
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
exports.LlmError = LlmError;
/** vLLM answers an oversized prompt with the real limit in the error body. Worth capturing. */
function parseContextOverflow(body) {
    const m = /maximum context length is (\d+)/i.exec(body);
    return m ? parseInt(m[1], 10) : undefined;
}
function isAbortError(e) {
    return e && (e.name === "AbortError" || e.code === "ABORT_ERR");
}
/**
 * One request against one model. `stream` decides SSE vs buffered; callers use
 * `callChat` rather than this directly so they get the fallback behaviour.
 */
function requestChat(spec, messages, opts, stream) {
    return new Promise((resolve, reject) => {
        const baseUrl = (0, config_1.getBaseUrl)();
        const fullUrl = new URL(`${baseUrl}${spec.path}/chat/completions`);
        const isHttps = fullUrl.protocol === "https:";
        const transport = isHttps ? https : http;
        const body = {
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
        const options = {
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
            timeout: opts.timeoutMs ?? (0, config_1.getTimeout)(),
            // Internal CA chains on airgapped networks are often self-signed; if your
            // gateway uses a trusted internal CA, set this to true and configure
            // NODE_EXTRA_CA_CERTS instead.
            rejectUnauthorized: false,
        };
        const t0 = Date.now();
        let settled = false;
        let firstTokenMs;
        let chunkCount = 0;
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            fn();
        };
        let onAbort;
        const cleanup = () => {
            if (onAbort && opts.signal)
                opts.signal.removeEventListener("abort", onAbort);
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
                        finish(() => reject(new LlmError("context_overflow", spec.name, `Prompt exceeds ${overflow} tokens`, {
                            status,
                            body: raw.slice(0, 500),
                            elapsedMs,
                            maxContextTokens: overflow,
                        })));
                        return;
                    }
                    // A gateway that rejects `stream:true` outright — let callChat retry buffered.
                    if (stream && (status === 400 || status === 404 || status === 501)) {
                        finish(() => reject(new LlmError("stream_unsupported", spec.name, `Gateway rejected streaming (HTTP ${status})`, {
                            status,
                            body: raw.slice(0, 500),
                            elapsedMs,
                        })));
                        return;
                    }
                    finish(() => reject(new LlmError("http", spec.name, `HTTP ${status}: ${raw.slice(0, 300)}`, {
                        status,
                        body: raw.slice(0, 500),
                        elapsedMs,
                    })));
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
                        finish(() => resolve({
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
                        }));
                    }
                    catch (e) {
                        finish(() => reject(new LlmError("parse", spec.name, `Parse error: ${e.message}`, {
                            body: raw.slice(0, 500),
                            elapsedMs,
                        })));
                    }
                });
                return;
            }
            // ---- Streaming path (SSE) ----
            if (stream && sse) {
                let buf = "";
                let text = "";
                let promptTokens;
                let completionTokens;
                let finishReason;
                res.setEncoding("utf8");
                // SSE events are separated by a blank line. Consume whole events only and
                // leave any partial tail in `buf` for the next chunk.
                const consumeEvents = () => {
                    const SEP = /\r?\n\r?\n/;
                    let m;
                    while ((m = SEP.exec(buf)) !== null) {
                        const rawEvent = buf.slice(0, m.index);
                        buf = buf.slice(m.index + m[0].length);
                        handleEvent(rawEvent);
                    }
                };
                const handleEvent = (rawEvent) => {
                    for (const line of rawEvent.split(/\r?\n/)) {
                        if (!line.startsWith("data:"))
                            continue;
                        const data = line.slice(5).trim();
                        if (!data)
                            continue;
                        if (data === "[DONE]")
                            continue;
                        chunkCount++;
                        try {
                            const j = JSON.parse(data);
                            const delta = j.choices?.[0]?.delta?.content;
                            if (typeof delta === "string" && delta.length > 0) {
                                if (firstTokenMs === undefined)
                                    firstTokenMs = Date.now() - t0;
                                text += delta;
                                opts.onToken?.(delta);
                            }
                            const fr = j.choices?.[0]?.finish_reason;
                            if (fr)
                                finishReason = fr;
                            if (j.usage) {
                                promptTokens = j.usage.prompt_tokens ?? promptTokens;
                                completionTokens = j.usage.completion_tokens ?? completionTokens;
                            }
                        }
                        catch {
                            // A partial or non-JSON keepalive line; ignore and keep reading.
                        }
                    }
                };
                res.on("data", (chunk) => {
                    buf += chunk;
                    consumeEvents();
                });
                res.on("end", () => {
                    // Some gateways omit the trailing blank line on the final event.
                    if (buf.trim())
                        handleEvent(buf);
                    finish(() => resolve({
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
                    }));
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
                    finish(() => resolve({
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
                    }));
                }
                catch (e) {
                    finish(() => reject(new LlmError("parse", spec.name, `Parse error: ${e.message}`, {
                        body: raw.slice(0, 500),
                        elapsedMs,
                    })));
                }
            });
        });
        req.on("timeout", () => {
            req.destroy();
            finish(() => reject(new LlmError("timeout", spec.name, "Request timed out", { elapsedMs: Date.now() - t0 })));
        });
        req.on("error", (e) => {
            if (isAbortError(e) || (opts.signal?.aborted && settled === false)) {
                finish(() => reject(new LlmError("aborted", spec.name, "Cancelled", { elapsedMs: Date.now() - t0 })));
                return;
            }
            finish(() => reject(new LlmError("network", spec.name, e.message, { elapsedMs: Date.now() - t0 })));
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
                finish(() => reject(new LlmError("aborted", spec.name, "Cancelled", { elapsedMs: Date.now() - t0 })));
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
async function callChat(llmName, messages, opts = {}) {
    const spec = (0, llmRegistry_1.getLLM)(llmName);
    if (!spec)
        throw new LlmError("unknown_model", llmName, `Unknown model: ${llmName}`);
    const mode = (0, config_1.getStreamingMode)();
    const wantStream = opts.stream ?? (mode !== "off");
    if (!wantStream)
        return requestChat(spec, messages, opts, false);
    try {
        return await requestChat(spec, messages, opts, true);
    }
    catch (e) {
        const err = e;
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
async function callLLM(llmName, messages, overrideTokens) {
    try {
        return await callChat(llmName, messages, { maxTokens: overrideTokens });
    }
    catch (e) {
        const err = e;
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
/**
 * Tries the primary model, then the enabled registry in priority order.
 *
 * Unlike the original, the reason for falling back is carried in its own field
 * rather than stuffed into `error` (which made a success look like a failure),
 * and an abort stops the chain instead of cascading through every model.
 */
async function callWithFallback(primaryLlm, messages, enabledModels, opts = {}) {
    let firstError;
    if (enabledModels.has(primaryLlm)) {
        try {
            return await callChat(primaryLlm, messages, opts);
        }
        catch (e) {
            const err = e;
            if (err.kind === "aborted")
                throw err;
            firstError = err;
        }
    }
    const sorted = [...llmRegistry_1.LLM_REGISTRY].sort((a, b) => a.priority - b.priority);
    for (const spec of sorted) {
        if (spec.name === primaryLlm || !enabledModels.has(spec.name))
            continue;
        try {
            const result = await callChat(spec.name, messages, opts);
            return {
                ...result,
                fellBackFrom: primaryLlm,
                fallbackReason: firstError?.message ?? "primary model disabled",
            };
        }
        catch (e) {
            const err = e;
            if (err.kind === "aborted")
                throw err;
            if (!firstError)
                firstError = err;
        }
    }
    throw new LlmError(firstError?.kind ?? "network", primaryLlm, `All enabled models failed, starting from ${primaryLlm}${firstError ? `: ${firstError.message}` : ""}`);
}
/** GET {base}{path}/models — health plus, when the gateway exposes it, the real context window. */
function checkHealth(llmName, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const spec = (0, llmRegistry_1.getLLM)(llmName);
        if (!spec) {
            resolve({ ok: false, detail: "Unknown model", elapsedMs: 0 });
            return;
        }
        const baseUrl = (0, config_1.getBaseUrl)();
        const fullUrl = new URL(`${baseUrl}${spec.path}/models`);
        const isHttps = fullUrl.protocol === "https:";
        const transport = isHttps ? https : http;
        const t0 = Date.now();
        const req = transport.request({
            hostname: fullUrl.hostname,
            port: fullUrl.port || (isHttps ? 443 : 80),
            path: fullUrl.pathname + fullUrl.search,
            method: "GET",
            timeout: timeoutMs,
            rejectUnauthorized: false,
        }, (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
                const elapsedMs = Date.now() - t0;
                const ok = res.statusCode === 200;
                let maxModelLen;
                if (ok) {
                    try {
                        const j = JSON.parse(raw);
                        const entry = Array.isArray(j.data)
                            ? j.data.find((d) => d.id === spec.model) ?? j.data[0]
                            : undefined;
                        const len = entry?.max_model_len;
                        if (typeof len === "number")
                            maxModelLen = len;
                    }
                    catch {
                        // Health is still valid even if the body isn't the shape we expect.
                    }
                }
                resolve({ ok, detail: `HTTP ${res.statusCode}`, maxModelLen, elapsedMs });
            });
        });
        req.on("timeout", () => {
            req.destroy();
            resolve({ ok: false, detail: "Timeout", elapsedMs: Date.now() - t0 });
        });
        req.on("error", (e) => resolve({ ok: false, detail: e.message, elapsedMs: Date.now() - t0 }));
        req.end();
    });
}
//# sourceMappingURL=llmClient.js.map