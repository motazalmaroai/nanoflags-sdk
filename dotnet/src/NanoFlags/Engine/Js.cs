using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace NanoFlags.Engine
{
    /// <summary>The JavaScript abstract operations the engine relies on.</summary>
    internal static class Js
    {
        internal static void WriteJson(JsonValue v, StringBuilder sb, int depth)
        {
            if (depth > JsonValue.MaxDepth * 4) throw new InvalidOperationException("The value is nested too deeply.");
            switch (v)
            {
                case JsonValue.Bool b:
                    sb.Append(b.Value ? "true" : "false");
                    break;
                case JsonValue.Num n:
                    if (double.IsNaN(n.Value) || double.IsInfinity(n.Value)) sb.Append("null");
                    else sb.Append(NumberToString(n.Value));
                    break;
                case JsonValue.Str s:
                    Quote(s.Value, sb);
                    break;
                case JsonValue.Arr a:
                    sb.Append('[');
                    for (int i = 0; i < a.Items.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        var e = a.Items[i];
                        if (e.IsUndefined || e is JsonValue.Func) sb.Append("null");
                        else WriteJson(e, sb, depth + 1);
                    }
                    sb.Append(']');
                    break;
                case JsonValue.Obj o:
                {
                    sb.Append('{');
                    bool first = true;
                    foreach (var k in o.Keys)
                    {
                        var e = o.Get(k)!;
                        if (e.IsUndefined || e is JsonValue.Func) continue;
                        if (!first) sb.Append(',');
                        first = false;
                        Quote(k, sb);
                        sb.Append(':');
                        WriteJson(e, sb, depth + 1);
                    }
                    sb.Append('}');
                    break;
                }
                default:
                    sb.Append("null");
                    break;
            }
        }

        private const string HexDigits = "0123456789abcdef";

        /// <summary><c>JSON.stringify</c> of a string (well-formed JSON.stringify: lone surrogates are escaped).</summary>
        internal static void Quote(string s, StringBuilder sb)
        {
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\b') sb.Append("\\b");
                else if (c == '\f') sb.Append("\\f");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < ' ') Hex(c, sb);
                else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                {
                    sb.Append(c).Append(s[i + 1]);
                    i++;
                }
                else if (char.IsSurrogate(c)) Hex(c, sb);
                else sb.Append(c);
            }
            sb.Append('"');
        }

        internal static string Quote(string s)
        {
            var sb = new StringBuilder(s.Length + 2);
            Quote(s, sb);
            return sb.ToString();
        }

        private static void Hex(char c, StringBuilder sb)
        {
            int u = c;
            sb.Append("\\u").Append(HexDigits[(u >> 12) & 0xF]).Append(HexDigits[(u >> 8) & 0xF]).Append(HexDigits[(u >> 4) & 0xF]).Append(HexDigits[u & 0xF]);
        }

        /// <summary>ECMAScript Number::toString(x) for radix 10 (shortest round-trip digits).</summary>
        internal static string NumberToString(double d)
        {
            if (double.IsNaN(d)) return "NaN";
            if (d == 0.0) return "0";
            if (double.IsPositiveInfinity(d)) return "Infinity";
            if (double.IsNegativeInfinity(d)) return "-Infinity";
            bool neg = d < 0;
            double x = Math.Abs(d);
            if (x < 9.007199254740992E15 && x == Math.Floor(x)) return (neg ? "-" : "") + ((long)x).ToString(CultureInfo.InvariantCulture);
            string digits = DoubleConv.Shortest(x, out int n);
            int k = digits.Length;
            string output;
            if (k <= n && n <= 21) output = digits + new string('0', n - k);
            else if (n >= 1 && n <= 21) output = digits.Substring(0, n) + "." + digits.Substring(n);
            else if (n > -6 && n <= 0) output = "0." + new string('0', -n) + digits;
            else
            {
                int e = n - 1;
                string es = (e < 0 ? "-" : "+") + Math.Abs(e).ToString(CultureInfo.InvariantCulture);
                output = k == 1 ? digits + "e" + es : digits.Substring(0, 1) + "." + digits.Substring(1) + "e" + es;
            }
            return neg ? "-" + output : output;
        }

        /// <summary>String(v).</summary>
        internal static string ToStr(JsonValue v)
        {
            if (v.IsUndefined) return "undefined";
            if (v.IsNull) return "null";
            switch (v)
            {
                case JsonValue.Bool b: return b.Value ? "true" : "false";
                case JsonValue.Num n: return NumberToString(n.Value);
                case JsonValue.Str s: return s.Value;
                case JsonValue.Arr a: return Join(a, ",");
                case JsonValue.Func f: return "function " + f.Name + "() { [native code] }";
                default: return "[object Object]";
            }
        }

        /// <summary>Array.prototype.join.</summary>
        internal static string Join(JsonValue.Arr v, string sep)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < v.Items.Count; i++)
            {
                if (i > 0) sb.Append(sep);
                var e = v.Items[i];
                if (!e.IsUndefined && !e.IsNull) sb.Append(ToStr(e));
            }
            return sb.ToString();
        }

        /// <summary>ToBoolean(v).</summary>
        internal static bool Truthy(JsonValue v)
        {
            if (v.IsUndefined || v.IsNull) return false;
            switch (v)
            {
                case JsonValue.Bool b: return b.Value;
                case JsonValue.Num n: return n.Value != 0.0 && !double.IsNaN(n.Value);
                case JsonValue.Str s: return s.Value.Length > 0;
                default: return true;
            }
        }

        /// <summary>ToNumber(ToPrimitive(v, number)).</summary>
        internal static double ToNumber(JsonValue v)
        {
            if (v.IsUndefined) return double.NaN;
            if (v.IsNull) return 0.0;
            switch (v)
            {
                case JsonValue.Bool b: return b.Value ? 1.0 : 0.0;
                case JsonValue.Num n: return n.Value;
                case JsonValue.Str s: return StringToNumber(s.Value);
                default: return StringToNumber(ToStr(v));
            }
        }

        internal static bool IsJsWhitespace(char c)
        {
            switch ((int)c)
            {
                case 0x09:
                case 0x0A:
                case 0x0B:
                case 0x0C:
                case 0x0D:
                case 0x20:
                case 0xA0:
                case 0x1680:
                case 0x2028:
                case 0x2029:
                case 0x202F:
                case 0x205F:
                case 0x3000:
                case 0xFEFF:
                    return true;
                default:
                    return c >= (char)0x2000 && c <= (char)0x200A;
            }
        }

        /// <summary>String.prototype.trim.</summary>
        internal static string Trim(string s)
        {
            int a = 0, b = s.Length;
            while (a < b && IsJsWhitespace(s[a])) a++;
            while (b > a && IsJsWhitespace(s[b - 1])) b--;
            return s.Substring(a, b - a);
        }

        private static int DigitValue(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'z') return c - 'a' + 10;
            if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
            return -1;
        }

        /// <summary>ECMAScript StringToNumber.</summary>
        internal static double StringToNumber(string input)
        {
            string s = Trim(input);
            if (s.Length == 0) return 0.0;
            if (s == "Infinity" || s == "+Infinity") return double.PositiveInfinity;
            if (s == "-Infinity") return double.NegativeInfinity;
            if (s.Length > 2 && s[0] == '0')
            {
                int radix = 0;
                char p = s[1];
                if (p == 'x' || p == 'X') radix = 16;
                else if (p == 'o' || p == 'O') radix = 8;
                else if (p == 'b' || p == 'B') radix = 2;
                if (radix != 0)
                {
                    var n = BigInteger.Zero;
                    for (int j = 2; j < s.Length; j++)
                    {
                        int dv = DigitValue(s[j]);
                        if (dv < 0 || dv >= radix) return double.NaN;
                        n = n * radix + dv;
                    }
                    return DoubleConv.ToDouble(n, 0);
                }
            }
            // StrDecimalLiteral: [+-] (digits [. digits] | . digits) [e [+-] digits]
            int i = 0;
            if (s[i] == '+' || s[i] == '-') i++;
            int intDigits = 0;
            while (i < s.Length && s[i] >= '0' && s[i] <= '9')
            {
                i++;
                intDigits++;
            }
            int fracDigits = 0;
            if (i < s.Length && s[i] == '.')
            {
                i++;
                while (i < s.Length && s[i] >= '0' && s[i] <= '9')
                {
                    i++;
                    fracDigits++;
                }
            }
            if (intDigits + fracDigits == 0) return double.NaN;
            if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
            {
                i++;
                if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
                int expDigits = 0;
                while (i < s.Length && s[i] >= '0' && s[i] <= '9')
                {
                    i++;
                    expDigits++;
                }
                if (expDigits == 0) return double.NaN;
            }
            if (i != s.Length) return double.NaN;
            return DoubleConv.ParseDecimal(s);
        }

        private static readonly HashSet<string> StringMethods = new HashSet<string>(StringComparer.Ordinal)
        {
            "anchor", "at", "big", "blink", "bold", "charAt", "charCodeAt", "codePointAt", "concat", "constructor", "endsWith", "fixed",
            "fontcolor", "fontsize", "includes", "indexOf", "isWellFormed", "italics", "lastIndexOf", "link", "localeCompare", "match",
            "matchAll", "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll", "search", "slice", "small", "split", "strike",
            "sub", "substr", "substring", "sup", "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase", "toString", "toUpperCase",
            "toWellFormed", "trim", "trimEnd", "trimLeft", "trimRight", "trimStart", "valueOf",
        };

        private static readonly HashSet<string> ArrayMethods = new HashSet<string>(StringComparer.Ordinal)
        {
            "at", "concat", "constructor", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast",
            "findLastIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push",
            "reduce", "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice", "toLocaleString", "toReversed", "toSorted",
            "toSpliced", "toString", "unshift", "values", "with",
        };

        /// <summary>Object.prototype members, as <c>${words[name]}</c> renders them in describeCondition.</summary>
        internal static readonly Dictionary<string, string> ObjectProtoStrings = BuildProto();

        private static Dictionary<string, string> BuildProto()
        {
            var d = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var n in new[] { "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf",
                         "propertyIsEnumerable", "toString", "valueOf", "toLocaleString" })
            {
                d[n] = "function " + n + "() { [native code] }";
            }
            d["constructor"] = "function Object() { [native code] }";
            d["__proto__"] = "[object Object]";
            return d;
        }

        /// <summary>
        /// The property read <c>v[name]</c> for the fixed property names the engine reads. Plain objects only expose own
        /// properties here: none of those names exist on Object.prototype.
        /// </summary>
        internal static JsonValue Get(JsonValue v, string name)
        {
            if (v.IsUndefined || v.IsNull) throw new JsTypeError("Cannot read properties of " + ToStr(v) + " (reading '" + name + "')");
            switch (v)
            {
                case JsonValue.Str s:
                {
                    if (name == "length") return new JsonValue.Num(s.Value.Length);
                    long n = JsonValue.ArrayIndex(name);
                    if (n >= 0) return n < s.Value.Length ? new JsonValue.Str(s.Value[(int)n].ToString()) : JsonValue.Undefined;
                    if (StringMethods.Contains(name)) return new JsonValue.Func(name);
                    break;
                }
                case JsonValue.Arr a:
                {
                    if (name == "length") return new JsonValue.Num(a.Items.Count);
                    long n = JsonValue.ArrayIndex(name);
                    if (n >= 0) return n < a.Items.Count ? a.Items[(int)n] : JsonValue.Undefined;
                    if (ArrayMethods.Contains(name)) return new JsonValue.Func(name);
                    break;
                }
                case JsonValue.Obj o:
                    return o.Get(name) ?? JsonValue.Undefined;
            }
            return JsonValue.Undefined;
        }

        /// <summary>The engine's <c>own(obj, key)</c>: an own-property lookup that never reads inherited members.</summary>
        internal static JsonValue Own(JsonValue obj, string key)
        {
            if (obj is JsonValue.Obj o) return o.Get(key) ?? JsonValue.Undefined;
            if (obj is JsonValue.Arr || obj is JsonValue.Str) return JsonValue.ArrayIndex(key) >= 0 || key == "length" ? Get(obj, key) : JsonValue.Undefined;
            return JsonValue.Undefined;
        }
    }
}
