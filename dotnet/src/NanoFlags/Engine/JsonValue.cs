using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace NanoFlags.Engine
{
    /// <summary>
    /// A JSON value with JavaScript semantics.
    /// </summary>
    /// <remarks>
    /// The engine is specified by its TypeScript implementation, which evaluates configuration that is plain JSON data
    /// with JavaScript semantics (truthiness, loose property access, <c>Number()</c>, <c>String()</c>,
    /// <c>JSON.stringify</c>). <see cref="JsonValue"/> models exactly that subset of JavaScript so that this port
    /// produces identical results, malformed configurations included. Values are immutable and thread-safe.
    /// <see cref="Undefined"/> is JavaScript <c>undefined</c> (no value at all); <see cref="Null"/> is JSON <c>null</c>.
    /// </remarks>
    public abstract class JsonValue
    {
        private protected JsonValue() { }

        /// <summary>JavaScript <c>undefined</c>. Never produced by parsing JSON text.</summary>
        public static readonly JsonValue Undefined = new UndefinedValue();

        /// <summary>JSON <c>null</c>.</summary>
        public static readonly JsonValue Null = new NullValue();

        /// <summary>JSON <c>true</c>.</summary>
        public static readonly Bool True = new Bool(true);

        /// <summary>JSON <c>false</c>.</summary>
        public static readonly Bool False = new Bool(false);

        private sealed class UndefinedValue : JsonValue
        {
            public override string ToString() => "undefined";
        }

        private sealed class NullValue : JsonValue
        {
            public override string ToString() => "null";
        }

        /// <summary>A JSON boolean.</summary>
        public sealed class Bool : JsonValue
        {
            internal Bool(bool value) => Value = value;

            /// <summary>The boolean.</summary>
            public bool Value { get; }

            /// <summary>The shared instance for <paramref name="b"/>.</summary>
            public static Bool Of(bool b) => b ? True : False;

            /// <inheritdoc/>
            public override bool Equals(object? obj) => obj is Bool b && b.Value == Value;

            /// <inheritdoc/>
            public override int GetHashCode() => Value.GetHashCode();

            /// <inheritdoc/>
            public override string ToString() => Value ? "true" : "false";
        }

        /// <summary>A JavaScript number (IEEE-754 double; JSON overflow becomes ±Infinity).</summary>
        public sealed class Num : JsonValue
        {
            /// <summary>Creates a number.</summary>
            public Num(double value) => Value = value;

            /// <summary>The number.</summary>
            public double Value { get; }

            /// <inheritdoc/>
            public override bool Equals(object? obj) => obj is Num n && n.Value == Value;

            /// <inheritdoc/>
            public override int GetHashCode() => (Value == 0 ? 0.0 : Value).GetHashCode();

            /// <inheritdoc/>
            public override string ToString() => Js.NumberToString(Value);
        }

        /// <summary>A JavaScript string (UTF-16; lone surrogates are kept as they are).</summary>
        public sealed class Str : JsonValue
        {
            /// <summary>Creates a string.</summary>
            public Str(string value) => Value = value ?? throw new ArgumentNullException(nameof(value));

            /// <summary>The string.</summary>
            public string Value { get; }

            /// <inheritdoc/>
            public override bool Equals(object? obj) => obj is Str s && string.Equals(s.Value, Value, StringComparison.Ordinal);

            /// <inheritdoc/>
            public override int GetHashCode() => StringComparer.Ordinal.GetHashCode(Value);

            /// <inheritdoc/>
            public override string ToString() => Value;
        }

        /// <summary>A JSON array.</summary>
        public sealed class Arr : JsonValue
        {
            /// <summary>Creates an array (the list is copied).</summary>
            public Arr(IEnumerable<JsonValue> items) => Items = items.ToList().AsReadOnly();

            internal Arr(List<JsonValue> items, bool owned) => Items = items.AsReadOnly();

            /// <summary>The elements.</summary>
            public IReadOnlyList<JsonValue> Items { get; }

            /// <inheritdoc/>
            public override bool Equals(object? obj) => obj is Arr a && a.Items.SequenceEqual(Items);

            /// <inheritdoc/>
            public override int GetHashCode() => Items.Count;

            /// <inheritdoc/>
            public override string ToString() => ToJson() ?? "[]";
        }

        /// <summary>
        /// A plain object. <see cref="Keys"/> are in JavaScript own-property order: array-index keys ascending first,
        /// then the other keys in insertion order (a repeated key keeps its first position and its last value, as
        /// <c>JSON.parse</c> does).
        /// </summary>
        public sealed class Obj : JsonValue
        {
            /// <summary>The empty object.</summary>
            public static readonly Obj Empty = new Builder().Build();

            private readonly Dictionary<string, JsonValue> _map;

            private Obj(IReadOnlyList<string> keys, Dictionary<string, JsonValue> map)
            {
                Keys = keys;
                _map = map;
            }

            /// <summary>Own property names in JavaScript order.</summary>
            public IReadOnlyList<string> Keys { get; }

            /// <summary>The number of members.</summary>
            public int Count => Keys.Count;

            /// <summary>The member <paramref name="key"/>, or <c>null</c> when absent.</summary>
            public JsonValue? Get(string key) => _map.TryGetValue(key, out var v) ? v : null;

            /// <summary>Whether the member exists.</summary>
            public bool ContainsKey(string key) => _map.ContainsKey(key);

            /// <inheritdoc/>
            public override bool Equals(object? obj) =>
                obj is Obj o && o.Keys.SequenceEqual(Keys) && Keys.All(k => o._map[k].Equals(_map[k]));

            /// <inheritdoc/>
            public override int GetHashCode() => Keys.Count;

            /// <inheritdoc/>
            public override string ToString() => ToJson() ?? "{}";

            /// <summary>A new builder.</summary>
            public static Builder CreateBuilder() => new Builder();

            /// <summary>Builds an <see cref="Obj"/>; a repeated key keeps its first position and its last value.</summary>
            public sealed class Builder
            {
                private readonly Dictionary<string, JsonValue> _map = new Dictionary<string, JsonValue>(StringComparer.Ordinal);
                private readonly List<string> _order = new List<string>();

                /// <summary>Sets a member.</summary>
                public Builder Put(string key, JsonValue value)
                {
                    if (key == null) throw new ArgumentNullException(nameof(key));
                    if (!_map.ContainsKey(key)) _order.Add(key);
                    _map[key] = value ?? throw new ArgumentNullException(nameof(value));
                    return this;
                }

                /// <summary>The object.</summary>
                public Obj Build()
                {
                    var index = new List<KeyValuePair<long, string>>();
                    var names = new List<string>();
                    foreach (var k in _order)
                    {
                        var n = ArrayIndex(k);
                        if (n >= 0) index.Add(new KeyValuePair<long, string>(n, k));
                        else names.Add(k);
                    }
                    var keys = index.OrderBy(e => e.Key).Select(e => e.Value).ToList();
                    keys.AddRange(names);
                    return new Obj(keys.AsReadOnly(), new Dictionary<string, JsonValue>(_map, StringComparer.Ordinal));
                }
            }
        }

        /// <summary>A function value; only ever produced by reading a String / Array prototype method by name.</summary>
        internal sealed class Func : JsonValue
        {
            internal Func(string name) => Name = name;

            internal string Name { get; }

            public override string ToString() => "function " + Name + "() { [native code] }";
        }

        /* ---------------- helpers ---------------- */

        /// <summary>Whether this is <c>undefined</c>.</summary>
        public bool IsUndefined => ReferenceEquals(this, Undefined);

        /// <summary>Whether this is <c>null</c>.</summary>
        public bool IsNull => ReferenceEquals(this, Null);

        /// <summary><c>JSON.stringify(this)</c>, or <c>null</c> when <c>JSON.stringify</c> would return <c>undefined</c>.</summary>
        public string? ToJson()
        {
            if (IsUndefined || this is Func) return null;
            var sb = new StringBuilder();
            Js.WriteJson(this, sb, 0);
            return sb.ToString();
        }

        /// <summary>
        /// Plain .NET data: <c>null</c> (null and undefined), <see cref="bool"/>, <see cref="double"/>, <see cref="string"/>,
        /// <see cref="List{T}"/> of object and <see cref="Dictionary{TKey,TValue}"/> (string keys, configuration order).
        /// </summary>
        public object? ToObject()
        {
            switch (this)
            {
                case Bool b: return b.Value;
                case Num n: return n.Value;
                case Str s: return s.Value;
                case Arr a: return a.Items.Select(x => x.ToObject()).ToList();
                case Obj o:
                    var d = new Dictionary<string, object?>(StringComparer.Ordinal);
                    foreach (var k in o.Keys)
                    {
                        var v = o.Get(k)!;
                        if (!v.IsUndefined) d[k] = v.ToObject();
                    }
                    return d;
                default: return null;
            }
        }

        /// <summary>The engine's type name: "null", "array", or the JavaScript <c>typeof</c> ("boolean", "number", …, "undefined").</summary>
        public string TypeName
        {
            get
            {
                if (IsUndefined) return "undefined";
                if (IsNull) return "null";
                switch (this)
                {
                    case Bool _: return "boolean";
                    case Num _: return "number";
                    case Str _: return "string";
                    case Arr _: return "array";
                    case Func _: return "function";
                    default: return "object";
                }
            }
        }

        /// <summary>Own property <paramref name="name"/> of an object (<see cref="Undefined"/> when absent or when this is not an object).</summary>
        public JsonValue Field(string name) => Js.Own(this, name);

        /// <summary>Parses JSON text exactly like JavaScript's <c>JSON.parse</c>.</summary>
        /// <exception cref="InvalidJsonException">The text is not valid JSON.</exception>
        public static JsonValue Parse(string text) => new JsonParser(text).ParseDocument();

        /// <summary>Parses UTF-8 JSON bytes (invalid UTF-8 becomes U+FFFD).</summary>
        public static JsonValue Parse(byte[] utf8) => Parse(Encoding.UTF8.GetString(utf8));

        internal const int MaxDepth = 512;

        /// <summary>
        /// Converts .NET data: <c>null</c>, <see cref="bool"/>, every numeric type (as a double, like JavaScript),
        /// <see cref="string"/>, <see cref="char"/>, enums (their name), dictionaries with string keys, sequences,
        /// <see cref="DateTime"/> / <see cref="DateTimeOffset"/> (ISO-8601), <see cref="Guid"/>, <see cref="JsonValue"/>.
        /// Anything else becomes <c>null</c>.
        /// </summary>
        public static JsonValue Of(object? x) => Of(x, 0);

        private static JsonValue Of(object? x, int depth)
        {
            if (depth > MaxDepth) throw new InvalidOperationException("The value is nested too deeply (or contains a cycle).");
            switch (x)
            {
                case null: return Null;
                case JsonValue j: return j;
                case bool b: return Bool.Of(b);
                case string s: return new Str(s);
                case char c: return new Str(c.ToString());
                case Enum e: return new Str(e.ToString());
                case double d: return new Num(d);
                case float f: return new Num(f);
                case decimal m: return new Num((double)m);
                case byte _:
                case sbyte _:
                case short _:
                case ushort _:
                case int _:
                case uint _:
                case long _:
                case ulong _:
                    return new Num(Convert.ToDouble(x, CultureInfo.InvariantCulture));
                case System.Numerics.BigInteger bi: return new Num((double)bi);
                case DateTime dt: return new Str(dt.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
                case DateTimeOffset dto: return new Str(dto.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
                case Guid g: return new Str(g.ToString());
                case IDictionary<string, object?> dict:
                {
                    var b = new Obj.Builder();
                    foreach (var kv in dict) b.Put(kv.Key, Of(kv.Value, depth + 1));
                    return b.Build();
                }
                case IReadOnlyDictionary<string, object?> rdict:
                {
                    var b = new Obj.Builder();
                    foreach (var kv in rdict) b.Put(kv.Key, Of(kv.Value, depth + 1));
                    return b.Build();
                }
                case IDictionary gdict:
                {
                    var b = new Obj.Builder();
                    foreach (DictionaryEntry kv in gdict) b.Put(Convert.ToString(kv.Key, CultureInfo.InvariantCulture) ?? "", Of(kv.Value, depth + 1));
                    return b.Build();
                }
                case IEnumerable seq:
                {
                    var list = new List<JsonValue>();
                    foreach (var o in seq) list.Add(Of(o, depth + 1));
                    return new Arr(list, true);
                }
                default: return Null;
            }
        }

        /// <summary>A canonical array index (0 … 2^32-2), or -1.</summary>
        internal static long ArrayIndex(string k)
        {
            if (k.Length == 0 || k.Length > 10 || (k.Length > 1 && k[0] == '0')) return -1;
            long n = 0;
            foreach (var c in k)
            {
                if (c < '0' || c > '9') return -1;
                n = n * 10 + (c - '0');
            }
            return n < 4294967295L ? n : -1;
        }
    }

    /// <summary>Thrown by <see cref="JsonValue.Parse(string)"/> for text that <c>JSON.parse</c> rejects.</summary>
    public sealed class InvalidJsonException : FormatException
    {
        /// <summary>Creates the exception.</summary>
        public InvalidJsonException(string message) : base(message) { }
    }

    /// <summary>V8's TypeError for the operations the engine performs (the message matches V8's).</summary>
    public sealed class JsTypeError : Exception
    {
        /// <summary>Creates the exception.</summary>
        public JsTypeError(string message) : base(message) { }
    }
}
