/**
 * Minimal in-memory stand-in for the `vscode` module, enough to run the extension's providers and commands in
 * vitest. Only what the extension uses is implemented.
 */
type Fn = (...a: any[]) => any;

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
  translate(dl = 0, dc = 0) {
    return new Position(this.line + dl, this.character + dc);
  }
}
export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}
export class Uri {
  private constructor(readonly value: string) {}
  static parse(v: string) {
    return new Uri(v);
  }
  static file(p: string) {
    return new Uri(`file://${p}`);
  }
  toString() {
    return this.value;
  }
}
export class EventEmitter<T> {
  private ls = new Set<(e: T) => void>();
  event = (l: (e: T) => void) => {
    this.ls.add(l);
    return { dispose: () => this.ls.delete(l) };
  };
  fire(e: T) {
    for (const l of this.ls) l(e);
  }
  dispose() {}
}
export class MarkdownString {
  isTrusted: unknown;
  constructor(public value = "") {}
}
export class Hover {
  constructor(
    readonly contents: MarkdownString,
    readonly range?: Range,
  ) {}
}
export class CodeLens {
  constructor(
    readonly range: Range,
    readonly command?: { title: string; command: string; arguments?: unknown[] },
  ) {}
}
export enum CompletionItemKind {
  Constant = 20,
}
export enum CompletionItemTag {
  Deprecated = 1,
}
export class CompletionItem {
  range?: Range;
  detail?: string;
  documentation?: MarkdownString;
  sortText?: string;
  tags?: CompletionItemTag[];
  constructor(
    readonly label: string,
    readonly kind?: CompletionItemKind,
  ) {}
}
export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}
export enum DiagnosticTag {
  Unnecessary = 1,
  Deprecated = 2,
}
export class Diagnostic {
  source?: string;
  code?: string;
  tags?: DiagnosticTag[];
  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: DiagnosticSeverity,
  ) {}
}
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
}
export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: unknown,
  ) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export class TreeItem {
  description?: string;
  iconPath?: ThemeIcon;
  contextValue?: string;
  tooltip?: unknown;
  command?: unknown;
  constructor(
    readonly label: string,
    readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

/** A text document over a string (offset/position conversions like VS Code's). */
export class TextDocument {
  version = 1;
  constructor(
    readonly uri: Uri,
    readonly languageId: string,
    private text: string,
  ) {}
  getText() {
    return this.text;
  }
  setText(t: string) {
    this.text = t;
    this.version++;
  }
  offsetAt(p: Position) {
    const lines = this.text.split("\n");
    let o = 0;
    for (let i = 0; i < p.line; i++) o += lines[i]!.length + 1;
    return o + p.character;
  }
  positionAt(offset: number) {
    const before = this.text.slice(0, offset).split("\n");
    return new Position(before.length - 1, before[before.length - 1]!.length);
  }
  lineAt(line: number) {
    return { text: this.text.split("\n")[line] ?? "" };
  }
}

// --- state the tests can inspect -------------------------------------------------------------------------------
export const state = {
  commands: new Map<string, Fn>(),
  config: new Map<string, unknown>(),
  diagnostics: new Map<string, Diagnostic[]>(),
  contexts: new Map<string, unknown>(),
  clipboard: "",
  opened: [] as string[],
  inputBox: undefined as string | undefined,
  quickPick: undefined as ((items: any[]) => any) | undefined,
  messages: [] as string[],
  documents: [] as TextDocument[],
  providers: { hover: [] as any[], codeLens: [] as any[], completion: [] as any[] },
  reset() {
    this.commands.clear();
    this.config.clear();
    this.diagnostics.clear();
    this.contexts.clear();
    this.clipboard = "";
    this.opened = [];
    this.inputBox = undefined;
    this.quickPick = undefined;
    this.messages = [];
    this.documents = [];
    this.providers = { hover: [], codeLens: [], completion: [] };
  },
};

const disposable = { dispose() {} };

export const commands = {
  registerCommand(id: string, fn: Fn) {
    state.commands.set(id, fn);
    return { dispose: () => state.commands.delete(id) };
  },
  async executeCommand(id: string, ...args: unknown[]) {
    if (id === "setContext") {
      state.contexts.set(args[0] as string, args[1]);
      return;
    }
    return state.commands.get(id)?.(...args);
  },
};

export const languages = {
  createDiagnosticCollection() {
    return {
      set: (uri: Uri, d: Diagnostic[]) => state.diagnostics.set(uri.toString(), d),
      delete: (uri: Uri) => state.diagnostics.delete(uri.toString()),
      clear: () => state.diagnostics.clear(),
      dispose() {},
    };
  },
  registerHoverProvider(_s: unknown, p: unknown) {
    state.providers.hover.push(p);
    return disposable;
  },
  registerCodeLensProvider(_s: unknown, p: unknown) {
    state.providers.codeLens.push(p);
    return disposable;
  },
  registerCompletionItemProvider(_s: unknown, p: unknown) {
    state.providers.completion.push(p);
    return disposable;
  },
};

export const workspace = {
  getConfiguration(section: string) {
    return { get: (k: string) => state.config.get(`${section}.${k}`) };
  },
  get textDocuments() {
    return state.documents;
  },
  onDidOpenTextDocument: () => disposable,
  onDidChangeTextDocument: () => disposable,
  onDidCloseTextDocument: () => disposable,
  onDidChangeConfiguration: () => disposable,
};

export const window = {
  activeTextEditor: undefined as unknown,
  async showInputBox(o: { validateInput?: (v: string) => string | undefined }) {
    const v = state.inputBox;
    if (v !== undefined && o.validateInput?.(v)) return undefined;
    return v;
  },
  async showQuickPick(items: any[]) {
    return state.quickPick?.(items);
  },
  async showInformationMessage(m: string) {
    state.messages.push(m);
  },
  async showWarningMessage(m: string) {
    state.messages.push(m);
  },
  async showErrorMessage(m: string) {
    state.messages.push(m);
  },
  setStatusBarMessage(m: string) {
    state.messages.push(m);
    return disposable;
  },
  createTreeView(_id: string, o: { treeDataProvider: unknown }) {
    return { description: undefined as string | undefined, treeDataProvider: o.treeDataProvider, dispose() {} };
  },
};

export const env = {
  clipboard: {
    async writeText(t: string) {
      state.clipboard = t;
    },
  },
  async openExternal(u: Uri) {
    state.opened.push(u.toString());
    return true;
  },
};

/** An ExtensionContext with in-memory secret and workspace storage. */
export function makeContext() {
  const secrets = new Map<string, string>();
  const ws = new Map<string, unknown>();
  const secretEmitter = new EventEmitter<{ key: string }>();
  return {
    subscriptions: [] as { dispose(): void }[],
    extension: { packageJSON: { version: "0.0.0-test" } },
    secrets: {
      get: async (k: string) => secrets.get(k),
      store: async (k: string, v: string) => {
        secrets.set(k, v);
      },
      delete: async (k: string) => {
        secrets.delete(k);
      },
      onDidChange: secretEmitter.event,
      raw: secrets,
    },
    workspaceState: {
      get: (k: string) => ws.get(k),
      update: async (k: string, v: unknown) => {
        ws.set(k, v);
      },
    },
  };
}
