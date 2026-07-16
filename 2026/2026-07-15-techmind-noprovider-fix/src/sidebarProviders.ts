/**
 * sidebarProviders.ts
 * TreeDataProviders that render the left-side "Workflows", "Tools" and
 * "Models" panels in the Activity Bar container.
 */

import * as vscode from "vscode";
import { WORKFLOWS, Workflow } from "./workflows";
import { LLM_REGISTRY } from "./llmRegistry";
import { SessionManager, SessionMeta } from "./sessionManager";

// ───────────────────────────── Workflows ─────────────────────────────

export class WorkflowItem extends vscode.TreeItem {
  constructor(public readonly workflow: Workflow) {
    super(`${workflow.icon}  ${workflow.label}`, vscode.TreeItemCollapsibleState.None);
    this.tooltip = workflow.description;
    this.description = workflow.preferredLlm;
    this.command = {
      command: "techmind.runWorkflow",
      title: "Run Workflow",
      arguments: [workflow],
    };
    this.contextValue = "workflowItem";
  }
}

export class WorkflowsProvider implements vscode.TreeDataProvider<WorkflowItem> {
  getTreeItem(element: WorkflowItem): vscode.TreeItem {
    return element;
  }
  getChildren(): WorkflowItem[] {
    return WORKFLOWS.map((w) => new WorkflowItem(w));
  }
}

// ─────────────────────────────── Tools ───────────────────────────────

interface ToolDef {
  label: string;
  icon: string;
  command: string;
  tooltip: string;
}

const TOOLS: ToolDef[] = [
  {
    label: "Attach Active File",
    icon: "$(file-add)",
    command: "techmind.attachActiveFile",
    tooltip: "Attach the currently open editor file to the agent's context",
  },
  {
    label: "Send Selection to Agent",
    icon: "$(arrow-right)",
    command: "techmind.attachSelection",
    tooltip: "Send the highlighted code/text directly to the agent panel",
  },
  {
    label: "Open Agent Panel",
    icon: "$(comment-discussion)",
    command: "techmind.openAgent",
    tooltip: "Open the TechMind Agent chat panel",
  },
  {
    label: "Clear Attached Context",
    icon: "$(clear-all)",
    command: "techmind.clearContext",
    tooltip: "Remove all files/selections currently attached to the agent",
  },
  {
    label: "Check Endpoint Health",
    icon: "$(pulse)",
    command: "techmind.checkEndpoints",
    tooltip: "Ping all configured vLLM endpoints",
  },
];

export class ToolItem extends vscode.TreeItem {
  constructor(tool: ToolDef) {
    super(tool.label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(tool.icon.replace(/^\$\(|\)$/g, ""));
    this.tooltip = tool.tooltip;
    this.command = { command: tool.command, title: tool.label };
  }
}

export class ToolsProvider implements vscode.TreeDataProvider<ToolItem> {
  getTreeItem(element: ToolItem): vscode.TreeItem {
    return element;
  }
  getChildren(): ToolItem[] {
    return TOOLS.map((t) => new ToolItem(t));
  }
}

// ─────────────────────────────── Models ───────────────────────────────

export class ModelItem extends vscode.TreeItem {
  constructor(public readonly modelName: string, public readonly enabled: boolean, public readonly strengths: string) {
    super(modelName, vscode.TreeItemCollapsibleState.None);
    this.description = enabled ? "enabled" : "disabled";
    this.tooltip = strengths;
    this.iconPath = new vscode.ThemeIcon(enabled ? "check" : "circle-slash");
    this.command = {
      command: "techmind.toggleModel",
      title: "Toggle Model",
      arguments: [modelName],
    };
  }
}

export class ModelsProvider implements vscode.TreeDataProvider<ModelItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private enabledSet: Set<string>;

  constructor(initialEnabled: Set<string>) {
    this.enabledSet = initialEnabled;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  isEnabled(name: string): boolean {
    return this.enabledSet.has(name);
  }

  toggle(name: string): void {
    if (this.enabledSet.has(name)) {
      this.enabledSet.delete(name);
    } else {
      this.enabledSet.add(name);
    }
    this.refresh();
  }

  getEnabledSet(): Set<string> {
    return this.enabledSet;
  }

  getTreeItem(element: ModelItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ModelItem[] {
    return LLM_REGISTRY.map(
      (m) => new ModelItem(m.name, this.enabledSet.has(m.name), m.strengths)
    );
  }
}

// ─────────────────────────────── Sessions ───────────────────────────────

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export class SessionItem extends vscode.TreeItem {
  constructor(public readonly meta: SessionMeta, active: boolean) {
    super(meta.title || "Untitled Session", vscode.TreeItemCollapsibleState.None);
    this.description = `${active ? "● " : ""}${meta.messageCount} msg · ${relTime(meta.updatedAt)}`;
    this.tooltip = `${meta.title}\nUpdated ${new Date(meta.updatedAt).toLocaleString()}\n${meta.messageCount} messages`;
    this.iconPath = new vscode.ThemeIcon(active ? "comment-discussion" : "comment");
    this.contextValue = "sessionItem";
    this.command = {
      command: "techmind.switchSession",
      title: "Open Session",
      arguments: [meta.id],
    };
  }
}

export class SessionsProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private sessions: SessionManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionItem[] {
    const activeId = this.sessions.getActiveId();
    return this.sessions.list().map((m) => new SessionItem(m, m.id === activeId));
  }
}
