using System.Collections.Concurrent;
using System.Collections.Generic;

namespace NanoFlags.Engine
{
    /// <summary>
    /// A parsed, immutable configuration bundle: one revision of one environment. Thread-safe.
    /// </summary>
    /// <remarks>
    /// <see cref="Parse(string)"/> accepts what every NanoFlags SDK accepts (<c>schema</c> 1, a numeric <c>revision</c>,
    /// an object <c>flags</c>, an object <c>segments</c>); the flags themselves are evaluated as they are, malformed or
    /// not, exactly like the TypeScript engine.
    /// </remarks>
    public sealed class Bundle
    {
        private readonly ConcurrentDictionary<string, IReadOnlyList<string>> _attrs = new ConcurrentDictionary<string, IReadOnlyList<string>>(System.StringComparer.Ordinal);

        private Bundle(JsonValue.Obj value)
        {
            Value = value;
            double r = ((JsonValue.Num)value.Get("revision")!).Value;
            Revision = double.IsNaN(r) || double.IsInfinity(r) ? 0 : (long)r;
        }

        /// <summary>The bundle document.</summary>
        public JsonValue.Obj Value { get; }

        /// <summary>The bundle's revision number.</summary>
        public long Revision { get; }

        /// <summary>The bundle's <c>engine</c> member (<see cref="JsonValue.Undefined"/> when absent: engine 1).</summary>
        public JsonValue Engine => Value.Field("engine");

        /// <summary>Whether this SDK's engine can evaluate the bundle.</summary>
        public bool SupportsEngine => Evaluator.SupportsEngine(Engine);

        /// <summary>Flag keys in document order.</summary>
        public IReadOnlyList<string> FlagKeys => ((JsonValue.Obj)Value.Get("flags")!).Keys;

        /// <summary>Evaluates one flag.</summary>
        public EngineResult Evaluate(string flagKey, IEvalContext? ctx, JsonValue? fallback) => Evaluator.Evaluate(Value, flagKey, ctx, fallback);

        /// <summary><c>JSON.stringify(bundle)</c>.</summary>
        public string ToJson() => Value.ToJson()!;

        /// <summary>Attribute names that <paramref name="flagKey"/>'s rules use (cached; see <see cref="Evaluator.AttributesUsedBy"/>).</summary>
        public IReadOnlyList<string> AttributesUsedBy(string flagKey) => _attrs.GetOrAdd(flagKey, k => Evaluator.AttributesUsedBy(Value, k));

        /// <summary>Whether <paramref name="v"/> has the shape the SDKs accept as a bundle.</summary>
        public static bool IsBundle(JsonValue v)
        {
            if (!(v is JsonValue.Obj)) return false;
            var schema = v.Field("schema");
            var segs = v.Field("segments");
            return schema is JsonValue.Num s && s.Value == 1.0 && v.Field("revision") is JsonValue.Num && v.Field("flags") is JsonValue.Obj
                && (segs is JsonValue.Obj || segs is JsonValue.Arr);
        }

        /// <summary>Wraps a parsed bundle document; <c>null</c> when it is not a bundle.</summary>
        public static Bundle? Of(JsonValue v) => IsBundle(v) ? new Bundle((JsonValue.Obj)v) : null;

        /// <summary>Parses bundle JSON text; <c>null</c> when it is not valid JSON or not a bundle.</summary>
        public static Bundle? Parse(string text)
        {
            try
            {
                return Of(JsonValue.Parse(text));
            }
            catch (InvalidJsonException)
            {
                return null;
            }
        }
    }
}
