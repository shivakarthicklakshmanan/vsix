/**
 * extension.ts
 * Entry point. Registers the WAT layout:
 *   LEFT  — Workflows tree, Tools tree, Models tree (Activity Bar container)
 *   RIGHT — Agent webview panel
 */

import * as vscode from "vscode";
import { WorkflowsProvider, ToolsProvider, ModelsProvider, SessionsProvider, SessionItem } from "./sidebarProviders";
import { AgentPanel } from "./agentPanel";
import { Workflow } from "./workflows";
import { LLM_REGISTRY, checkHealth } from "./llmRegistry";
import { SessionManager } from "./sessionManager";

export function activate(context: vscode.ExtensionContext) {
  // ── Models state (enabled/disabled) ──
  const initiallyEnabled = new Set(LLM_REGISTRY.map((m) => m.name));
  const modelsProvider = new ModelsProvider(initiallyEnabled);

  // ── Sessions (persistent chat sessions, stored locally in globalState) ──
  const sessionManager = new SessionManager(context.globalState);
  const sessionsProvider = new SessionsProvider(sessionManager);
  AgentPanel.sessionManager = sessionManager;
  AgentPanel.refreshSessions = () => sessionsProvider.refresh();

  // ── Register TreeViews (LEFT side: Sessions, Workflows, Tools, Models) ──
  const workflowsProvider = new WorkflowsProvider();
  const toolsProvider = new ToolsProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("techmind.sessions", sessionsProvider),
    vscode.window.registerTreeDataProvider("techmind.workflows", workflowsProvider),
    vscode.window.registerTreeDataProvider("techmind.tools", toolsProvider),
    vscode.window.registerTreeDataProvider("techmind.models", modelsProvider)
  );

  // Ensure a first session exists so the panel always has somewhere to write.
  sessionManager.ensureActive().then(() => sessionsProvider.refresh());

  const getEnabledModels = () => modelsProvider.getEnabledSet();

  // ── Command: Open Agent Panel (RIGHT side) ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.openAgent", () => {
      AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
    })
  );

  // ── Command: New Session ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.newSession", async () => {
      await sessionManager.create();
      sessionsProvider.refresh();
      const agent = AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
      await agent.loadActiveSession();
    })
  );

  // ── Command: Switch to a Session (from the Sessions tree) ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.switchSession", async (sessionId: string) => {
      if (!sessionId) return;
      await sessionManager.setActive(sessionId);
      sessionsProvider.refresh();
      const agent = AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
      await agent.loadActiveSession();
    })
  );

  // ── Command: Rename a Session ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.renameSession", async (item: SessionItem) => {
      if (!item || !item.meta) return;
      const title = await vscode.window.showInputBox({
        prompt: "Rename session",
        value: item.meta.title,
      });
      if (title && title.trim()) {
        await sessionManager.rename(item.meta.id, title.trim());
        sessionsProvider.refresh();
      }
    })
  );

  // ── Command: Delete a Session ──
  context.subscriptions.push(
    vscode.commands.registerCommand("techmind.deleteSession", async (item: SessionItem) => {
      if (!item || !item.meta) return;
      const pick = await vscode.window.showWarningMessage(
        `Delete session "${item.meta.title}"? This cannot be undone.`,
        { modal: true },
        "Delete"
      );
      if (pick !== "Delete") return;
      const wasActive = sessionManager.getActiveId() === item.meta.id;
      await sessionManager.delete(item.meta.id);
      await sessionManager.ensureActive();
      sessionsProvider.refresh();
      if (wasActive && AgentPanel.currentPanel) {
        await AgentPanel.currentPanel.loadActiveSession();
      }
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
            results.push(`${r.ok ? "✅" : "❌"} ${spec.name} — ${r.detail}`);
          }
          vscode.window.showInformationMessage(results.join("\n"), { modal: true });
        }
      );
    })
  );
}

export function deactivate() {}
