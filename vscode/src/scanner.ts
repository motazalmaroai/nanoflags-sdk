/**
 * Finds NanoFlags flag keys in source code: string literals passed as the key argument of a NanoFlags SDK getter.
 *
 * The getter names follow the SDKs in this repository and the OpenFeature providers:
 *   JS/TS      flags.boolean("k") · string · number · json · evaluate · useFlag · …Details (same names as the CLI's
 *              code-reference scanner, packages/cli/src/refs-lite.ts) · OpenFeature getBooleanValue("k") …
 *   Python     bool_variation("k") · string_variation · number_variation · json_variation (+ _detail) · get_boolean_value …
 *   Ruby       bool_variation("k") … (same names as Python)
 *   Go         BoolVariation("k") · StringVariation · Float64Variation · JSONVariation (+ Detail) ·
 *              OpenFeature BooleanValue(ctx, "k") …
 *   Java       boolVariation("k") · stringVariation · intVariation · longVariation · doubleVariation · jsonVariation …
 *   C#         BoolVariation("k") · … · OpenFeature GetBooleanValueAsync("k") …
 *   PHP        $flags->boolVariation('k') · stringVariation · numberVariation · jsonVariation (+ Detail)
 *   Kotlin     boolVariation("k") · intVariation · doubleVariation · … · rememberFlag("k")
 *   Swift      boolVariation(key: "k") · stringVariation(key:) · numberVariation(key:) …
 *   Dart       boolVariation('k') · … · FlagBuilder(flagKey: 'k')
 *
 * A reference is "strong" when the getter name is NanoFlags-specific (…Variation…, useFlag, rememberFlag, flagKey:,
 * OpenFeature getters) or the receiver's name mentions flags (`flags.boolean`, `nanoflags.string`). Generic names such
 * as `x.boolean("k")` are "weak": they are used for hovers when the key is a known flag, but never reported as unknown.
 * Comments are ignored; only plain string literals count (no interpolation or concatenation).
 */

export interface FlagRef {
  key: string;
  /** Offsets of the key text (inside the quotes) in the scanned text. */
  start: number;
  end: number;
  callee: string;
  strong: boolean;
}

const JS_GENERIC = ["boolean", "string", "number", "json", "evaluate"];
const JS_SPECIFIC = ["useFlag", "useFlagDetails", "booleanDetails", "stringDetails", "numberDetails", "jsonDetails", "evaluateDetails"];
const OPENFEATURE = [
  "getBooleanValue", "getStringValue", "getNumberValue", "getObjectValue", "getIntegerValue", "getDoubleValue",
  "getBooleanDetails", "getStringDetails", "getNumberDetails", "getObjectDetails", "getIntegerDetails", "getDoubleDetails",
  "get_boolean_value", "get_string_value", "get_float_value", "get_integer_value", "get_object_value",
  "get_boolean_details", "get_string_details", "get_float_details", "get_integer_details", "get_object_details",
  "GetBooleanValueAsync", "GetStringValueAsync", "GetIntegerValueAsync", "GetDoubleValueAsync", "GetObjectValueAsync",
  "GetBooleanDetailsAsync", "GetStringDetailsAsync", "GetIntegerDetailsAsync", "GetDoubleDetailsAsync", "GetObjectDetailsAsync",
];
/** Go OpenFeature getters take a context first: client.BooleanValue(ctx, "k", …). */
const GO_OPENFEATURE = ["BooleanValue", "StringValue", "FloatValue", "IntValue", "ObjectValue", "BooleanValueDetails", "StringValueDetails", "FloatValueDetails", "IntValueDetails", "ObjectValueDetails"];

function variations(): string[] {
  const kinds = ["bool", "string", "number", "json", "int", "long", "double", "float64", "jsonValue", "JSON", "Float64"];
  const out = new Set<string>();
  for (const k of kinds) {
    for (const cap of [k, k[0]!.toUpperCase() + k.slice(1)]) {
      out.add(`${cap}Variation`);
      out.add(`${cap}VariationDetail`);
    }
  }
  for (const k of ["bool", "string", "number", "json"]) {
    out.add(`${k}_variation`);
    out.add(`${k}_variation_detail`);
  }
  return [...out];
}

const SPECIFIC = new Set<string>([...variations(), ...JS_SPECIFIC, ...OPENFEATURE, ...GO_OPENFEATURE, "rememberFlag"]);
const GENERIC = new Set<string>(JS_GENERIC);
const CTX_FIRST = new Set<string>(GO_OPENFEATURE);

/** Every getter name the scanner recognises. */
export const GETTER_NAMES: ReadonlySet<string> = new Set([...SPECIFIC, ...GENERIC]);

const FLAGGY_RECEIVER = /flag|nanoflags|^nf$|featureclient|openfeature/i;

type Family = "c" | "hash" | "python";

function family(languageId: string): Family {
  if (languageId === "python") return "python";
  if (languageId === "ruby" || languageId === "shellscript" || languageId === "yaml") return "hash";
  return "c";
}

/**
 * Replaces comments with spaces (offsets are kept) so commented-out calls are not references.
 * Strings are kept as they are. PHP accepts both `//` and `#` comments.
 */
export function maskComments(text: string, languageId: string): string {
  const fam = family(languageId);
  const hashComments = fam !== "c" || languageId === "php";
  const slashComments = fam === "c";
  const out = text.split("");
  let i = 0;
  const n = text.length;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) if (out[j] !== "\n" && out[j] !== "\r") out[j] = " ";
  };
  while (i < n) {
    const c = text[i]!;
    if (fam === "python" && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const q = text.slice(i, i + 3);
      const end = text.indexOf(q, i + 3);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      if (c === "'" && (languageId === "rust" || languageId === "swift")) {
        i++;
        continue;
      }
      i++;
      while (i < n && text[i] !== c && text[i] !== "\n") {
        if (text[i] === "\\") i++;
        i++;
      }
      if (c === "`" && i < n && text[i] === "\n") {
        // Template literals and Go raw strings span lines.
        while (i < n && text[i] !== "`") i++;
      }
      i++;
      continue;
    }
    if (slashComments && c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      continue;
    }
    if (slashComments && c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      blank(i, end < 0 ? n : end + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (hashComments && c === "#" && !(languageId === "php" && text[i + 1] === "[")) {
      const end = text.indexOf("\n", i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      continue;
    }
    i++;
  }
  return out.join("");
}

const NAME_ALT = [...GETTER_NAMES].sort((a, b) => b.length - a.length).join("|");
// receiver?  name  <generics>?  (  [ctx,]?  [key:|flagKey:]?  "key"  followed by , or )
const CALL_RE = new RegExp(
  String.raw`(?:([A-Za-z_$][\w$]*)\s*(?:\?\.|!\.|\.|->|::)\s*)?(?<![\w$])(` +
    NAME_ALT +
    String.raw`)\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*\(\s*((?:[A-Za-z_][\w.]*(?:\(\s*\))?\s*,\s*)?)(?:(?:key|flagKey)\s*:\s*)?` +
    String.raw`(?:[rRuUbB]?)("([^"\\\n]*)"|'([^'\\\n]*)'|` + "`([^`$\\\\]*)`" + String.raw`)\s*(?=[,)])`,
  "g",
);
const FLAG_KEY_ARG_RE = /(?<![\w$])flagKey\s*:\s*("([^"\\\n]*)"|'([^'\\\n]*)')/g;

/** Finds flag references in a document. */
export function scanText(text: string, languageId: string): FlagRef[] {
  const src = maskComments(text, languageId);
  const refs: FlagRef[] = [];
  for (const m of src.matchAll(CALL_RE)) {
    const receiver = m[1];
    const callee = m[2]!;
    const ctxArg = m[3] ?? "";
    if (ctxArg !== "" && !CTX_FIRST.has(callee)) continue;
    const key = m[5] ?? m[6] ?? m[7];
    if (key === undefined || key === "") continue;
    const literal = m[4]!;
    const litStart = m.index! + m[0].lastIndexOf(literal);
    const start = litStart + 1;
    const strong = SPECIFIC.has(callee) || (receiver !== undefined && FLAGGY_RECEIVER.test(receiver));
    refs.push({ key, start, end: start + key.length, callee, strong });
  }
  for (const m of src.matchAll(FLAG_KEY_ARG_RE)) {
    const key = m[2] ?? m[3];
    if (!key) continue;
    const start = m.index! + m[0].indexOf(m[1]!) + 1;
    if (refs.some((r) => r.start === start)) continue;
    refs.push({ key, start, end: start + key.length, callee: "flagKey", strong: true });
  }
  return refs.sort((a, b) => a.start - b.start);
}

/** The reference whose key text contains the offset (inclusive of the closing quote position). */
export function refAt(refs: FlagRef[], offset: number): FlagRef | undefined {
  return refs.find((r) => offset >= r.start && offset <= r.end);
}

export interface CompletionContext {
  /** Text of the key typed so far (between the opening quote and the cursor). */
  prefix: string;
  /** Offset where the key starts (just after the opening quote). */
  start: number;
  quote: string;
  callee: string;
}

const COMPLETION_RE = new RegExp(
  String.raw`(?:([A-Za-z_$][\w$]*)\s*(?:\?\.|!\.|\.|->|::)\s*)?(?<![\w$])(` +
    NAME_ALT +
    String.raw`)\s*(?:<[^<>()]*>)?\s*\(\s*((?:[A-Za-z_][\w.]*(?:\(\s*\))?\s*,\s*)?)(?:(?:key|flagKey)\s*:\s*)?(["'` + "`" + String.raw`])([\w.:/-]*)$`,
);
const COMPLETION_FLAGKEY_RE = /(?<![\w$])flagKey\s*:\s*(["'])([\w.:/-]*)$/;

/**
 * Whether the cursor is inside the key string of a getter call (for completion). Only looks at the current line.
 * Generic JS names (`x.boolean(`) complete only on a receiver that mentions flags.
 */
export function completionContextAt(lineText: string, column: number, lineOffset = 0): CompletionContext | undefined {
  const before = lineText.slice(0, column);
  const m = COMPLETION_RE.exec(before);
  if (m) {
    const receiver = m[1];
    const callee = m[2]!;
    if ((m[3] ?? "") !== "" && !CTX_FIRST.has(callee)) return undefined;
    if (GENERIC.has(callee) && !(receiver && FLAGGY_RECEIVER.test(receiver))) return undefined;
    const prefix = m[5]!;
    return { prefix, start: lineOffset + column - prefix.length, quote: m[4]!, callee };
  }
  const f = COMPLETION_FLAGKEY_RE.exec(before);
  if (f) {
    const prefix = f[2]!;
    return { prefix, start: lineOffset + column - prefix.length, quote: f[1]!, callee: "flagKey" };
  }
  return undefined;
}

/** Languages the extension scans (VS Code language ids). */
export const LANGUAGES = [
  "javascript", "javascriptreact", "typescript", "typescriptreact", "vue", "svelte", "astro",
  "python", "go", "java", "csharp", "php", "ruby", "kotlin", "swift", "dart",
];
