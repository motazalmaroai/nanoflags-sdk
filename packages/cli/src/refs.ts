import ts from "typescript";
import { clip } from "./util.js";

const VALUE_NAMES = ["boolean", "string", "number", "json", "evaluate", "useFlag", "getBooleanValue", "getStringValue", "getNumberValue", "getObjectValue"];
const DETAILS_NAMES = ["getBooleanDetails", "getStringDetails", "getNumberDetails", "getObjectDetails", "booleanDetails", "stringDetails", "numberDetails", "jsonDetails", "evaluateDetails", "useFlagDetails"];
/** Callee names (the identifier, or the last name of a member access) that count as a flag read. */
export const CALLEE_NAMES: ReadonlySet<string> = new Set([...VALUE_NAMES, ...DETAILS_NAMES]);

export interface CodeRef {
  flag: string;
  path: string;
  line: number;
  snippet: string;
}

export interface CallSite {
  call: ts.CallExpression;
  /** Callee name, e.g. `boolean` for `flags.boolean(…)`. */
  name: string;
  flag: string;
}

export function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS; // .js .mjs .cjs
}

export function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
}

function calleeName(callee: ts.Expression): string | null {
  let e = callee;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text; // also covers `a?.b`
  return null;
}

/**
 * Calls whose callee name is a known flag accessor and whose first argument is a string literal
 * (or a template literal without substitutions) equal to one of `keys`. Nothing else is a reference:
 * computed keys, keys held in variables and string concatenation are not followed.
 */
export function findCallSites(source: ts.SourceFile, keys: ReadonlySet<string>): CallSite[] {
  const out: CallSite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const first = node.arguments[0];
      if (name !== null && CALLEE_NAMES.has(name) && first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && keys.has(first.text)) {
        out.push({ call: node, name, flag: first.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export function lineOf(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}

export function snippetAt(text: string, source: ts.SourceFile, pos: number): string {
  const line = source.getLineAndCharacterOfPosition(pos).line;
  const starts = source.getLineStarts();
  const end = line + 1 < starts.length ? starts[line + 1]! : text.length;
  return clip(text.slice(starts[line]!, end).trim(), 240);
}

export function scanText(path: string, text: string, keys: ReadonlySet<string>): CodeRef[] {
  // Cheap pre-filter: a file that mentions no known key cannot contain a reference.
  let mentions = false;
  for (const k of keys) {
    if (text.includes(k)) {
      mentions = true;
      break;
    }
  }
  if (!mentions) return [];
  const source = parse(path, text);
  return findCallSites(source, keys).map((s) => {
    const pos = s.call.getStart(source);
    return { flag: s.flag, path, line: lineOf(source, pos), snippet: snippetAt(text, source, pos) };
  });
}
