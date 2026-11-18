import * as vscode from "vscode";
import { API_TOKEN_RE, ManagementClient, explainError, type Flag, type TokenInfo } from "./api";
import { closest, dashboardFlagUrl, hoverMarkdown, problems } from "./present";
import { LANGUAGES, completionContextAt, refAt, scanText, type FlagRef } from "./scanner";
import { FlagStore } from "./store";
import { FlagTreeProvider, type FlagTreeNode } from "./tree";

const SECRET_KEY = "nanoflags.apiToken";
const PROJECT_STATE = "nanoflags.project";
const SELECTOR: vscode.DocumentSelector = LANGUAGES.flatMap((language) => [
  { language, scheme: "file" },
  { language, scheme: "untitled" },
]);

type Severity = "error" | "warning" | "information" | "hint" | "off";

function cfg() {
  const c = vscode.workspace.getConfiguration("nanoflags");
  return {
    baseUrl: c.get<string>("baseUrl") || undefined,
    dashboardUrl: c.get<string>("dashboardUrl") || undefined,
    project: c.get<string>("project") || undefined,
    cacheMinutes: c.get<number>("cacheMinutes") ?? 5,
    unknownSeverity: (c.get<string>("diagnostics.unknownFlags") ?? "warning") as Severity,
    archivedSeverity: (c.get<string>("diagnostics.archivedFlags") ?? "warning") as Severity,
    codeLens: c.get<boolean>("codeLens.enabled") ?? true,
  };
}

function toSeverity(s: Severity): vscode.DiagnosticSeverity | undefined {
  switch (s) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "information":
      return vscode.DiagnosticSeverity.Information;
    case "hint":
      return vscode.DiagnosticSeverity.Hint;
    default:
      return undefined;
  }
}

/** Extension state shared by the providers. Exported for tests. */
export class NanoFlags implements vscode.Disposable {
  token: string | undefined;
  tokenInfo: TokenInfo | undefined;
  readonly store: FlagStore;
  readonly diagnostics: vscode.DiagnosticCollection;
  readonly tree: FlagTreeProvider;
  private readonly refsCache = new Map<string, { version: number; refs: FlagRef[] }>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    readonly context: vscode.ExtensionContext,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.store = new FlagStore(() => this.client(), { ttlMs: cfg().cacheMinutes * 60_000 });
    this.diagnostics = vscode.languages.createDiagnosticCollection("nanoflags");
    this.tree = new FlagTreeProvider(this.store, () => cfg().dashboardUrl, () => this.token !== undefined);
    this.disposables.push(
      this.diagnostics,
      this.store.onDidChange(() => {
        this.tree.refresh();
        this.lensEmitter.fire();
        this.updateAllDiagnostics();
      }),
    );
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }

  client(): ManagementClient | undefined {
    if (!this.token) return undefined;
    const version = (this.context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "dev";
    return new ManagementClient({ token: this.token, baseUrl: cfg().baseUrl, fetch: this.fetchImpl, userAgent: `vscode-nanoflags/${version}` });
  }

  /** The project to use: setting, then the token's project, then the one picked earlier. */
  projectKey(): string | undefined {
    return cfg().project ?? this.tokenInfo?.projectKey ?? this.context.workspaceState.get<string>(PROJECT_STATE);
  }

  async restore(): Promise<void> {
    this.token = await this.context.secrets.get(SECRET_KEY);
    await vscode.commands.executeCommand("setContext", "nanoflags.signedIn", this.token !== undefined);
    if (this.token) await this.load(false);
  }

  /** Loads (or refreshes) the flags of the current project; asks for a project when none is known. */
  async load(force: boolean): Promise<void> {
    if (!this.token) return;
    if (!this.tokenInfo) {
      try {
        this.tokenInfo = await this.client()!.token();
      } catch (e) {
        void vscode.window.showWarningMessage(`NanoFlags: ${explainError(e)}`);
        return;
      }
    }
    let project = this.projectKey();
    if (!project) project = await this.pickProject();
    if (!project) return;
    if (force) await this.store.refresh(project);
    else await this.store.ensureFresh(project);
    if (this.store.lastError) void vscode.window.showWarningMessage(`NanoFlags: ${explainError(this.store.lastError)}`);
  }

  async pickProject(): Promise<string | undefined> {
    const c = this.client();
    if (!c) return undefined;
    let projects;
    try {
      projects = await c.projects();
    } catch (e) {
      void vscode.window.showErrorMessage(`NanoFlags: ${explainError(e)}`);
      return undefined;
    }
    if (projects.length === 0) {
      void vscode.window.showWarningMessage("NanoFlags: this token cannot see any project.");
      return undefined;
    }
    let key = projects[0]!.key;
    if (projects.length > 1) {
      const pick = await vscode.window.showQuickPick(
        projects.map((p) => ({ label: p.name, description: p.key, key: p.key })),
        { placeHolder: "NanoFlags project for this workspace" },
      );
      if (!pick) return undefined;
      key = pick.key;
    }
    await this.context.workspaceState.update(PROJECT_STATE, key);
    return key;
  }

  async signIn(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: "Sign in to NanoFlags",
      prompt: "Paste a Management API token (Settings → API tokens in the dashboard). It needs the flags:read scope and is stored in VS Code's secret storage.",
      placeHolder: "nf_api_…",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (API_TOKEN_RE.test(v.trim()) ? undefined : "A Management API token looks like nf_api_ followed by 48 hex characters."),
    });
    if (!token) return;
    const client = new ManagementClient({ token: token.trim(), baseUrl: cfg().baseUrl, fetch: this.fetchImpl });
    let info: TokenInfo;
    try {
      info = await client.token();
    } catch (e) {
      void vscode.window.showErrorMessage(`NanoFlags: ${explainError(e)}`);
      return;
    }
    if (!info.scopes.includes("flags:read") && !info.scopes.includes("flags:write")) {
      void vscode.window.showWarningMessage("NanoFlags: this token has no flags:read scope; flags cannot be listed. Create a token with flags:read.");
    }
    this.token = token.trim();
    this.tokenInfo = info;
    await this.context.secrets.store(SECRET_KEY, this.token);
    await vscode.commands.executeCommand("setContext", "nanoflags.signedIn", true);
    void vscode.window.showInformationMessage(`NanoFlags: signed in with “${info.name}”${info.projectKey ? ` (project ${info.projectKey})` : ""}.`);
    this.store.clear();
    await this.load(true);
  }

  async signOut(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    this.token = undefined;
    this.tokenInfo = undefined;
    this.store.clear();
    this.diagnostics.clear();
    await vscode.commands.executeCommand("setContext", "nanoflags.signedIn", false);
    void vscode.window.showInformationMessage("NanoFlags: signed out; the API token was removed from secret storage.");
  }

  refs(doc: vscode.TextDocument): FlagRef[] {
    const k = doc.uri.toString();
    const hit = this.refsCache.get(k);
    if (hit && hit.version === doc.version) return hit.refs;
    const refs = scanText(doc.getText(), doc.languageId);
    this.refsCache.set(k, { version: doc.version, refs });
    return refs;
  }

  forget(doc: vscode.TextDocument): void {
    this.refsCache.delete(doc.uri.toString());
    this.diagnostics.delete(doc.uri);
  }

  updateDiagnostics(doc: vscode.TextDocument): void {
    if (!LANGUAGES.includes(doc.languageId)) return;
    if (!this.token || !this.store.loaded) {
      this.diagnostics.delete(doc.uri);
      return;
    }
    const c = cfg();
    const unknown = toSeverity(c.unknownSeverity);
    const archived = toSeverity(c.archivedSeverity);
    const keys = this.store.flags.map((f) => f.key);
    const out: vscode.Diagnostic[] = [];
    for (const p of problems(this.refs(doc), (key) => this.store.get(key), this.store.project?.name ?? "")) {
      const sev = p.kind === "unknown" ? unknown : archived;
      if (sev === undefined) continue;
      let message = p.message;
      if (p.kind === "unknown") {
        const near = closest(p.key, keys);
        if (near) message += ` Did you mean "${near}"?`;
      }
      const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(p.start), doc.positionAt(p.end)), message, sev);
      d.source = "NanoFlags";
      d.code = p.kind === "unknown" ? "unknown-flag" : "archived-flag";
      if (p.kind === "archived") d.tags = [vscode.DiagnosticTag.Deprecated];
      out.push(d);
    }
    this.diagnostics.set(doc.uri, out);
  }

  scheduleDiagnostics(doc: vscode.TextDocument): void {
    const k = doc.uri.toString();
    clearTimeout(this.timers.get(k));
    this.timers.set(
      k,
      setTimeout(() => {
        this.timers.delete(k);
        this.updateDiagnostics(doc);
      }, 300),
    );
  }

  updateAllDiagnostics(): void {
    for (const doc of vscode.workspace.textDocuments) this.updateDiagnostics(doc);
  }

  /** Lazily refreshes stale data when a provider needs it, without blocking the provider. */
  touch(): void {
    if (this.token && this.store.isStale()) void this.load(false);
  }

  readonly hover: vscode.HoverProvider = {
    provideHover: (doc, position) => {
      const ref = refAt(this.refs(doc), doc.offsetAt(position));
      if (!ref) return undefined;
      this.touch();
      const flag = this.store.get(ref.key);
      const range = new vscode.Range(doc.positionAt(ref.start), doc.positionAt(ref.end));
      if (!flag) {
        if (!ref.strong) return undefined;
        const text = !this.token
          ? "NanoFlags: [sign in](command:nanoflags.signIn) to see this flag."
          : this.store.loaded
            ? `NanoFlags: no flag \`${ref.key}\` in project ${this.store.project?.name ?? ""}.`
            : "NanoFlags: loading flags…";
        const ms = new vscode.MarkdownString(text);
        ms.isTrusted = { enabledCommands: ["nanoflags.signIn"] };
        return new vscode.Hover(ms, range);
      }
      return new vscode.Hover(new vscode.MarkdownString(hoverMarkdown(flag, this.store.statusOf(flag.key), cfg().dashboardUrl, this.store.project?.name)), range);
    },
  };

  readonly codeLens: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: this.lensEmitter.event,
    provideCodeLenses: (doc) => {
      if (!cfg().codeLens || !this.store.loaded) return [];
      const seen = new Set<string>();
      const lenses: vscode.CodeLens[] = [];
      for (const r of this.refs(doc)) {
        const flag = this.store.get(r.key);
        if (!flag) continue;
        const pos = doc.positionAt(r.start);
        const id = `${pos.line}:${r.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const range = new vscode.Range(pos, doc.positionAt(r.end));
        lenses.push(new vscode.CodeLens(range, { title: `Open in NanoFlags: ${flag.name}${flag.archivedAt ? " (archived)" : ""}`, command: "nanoflags.openInDashboard", arguments: [r.key] }));
      }
      return lenses;
    },
  };

  readonly completion: vscode.CompletionItemProvider = {
    provideCompletionItems: (doc, position) => {
      const line = doc.lineAt(position.line).text;
      const ctx = completionContextAt(line, position.character);
      if (!ctx) return undefined;
      this.touch();
      const start = new vscode.Position(position.line, position.character - ctx.prefix.length);
      const range = new vscode.Range(start, position);
      return this.store.flags.map((f: Flag) => {
        const item = new vscode.CompletionItem(f.key, vscode.CompletionItemKind.Constant);
        item.range = range;
        item.detail = `${f.name} · ${f.type}${f.archivedAt ? " · archived" : ""}`;
        item.documentation = new vscode.MarkdownString(hoverMarkdown(f, this.store.statusOf(f.key), cfg().dashboardUrl, this.store.project?.name));
        item.sortText = `${f.archivedAt ? "1" : "0"}${f.key}`;
        if (f.archivedAt) item.tags = [vscode.CompletionItemTag.Deprecated];
        return item;
      });
    },
  };

  /** Resolves a command argument (a key, a tree node or nothing) to a flag key, asking when needed. */
  async resolveKey(arg: unknown): Promise<string | undefined> {
    if (typeof arg === "string") return arg;
    if (arg && typeof arg === "object" && "flag" in arg) return (arg as { flag: Flag }).flag.key;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const ref = refAt(this.refs(editor.document), editor.document.offsetAt(editor.selection.active));
      if (ref) return ref.key;
    }
    if (!this.store.loaded) await this.load(false);
    const pick = await vscode.window.showQuickPick(
      this.store.flags.map((f) => ({ label: f.key, description: f.name, detail: f.archivedAt ? "archived" : f.type })),
      { placeHolder: "NanoFlags flag" },
    );
    return pick?.label;
  }

  register(): void {
    const reg = (id: string, fn: (...a: unknown[]) => unknown) => this.disposables.push(vscode.commands.registerCommand(id, fn));
    reg("nanoflags.signIn", () => this.signIn());
    reg("nanoflags.signOut", () => this.signOut());
    reg("nanoflags.refresh", () => this.load(true));
    reg("nanoflags.selectProject", async () => {
      const key = await this.pickProject();
      if (key) {
        if (cfg().project) void vscode.window.showInformationMessage("NanoFlags: the nanoflags.project setting overrides the picked project.");
        this.store.clear();
        await this.load(true);
      }
    });
    reg("nanoflags.copyFlagKey", async (arg) => {
      const key = await this.resolveKey(arg);
      if (!key) return;
      await vscode.env.clipboard.writeText(key);
      void vscode.window.setStatusBarMessage(`Copied flag key ${key}`, 2000);
    });
    reg("nanoflags.openInDashboard", async (arg) => {
      const key = await this.resolveKey(arg);
      if (key) await vscode.env.openExternal(vscode.Uri.parse(dashboardFlagUrl(cfg().dashboardUrl, key)));
    });

    const view = vscode.window.createTreeView<FlagTreeNode>("nanoflags.flags", { treeDataProvider: this.tree, showCollapseAll: true });
    this.disposables.push(
      view,
      this.store.onDidChange(() => {
        view.description = this.store.project?.name;
      }),
      vscode.languages.registerHoverProvider(SELECTOR, this.hover),
      vscode.languages.registerCodeLensProvider(SELECTOR, this.codeLens),
      vscode.languages.registerCompletionItemProvider(SELECTOR, this.completion, '"', "'", "`"),
      vscode.workspace.onDidOpenTextDocument((d) => this.updateDiagnostics(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleDiagnostics(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.forget(d)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nanoflags.project") || e.affectsConfiguration("nanoflags.baseUrl")) {
          this.store.clear();
          void this.load(true);
        } else if (e.affectsConfiguration("nanoflags")) {
          this.updateAllDiagnostics();
          this.lensEmitter.fire();
        }
      }),
      this.context.secrets.onDidChange(async (e) => {
        if (e.key !== SECRET_KEY) return;
        const t = await this.context.secrets.get(SECRET_KEY);
        if (t !== this.token) {
          this.token = t;
          this.tokenInfo = undefined;
          this.store.clear();
          if (t) void this.load(true);
        }
      }),
    );
  }
}

let instance: NanoFlags | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<NanoFlags> {
  instance = new NanoFlags(context);
  context.subscriptions.push(instance);
  instance.register();
  await instance.restore();
  return instance;
}

export function deactivate(): void {
  instance = undefined;
}
