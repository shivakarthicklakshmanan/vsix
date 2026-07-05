"use strict";
/**
 * llmRegistry.ts
 * Model registry, task-based auto-routing, and direct HTTPS calls to
 * the airgapped vLLM gateway. Mirrors the logic from TechMind Studio (Streamlit).
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
exports.SYSTEM_CONTEXT = exports.LLM_REGISTRY = void 0;
exports.autoRoute = autoRoute;
exports.getLLM = getLLM;
exports.callLLM = callLLM;
exports.callWithFallback = callWithFallback;
exports.checkHealth = checkHealth;
const https = __importStar(require("https"));
const vscode = __importStar(require("vscode"));
exports.LLM_REGISTRY = [
    {
        name: "Llama-3.3-70B",
        alias: "llama70b",
        model: "Nvidia/Llama-3.3-70B-Instruct-FP8",
        path: "/llama/v1",
        strengths: "Structured output, implementation plans, orchestration, fact bundles",
        keywords: ["implement", "build", "plan", "design", "explain", "summarise", "summarize",
            "pipeline", "schema", "workflow", "what is", "describe"],
        priority: 1,
        maxTokens: 4096,
        temperature: 0.2,
    },
    {
        name: "Qwen3-30B-Thinking",
        alias: "qwen30b",
        model: "Qwen/Qwen--Qwen3-30B-A3B-Thinking-2507-FP8",
        path: "/qwen30b/v1",
        strengths: "Deep reasoning, brainstorming, root cause analysis, architecture comparisons",
        keywords: ["brainstorm", "analyse", "analyze", "why", "root cause", "compare",
            "architect", "approach", "strategy", "think", "explore", "pros cons"],
        priority: 2,
        maxTokens: 4096,
        temperature: 0.3,
    },
    {
        name: "Gemma-4-31B",
        alias: "gemma31b",
        model: "RedHatAI--gemma-4-31B-it-FP8-block",
        path: "/gemma/v1",
        strengths: "QA, validation, business logic clarification, review",
        keywords: ["review", "validate", "check", "verify", "qa", "feedback", "clarify",
            "does this work", "improve", "is this right"],
        priority: 3,
        maxTokens: 3072,
        temperature: 0.2,
    },
    {
        name: "Qwen3-8B",
        alias: "qwen8b",
        model: "RedHatAI/Qwen3-8B-NVFP4",
        path: "/qwenq/v1",
        strengths: "Fast code generation, SQL, Spark, lightweight scripting",
        keywords: ["code", "sql", "spark", "python", "function", "class", "script",
            "query", "fix", "error", "exception", "traceback", "bug", "debug"],
        priority: 4,
        maxTokens: 2048,
        temperature: 0.1,
    },
    {
        name: "Qwen2.5-7B",
        alias: "qwen25",
        model: "Qwen/Qwen2.5-7B-Instruct",
        path: "/qwen25-7b/v1",
        strengths: "Sanity checks, format conversion, self-correction",
        keywords: ["sanity", "format", "convert", "test", "verify output"],
        priority: 5,
        maxTokens: 2048,
        temperature: 0.1,
    },
    {
        name: "CodeLlama-13B",
        alias: "codellama",
        model: "meta-llama/CodeLlama-13b-Instruct-hf",
        path: "/codellama/v1",
        strengths: "Narrow code completion fallback",
        keywords: [],
        priority: 6,
        maxTokens: 2048,
        temperature: 0.1,
    },
];
exports.SYSTEM_CONTEXT = `You are TechMind Studio, a senior technical consultant and implementation expert embedded directly in a developer's VS Code editor, inside an Indian Public Sector Bank's analytics environment.

## YOUR ENVIRONMENT (ALWAYS RESPECT THESE CONSTRAINTS)
- STRICTLY AIRGAPPED — no internet, no cloud APIs, zero external calls allowed
- Database: IBM Db2 (BLUDB), accessed via ibm_db Python library
- Orchestration: LangGraph (Python-based agent workflows)
- Data pipelines: Apache Spark, SQL on Db2
- LLM serving: vLLM with OpenAI-compatible /v1/chat/completions endpoints
- Available LLMs: Llama-3.3-70B, Qwen3-30B-Thinking, Gemma-4-31B, Qwen3-8B, Qwen2.5-7B, CodeLlama-13B

## YOUR DOMAIN EXPERTISE
- Indian Public Sector Bank operations, CBS systems, branch hierarchy, DGM/B&O workflows
- Outlier detection: branch transfer reversal detection, suspicion scoring, watchlist patterns
- Agentic AI design: multi-agent LangGraph pipelines, tool-calling agents, human-in-the-loop
- Data engineering: nightly Spark jobs, BLUDB tool exposure, fact bundles, justification narratives

## YOUR BEHAVIOUR — INTERACTIVE EDITOR MODE
- You are operating inside an editor's side panel. The developer may attach open files or selections as context.
- Give Claude-equivalent depth, clarity and quality in every response.
- For complex or ambiguous requests, ask ONE clarifying question before producing a large output — do not guess silently.
- When given code or errors, diagnose precisely and give corrected code, not vague advice.
- When given requirements, produce concrete deliverables: table designs, data flows, agent contracts, code.
- Use tables, structured sections, and code blocks. Suppress LaTeX/math symbols.
- Never suggest cloud APIs, SaaS tools, or anything that touches the internet.
- Code blocks should be directly insertable into the developer's file — clean, complete, no placeholders unless explicitly marked.`;
const TASK_RULES = [
    { taskType: "Brainstorm / Analyse", llmName: "Qwen3-30B-Thinking", icon: "🧠",
        keywords: exports.LLM_REGISTRY[1].keywords },
    { taskType: "Code / SQL / Spark", llmName: "Qwen3-8B", icon: "💻",
        keywords: exports.LLM_REGISTRY[3].keywords },
    { taskType: "Review / Validate", llmName: "Gemma-4-31B", icon: "✅",
        keywords: exports.LLM_REGISTRY[2].keywords },
    { taskType: "Implement / Plan", llmName: "Llama-3.3-70B", icon: "⚙️",
        keywords: exports.LLM_REGISTRY[0].keywords },
];
function autoRoute(query) {
    const q = query.toLowerCase();
    let best = TASK_RULES[3]; // default: Implement/Plan
    let bestScore = 0;
    for (const rule of TASK_RULES) {
        const score = rule.keywords.reduce((acc, kw) => acc + (q.includes(kw) ? 1 : 0), 0);
        if (score > bestScore) {
            bestScore = score;
            best = rule;
        }
    }
    return { taskType: best.taskType, llmName: best.llmName, icon: best.icon };
}
function getLLM(name) {
    return exports.LLM_REGISTRY.find((m) => m.name === name);
}
function getBaseUrl() {
    return vscode.workspace.getConfiguration("techmind").get("baseUrl") ||
        "https://chatbotapi.analytics.idb.gunk.in";
}
function getTimeout() {
    return vscode.workspace.getConfiguration("techmind").get("timeoutMs") || 120000;
}
/** Direct HTTPS POST to the internal vLLM gateway. No proxy, no external host. */
function callLLM(llmName, messages, overrideTokens) {
    return new Promise((resolve) => {
        const spec = getLLM(llmName);
        if (!spec) {
            resolve({ text: "", llmUsed: llmName, elapsedMs: 0, error: `Unknown model: ${llmName}` });
            return;
        }
        const baseUrl = getBaseUrl();
        const fullUrl = new URL(`${baseUrl}${spec.path}/chat/completions`);
        const payload = JSON.stringify({
            model: spec.model,
            messages,
            max_tokens: overrideTokens || spec.maxTokens,
            temperature: spec.temperature,
        });
        const options = {
            hostname: fullUrl.hostname,
            port: fullUrl.port || 443,
            path: fullUrl.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
                Authorization: "Bearer EMPTY",
            },
            timeout: getTimeout(),
            // Internal CA chains on airgapped networks are often self-signed;
            // if your gateway uses a trusted internal CA, set this to true
            // and configure NODE_EXTRA_CA_CERTS instead.
            rejectUnauthorized: false,
        };
        const t0 = Date.now();
        const req = https.request(options, (res) => {
            let raw = "";
            res.on("data", (chunk) => (raw += chunk));
            res.on("end", () => {
                const elapsedMs = Date.now() - t0;
                if (res.statusCode !== 200) {
                    resolve({ text: "", llmUsed: llmName, elapsedMs, error: `HTTP ${res.statusCode}: ${raw.slice(0, 300)}` });
                    return;
                }
                try {
                    const data = JSON.parse(raw);
                    const text = data.choices?.[0]?.message?.content ?? "";
                    resolve({ text, llmUsed: llmName, elapsedMs, error: "" });
                }
                catch (e) {
                    resolve({ text: "", llmUsed: llmName, elapsedMs, error: `Parse error: ${e.message}` });
                }
            });
        });
        req.on("timeout", () => {
            req.destroy();
            resolve({ text: "", llmUsed: llmName, elapsedMs: Date.now() - t0, error: "Request timed out" });
        });
        req.on("error", (e) => {
            resolve({ text: "", llmUsed: llmName, elapsedMs: Date.now() - t0, error: e.message });
        });
        req.write(payload);
        req.end();
    });
}
/** Tries primary model, falls back through the enabled registry in priority order. */
async function callWithFallback(primaryLlm, messages, enabledModels) {
    if (enabledModels.has(primaryLlm)) {
        const result = await callLLM(primaryLlm, messages);
        if (!result.error)
            return result;
    }
    const sorted = [...exports.LLM_REGISTRY].sort((a, b) => a.priority - b.priority);
    for (const spec of sorted) {
        if (spec.name === primaryLlm || !enabledModels.has(spec.name))
            continue;
        const result = await callLLM(spec.name, messages);
        if (!result.error) {
            result.error = `(fell back from ${primaryLlm})`;
            return result;
        }
    }
    return { text: "", llmUsed: primaryLlm, elapsedMs: 0, error: `All enabled models failed, starting from ${primaryLlm}` };
}
/** Quick health check against a model's endpoint. */
function checkHealth(llmName) {
    return new Promise((resolve) => {
        const spec = getLLM(llmName);
        if (!spec) {
            resolve({ ok: false, detail: "Unknown model" });
            return;
        }
        const baseUrl = getBaseUrl();
        const fullUrl = new URL(`${baseUrl}${spec.path}/models`);
        const options = {
            hostname: fullUrl.hostname,
            port: fullUrl.port || 443,
            path: fullUrl.pathname,
            method: "GET",
            timeout: 8000,
            rejectUnauthorized: false,
        };
        const req = https.request(options, (res) => {
            resolve({ ok: res.statusCode === 200, detail: `HTTP ${res.statusCode}` });
        });
        req.on("timeout", () => {
            req.destroy();
            resolve({ ok: false, detail: "Timeout" });
        });
        req.on("error", (e) => resolve({ ok: false, detail: e.message }));
        req.end();
    });
}
//# sourceMappingURL=llmRegistry.js.map