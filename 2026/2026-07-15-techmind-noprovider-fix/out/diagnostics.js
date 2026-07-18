"use strict";
/**
 * diagnostics.ts
 * Probes the gateway and reports what it can actually do.
 *
 * This exists because several design decisions depend on facts we cannot learn
 * from documentation on an airgapped network:
 *   - Does the gateway really stream, or is a reverse proxy buffering it?
 *   - What is each model's REAL context window (vs the completion cap in the registry)?
 *   - Does aborting the socket actually stop generation?
 *
 * Results are written to an untitled Markdown document so they can be read,
 * copied out, and kept alongside the code.
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
exports.runDiagnostics = runDiagnostics;
const vscode = __importStar(require("vscode"));
const llmRegistry_1 = require("./llmRegistry");
const llmClient_1 = require("./llmClient");
/**
 * Streaming verdict. A gateway can answer 200 with `text/event-stream` and still
 * be useless if a proxy buffered the whole body — in that case every token
 * arrives at once at the end, which we detect via first-token vs total time.
 */
function streamVerdict(p) {
    if (!p.streamed)
        return "NOT STREAMING — responded with a single buffered body";
    if (p.chunkCount < 10)
        return `WEAK — only ${p.chunkCount} chunks; likely a buffering proxy`;
    if (p.firstTokenMs === undefined)
        return "UNCLEAR — streamed but no content tokens seen";
    if (p.firstTokenMs > 0.4 * p.totalMs) {
        return `DEGRADED — first token at ${(p.firstTokenMs / 1000).toFixed(1)}s of ${(p.totalMs / 1000).toFixed(1)}s total; proxy is buffering`;
    }
    return `OK — ${p.chunkCount} chunks, first token in ${(p.firstTokenMs / 1000).toFixed(1)}s`;
}
async function probeStreaming(spec) {
    // A prompt that forces a long, steady answer so chunk counts are meaningful.
    const messages = [
        { role: "user", content: "Count from 1 to 60. Put each number on its own line. No other text." },
    ];
    try {
        const r = await (0, llmClient_1.callChat)(spec.name, messages, {
            stream: true,
            maxTokens: 300,
            temperature: 0,
            timeoutMs: 90000,
        });
        const p = {
            attempted: true,
            streamed: r.streamed,
            chunkCount: r.chunkCount,
            firstTokenMs: r.firstTokenMs,
            totalMs: r.elapsedMs,
            contentType: r.contentType,
        };
        return { ...p, verdict: streamVerdict(p) };
    }
    catch (e) {
        const err = e;
        return {
            attempted: true,
            streamed: false,
            chunkCount: 0,
            totalMs: err.elapsedMs ?? 0,
            verdict: err.kind === "stream_unsupported"
                ? "REJECTED — gateway refused stream:true"
                : `FAILED — ${err.kind}`,
            error: err.message,
        };
    }
}
/**
 * The real context window. `max_model_len` from /models is authoritative and free;
 * failing that, vLLM states the limit in its overflow error, so we provoke one.
 */
async function probeContext(spec, maxModelLen) {
    if (typeof maxModelLen === "number") {
        return { source: "max_model_len", tokens: maxModelLen, note: "reported by GET /models" };
    }
    const filler = "word ".repeat(60000); // ~300k chars; overflows anything in this registry
    try {
        await (0, llmClient_1.callChat)(spec.name, [{ role: "user", content: filler }], {
            stream: false,
            maxTokens: 16,
            timeoutMs: 60000,
        });
        return { source: "unknown", note: "oversized prompt was accepted — context is larger than the probe" };
    }
    catch (e) {
        const err = e;
        if (err.kind === "context_overflow" && err.maxContextTokens) {
            return { source: "overflow_error", tokens: err.maxContextTokens, note: "parsed from the gateway's 400 response" };
        }
        return { source: "unknown", note: `probe failed: ${err.kind} — ${err.message}` };
    }
}
/**
 * Whether Stop actually works. We start a long generation, abort after a moment,
 * and confirm the client rejects promptly. Note this proves the CLIENT stops
 * reading; whether the SERVER frees its slot cannot be observed from here.
 */
async function probeAbort(spec) {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = (0, llmClient_1.callChat)(spec.name, [{ role: "user", content: "Write a very long essay about databases. At least 2000 words." }], { stream: true, maxTokens: 2000, signal: ac.signal, timeoutMs: 90000 });
    setTimeout(() => ac.abort(), 1500);
    try {
        await p;
        return { aborted: false, note: "completed before the abort fired — inconclusive" };
    }
    catch (e) {
        const err = e;
        if (err.kind === "aborted") {
            return {
                aborted: true,
                msToAbort: Date.now() - t0,
                note: "client stopped; server-side slot release cannot be observed from the extension",
            };
        }
        return { aborted: false, note: `unexpected ${err.kind}: ${err.message}` };
    }
}
async function probeModel(spec, report) {
    report(`${spec.name}: health`);
    const health = await (0, llmClient_1.checkHealth)(spec.name);
    let streaming = {
        attempted: false, streamed: false, chunkCount: 0, totalMs: 0,
        verdict: "SKIPPED — endpoint unhealthy",
    };
    let context = { source: "unknown", note: "skipped — endpoint unhealthy" };
    let abort = { aborted: false, note: "skipped — endpoint unhealthy" };
    if (health.ok) {
        report(`${spec.name}: streaming`);
        streaming = await probeStreaming(spec);
        report(`${spec.name}: context window`);
        context = await probeContext(spec, health.maxModelLen);
        report(`${spec.name}: cancellation`);
        abort = await probeAbort(spec);
    }
    return {
        name: spec.name,
        path: spec.path,
        model: spec.model,
        completionCap: spec.maxTokens,
        health: { ok: health.ok, detail: health.detail, elapsedMs: health.elapsedMs, maxModelLen: health.maxModelLen },
        streaming,
        context,
        abort,
    };
}
function renderMarkdown(rep) {
    const L = [];
    L.push("# TechMind gateway diagnostics", "");
    L.push(`- **Generated:** ${rep.generatedAt}`);
    L.push(`- **Base URL:** \`${rep.baseUrl}\``, "");
    L.push("## Summary", "");
    L.push("| Model | Health | Streaming | Real context | Completion cap | Stop works |");
    L.push("|---|---|---|---|---|---|");
    for (const m of rep.models) {
        const ctx = m.context.tokens ? `${m.context.tokens}` : "unknown";
        L.push(`| ${m.name} | ${m.health.ok ? "ok" : "FAIL"} | ${m.streaming.verdict.split(" — ")[0]} | ${ctx} | ${m.completionCap} | ${m.abort.aborted ? "yes" : "no"} |`);
    }
    L.push("");
    const anyStreams = rep.models.some((m) => m.streaming.verdict.startsWith("OK"));
    L.push("## What this means", "");
    L.push(anyStreams
        ? "- The gateway **does** stream. Token-by-token rendering is live."
        : "- The gateway does **not** usefully stream. The panel falls back to a live phase indicator and elapsed timer; responses still arrive in one piece.");
    L.push("- **Real context** is what the budgeter must use. Where it says `unknown`, the gateway exposed neither `max_model_len` nor an overflow limit.");
    L.push("- Models whose real context is at or below ~2048 tokens cannot host an agent loop: a prompted tool spec alone costs 600-900 tokens.", "");
    L.push("## Detail", "");
    for (const m of rep.models) {
        L.push(`### ${m.name}`, "");
        L.push(`- Path: \`${m.path}\`  ·  Model id: \`${m.model}\``);
        L.push(`- Health: ${m.health.detail} (${m.health.elapsedMs}ms)`);
        L.push(`- Streaming: ${m.streaming.verdict}`);
        if (m.streaming.attempted) {
            L.push(`  - chunks: ${m.streaming.chunkCount}, first token: ${m.streaming.firstTokenMs ?? "n/a"}ms, total: ${m.streaming.totalMs}ms, content-type: \`${m.streaming.contentType ?? "n/a"}\``);
        }
        if (m.streaming.error)
            L.push(`  - error: ${m.streaming.error}`);
        L.push(`- Context: ${m.context.tokens ?? "unknown"} (${m.context.source}) — ${m.context.note ?? ""}`);
        L.push(`- Cancellation: ${m.abort.aborted ? `aborted after ${m.abort.msToAbort}ms` : "not confirmed"} — ${m.abort.note}`);
        L.push("");
    }
    L.push("## Raw", "");
    L.push("```json");
    L.push(JSON.stringify(rep, null, 2));
    L.push("```");
    return L.join("\n");
}
/** Runs every probe against every model and opens the report. */
async function runDiagnostics(baseUrl) {
    const report = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "TechMind: probing gateway",
        cancellable: false,
    }, async (progress) => {
        const models = [];
        for (const spec of llmRegistry_1.LLM_REGISTRY) {
            progress.report({ message: spec.name });
            models.push(await probeModel(spec, (m) => progress.report({ message: m })));
        }
        return { generatedAt: new Date().toISOString(), baseUrl, models };
    });
    const doc = await vscode.workspace.openTextDocument({
        content: renderMarkdown(report),
        language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: false });
}
//# sourceMappingURL=diagnostics.js.map