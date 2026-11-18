import * as vscode from "vscode";
import type { Environment, Flag } from "./api";
import { formatValue, hoverMarkdown } from "./present";
import type { FlagStore } from "./store";

type Node = { kind: "env"; env: Environment } | { kind: "archived" } | { kind: "flag"; flag: Flag; env?: Environment } | { kind: "message"; text: string };

/** Tree of the selected project: one node per environment with its flags and their status, plus archived flags. */
export class FlagTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: FlagStore,
    private readonly dashboardUrl: () => string | undefined,
    private readonly signedIn: () => boolean,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      if (!this.signedIn()) return [];
      if (!this.store.loaded) return [{ kind: "message", text: this.store.lastError ? "Could not load flags. Refresh to retry." : "Loading flags…" }];
      const nodes: Node[] = this.store.environments.map((env) => ({ kind: "env", env }));
      if (this.store.flags.some((f) => f.archivedAt)) nodes.push({ kind: "archived" });
      if (this.store.environments.length === 0) nodes.push(...this.store.flags.filter((f) => !f.archivedAt).map((flag): Node => ({ kind: "flag", flag })));
      return nodes;
    }
    if (node.kind === "env") return this.store.flags.filter((f) => !f.archivedAt).map((flag) => ({ kind: "flag", flag, env: node.env }));
    if (node.kind === "archived") return this.store.flags.filter((f) => f.archivedAt).map((flag) => ({ kind: "flag", flag }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "message") return new vscode.TreeItem(node.text);
    if (node.kind === "archived") {
      const item = new vscode.TreeItem("Archived", vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("archive");
      return item;
    }
    if (node.kind === "env") {
      const item = new vscode.TreeItem(node.env.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = node.env.publishedRevision > 0 ? `revision ${node.env.publishedRevision}` : "not published";
      item.iconPath = new vscode.ThemeIcon(node.env.isProtected ? "shield" : "server-environment");
      item.contextValue = "environment";
      return item;
    }
    const f = node.flag;
    const item = new vscode.TreeItem(f.key, vscode.TreeItemCollapsibleState.None);
    item.contextValue = f.archivedAt ? "flag.archived" : "flag";
    item.tooltip = new vscode.MarkdownString(hoverMarkdown(f, this.store.statusOf(f.key), this.dashboardUrl(), this.store.project?.name));
    item.command = { command: "nanoflags.copyFlagKey", title: "Copy Flag Key", arguments: [f.key] };
    if (f.archivedAt) {
      item.iconPath = new vscode.ThemeIcon("archive");
      item.description = f.name !== f.key ? f.name : undefined;
      return item;
    }
    const s = node.env ? this.store.statusOf(f.key).find((x) => x.environment.key === node.env!.key) : undefined;
    const live = s?.published;
    if (!node.env) {
      item.iconPath = new vscode.ThemeIcon("symbol-boolean");
    } else if (!live) {
      item.iconPath = new vscode.ThemeIcon("circle-outline");
      item.description = "not published";
    } else if (live.enabled) {
      item.iconPath = new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"));
      item.description = `on · ${formatValue(live.default, 24)}`;
    } else {
      item.iconPath = new vscode.ThemeIcon("circle-slash");
      item.description = `off · ${formatValue(live.off, 24)}`;
    }
    return item;
  }
}

export type { Node as FlagTreeNode };
