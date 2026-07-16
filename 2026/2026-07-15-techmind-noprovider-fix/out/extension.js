"use strict";
/**
 * extension.ts
 * Entry point. Registers the WAT layout:
 *   LEFT  — Workflows tree, Tools tree, Models tree (Activity Bar container)
 *   RIGHT — Agent webview panel
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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const sidebarProviders_1 = require("./sidebarProviders");
const agentPanel_1 = require("./agentPanel");
const llmRegistry_1 = require("./llmRegistry");
const sessionManager_1 = require("./sessionManager");
function activate(context) {
    // ── Models state (enabled/disabled) ──
    const initiallyEnabled = new Set(llmRegistry_1.LLM_REGISTRY.map((m) => m.name));
    const modelsProvider = new sidebarProviders_1.ModelsProvider(initiallyEnabled);
    // ── Sessions (persistent chat sessions, stored locally in globalState) ──
    const sessionManager = new sessionManager_1.SessionManager(context.globalState);
    const sessionsProvider = new sidebarProviders_1.SessionsProvider(sessionManager);
    agentPanel_1.AgentPanel.sessionManager = sessionManager;
    agentPanel_1.AgentPanel.refreshSessions = () => sessionsProvider.refresh();
    // ── Register TreeViews (LEFT side: Sessions, Workflows, Tools, Models) ──
    const workflowsProvider = new sidebarProviders_1.WorkflowsProvider();
    const toolsProvider = new sidebarProviders_1.ToolsProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider("techmind.sessions", sessionsProvider), vscode.window.registerTreeDataProvider("techmind.workflows", workflowsProvider), vscode.window.registerTreeDataProvider("techmind.tools", toolsProvider), vscode.window.registerTreeDataProvider("techmind.models", modelsProvider));
    // Ensure a first session exists so the panel always has somewhere to write.
    sessionManager.ensureActive().then(() => sessionsProvider.refresh());
    const getEnabledModels = () => modelsProvider.getEnabledSet();
    // ── Command: Open Agent Panel (RIGHT side) ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.openAgent", () => {
        agentPanel_1.AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
    }));
    // ── Command: New Session ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.newSession", async () => {
        await sessionManager.create();
        sessionsProvider.refresh();
        const agent = agentPanel_1.AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
        await agent.loadActiveSession();
    }));
    // ── Command: Switch to a Session (from the Sessions tree) ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.switchSession", async (sessionId) => {
        if (!sessionId)
            return;
        await sessionManager.setActive(sessionId);
        sessionsProvider.refresh();
        const agent = agentPanel_1.AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
        await agent.loadActiveSession();
    }));
    // ── Command: Rename a Session ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.renameSession", async (item) => {
        if (!item || !item.meta)
            return;
        const title = await vscode.window.showInputBox({
            prompt: "Rename session",
            value: item.meta.title,
        });
        if (title && title.trim()) {
            await sessionManager.rename(item.meta.id, title.trim());
            sessionsProvider.refresh();
        }
    }));
    // ── Command: Delete a Session ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.deleteSession", async (item) => {
        if (!item || !item.meta)
            return;
        const pick = await vscode.window.showWarningMessage(`Delete session "${item.meta.title}"? This cannot be undone.`, { modal: true }, "Delete");
        if (pick !== "Delete")
            return;
        const wasActive = sessionManager.getActiveId() === item.meta.id;
        await sessionManager.delete(item.meta.id);
        await sessionManager.ensureActive();
        sessionsProvider.refresh();
        if (wasActive && agentPanel_1.AgentPanel.currentPanel) {
            await agentPanel_1.AgentPanel.currentPanel.loadActiveSession();
        }
    }));
    // ── Command: Run a predefined workflow ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.runWorkflow", (workflow) => {
        const agent = agentPanel_1.AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
        agent.prefillStarter(workflow.starterPrompt, workflow.preferredLlm);
    }));
    // ── Command: Attach active editor file to agent context ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.attachActiveFile", () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("No active file open.");
            return;
        }
        const fileName = editor.document.fileName.split(/[\\/]/).pop() || "untitled";
        const content = editor.document.getText();
        const agent = agentPanel_1.AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
        agent.attachFile(fileName, content);
        vscode.window.showInformationMessage(`Attached ${fileName} to TechMind context.`);
    }));
    // ── Command: Send selected text directly to agent ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.attachSelection", () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showWarningMessage("No text selected.");
            return;
        }
        const text = editor.document.getText(editor.selection);
        const fileName = editor.document.fileName.split(/[\\/]/).pop() || "untitled";
        const agent = agentPanel_1.AgentPanel.createOrShow(context.extensionUri, getEnabledModels);
        agent.sendSelectionAsPrompt(text, fileName);
    }));
    // ── Command: Clear attached context ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.clearContext", () => {
        if (agentPanel_1.AgentPanel.currentPanel) {
            vscode.commands.executeCommand("techmind.openAgent");
        }
        vscode.window.showInformationMessage("TechMind context cleared.");
    }));
    // ── Command: Toggle a model enabled/disabled (from Models tree) ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.toggleModel", (modelName) => {
        modelsProvider.toggle(modelName);
    }));
    // ── Command: Check endpoint health for all models ──
    context.subscriptions.push(vscode.commands.registerCommand("techmind.checkEndpoints", async () => {
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Checking TechMind endpoints..." }, async () => {
            const results = [];
            for (const spec of llmRegistry_1.LLM_REGISTRY) {
                const r = await (0, llmRegistry_1.checkHealth)(spec.name);
                results.push(`${r.ok ? "✅" : "❌"} ${spec.name} — ${r.detail}`);
            }
            vscode.window.showInformationMessage(results.join("\n"), { modal: true });
        });
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map