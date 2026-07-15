/**
 * workflows.ts
 * Predefined workflows shown in the left sidebar. Each pre-loads a mode
 * and a starter prompt template into the Agent panel.
 */

export interface Workflow {
  id: string;
  label: string;
  icon: string;
  description: string;
  preferredLlm: string;
  starterPrompt: string;
}

export const WORKFLOWS: Workflow[] = [
  {
    id: "brainstorm",
    label: "Brainstorm Approach",
    icon: "🧠",
    description: "Explore multiple solution approaches before committing to one",
    preferredLlm: "Qwen3-30B-Thinking",
    starterPrompt: "I want to brainstorm approaches for: ",
  },
  {
    id: "implement",
    label: "Implementation Plan",
    icon: "⚙️",
    description: "Turn a requirement into a concrete, step-by-step build plan",
    preferredLlm: "Llama-3.3-70B",
    starterPrompt: "Give me an implementation plan for: ",
  },
  {
    id: "debug",
    label: "Debug Error",
    icon: "🐛",
    description: "Diagnose an error/traceback and get a corrected fix",
    preferredLlm: "Qwen3-8B",
    starterPrompt: "I'm getting this error, please diagnose and fix:\n\n",
  },
  {
    id: "review",
    label: "Review Code",
    icon: "✅",
    description: "Get a structured review of attached code or selection",
    preferredLlm: "Gemma-4-31B",
    starterPrompt: "Please review this code for correctness, edge cases and improvements:\n\n",
  },
  {
    id: "design_table",
    label: "Data Table Design",
    icon: "🗂️",
    description: "Design a base table / schema with column-level logic",
    preferredLlm: "Llama-3.3-70B",
    starterPrompt: "Help me design a data table for this use case, with logic for each column: ",
  },
  {
    id: "agent_design",
    label: "Agent / LangGraph Design",
    icon: "🕸️",
    description: "Design or extend a multi-agent LangGraph pipeline",
    preferredLlm: "Llama-3.3-70B",
    starterPrompt: "Help me design the agent architecture (LangGraph) for: ",
  },
  {
    id: "sql_spark",
    label: "SQL / Spark Job",
    icon: "🔥",
    description: "Write or fix a SQL query or Spark job",
    preferredLlm: "Qwen3-8B",
    starterPrompt: "Write a SQL/Spark job that does the following: ",
  },
  {
    id: "explain",
    label: "Explain / Summarise",
    icon: "📖",
    description: "Get a clear explanation of a concept, file, or output",
    preferredLlm: "Llama-3.3-70B",
    starterPrompt: "Explain the following clearly: ",
  },
];
