/**
 * `nanoflags cleanup`: rewrite the reads of a flag that is permanently resolved to one value.
 *
 * Text edits driven by the TypeScript syntax tree: formatting outside the touched ranges is kept.
 * Every rewrite is one of a small set of patterns; anything else is left alone and reported.
 */
import ts from "typescript";
import { findCallSites, lineOf, parse, scriptKind, snippetAt, type CallSite } from "./refs.js";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface SiteReport {
  line: number;
  snippet: string;
  /** Why the reference was not rewritten. */
  reason?: string;
  /** The reference was not rewritten but no longer exists: it was inside code removed as dead. */
  removed?: boolean;
}

export interface CleanupResult {
  output: string;
  transformed: SiteReport[];
  skipped: SiteReport[];
  /** Statements that became unreachable (they follow a `return`/`throw` the cleanup exposed). Lines refer to `output`. */
  unreachable: SiteReport[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const truthy = (c: Json) => Boolean(c);
const typeName = (v: Json) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/* ---------------- classification ---------------- */

function skipOuter(node: ts.Node): ts.Node {
  let p = node.parent;
  while (ts.isParenthesizedExpression(p)) p = p.parent;
  return p;
}

/** No calls, constructions, awaits, assignments or updates anywhere inside: dropping it changes nothing. */
function isPure(node: ts.Node): boolean {
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isDeleteExpression(node) || ts.isSpreadElement(node)) return false;
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return true; // defined, not run
  if (ts.isClassExpression(node)) return false;
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return false;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return false;
  let pure = true;
  ts.forEachChild(node, (child) => {
    if (pure && !isPure(child)) pure = false;
  });
  return pure;
}

function fallbackKind(arg: ts.Expression | undefined): "boolean" | "string" | "number" | "json" | null {
  if (!arg) return null;
  let e = arg;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return "string";
  if (ts.isNumericLiteral(e) || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand))) return "number";
  if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e) || e.kind === ts.SyntaxKind.NullKeyword) return "json";
  return null;
}

/** Null when the call can be rewritten; otherwise the reason it is left alone. */
export function unsupportedReason(site: CallSite, value: Json): string | null {
  const { call, name } = site;
  if (name === "evaluate" || name.endsWith("Details")) return `${name}() returns an evaluation object, not the value`;
  if (call.questionDotToken || (call.flags & ts.NodeFlags.OptionalChain) !== 0) return "optional call (?.) may also yield undefined";
  let accessor: "boolean" | "string" | "number" | "json" | null;
  if (name === "boolean" || name === "getBooleanValue") accessor = "boolean";
  else if (name === "string" || name === "getStringValue") accessor = "string";
  else if (name === "number" || name === "getNumberValue") accessor = "number";
  else if (name === "json" || name === "getObjectValue") accessor = "json";
  else accessor = fallbackKind(call.arguments[1]); // useFlag picks its accessor from the fallback
  if (accessor === null) return "the accessor type depends on a fallback that is not a literal";
  if (accessor !== "json" && accessor !== typeName(value)) return `this is a ${accessor} read but the value is a ${typeName(value)}: today it returns its fallback, not the value`;
  if (name.startsWith("get") && !ts.isAwaitExpression(skipOuter(call))) return `${name}() may return a promise (OpenFeature server SDK); only awaited calls are rewritten`;
  if (!isPure(call.expression) || !call.arguments.every(isPure)) return "the call or its arguments may have side effects";
  return null;
}

/* ---------------- helpers ---------------- */

interface Ctx {
  path: string;
  text: string;
  source: ts.SourceFile;
  checker: () => ts.TypeChecker;
}

const src = (ctx: Ctx, n: ts.Node) => ctx.text.slice(n.getStart(ctx.source), n.end);

function lineBounds(text: string, start: number, end: number): { lineStart: number; lineEnd: number; alone: boolean } {
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  let lineEnd = end;
  while (lineEnd < text.length && text[lineEnd] !== "\n") lineEnd++;
  const alone = text.slice(lineStart, start).trim() === "" && text.slice(end, lineEnd).trim() === "";
  return { lineStart, lineEnd: lineEnd < text.length ? lineEnd + 1 : lineEnd, alone };
}

/** Remove a statement; when nothing else is on its line(s), remove the line(s) too. */
function removeStatement(ctx: Ctx, node: ts.Node): Edit {
  const start = node.getStart(ctx.source);
  const b = lineBounds(ctx.text, start, node.end);
  return b.alone ? { start: b.lineStart, end: b.lineEnd, text: "" } : { start, end: node.end, text: "" };
}

function literalText(c: Json, at: ts.Node): string {
  const parent = at.parent;
  if (typeof c === "number") {
    const s = JSON.stringify(c);
    const tight = ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isCallExpression(parent);
    const operand = ts.isBinaryExpression(parent) || ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent);
    return (tight && (parent as ts.PropertyAccessExpression).expression === at) || (c < 0 && (tight || operand)) ? `(${s})` : s;
  }
  if (typeof c === "object" && c !== null) {
    const s = JSON.stringify(c);
    // `{` at the start of a statement or an arrow body would be read as a block.
    return !Array.isArray(c) && (ts.isExpressionStatement(parent) || (ts.isArrowFunction(parent) && parent.body === at)) ? `(${s})` : s;
  }
  return JSON.stringify(c);
}

/** Text of `from`, safe to put where `target` is. */
function moved(ctx: Ctx, from: ts.Expression, target: ts.Node): string {
  const s = src(ctx, from);
  const parent = target.parent;
  const statementStart = ts.isExpressionStatement(parent) || (ts.isArrowFunction(parent) && parent.body === target);
  return statementStart && /^(\{|function\b|class\b|let\b)/.test(s) ? `(${s})` : s;
}

const ATOMIC = /^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\d+(?:\.\d+)?|"[^"\\\n]*")$/;

/** The edit that puts `text` where `target` is, dropping parentheses and JSX braces that became pointless. */
function place(ctx: Ctx, target: ts.Node, text: string): Edit {
  let node = target;
  if (ATOMIC.test(text) && ts.isParenthesizedExpression(node.parent)) {
    const outer = node.parent.parent;
    const memberOfNumber = /^\d/.test(text) && (ts.isPropertyAccessExpression(outer) || ts.isElementAccessExpression(outer)) && outer.expression === node.parent;
    if (!memberOfNumber) node = node.parent;
  }
  const holder = node.parent;
  if (ts.isJsxExpression(holder) && (ts.isJsxElement(holder.parent) || ts.isJsxFragment(holder.parent))) {
    // As a child, `{<A />}` is `<A />` and `{false}` renders nothing.
    if (text.startsWith("<")) return { start: holder.getStart(ctx.source), end: holder.end, text };
    if (text === "false" || text === "null") return removeStatement(ctx, holder);
  }
  return { start: node.getStart(ctx.source), end: node.end, text };
}

function inBooleanContext(node: ts.Node): boolean {
  const p = node.parent;
  if (ts.isParenthesizedExpression(p)) return inBooleanContext(p);
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
  if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === node) return true;
  if (ts.isForStatement(p) && p.condition === node) return true;
  if (ts.isConditionalExpression(p) && p.condition === node) return true;
  if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || p.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return inBooleanContext(p);
  return false;
}

function literalValue(e: ts.Expression): { value: string | number | boolean | null } | null {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return { value: x.text };
  if (ts.isNumericLiteral(x)) return { value: Number(x.text) };
  if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(x.operand)) return { value: -Number(x.operand.text) };
  if (x.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (x.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (x.kind === ts.SyntaxKind.NullKeyword) return { value: null };
  return null;
}

function hasMultilineTemplate(ctx: Ctx, node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if ((ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && src(ctx, n).includes("\n")) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Can the statements of `block` be spliced into the enclosing statement list without changing what names mean? */
function canUnwrap(ctx: Ctx, block: ts.Block): boolean {
  if (hasMultilineTemplate(ctx, block)) return false;
  const declared = new Set<string>();
  const bind = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) declared.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
  };
  for (const s of block.statements) {
    if (ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) s.declarationList.declarations.forEach((d) => bind(d.name));
    else if ((ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) declared.add(s.name.text);
  }
  if (declared.size === 0) return true;
  // Block-scoped names move one scope out: refuse when the name is used anywhere outside the block.
  let clash = false;
  const visit = (n: ts.Node) => {
    if (clash || n === block) return;
    if (ts.isIdentifier(n) && declared.has(n.text)) clash = true;
    else ts.forEachChild(n, visit);
  };
  visit(ctx.source);
  return !clash;
}

function isStatementList(n: ts.Node): boolean {
  return ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n);
}

/* ---------------- rewrites ---------------- */

function rewriteIf(ctx: Ctx, stmt: ts.IfStatement, c: Json): Edit {
  const taken = truthy(c) ? stmt.thenStatement : stmt.elseStatement;
  const start = stmt.getStart(ctx.source);
  const inList = isStatementList(stmt.parent);
  if (!taken) {
    if (inList) return removeStatement(ctx, stmt);
    // `… else if (flag) {…}` with nothing left: drop the else clause.
    if (ts.isIfStatement(stmt.parent) && stmt.parent.elseStatement === stmt) return { start: stmt.parent.thenStatement.end, end: stmt.end, text: "" };
    return { start, end: stmt.end, text: "{}" };
  }
  const bounds = lineBounds(ctx.text, start, stmt.end);
  const startsLine = ctx.text.slice(bounds.lineStart, start).trim() === "";
  if (ts.isBlock(taken) && inList && startsLine && canUnwrap(ctx, taken)) {
    const inner = ctx.text.slice(taken.getStart(ctx.source) + 1, taken.end - 1);
    const lines = inner.split("\n");
    while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
    while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
    if (lines.length === 0) return removeStatement(ctx, stmt);
    const outerIndent = ctx.text.slice(bounds.lineStart, start);
    const innerIndent = /^[ \t]*/.exec(lines[0]!)![0];
    const out = lines.map((l, i) => {
      const body = l.startsWith(innerIndent) ? l.slice(innerIndent.length) : l.trimStart();
      return body === "" ? "" : (i === 0 ? "" : outerIndent) + body;
    });
    return { start, end: stmt.end, text: out.join("\n") };
  }
  return { start, end: stmt.end, text: src(ctx, taken) };
}

/** All identifiers that resolve to the variable declared by `decl`, except its own name. */
function referencesOf(ctx: Ctx, decl: ts.VariableDeclaration & { name: ts.Identifier }): { refs: ts.Identifier[]; exported: boolean } {
  const checker = ctx.checker();
  const symbol = checker.getSymbolAtLocation(decl.name);
  const refs: ts.Identifier[] = [];
  let exported = false;
  if (!symbol) return { refs, exported: true }; // unknown binding: keep the declaration
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n !== decl.name && n.text === decl.name.text) {
      const p = n.parent;
      if (ts.isExportSpecifier(p)) {
        if (checker.getExportSpecifierLocalTargetSymbol(p) === symbol) exported = true;
      } else if (ts.isShorthandPropertyAssignment(p)) {
        if (checker.getShorthandAssignmentValueSymbol(p) === symbol) refs.push(n);
      } else if (checker.getSymbolAtLocation(n) === symbol) refs.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(ctx.source);
  return { refs, exported };
}

const AND = ts.SyntaxKind.AmpersandAmpersandToken;
const OR = ts.SyntaxKind.BarBarToken;

/**
 * `node` is an expression known to evaluate to the constant `c`. Returns the edit that makes the most
 * of it: simplify the enclosing `if` / ternary / logical expression, or else put the literal there.
 */
function editFor(ctx: Ctx, start: ts.Node, value: Json, depth = 0): Edit {
  let node = start;
  let c = value;
  for (;;) {
    const p = node.parent;
    if (ts.isParenthesizedExpression(p) || ts.isAwaitExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) {
      node = p;
      continue;
    }
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) {
      node = p;
      c = !truthy(c);
      continue;
    }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      const isLeft = p.left === node;
      if (op === AND || op === OR) {
        const decides = op === AND ? !truthy(c) : truthy(c); // the constant alone decides the result
        if (isLeft) {
          if (!decides) return place(ctx, p, moved(ctx, p.right, p)); // true && x → x
          node = p; // false && x → false (x is never evaluated)
          continue;
        }
        if (!inBooleanContext(p)) break; // `x && true` is not `x` as a value
        if (!decides) return place(ctx, p, moved(ctx, p.left, p)); // if (x && true) → if (x)
        if (!isPure(p.left)) break; // `sideEffect() && false`: the left side must still run
        node = p;
        c = op === OR;
        continue;
      }
      if (op === ts.SyntaxKind.QuestionQuestionToken && isLeft) {
        if (c === null) return place(ctx, p, moved(ctx, p.right, p));
        node = p;
        continue;
      }
      const strict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      const loose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
      if ((strict || loose) && (typeof c !== "object" || c === null)) {
        const other = literalValue(isLeft ? p.right : p.left);
        // Loose equality is only folded between values of the same type, where it equals strict equality.
        if (other && (strict || typeName(other.value) === typeName(c))) {
          const equal = other.value === c;
          node = p;
          c = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken ? equal : !equal;
          continue;
        }
      }
      break;
    }
    if (ts.isConditionalExpression(p) && p.condition === node) {
      return place(ctx, p, moved(ctx, truthy(c) ? p.whenTrue : p.whenFalse, p));
    }
    if (ts.isIfStatement(p) && p.expression === node) return rewriteIf(ctx, p, c);
    if (ts.isVariableDeclaration(p) && p.initializer === node && ts.isIdentifier(p.name) && ts.isVariableDeclarationList(p.parent) && (p.parent.flags & ts.NodeFlags.Const) !== 0 && depth < 20) {
      const decl = p as ts.VariableDeclaration & { name: ts.Identifier };
      const { refs, exported } = referencesOf(ctx, decl);
      const first = refs[0];
      if (first) {
        // One use per step; the declaration goes once no use is left.
        if (ts.isShorthandPropertyAssignment(first.parent)) return { start: first.parent.getStart(ctx.source), end: first.parent.end, text: `${first.text}: ${literalText(c, first.parent)}` };
        return editFor(ctx, first, c, depth + 1);
      }
      const list = p.parent;
      const statement = list.parent;
      const isExported = exported || (ts.isVariableStatement(statement) && (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) !== 0);
      if (!isExported && list.declarations.length === 1 && ts.isVariableStatement(statement) && isStatementList(statement.parent)) return removeStatement(ctx, statement);
    }
    break;
  }
  return place(ctx, node, literalText(c, node));
}

function syntaxErrors(source: ts.SourceFile): number {
  return ((source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length;
}

/** A single-file program without libraries: enough for the checker to resolve local bindings. */
function checkerFor(source: ts.SourceFile): ts.TypeChecker {
  const fileName = source.fileName;
  const host: ts.CompilerHost = {
    getSourceFile: (f) => (f === fileName ? source : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/nanoflags-cleanup",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f === fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram([fileName], { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest, noEmit: true, types: [] }, host);
  return program.getTypeChecker();
}

/** One rewrite. Null when no supported read of the flag is left. */
function step(path: string, text: string, keys: ReadonlySet<string>, value: Json): string | null {
  const ext = /\.[a-z]+$/.exec(path)?.[0] ?? ".ts";
  const source = ts.createSourceFile(`/nanoflags-cleanup/file${ext}`, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const site = findCallSites(source, keys).find((s) => unsupportedReason(s, value) === null);
  if (!site) return null;
  let checker: ts.TypeChecker | null = null;
  // The program is built around this very tree, so symbols and nodes line up. Only bindings need it.
  const ctx: Ctx = { path, text, source, checker: () => (checker ??= checkerFor(source)) };
  const edit = editFor(ctx, site.call, value);
  return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
}

/** Statements that directly follow an unconditional return/throw/break/continue in the same list. */
function unreachableStatements(text: string, source: ts.SourceFile): SiteReport[] {
  const out: SiteReport[] = [];
  const visit = (n: ts.Node) => {
    if (isStatementList(n)) {
      const list = (n as ts.Block).statements;
      for (let i = 0; i + 1 < list.length; i++) {
        const s = list[i]!;
        const next = list[i + 1]!;
        if ((ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s)) && !ts.isFunctionDeclaration(next)) {
          const pos = next.getStart(source);
          out.push({ line: lineOf(source, pos), snippet: snippetAt(text, source, pos) });
          break;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return out;
}

export function cleanupText(path: string, text: string, flag: string, value: Json): CleanupResult {
  const keys = new Set([flag]);
  const original = parse(path, text);
  const sites = findCallSites(original, keys).map((s) => {
    const pos = s.call.getStart(original);
    const reason = unsupportedReason(s, value);
    return { line: lineOf(original, pos), snippet: snippetAt(text, original, pos), ...(reason === null ? {} : { reason }) } as SiteReport;
  });
  if (sites.every((s) => s.reason !== undefined)) return { output: text, transformed: [], skipped: sites, unreachable: [] };

  let current = text;
  for (let i = 0; i < 2000; i++) {
    const next = step(path, current, keys, value);
    if (next === null || next === current) break;
    current = next;
  }

  const final = parse(path, current);
  const left = findCallSites(final, keys);
  const failed = syntaxErrors(final) > syntaxErrors(original) || left.some((s) => unsupportedReason(s, value) === null);
  if (failed) {
    // Never hand back a file this tool may have broken.
    return { output: text, transformed: [], skipped: sites.map((s) => ({ ...s, reason: s.reason ?? "the rewrite could not be completed safely; the file was left unchanged" })), unreachable: [] };
  }
  const remaining = new Map<string, number>();
  for (const s of left) {
    const snip = snippetAt(current, final, s.call.getStart(final));
    remaining.set(snip, (remaining.get(snip) ?? 0) + 1);
  }
  const unmatched: SiteReport[] = [];
  const skippedBefore = sites.filter((s) => s.reason !== undefined);
  for (const s of skippedBefore) {
    const n = remaining.get(s.snippet) ?? 0;
    if (n > 0) remaining.set(s.snippet, n - 1);
    else unmatched.push(s);
  }
  // A read that was not rewritten can still disappear: it sat in a branch that was removed as dead code.
  const gone = skippedBefore.length - left.length;
  const skipped = skippedBefore.map((s) => (gone > 0 && gone === unmatched.length && unmatched.includes(s) ? { ...s, removed: true } : s));
  const already = new Set(unreachableStatements(text, original).map((u) => u.snippet));
  const unreachable = unreachableStatements(current, final).filter((u) => !already.has(u.snippet));
  return { output: current, transformed: sites.filter((s) => s.reason === undefined), skipped, unreachable };
}
