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

import * as vscode from "vscode";
import { LLM_REGISTRY, LLMSpec } from "./llmRegistry";
import { callChat, checkHealth, LlmError } from "./llmClient";
import { createAbortController } from "./abort";

export interface StreamProbe {
  attempted: boolean;
  streamed: boolean;
  chunkCount: number;
  firstTokenMs?: number;
  totalMs: number;
  contentType?: string;
  verdict: string;
  error?: string;
}

export interface ContextProbe {
  source: "max_model_len" | "overflow_error" | "unknown";
  tokens?: number;
  note?: string;
}

export interface AbortProbe {
  aborted: boolean;
  msToAbort?: number;
  note: string;
}

export interface ModelReport {
  name: string;
  path: string;
  model: string;
  completionCap: number;
  health: { ok: boolean; detail: string; elapsedMs: number; maxModelLen?: number };
  streaming: StreamProbe;
  context: ContextProbe;
  abort: AbortProbe;
}

export interface GatewayReport {
  generatedAt: string;
  baseUrl: string;
  models: ModelReport[];
}

/**
 * Streaming verdict. A gateway can answer 200 with `text/event-stream` and still
 * be useless if a proxy buffered the whole body — in that case every token
 * arrives at once at the end, which we detect via first-token vs total time.
 */
function streamVerdict(p: { streamed: boolean; chunkCount: number; firstTokenMs?: number; totalMs: number }): string {
  if (!p.streamed) return "NOT STREAMING — responded with a single buffered body";
  if (p.chunkCount < 10) return `WEAK — only ${p.chunkCount} chunks; likely a buffering proxy`;
  if (p.firstTokenMs === undefined) return "UNCLEAR — streamed but no content tokens seen";
  if (p.firstTokenMs > 0.4 * p.totalMs) {
    return `DEGRADED — first token at ${(p.firstTokenMs / 1000).toFixed(1)}s of ${(p.totalMs / 1000).toFixed(1)}s total; proxy is buffering`;
  }
  return `OK — ${p.chunkCount} chunks, first token in ${(p.firstTokenMs / 1000).toFixed(1)}s`;
}

async function probeStreaming(spec: LLMSpec): Promise<StreamProbe> {
  // A prompt that forces a long, steady answer so chunk counts are meaningful.
  const messages = [
    { role: "user" as const, content: "Count from 1 to 60. Put each number on its own line. No other text." },
  ];
  try {
    const r = await callChat(spec.name, messages, {
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
  } catch (e) {
    const err = e as LlmError;
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
async function probeContext(spec: LLMSpec, maxModelLen?: number): Promise<ContextProbe> {
  if (typeof maxModelLen === "number") {
    return { source: "max_model_len", tokens: maxModelLen, note: "reported by GET /models" };
  }
  const filler = "word ".repeat(60000); // ~300k chars; overflows anything in this registry
  try {
    await callChat(spec.name, [{ role: "user", content: filler }], {
      stream: false,
      maxTokens: 16,
      timeoutMs: 60000,
    });
    return { source: "unknown", note: "oversized prompt was accepted — context is larger than the probe" };
  } catch (e) {
    const err = e as LlmError;
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
async function probeAbort(spec: LLMSpec): Promise<AbortProbe> {
  const ac = createAbortController();
  const t0 = Date.now();
  const p = callChat(
    spec.name,
    [{ role: "user", content: "Write a very long essay about databases. At least 2000 words." }],
    { stream: true, maxTokens: 2000, signal: ac.signal, timeoutMs: 90000 }
  );
  setTimeout(() => ac.abort(), 1500);
  try {
    await p;
    return { aborted: false, note: "completed before the abort fired — inconclusive" };
  } catch (e) {
    const err = e as LlmError;
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

async function probeModel(
  spec: LLMSpec,
  report: (s: string) => void
): Promise<ModelReport> {
  report(`${spec.name}: health`);
  const health = await checkHealth(spec.name);

  let streaming: StreamProbe = {
    attempted: false, streamed: false, chunkCount: 0, totalMs: 0,
    verdict: "SKIPPED — endpoint unhealthy",
  };
  let context: ContextProbe = { source: "unknown", note: "skipped — endpoint unhealthy" };
  let abort: AbortProbe = { aborted: false, note: "skipped — endpoint unhealthy" };

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

function renderMarkdown(rep: GatewayReport): string {
  const L: string[] = [];
  L.push("# TechMind gateway diagnostics", "");
  L.push(`- **Generated:** ${rep.generatedAt}`);
  L.push(`- **Base URL:** \`${rep.baseUrl}\``, "");

  L.push("## Summary", "");
  L.push("| Model | Health | Streaming | Real context | Completion cap | Stop works |");
  L.push("|---|---|---|---|---|---|");
  for (const m of rep.models) {
    const ctx = m.context.tokens ? `${m.context.tokens}` : "unknown";
    L.push(
      `| ${m.name} | ${m.health.ok ? "ok" : "FAIL"} | ${m.streaming.verdict.split(" — ")[0]} | ${ctx} | ${m.completionCap} | ${m.abort.aborted ? "yes" : "no"} |`
    );
  }
  L.push("");

  const anyStreams = rep.models.some((m) => m.streaming.verdict.startsWith("OK"));
  L.push("## What this means", "");
  L.push(
    anyStreams
      ? "- The gateway **does** stream. Token-by-token rendering is live."
      : "- The gateway does **not** usefully stream. The panel falls back to a live phase indicator and elapsed timer; responses still arrive in one piece."
  );
  L.push(
    "- **Real context** is what the budgeter must use. Where it says `unknown`, the gateway exposed neither `max_model_len` nor an overflow limit."
  );
  L.push("- Models whose real context is at or below ~2048 tokens cannot host an agent loop: a prompted tool spec alone costs 600-900 tokens.", "");

  L.push("## Detail", "");
  for (const m of rep.models) {
    L.push(`### ${m.name}`, "");
    L.push(`- Path: \`${m.path}\`  ·  Model id: \`${m.model}\``);
    L.push(`- Health: ${m.health.detail} (${m.health.elapsedMs}ms)`);
    L.push(`- Streaming: ${m.streaming.verdict}`);
    if (m.streaming.attempted) {
      L.push(
        `  - chunks: ${m.streaming.chunkCount}, first token: ${m.streaming.firstTokenMs ?? "n/a"}ms, total: ${m.streaming.totalMs}ms, content-type: \`${m.streaming.contentType ?? "n/a"}\``
      );
    }
    if (m.streaming.error) L.push(`  - error: ${m.streaming.error}`);
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
export async function runDiagnostics(baseUrl: string): Promise<void> {
  const report = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "TechMind: probing gateway",
      cancellable: false,
    },
    async (progress) => {
      const models: ModelReport[] = [];
      for (const spec of LLM_REGISTRY) {
        progress.report({ message: spec.name });
        models.push(await probeModel(spec, (m) => progress.report({ message: m })));
      }
      return { generatedAt: new Date().toISOString(), baseUrl, models } as GatewayReport;
    }
  );

  const doc = await vscode.workspace.openTextDocument({
    content: renderMarkdown(report),
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}
