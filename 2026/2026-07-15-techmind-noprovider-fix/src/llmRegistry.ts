/**
 * llmRegistry.ts
 * Model registry and task-based auto-routing.
 *
 * Transport lives in llmClient.ts; this file is data + routing only, so the two
 * can evolve independently and neither has to import the other's concerns.
 */

export interface LLMSpec {
  name: string;
  alias: string;
  model: string;
  path: string;          // appended to base URL, e.g. "/llama/v1"
  strengths: string;
  keywords: string[];
  priority: number;
  maxTokens: number;
  temperature: number;
}

export const LLM_REGISTRY: LLMSpec[] = [
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

export const SYSTEM_CONTEXT = `You are TechMind Studio, a senior technical consultant and implementation expert embedded directly in a developer's VS Code editor, inside an Indian Public Sector Bank's analytics environment.

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

export interface RouteResult {
  taskType: string;
  llmName: string;
  icon: string;
}

interface TaskRule {
  taskType: string;
  llmName: string;
  icon: string;
  keywords: string[];
}

const TASK_RULES: TaskRule[] = [
  { taskType: "Brainstorm / Analyse", llmName: "Qwen3-30B-Thinking", icon: "🧠",
    keywords: LLM_REGISTRY[1].keywords },
  { taskType: "Code / SQL / Spark", llmName: "Qwen3-8B", icon: "💻",
    keywords: LLM_REGISTRY[3].keywords },
  { taskType: "Review / Validate", llmName: "Gemma-4-31B", icon: "✅",
    keywords: LLM_REGISTRY[2].keywords },
  { taskType: "Implement / Plan", llmName: "Llama-3.3-70B", icon: "⚙️",
    keywords: LLM_REGISTRY[0].keywords },
];

export function autoRoute(query: string): RouteResult {
  const q = query.toLowerCase();
  let best: TaskRule = TASK_RULES[3]; // default: Implement/Plan
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

export function getLLM(name: string): LLMSpec | undefined {
  return LLM_REGISTRY.find((m) => m.name === name);
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  // string for plain text turns, or an array of content parts
  // (text + image_url blocks) for multimodal messages to vLLM.
  content: string | any[];
}
