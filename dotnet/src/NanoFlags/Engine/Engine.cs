using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace NanoFlags.Engine
{
    /// <summary>Why an evaluation produced its value.</summary>
    public enum Reason
    {
        /// <summary>A rule matched ("rule_match").</summary>
        RuleMatch,
        /// <summary>No rule matched; the flag default was served ("default").</summary>
        Default,
        /// <summary>The flag is disabled ("off").</summary>
        Off,
        /// <summary>The flag (or any configuration) is missing; the fallback was served ("flag_not_found").</summary>
        FlagNotFound,
        /// <summary>Evaluation failed or the value had another type; the fallback was served ("error").</summary>
        Error,
    }

    /// <summary>Wire spellings of <see cref="Reason"/>.</summary>
    public static class ReasonExtensions
    {
        /// <summary>The engine's spelling ("rule_match", "default", "off", "flag_not_found", "error").</summary>
        public static string Wire(this Reason r)
        {
            switch (r)
            {
                case Reason.RuleMatch: return "rule_match";
                case Reason.Default: return "default";
                case Reason.Off: return "off";
                case Reason.FlagNotFound: return "flag_not_found";
                default: return "error";
            }
        }
    }

    /// <summary>One line of the human-readable explanation of an evaluation.</summary>
    public sealed class TraceStep
    {
        /// <summary>Creates a step.</summary>
        public TraceStep(string kind, string title, string detail, bool? matched = null)
        {
            Kind = kind;
            Title = title;
            Detail = detail;
            Matched = matched;
        }

        /// <summary>"config", "rule", "allocation" or "result".</summary>
        public string Kind { get; }

        /// <summary>The headline.</summary>
        public string Title { get; }

        /// <summary>The explanation.</summary>
        public string Detail { get; }

        /// <summary>Set for rule and allocation steps.</summary>
        public bool? Matched { get; }

        /// <inheritdoc/>
        public override string ToString() => $"{Kind,-10} {Title} — {Detail}";
    }

    /// <summary>The full outcome of <see cref="Evaluator.Evaluate"/>, mirroring the engine's <c>Evaluation</c> object.</summary>
    public sealed class EngineResult
    {
        internal EngineResult(string flagKey, JsonValue value, Reason reason, IReadOnlyList<TraceStep> trace, JsonValue? revision = null,
            int ruleIndex = -1, JsonValue? ruleId = null, bool? inRollout = null, double? bucket = null, string? error = null)
        {
            FlagKey = flagKey;
            Value = value;
            Reason = reason;
            Trace = trace;
            Revision = revision ?? new JsonValue.Num(0);
            RuleIndex = ruleIndex;
            RuleId = ruleId ?? JsonValue.Undefined;
            InRollout = inRollout;
            Bucket = bucket;
            Error = error;
        }

        /// <summary>The flag key.</summary>
        public string FlagKey { get; }

        /// <summary>The served value; <see cref="JsonValue.Undefined"/> when the configuration served nothing.</summary>
        public JsonValue Value { get; }

        /// <summary>Why.</summary>
        public Reason Reason { get; }

        /// <summary>Zero-based index of the matching rule, or -1.</summary>
        public int RuleIndex { get; }

        /// <summary>The matching rule's <c>id</c> (<see cref="JsonValue.Undefined"/> when there is none).</summary>
        public JsonValue RuleId { get; }

        /// <summary>Set for percentage rollouts.</summary>
        public bool? InRollout { get; }

        /// <summary>The rollout bucket (0–99.99), set for percentage rollouts.</summary>
        public double? Bucket { get; }

        /// <summary>The bundle's <c>revision</c> (0 without a bundle).</summary>
        public JsonValue Revision { get; }

        /// <summary>The decision step by step.</summary>
        public IReadOnlyList<TraceStep> Trace { get; }

        /// <summary>The evaluation error message (reason <see cref="Reason.Error"/> only).</summary>
        public string? Error { get; }
    }

    /// <summary>Attribute lookup for evaluation: the engine only ever reads own attributes by name.</summary>
    public interface IEvalContext
    {
        /// <summary>The attribute, or <c>null</c> when it is absent (<c>undefined</c>).</summary>
        JsonValue? Lookup(string name);
    }

    /// <summary>Context implementations.</summary>
    public static class EvalContexts
    {
        private sealed class ValueContext : IEvalContext
        {
            private readonly JsonValue _v;

            public ValueContext(JsonValue v) => _v = v;

            public JsonValue? Lookup(string name) => (_v as JsonValue.Obj)?.Get(name);
        }

        private sealed class MapContext : IEvalContext
        {
            private readonly IReadOnlyDictionary<string, object?>? _m;

            public MapContext(IReadOnlyDictionary<string, object?>? m) => _m = m;

            public JsonValue? Lookup(string name) => _m != null && _m.TryGetValue(name, out var v) ? JsonValue.Of(v) : null;
        }

        /// <summary>A context held as an object <see cref="JsonValue"/> (as parsed from JSON).</summary>
        public static IEvalContext Of(JsonValue v) => new ValueContext(v);

        /// <summary>A context backed by .NET data; values are converted with <see cref="JsonValue.Of(object)"/> when read.</summary>
        public static IEvalContext Of(IReadOnlyDictionary<string, object?>? m) => new MapContext(m);
    }

    /// <summary>
    /// The NanoFlags evaluation engine: a port of the TypeScript engine (<c>@nanoflags/engine</c>) that the dashboard, the
    /// edge and every SDK share. Pure and deterministic: the same bundle, flag key and context always produce the same
    /// result, including the bucket of percentage rollouts (MurmurHash3 x86 32-bit over the NFC-normalised UTF-8 bytes of
    /// <c>"seed:identity"</c>). The shared conformance fixtures (<c>packages/engine/fixtures/parity.json</c>) pin the
    /// behaviour, malformed configurations included.
    /// </summary>
    public static class Evaluator
    {
        /// <summary>The engine version implemented here. Newer bundles are refused.</summary>
        public const int Version = 1;

        /* ---------------- hashing ---------------- */

        private static string Nfc(string s)
        {
            try
            {
                return s.Normalize(NormalizationForm.FormC);
            }
            catch (PlatformNotSupportedException)
            {
                return s; // globalization-invariant mode without normalization data
            }
        }

        /// <summary>
        /// <c>TextEncoder.encode(input.normalize("NFC"))</c>: well-formed runs are NFC-normalised, lone surrogates (which
        /// never compose with their neighbours) become U+FFFD.
        /// </summary>
        internal static byte[] HashInput(string s)
        {
            bool simple = true;
            foreach (var ch in s)
            {
                if (ch >= '̀')
                {
                    simple = false;
                    break;
                }
            }
            if (simple) return Encoding.UTF8.GetBytes(s);
            var output = new StringBuilder(s.Length);
            int runStart = 0, i = 0;
            while (i < s.Length)
            {
                char c = s[i];
                if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                {
                    i += 2;
                    continue;
                }
                if (char.IsSurrogate(c))
                {
                    if (i > runStart) output.Append(Nfc(s.Substring(runStart, i - runStart)));
                    output.Append('�');
                    runStart = i + 1;
                }
                i++;
            }
            if (runStart < s.Length) output.Append(Nfc(s.Substring(runStart)));
            return Encoding.UTF8.GetBytes(output.ToString());
        }

        private static uint Rotl(uint x, int r) => (x << r) | (x >> (32 - r));

        /// <summary>MurmurHash3 x86 32-bit over the NFC-normalised UTF-8 bytes of <paramref name="input"/>. Distribution only.</summary>
        public static uint Murmur3(string input, uint seed = 0)
        {
            unchecked
            {
                byte[] data = HashInput(input);
                const uint c1 = 0xcc9e2d51, c2 = 0x1b873593;
                uint h = seed;
                int n = data.Length, blocks = n / 4;
                for (int i = 0; i < blocks; i++)
                {
                    int o = i * 4;
                    uint k = (uint)(data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24));
                    k *= c1;
                    k = Rotl(k, 15);
                    k *= c2;
                    h ^= k;
                    h = Rotl(h, 13);
                    h = h * 5 + 0xe6546b64;
                }
                uint t = 0;
                int tail = blocks * 4, rem = n & 3;
                if (rem >= 3) t ^= (uint)data[tail + 2] << 16;
                if (rem >= 2) t ^= (uint)data[tail + 1] << 8;
                if (rem >= 1)
                {
                    t ^= data[tail];
                    t *= c1;
                    t = Rotl(t, 15);
                    t *= c2;
                    h ^= t;
                }
                h ^= (uint)n;
                h ^= h >> 16;
                h *= 0x85ebca6b;
                h ^= h >> 13;
                h *= 0xc2b2ae35;
                h ^= h >> 16;
                return h;
            }
        }

        /// <summary>Bucket in [0, 100) with two decimals of resolution, stable for a given seed + identity.</summary>
        public static double BucketOf(string seed, string identity) => (double)(Murmur3(seed + ":" + identity) % 10000) / 100;

        /* ---------------- conditions ---------------- */

        private static bool IsObjLike(JsonValue v) => v.IsNull || v is JsonValue.Arr || v is JsonValue.Obj;

        private static bool LooseEq(JsonValue a, JsonValue b)
        {
            if (a.IsUndefined || b.IsUndefined) return false;
            if (IsObjLike(a) || IsObjLike(b)) return string.Equals(a.ToJson(), b.ToJson(), StringComparison.Ordinal);
            return StrictEq(a, b);
        }

        private static bool StrictEq(JsonValue a, JsonValue b)
        {
            if (a is JsonValue.Bool x && b is JsonValue.Bool y) return x.Value == y.Value;
            if (a is JsonValue.Num p && b is JsonValue.Num q) return p.Value == q.Value;
            if (a is JsonValue.Str s && b is JsonValue.Str t) return string.Equals(s.Value, t.Value, StringComparison.Ordinal);
            return ReferenceEquals(a, b) && (a.IsNull || a.IsUndefined);
        }

        private static double? Num(JsonValue v)
        {
            if (v is JsonValue.Num n && !double.IsNaN(n.Value) && !double.IsInfinity(n.Value)) return n.Value;
            if (v is JsonValue.Str s && Js.Trim(s.Value).Length != 0)
            {
                double d = Js.StringToNumber(s.Value);
                if (!double.IsNaN(d) && !double.IsInfinity(d)) return d;
            }
            return null;
        }

        private static bool IsStr(JsonValue v, string s) => v is JsonValue.Str x && string.Equals(x.Value, s, StringComparison.Ordinal);

        private static JsonValue Lookup(IEvalContext? ctx, string name) => ctx?.Lookup(name) ?? JsonValue.Undefined;

        private static bool MatchCondition(JsonValue c, IEvalContext? ctx, JsonValue segments, int depth)
        {
            var op = Js.Get(c, "op");
            if (IsStr(op, "segment") || IsStr(op, "not_segment"))
            {
                var segValue = Js.Get(c, "value");
                var seg = segValue is JsonValue.Str sv ? Js.Own(segments, sv.Value) : JsonValue.Undefined;
                bool inSeg = false;
                if (!seg.IsUndefined && depth < 4)
                {
                    var match = Js.Get(seg, "match");
                    var conds = Js.Get(seg, "conditions");
                    inSeg = MatchAll(match, conds, ctx, segments, depth + 1);
                }
                return IsStr(op, "segment") ? inSeg : !seg.IsUndefined && !inSeg;
            }
            var attribute = Js.Get(c, "attribute");
            var actual = Lookup(ctx, Js.ToStr(attribute));
            var value = Js.Get(c, "value");
            if (!(op is JsonValue.Str opStr)) return false;
            switch (opStr.Value)
            {
                case "exists": return !actual.IsUndefined && !actual.IsNull;
                case "not_exists": return actual.IsUndefined || actual.IsNull;
                case "eq": return LooseEq(actual, value);
                case "neq": return !actual.IsUndefined && !LooseEq(actual, value);
                case "in": return value is JsonValue.Arr inArr && inArr.Items.Any(it => LooseEq(actual, it));
                case "not_in": return !actual.IsUndefined && value is JsonValue.Arr ninArr && !ninArr.Items.Any(it => LooseEq(actual, it));
                case "contains":
                    return actual is JsonValue.Str a1 && value is JsonValue.Str v1 && a1.Value.IndexOf(v1.Value, StringComparison.Ordinal) >= 0;
                case "starts_with":
                    return actual is JsonValue.Str a2 && value is JsonValue.Str v2 && a2.Value.StartsWith(v2.Value, StringComparison.Ordinal);
                case "ends_with":
                    return actual is JsonValue.Str a3 && value is JsonValue.Str v3 && a3.Value.EndsWith(v3.Value, StringComparison.Ordinal);
                case "gt":
                case "gte":
                case "lt":
                case "lte":
                {
                    var a = Num(actual);
                    if (a == null) return false;
                    var b = Num(value);
                    if (b == null) return false;
                    switch (opStr.Value)
                    {
                        case "gt": return a.Value > b.Value;
                        case "gte": return a.Value >= b.Value;
                        case "lt": return a.Value < b.Value;
                        default: return a.Value <= b.Value;
                    }
                }
                default: return false;
            }
        }

        /// <summary>The engine's matchAll(mode, conditions, …), including its failure modes.</summary>
        private static bool MatchAll(JsonValue mode, JsonValue conditions, IEvalContext? ctx, JsonValue segments, int depth)
        {
            var length = Js.Get(conditions, "length");
            if (length is JsonValue.Num ln && ln.Value == 0.0) return true;
            bool some = IsStr(mode, "any");
            if (!(conditions is JsonValue.Arr arr)) throw new JsTypeError("conditions." + (some ? "some" : "every") + " is not a function");
            foreach (var c in arr.Items)
            {
                bool ok = MatchCondition(c, ctx, segments, depth);
                if (some && ok) return true;
                if (!some && !ok) return false;
            }
            return !some;
        }

        private static readonly Dictionary<string, string> OpWords = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["eq"] = "=", ["neq"] = "≠", ["in"] = "in", ["not_in"] = "not in", ["contains"] = "contains", ["starts_with"] = "starts with",
            ["ends_with"] = "ends with", ["gt"] = ">", ["gte"] = "≥", ["lt"] = "<", ["lte"] = "≤", ["exists"] = "exists",
            ["not_exists"] = "does not exist", ["segment"] = "in segment", ["not_segment"] = "not in segment",
        };

        private static string DescribeCondition(JsonValue c)
        {
            var value = Js.Get(c, "value");
            string v = value is JsonValue.Arr arr ? Js.Join(arr, ", ") : value.IsUndefined ? "" : Js.ToStr(value);
            var op = Js.Get(c, "op");
            string key = Js.ToStr(op);
            if (!OpWords.TryGetValue(key, out var word) && !Js.ObjectProtoStrings.TryGetValue(key, out word)) word = "undefined";
            if (IsStr(op, "segment") || IsStr(op, "not_segment")) return word + " " + v;
            var attribute = Js.Get(c, "attribute");
            if (IsStr(op, "exists") || IsStr(op, "not_exists")) return Js.ToStr(attribute) + " " + word;
            return Js.ToStr(attribute) + " " + word + " " + v;
        }

        /// <summary>The engine's fmt(v): strings as they are, everything else as JSON ("undefined" when there is none).</summary>
        private static string Fmt(JsonValue v) => v is JsonValue.Str s ? s.Value : v.ToJson() ?? "undefined";

        /* ---------------- evaluation ---------------- */

        /// <summary>
        /// Evaluates one flag of <paramref name="bundle"/> (a parsed bundle document; <see cref="JsonValue.Undefined"/> or
        /// <see cref="JsonValue.Null"/> for "no configuration loaded"). Never throws: on any problem it returns
        /// <paramref name="fallback"/> with reason <c>flag_not_found</c> or <c>error</c>.
        /// </summary>
        public static EngineResult Evaluate(JsonValue? bundle, string flagKey, IEvalContext? ctx, JsonValue? fallback)
        {
            bundle ??= JsonValue.Null;
            fallback ??= JsonValue.Null;
            bool nullish = bundle.IsUndefined || bundle.IsNull;
            JsonValue revision = new JsonValue.Num(0);
            if (!nullish)
            {
                JsonValue r;
                try
                {
                    r = Js.Get(bundle, "revision");
                }
                catch (Exception)
                {
                    r = JsonValue.Undefined;
                }
                if (!r.IsUndefined && !r.IsNull) revision = r;
            }
            var trace = new List<TraceStep>();
            try
            {
                var flag = nullish ? JsonValue.Undefined : Js.Own(Js.Get(bundle, "flags"), flagKey);
                if (!Js.Truthy(bundle) || !Js.Truthy(flag))
                {
                    string detail = Js.Truthy(bundle) ? "Flag is not in this configuration. The application fallback applies." : "No configuration is loaded. The application fallback applies.";
                    trace.Add(new TraceStep("result", "Returned " + Fmt(fallback), detail));
                    return new EngineResult(flagKey, fallback, Reason.FlagNotFound, trace, revision);
                }
                trace.Add(new TraceStep("config", "Configuration loaded", Js.ToNumber(revision) > 0 ? "r" + Js.ToStr(revision) : "draft"));
                var enabled = Js.Get(flag, "enabled");
                if (!Js.Truthy(enabled))
                {
                    var off = Js.Get(flag, "off");
                    trace.Add(new TraceStep("result", "Returned " + Fmt(off), "Flag is disabled in this environment."));
                    return new EngineResult(flagKey, off, Reason.Off, trace, revision);
                }
                var rules = Js.Get(flag, "rules");
                var segments = Js.Get(bundle, "segments");
                int i = 0;
                while (true)
                {
                    var length = Js.Get(rules, "length");
                    if (!(i < Js.ToNumber(length))) break;
                    var rule = Js.Get(rules, i.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    var match = Js.Get(rule, "match");
                    var conditions = Js.Get(rule, "conditions");
                    bool matched = MatchAll(match, conditions, ctx, segments, 0);
                    string label = "Rule " + (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture).PadLeft(2, '0');
                    string summary = "all contexts";
                    if (Js.Truthy(Js.Get(conditions, "length")))
                    {
                        var parts = ((JsonValue.Arr)conditions).Items.Select(DescribeCondition);
                        summary = string.Join(IsStr(match, "any") ? " OR " : " AND ", parts);
                    }
                    trace.Add(new TraceStep("rule", matched ? label + " matched" : label + " did not match", summary, matched));
                    if (!matched)
                    {
                        i++;
                        continue;
                    }
                    var serve = Js.Get(rule, "serve");
                    var serveType = Js.Get(serve, "type");
                    var ruleId = Js.Get(rule, "id");
                    if (IsStr(serveType, "fixed"))
                    {
                        var fixedValue = Js.Get(serve, "value");
                        trace.Add(new TraceStep("result", "Returned " + Fmt(fixedValue), label + " serves a fixed value."));
                        return new EngineResult(flagKey, fixedValue, Reason.RuleMatch, trace, revision, i, ruleId);
                    }
                    var attrV = Js.Get(serve, "bucketBy");
                    string attr = attrV.IsUndefined || attrV.IsNull ? "key" : Js.ToStr(attrV);
                    var identity = Lookup(ctx, attr);
                    var otherwise = Js.Get(serve, "otherwise");
                    if (identity.IsUndefined || identity.IsNull || IsStr(identity, ""))
                    {
                        trace.Add(new TraceStep("allocation", "Allocation skipped", "Context has no \"" + attr + "\" to bucket by; treated as outside the allocation.", false));
                        trace.Add(new TraceStep("result", "Returned " + Fmt(otherwise), "Remaining eligible users."));
                        return new EngineResult(flagKey, otherwise, Reason.RuleMatch, trace, revision, i, ruleId, false);
                    }
                    var seedV = Js.Get(serve, "seed");
                    string seed = seedV.IsUndefined || seedV.IsNull ? flagKey : Js.ToStr(seedV);
                    double bucket = BucketOf(seed, Js.ToStr(identity));
                    var percentage = Js.Get(serve, "percentage");
                    bool inRollout = bucket < Js.ToNumber(percentage);
                    string pct = Js.ToStr(percentage);
                    trace.Add(new TraceStep("allocation", "Allocation evaluated",
                        pct + "% rollout · " + attr + " " + (inRollout ? "inside" : "outside") + " allocation (bucket " + DoubleConv.ToFixed2(bucket) + ")", inRollout));
                    var served = inRollout ? Js.Get(serve, "value") : otherwise;
                    trace.Add(new TraceStep("result", "Returned " + Fmt(served), inRollout ? "Inside the " + pct + "% allocation." : "Remaining eligible users."));
                    return new EngineResult(flagKey, served, Reason.RuleMatch, trace, revision, i, ruleId, inRollout, bucket);
                }
                var def = Js.Get(flag, "default");
                trace.Add(new TraceStep("result", "Returned " + Fmt(def), "No rule matched. The flag default applies."));
                return new EngineResult(flagKey, def, Reason.Default, trace, revision);
            }
            catch (Exception e)
            {
                string msg = e.Message;
                trace.Add(new TraceStep("result", "Returned " + Fmt(fallback), "Evaluation error: " + msg + ". The application fallback applies."));
                return new EngineResult(flagKey, fallback, Reason.Error, trace, revision, error: msg);
            }
        }

        /// <summary>True when this engine can evaluate a bundle whose <c>engine</c> member is <paramref name="e"/>.</summary>
        public static bool SupportsEngine(JsonValue e)
        {
            if (e.IsUndefined) return true;
            return e is JsonValue.Num n && n.Value == Math.Floor(n.Value) && !double.IsInfinity(n.Value) && n.Value >= 1 && n.Value <= Version;
        }

        private static void SegmentRefs(JsonValue conditions, List<string> pending)
        {
            if (!(conditions is JsonValue.Arr arr)) return;
            foreach (var c in arr.Items)
            {
                var op = c.Field("op");
                if ((IsStr(op, "segment") || IsStr(op, "not_segment")) && c.Field("value") is JsonValue.Str v) pending.Add(v.Value);
            }
        }

        /// <summary>
        /// Removes what must not reach browser keys: flags that are not client-exposed, and every segment that no
        /// client-exposed flag references (directly or through other segments). Mirrors <c>clientBundle()</c>.
        /// </summary>
        public static JsonValue.Obj ClientBundle(JsonValue.Obj bundle)
        {
            var flags = bundle.Get("flags") as JsonValue.Obj ?? JsonValue.Obj.Empty;
            var kept = new JsonValue.Obj.Builder();
            var pending = new List<string>();
            foreach (var k in flags.Keys)
            {
                var f = flags.Get(k)!;
                if (!JsonValue.True.Equals(f.Field("clientExposed"))) continue;
                kept.Put(k, f);
                if (f.Field("rules") is JsonValue.Arr rules) foreach (var r in rules.Items) SegmentRefs(r.Field("conditions"), pending);
            }
            var segments = bundle.Get("segments") as JsonValue.Obj;
            var needed = new HashSet<string>(StringComparer.Ordinal);
            while (pending.Count > 0)
            {
                var k = pending[pending.Count - 1];
                pending.RemoveAt(pending.Count - 1);
                var seg = segments?.Get(k);
                if (seg == null) continue;
                if (!needed.Add(k)) continue;
                SegmentRefs(seg.Field("conditions"), pending);
            }
            var segOut = new JsonValue.Obj.Builder();
            if (segments != null) foreach (var k in segments.Keys) if (needed.Contains(k)) segOut.Put(k, segments.Get(k)!);
            var output = new JsonValue.Obj.Builder();
            foreach (var k in bundle.Keys)
            {
                if (k == "flags") output.Put(k, kept.Build());
                else if (k == "segments") output.Put(k, segOut.Build());
                else output.Put(k, bundle.Get(k)!);
            }
            if (!bundle.ContainsKey("flags")) output.Put("flags", kept.Build());
            if (!bundle.ContainsKey("segments")) output.Put("segments", segOut.Build());
            return output.Build();
        }

        private static bool VisitAttributes(JsonValue conds, int depth, JsonValue segments, List<string> names)
        {
            if (!(conds is JsonValue.Arr arr)) return conds is JsonValue.Str;
            foreach (var c in arr.Items)
            {
                var op = Js.Get(c, "op");
                if (IsStr(op, "segment") || IsStr(op, "not_segment"))
                {
                    if (Js.Get(c, "value") is JsonValue.Str value)
                    {
                        var seg = Js.Own(segments, value.Value);
                        if (Js.Truthy(seg) && depth < 4 && !VisitAttributes(Js.Get(seg, "conditions"), depth + 1, segments, names)) return false;
                    }
                }
                else
                {
                    var attr = Js.Get(c, "attribute");
                    if (Js.Truthy(attr))
                    {
                        var n = Js.ToStr(attr);
                        if (!names.Contains(n)) names.Add(n);
                    }
                }
            }
            return true;
        }

        /// <summary>
        /// The context attributes that the rules of <paramref name="flagKey"/> reference (through segments up to the
        /// engine's nesting limit), plus the bucketing attribute of rollouts. Telemetry reports only these names (with the
        /// type of the value, never the value).
        /// </summary>
        public static IReadOnlyList<string> AttributesUsedBy(JsonValue bundle, string flagKey)
        {
            var names = new List<string>();
            try
            {
                var segments = bundle.Field("segments");
                if (!(Js.Get(Js.Own(bundle.Field("flags"), flagKey), "rules") is JsonValue.Arr rules)) return Array.Empty<string>();
                foreach (var r in rules.Items)
                {
                    if (!VisitAttributes(Js.Get(r, "conditions"), 0, segments, names)) return Array.Empty<string>();
                    var serve = Js.Get(r, "serve");
                    if (IsStr(Js.Get(serve, "type"), "rollout"))
                    {
                        var by = Js.Get(serve, "bucketBy");
                        var n = by.IsUndefined || by.IsNull ? "key" : Js.ToStr(by);
                        if (!names.Contains(n)) names.Add(n);
                    }
                }
                return names.AsReadOnly();
            }
            catch (Exception)
            {
                return Array.Empty<string>();
            }
        }
    }
}
