/**
 * extension.ts
 * Entry point. Registers the WAT layout:
 *   LEFT  — Workflows tree, Tools tree, Models tree (Activity Bar container)
 *   RIGHT — Agent webview panel
 */

import * as vscode from "vscode";
import { WorkflowsProvider, ToolsProvider, ModelsProvider } from "./sidebarProviders";
import { AgentPanel } from "./agentPanel";
import { Workflow } from "./workflows";
import { LLM_REGISTRY } from "./llmRegistry";
import { checkHealth } from "./llmClient";
import { getBaseUrl } from "./config";
import { runDiagnostics } from "./diagnostics";

export function activate(context: vscode.ExtensionContext) {
  // ── Models state (enabled/disabled) ──
  const initiallyEnabled = new Set(LLM_REGISTRY.map((m) => m.name));
  const modelsProvider = new ModelsProvider(initiallyEnabled);

  // ── Register TreeViews (LEFT side: Workflows, Tools, Models) ──
  const workflowsProvider = new WorkflowsProvider();
  const toolsProvider = new ToolsProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("techmind.workflows", workflowsProvider),
    vscode.window.registerTreeDataProvider("techmind.tools", toolsProvider),
    vscode.window.registerTreeDataProvider("techmind.models", modelsProvider)
  );

  const getEnabledModels = () => modelsProvider.getEnabledSet();

  // ── Command: Open Agent Panel (RIGHT side) ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.openAgent", () => {
      AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
    })
  );

  // ── Command: Run a predefined workflow ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.runWorkflow", (workflow: Workflow) => {
      const agent = AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
      agent.prefillStarter(workflow.starterPrompt, workflow.preferredLlm);
    })
  );

  // ── Command: Attach active editor file to agent context ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.attachActiveFile", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active file open.");
        return;
      }
      const fileName = editor.document.fileName.split(/[\\/]/).pop() || "untitled";
      const content = editor.document.getText();
      const agent = AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
      agent.attachFile(fileName, content);
      vscode.window.showInformationMessage(`Attached ${fileName} to TechMind context.`);
    })
  );

  // ── Command: Send selected text directly to agent ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.attachSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage("No text selected.");
        return;
      }
      const text = editor.document.getText(editor.selection);
      const fileName = editor.document.fileName.split(/[\\/]/).pop() || "untitled";
      const agent = AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
      agent.sendSelectionAsPrompt(text, fileName);
    })
  );

  // ── Command: Clear attached context ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.clearContext", () => {
      if (AgentPanel.currentPanel) {
        vscode.commands.executeCommand("techmind.openAgent");
      }
      vscode.window.showInformationMessage("TechMind context cleared.");
    })
  );

  // ── Command: Toggle a model enabled/disabled (from Models tree) ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.toggleModel", (modelName: string) => {
      modelsProvider.toggle(modelName);
    })
  );

  // ── Command: Check endpoint health for all models ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.checkEndpoints", async () => {
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Checking TechMind endpoints..." },
        async () => {
          const results: string[] = [];
          for (const spec of LLM_REGISTRY) {
            const r = await checkHealth(spec.name);
            const ctx = r.maxModelLen ? ` · context ${r.maxModelLen}` : "";
            results.push(`${r.ok ? "✅" : "❌"} ${spec.name} — ${r.detail}${ctx}`);
          }
          vscode.window.showInformationMessage(results.join("\n"), { modal: true });
        }
      );
    })
  );

  // ── Command: Full gateway diagnostics (streaming, real context window, cancel) ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.diagnostics", async () => {
      try {
        await runDiagnostics(getBaseUrl());
      } catch (e: any) {
        vscode.window.showErrorMessage(`TechMind diagnostics failed: ${e?.message ?? e}`);
      }
    })
  );
}

export function deactivate() {}
