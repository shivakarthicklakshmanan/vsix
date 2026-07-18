/**
 * config.ts
 * Central accessors for TechMind settings. Kept separate from llmRegistry so the
 * transport layer (llmClient) can read configuration without importing the
 * registry's routing logic, and vice versa — no circular imports.
 */

import * as vscode from "vscode";

const DEFAULT_BASE_URL = "https://chatbotapi.analytics.idb.gunk.in";
const DEFAULT_TIMEOUT_MS = 120000;

function cfg() {
  return vscode.workspace.getConfiguration("techmind");
}

export function getBaseUrl(): string {
  return cfg().get<string>("baseUrl") || DEFAULT_BASE_URL;
}

export function getTimeout(): number {
  return cfg().get<number>("timeoutMs") || DEFAULT_TIMEOUT_MS;
}

export function getGuidedMode(): boolean {
  return cfg().get<boolean>("guidedMode") ?? true;
}

/**
 * "auto" — try SSE, fall back to a buffered request if the gateway rejects it
 *          or answers with a non-SSE body (a buffering reverse proxy).
 * "on"   — always request SSE, surface the failure instead of falling back.
 * "off"  — never request SSE.
 */
export type StreamingMode = "auto" | "on" | "off";

export function getStreamingMode(): StreamingMode {
  const v = cfg().get<string>("streaming");
  return v === "on" || v === "off" ? v : "auto";
}
