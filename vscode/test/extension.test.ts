import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { NanoFlags } from "../src/extension";
import { TOKEN, fakeApi } from "./fake-api";

const mock = vscode as unknown as typeof import("./vscode-mock");
const { state } = mock;

async function start(signedIn = true) {
  state.reset();
  state.config.set("nanoflags.baseUrl", "https://edge.test");
  const api = fakeApi();
  const context = mock.makeContext();
  if (signedIn) await context.secrets.store("nanoflags.apiToken", TOKEN);
  const ext = new NanoFlags(context as any, api.fetch);
  ext.register();
  await ext.restore();
  return { ext, api, context };
}

function doc(text: string, language = "typescript") {
  const d = new mock.TextDocument(mock.Uri.file(`/w/${Math.random()}.ts`), language, text);
  state.documents.push(d);
  return d;
}

describe("extension", () => {
  let ext: NanoFlags | undefined;
  afterEach(() => ext?.dispose());

  it("registers commands, providers and restores the session from secret storage", async () => {
    ({ ext } = await start());
    expect([...state.commands.keys()].sort()).toEqual([
      "nanoflags.copyFlagKey", "nanoflags.openInDashboard", "nanoflags.refresh", "nanoflags.selectProject", "nanoflags.signIn", "nanoflags.signOut",
    ]);
    expect(state.contexts.get("nanoflags.signedIn")).toBe(true);
    expect(ext.store.loaded).toBe(true);
    expect(ext.projectKey()).toBe("web"); // the only project was picked and remembered
  });

  it("signs in: validates the token format, checks it with the API and stores it as a secret", async () => {
    const s = await start(false);
    ext = s.ext;
    expect(state.contexts.get("nanoflags.signedIn")).toBe(false);
    state.inputBox = "nf_srv_not-an-api-token";
    await vscode.commands.executeCommand("nanoflags.signIn");
    expect(s.context.secrets.raw.size).toBe(0);
    state.inputBox = TOKEN;
    await vscode.commands.executeCommand("nanoflags.signIn");
    expect(s.context.secrets.raw.get("nanoflags.apiToken")).toBe(TOKEN);
    expect(ext.store.flags).toHaveLength(3);
    await vscode.commands.executeCommand("nanoflags.signOut");
    expect(s.context.secrets.raw.size).toBe(0);
    expect(ext.store.loaded).toBe(false);
  });

  it("hovers known flags with status and a dashboard link", async () => {
    ({ ext } = await start());
    const d = doc(`const on = flags.boolean("new-checkout", false);`);
    const pos = d.positionAt(d.getText().indexOf("checkout"));
    const hover = state.providers.hover[0].provideHover(d, pos) as vscode.Hover;
    const text = (hover.contents as unknown as { value: string }).value;
    expect(text).toContain("**New checkout**");
    expect(text).toContain("| Development | Off · serves false | On · default false · 1 rule |");
    expect(text).toContain("| Production | not published |");
    expect(text).toContain("https://app.nanoflags.io/app/flags/new-checkout");
  });

  it("publishes diagnostics for unknown and archived flags", async () => {
    ({ ext } = await start());
    const d = doc(`flags.boolean("new-chekout", false);\nflags.boolean("old-banner", false);\nflags.boolean("accent-color", "x");`);
    ext.updateDiagnostics(d as any);
    const diags = state.diagnostics.get(d.uri.toString())!;
    expect(diags.map((x) => x.code)).toEqual(["unknown-flag", "archived-flag"]);
    expect(diags[0]!.message).toContain('Did you mean "new-checkout"?');
    expect(diags[1]!.tags).toEqual([mock.DiagnosticTag.Deprecated]);
    state.config.set("nanoflags.diagnostics.unknownFlags", "off");
    ext.updateDiagnostics(d as any);
    expect(state.diagnostics.get(d.uri.toString())!.map((x) => x.code)).toEqual(["archived-flag"]);
  });

  it("completes flag keys inside getter calls only", async () => {
    ({ ext } = await start());
    const d = doc(`const on = flags.boolean("new`);
    const items = state.providers.completion[0].provideCompletionItems(d, new mock.Position(0, 29)) as vscode.CompletionItem[];
    expect(items.map((i) => i.label)).toEqual(["accent-color", "new-checkout", "old-banner"]);
    const archived = items.find((i) => i.label === "old-banner")!;
    expect(archived.tags).toEqual([mock.CompletionItemTag.Deprecated]);
    expect(archived.sortText!.startsWith("1")).toBe(true);
    const d2 = doc(`console.log("new`);
    expect(state.providers.completion[0].provideCompletionItems(d2, new mock.Position(0, 16))).toBeUndefined();
  });

  it("offers an Open in NanoFlags CodeLens and the copy/open commands", async () => {
    ({ ext } = await start());
    const d = doc(`flags.boolean("new-checkout", false); flags.boolean("new-checkout", true);\nflags.boolean("unknown", false)`);
    const lenses = state.providers.codeLens[0].provideCodeLenses(d) as vscode.CodeLens[];
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.command).toMatchObject({ title: "Open in NanoFlags: New checkout", command: "nanoflags.openInDashboard", arguments: ["new-checkout"] });
    await vscode.commands.executeCommand("nanoflags.copyFlagKey", "accent-color");
    expect(state.clipboard).toBe("accent-color");
    await vscode.commands.executeCommand("nanoflags.openInDashboard", "accent-color");
    expect(state.opened).toEqual(["https://app.nanoflags.io/app/flags/accent-color"]);
    state.quickPick = (items) => items.find((i: { label: string }) => i.label === "new-checkout");
    await vscode.commands.executeCommand("nanoflags.copyFlagKey");
    expect(state.clipboard).toBe("new-checkout");
  });

  it("shows flags per environment in the tree", async () => {
    ({ ext } = await start());
    const roots = ext.tree.getChildren();
    expect(roots.map((n) => ext!.tree.getTreeItem(n).label)).toEqual(["Development", "Production", "Archived"]);
    const dev = ext.tree.getChildren(roots[0]);
    const items = dev.map((n) => ext!.tree.getTreeItem(n));
    expect(items.map((i) => `${i.label}:${i.description}`)).toEqual(["accent-color:not published", "new-checkout:off · false"]);
    expect(ext.tree.getChildren(roots[2]).map((n) => ext!.tree.getTreeItem(n).label)).toEqual(["old-banner"]);
  });

  it("refreshes on demand", async () => {
    let api;
    ({ ext, api } = await start());
    const before = api.requests.length;
    await vscode.commands.executeCommand("nanoflags.refresh");
    expect(api.requests.length).toBeGreaterThan(before);
  });
});

beforeEach(() => state.reset());
