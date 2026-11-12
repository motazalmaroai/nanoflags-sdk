/**
 * Dependency-free flag-reference scanner: the same detection as `refs.ts` (TypeScript AST) without the TypeScript
 * compiler, for runtimes where loading the compiler is too heavy (such as the server side of the GitHub App).
 * No Node.js imports: this file must stay runnable in a Worker.
 *
 * A reference is a call whose callee name (the identifier, or the last name of a member access, also through `?.`
 * and `!`, optionally with type arguments in TypeScript files) is one of CALLEE_NAMES and whose first argument is a
 * string literal or a template literal without substitutions equal to a known flag key, standing alone (followed by
 * `,` or `)`). `new` expressions, computed keys, variables and concatenations are not references. The reported line
 * is the line where the call expression starts (the start of its member chain), and the snippet is that line,
 * trimmed and clipped to 240 characters — exactly what `scanText` reports.
 *
 * Known differences from the AST scanner (covered by the parity tests in test/refs-lite.test.ts):
 * a parenthesized callee (`(flags.boolean)("k")`) is not recognised, and code-like text inside JSX text is skipped
 * only for well-formed JSX.
 */

const VALUE_NAMES = ["boolean", "string", "number", "json", "evaluate", "useFlag", "getBooleanValue", "getStringValue", "getNumberValue", "getObjectValue"];
const DETAILS_NAMES = ["getBooleanDetails", "getStringDetails", "getNumberDetails", "getObjectDetails", "booleanDetails", "stringDetails", "numberDetails", "jsonDetails", "evaluateDetails", "useFlagDetails"];
/** Callee names (the identifier, or the last name of a member access) that count as a flag read. */
export const CALLEE_NAMES: ReadonlySet<string> = new Set([...VALUE_NAMES, ...DETAILS_NAMES]);

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
export const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".next", ".git"]);
export const DEFAULT_MAX_FILE_BYTES = 1_000_000;

/** Whether a repository-relative path (forward slashes) is a file the scanners read. */
export function isSourcePath(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (parts.slice(0, -1).some((p) => SKIP_DIRECTORIES.has(p))) return false;
  return SOURCE_EXTENSIONS.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts");
}

export interface CodeRef {
  flag: string;
  path: string;
  line: number;
  snippet: string;
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

type Kind = "id" | "str" | "tpl" | "num" | "punc" | "regex";
interface Token {
  k: Kind;
  /** Cooked value for `str` and substitution-free `tpl`; the source text otherwise. */
  v: string;
  s: number;
  /** For brackets: index of the matching bracket token. */
  m?: number;
  /** Template with substitutions (never a key). */
  sub?: boolean;
}

const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "export", "extends", "finally", "for",
  "function", "if", "import", "in", "instanceof", "let", "new", "return", "switch", "throw", "try", "typeof", "var", "void", "while", "with",
  "yield", "await", "of", "as", "satisfies",
]);
/** After these keywords an expression starts (a `/` is a regex, a `<` may open JSX). */
const EXPR_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends", "default"]);
const PUNCS = ["?.", "!==", "===", "!=", "==", "=>", ">=", "<=", "&&", "||", "??", "++", "--", "..."];

const isIdStart = (c: string) => /[A-Za-z_$#]/.test(c) || c.charCodeAt(0) > 0x7f;
const isIdPart = (c: string) => /[\w$]/.test(c) || c.charCodeAt(0) > 0x7f;

function cook(raw: string): string {
  if (!raw.includes("\\")) return raw;
  return raw.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r\n|[\s\S])/g, (_m, all: string, cp?: string, u?: string, x?: string) => {
    if (cp) return String.fromCodePoint(parseInt(cp, 16));
    if (u) return String.fromCharCode(parseInt(u, 16));
    if (x) return String.fromCharCode(parseInt(x, 16));
    const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "", "\r\n": "", "\r": "", " ": "", " ": "" };
    return all in map ? map[all]! : all;
  });
}

class Lexer {
  pos = 0;
  readonly tokens: Token[] = [];
  private readonly open: number[] = [];
  /** For each open `{`: whether it is a template substitution (`${`). */
  private readonly braceKind: ("brace" | "tpl" | "jsx")[] = [];

  constructor(
    readonly src: string,
    readonly jsx: boolean,
  ) {}

  private push(t: Token): void {
    this.tokens.push(t);
  }

  private openBracket(v: string, s: number, kind: "brace" | "tpl" | "jsx" = "brace"): void {
    this.open.push(this.tokens.length);
    if (v !== "(" && v !== "[") this.braceKind.push(kind);
    this.push({ k: "punc", v, s });
  }

  private closeBracket(v: string, s: number): void {
    const i = this.tokens.length;
    this.push({ k: "punc", v, s });
    const o = this.open.pop();
    if (o !== undefined) {
      this.tokens[o]!.m = i;
      this.tokens[i]!.m = o;
    }
  }

  /** Whether an expression may start here (decides regex vs division and JSX vs less-than). */
  private exprAllowed(): boolean {
    const p = this.tokens[this.tokens.length - 1];
    if (!p) return true;
    if (p.k === "id") return KEYWORDS.has(p.v) && EXPR_KEYWORDS.has(p.v);
    if (p.k === "punc") return p.v !== ")" && p.v !== "]" && p.v !== "}" && p.v !== "++" && p.v !== "--";
    return false;
  }

  private skipSpaceAndComments(): void {
    const s = this.src;
    for (;;) {
      const c = s[this.pos];
      if (c === undefined) return;
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === " " || c === "﻿" || c === " " || c === " ") {
        this.pos++;
      } else if (c === "/" && s[this.pos + 1] === "/") {
        while (this.pos < s.length && s[this.pos] !== "\n") this.pos++;
      } else if (c === "/" && s[this.pos + 1] === "*") {
        const end = s.indexOf("*/", this.pos + 2);
        this.pos = end < 0 ? s.length : end + 2;
      } else if (c === "#" && this.pos === 0 && s[1] === "!") {
        while (this.pos < s.length && s[this.pos] !== "\n") this.pos++;
      } else return;
    }
  }

  private readQuoted(q: string): string {
    const s = this.src;
    const start = ++this.pos;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === "\\") this.pos += 2;
      else if (c === q) break;
      else if (c === "\n" && q !== "`") break; // unterminated string: stop at the line end
      else this.pos++;
    }
    const raw = s.slice(start, Math.min(this.pos, s.length));
    this.pos++;
    return raw;
  }

  /** Reads template text from the current position up to `${` or the closing backtick. */
  private readTemplatePart(): { raw: string; ended: boolean } {
    const s = this.src;
    const start = this.pos;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === "\\") this.pos += 2;
      else if (c === "`") {
        const raw = s.slice(start, this.pos);
        this.pos++;
        return { raw, ended: true };
      } else if (c === "$" && s[this.pos + 1] === "{") {
        const raw = s.slice(start, this.pos);
        this.pos += 2;
        return { raw, ended: false };
      } else this.pos++;
    }
    return { raw: s.slice(start), ended: true };
  }

  private template(): void {
    const s = this.pos;
    this.pos++; // `
    const first = this.readTemplatePart();
    if (first.ended) {
      this.push({ k: "tpl", v: cook(first.raw), s });
      return;
    }
    this.push({ k: "tpl", v: "", s, sub: true });
    this.openBracket("${", this.pos - 2, "tpl");
  }

  private regex(): void {
    const s = this.src;
    const start = this.pos++;
    let inClass = false;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === "\\") this.pos += 2;
      else if (c === "\n") break;
      else {
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        this.pos++;
      }
    }
    this.pos++;
    while (this.pos < s.length && isIdPart(s[this.pos]!)) this.pos++;
    this.push({ k: "regex", v: s.slice(start, this.pos), s: start });
  }

  /**
   * JSX element at `<`. Text children are skipped; attribute strings and `{…}` containers are lexed as code.
   * Returns false (and restores the position) when this is not well-formed JSX.
   */
  private tryJsx(): boolean {
    const save = this.pos;
    const saveTokens = this.tokens.length;
    const saveOpen = this.open.length;
    const saveKinds = this.braceKind.length;
    try {
      if (this.jsxElement()) return true;
    } catch {
      /* fall through */
    }
    this.pos = save;
    this.tokens.length = saveTokens;
    this.open.length = saveOpen;
    this.braceKind.length = saveKinds;
    return false;
  }

  private jsxName(): string | null {
    const s = this.src;
    const start = this.pos;
    while (this.pos < s.length && /[\w$.:\-]/.test(s[this.pos]!)) this.pos++;
    return this.pos > start ? s.slice(start, this.pos) : "";
  }

  private ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  /** Lexes code inside `{ … }` of JSX until its matching `}`. */
  private jsxContainer(): void {
    const s = this.pos;
    this.pos++; // {
    this.openBracket("{", s, "jsx");
    const depth = this.braceKind.length;
    this.lexUntil(() => this.braceKind.length < depth);
  }

  private jsxElement(): boolean {
    const s = this.src;
    if (s[this.pos] !== "<") return false;
    this.pos++;
    this.ws();
    const name = this.jsxName();
    if (name === null || (name !== "" && !/^[A-Za-z_$]/.test(name))) return false;
    // attributes
    for (;;) {
      this.ws();
      const c = s[this.pos];
      if (c === undefined) return false;
      if (c === "/" && s[this.pos + 1] === ">") {
        this.pos += 2;
        return true;
      }
      if (c === ">") {
        this.pos++;
        break;
      }
      if (c === "{") {
        this.jsxContainer(); // spread attribute
        continue;
      }
      const attr = this.jsxName();
      if (!attr) return false;
      this.ws();
      if (s[this.pos] === "=") {
        this.pos++;
        this.ws();
        const v = s[this.pos];
        if (v === '"' || v === "'") {
          const start = this.pos;
          const raw = this.readQuoted(v);
          this.push({ k: "str", v: raw, s: start });
        } else if (v === "{") this.jsxContainer();
        else if (v === "<") {
          if (!this.jsxElement()) return false;
        } else return false;
      }
    }
    // children
    for (;;) {
      const c = s[this.pos];
      if (c === undefined) return false;
      if (c === "{") this.jsxContainer();
      else if (c === "<") {
        if (s[this.pos + 1] === "/") {
          this.pos += 2;
          this.ws();
          const close = this.jsxName();
          this.ws();
          if (s[this.pos] !== ">" || close !== name) return false;
          this.pos++;
          return true;
        }
        if (!this.jsxElement()) return false;
      } else this.pos++;
    }
  }

  private lexUntil(stop: () => boolean): void {
    const s = this.src;
    while (!stop()) {
      this.skipSpaceAndComments();
      const c = s[this.pos];
      if (c === undefined) return;
      const start = this.pos;
      if (c === '"' || c === "'") {
        const raw = this.readQuoted(c);
        this.push({ k: "str", v: cook(raw), s: start });
      } else if (c === "`") this.template();
      else if (isIdStart(c)) {
        this.pos++;
        while (this.pos < s.length && isIdPart(s[this.pos]!)) this.pos++;
        this.push({ k: "id", v: s.slice(start, this.pos), s: start });
      } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[this.pos + 1] ?? ""))) {
        this.pos++;
        while (this.pos < s.length && /[\w.]/.test(s[this.pos]!)) this.pos++;
        this.push({ k: "num", v: s.slice(start, this.pos), s: start });
      } else if (c === "(" || c === "[" || c === "{") {
        this.pos++;
        this.openBracket(c, start);
      } else if (c === ")" || c === "]") {
        this.pos++;
        this.closeBracket(c, start);
      } else if (c === "}") {
        this.pos++;
        const kind = this.braceKind.pop();
        this.closeBracket("}", start);
        if (kind === "tpl") {
          const part = this.readTemplatePart();
          if (!part.ended) this.openBracket("${", this.pos - 2, "tpl");
        }
      } else if (c === "/" && this.exprAllowed()) this.regex();
      else if (c === "<" && this.jsx && this.exprAllowed() && this.tryJsx()) {
        /* JSX consumed */
      } else {
        const p = PUNCS.find((x) => s.startsWith(x, this.pos) && !(x === "?." && /[0-9]/.test(s[this.pos + 2] ?? "")));
        const v = p ?? c;
        this.pos += v.length;
        this.push({ k: "punc", v, s: start });
      }
    }
  }

  run(): Token[] {
    this.lexUntil(() => this.pos >= this.src.length);
    return this.tokens;
  }
}

function isTsPath(path: string): boolean {
  return /\.(ts|tsx|mts|cts)$/.test(path);
}

/** Index of the token after balanced type arguments starting at `i` (`<`), or -1. */
function skipTypeArgs(t: Token[], i: number): number {
  let depth = 0;
  for (let j = i; j < t.length && j < i + 200; j++) {
    const x = t[j]!;
    if (x.k === "punc") {
      if (x.v === "<") depth++;
      else if (x.v === ">") {
        depth--;
        if (depth === 0) return j + 1;
      } else if (x.v === "(" || x.v === "[" || x.v === "{") {
        if (x.m === undefined) return -1;
        j = x.m;
      } else if (x.v === ";" || x.v === "&&" || x.v === "||" || x.v === ")" || x.v === "]" || x.v === "}") return -1;
    }
  }
  return -1;
}

const NOT_CHAIN_KEYWORDS = new Set([...KEYWORDS].filter((k) => k !== "this" && k !== "super"));

const isPunc = (t: Token | undefined, v: string) => t?.k === "punc" && t.v === v;

/**
 * First token of the chain element that ends at token `p` (an identifier, a literal, or a call / element access on
 * one), or null when the token cannot end an object expression. `terminal`: nothing can precede it in the chain.
 */
function elementStart(t: Token[], p: number, depth = 0): { start: number; call: boolean; terminal: boolean } | null {
  const obj = t[p];
  if (!obj || depth > 50) return null;
  if (obj.k === "id") return NOT_CHAIN_KEYWORDS.has(obj.v) ? null : { start: p, call: false, terminal: false };
  if (obj.k === "str" || obj.k === "tpl" || obj.k === "num" || obj.k === "regex") return { start: p, call: false, terminal: true };
  if (obj.k === "punc" && (obj.v === ")" || obj.v === "]") && obj.m !== undefined) {
    const o = obj.m;
    let q = o - 1;
    if (isPunc(t[q], "?.")) q--;
    while (isPunc(t[q], "!")) q--;
    const callee = t[q];
    const isCallee = callee && ((callee.k === "id" && !NOT_CHAIN_KEYWORDS.has(callee.v)) || isPunc(callee, ")") || isPunc(callee, "]"));
    if (!isCallee) return { start: o, call: false, terminal: true }; // parenthesized expression or array literal
    const inner = elementStart(t, q, depth + 1);
    if (!inner) return { start: o, call: false, terminal: true };
    return { start: inner.start, call: obj.v === ")" || inner.call, terminal: inner.terminal };
  }
  return null;
}

/** Start token of the member chain ending at `i`, or null when the chain is a `new` target (not a call). */
function chainStart(t: Token[], i: number): number | null {
  let start = i;
  let crossedCall = false;
  for (;;) {
    let p = start - 1;
    if (!isPunc(t[p], ".") && !isPunc(t[p], "?.")) break;
    p--;
    while (isPunc(t[p], "!")) p--;
    const el = elementStart(t, p);
    if (!el) break;
    start = el.start;
    crossedCall ||= el.call;
    if (el.terminal) break;
  }
  if (t[start - 1]?.k === "id" && t[start - 1]!.v === "new") return crossedCall ? start - 1 : null;
  return start;
}

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) out.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      out.push(i + 1);
    } else if (c === 0x2028 || c === 0x2029) out.push(i + 1);
  }
  return out;
}

function lineIndex(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** References to `keys` in one file. Same result shape and order as `scanText` in refs.ts. */
export function scanSource(path: string, text: string, keys: ReadonlySet<string>): CodeRef[] {
  let mentions = false;
  for (const k of keys) {
    if (text.includes(k)) {
      mentions = true;
      break;
    }
  }
  if (!mentions) return [];
  const jsx = !/\.(ts|mts|cts)$/.test(path);
  const t = new Lexer(text, jsx).run();
  const ts = isTsPath(path);
  const hits: { start: number; name: number; flag: string }[] = [];
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (tok.k !== "id" || !CALLEE_NAMES.has(tok.v)) continue;
    let j = i + 1;
    while (t[j]?.k === "punc" && t[j]!.v === "!") j++;
    if (ts && t[j]?.k === "punc" && t[j]!.v === "<") {
      j = skipTypeArgs(t, j);
      if (j < 0) continue;
    }
    if (t[j]?.k === "punc" && t[j]!.v === "?.") j++;
    if (t[j]?.k !== "punc" || t[j]!.v !== "(") continue;
    const arg = t[j + 1];
    const after = t[j + 2];
    if (!arg || (arg.k !== "str" && !(arg.k === "tpl" && !arg.sub))) continue;
    if (!after || after.k !== "punc" || (after.v !== "," && after.v !== ")")) continue;
    if (!keys.has(arg.v)) continue;
    // `function boolean(…)`, `get boolean(…)` style declarations cannot have a string parameter, so a match is a call.
    const start = chainStart(t, i);
    if (start === null) continue;
    hits.push({ start: t[start]!.s, name: tok.s, flag: arg.v });
  }
  // AST pre-order: by start, and for calls starting at the same position the outer one (later name) first.
  hits.sort((a, b) => a.start - b.start || b.name - a.name);
  const starts = lineStarts(text);
  return hits.map((h) => {
    const li = lineIndex(starts, h.start);
    const end = li + 1 < starts.length ? starts[li + 1]! : text.length;
    return { flag: h.flag, path, line: li + 1, snippet: clip(text.slice(starts[li]!, end).trim(), 240) };
  });
}
