/**
 * sidebarProviders.ts
 * TreeDataProviders that render the left-side "Workflows", "Tools" and
 * "Models" panels in the Activity Bar container.
 */

import * as vscode from "vscode";
import { WORKFLOWS, Workflow } from "./workflows";
import { LLM_REGISTRY } from "./llmRegistry";

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
