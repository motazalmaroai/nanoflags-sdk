using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using NanoFlags.Engine;
using Xunit;
using Xunit.Abstractions;

namespace NanoFlags.Tests
{
    /// <summary>
    /// Cross-language conformance: every expected result was produced by the TypeScript engine
    /// (packages/engine/fixtures/generate-parity.mjs, shared by every port), plus the Go port's extra corner cases
    /// (go/internal/testdata/extra.json) with V8's error messages. Results are compared as canonical JSON text: value,
    /// reason, rule, bucket, revision and the full trace.
    /// </summary>
    public class ParityTests
    {
        private readonly ITestOutputHelper _out;

        public ParityTests(ITestOutputHelper output) => _out = output;

        private static string Js(JsonValue v) => v.ToJson() ?? "undefined";

        private static string Q(string s) => Engine.Js.Quote(s);

        private static string Bool(bool b) => b ? "true" : "false";

        internal static string CanonicalResult(EngineResult r, bool withTrace, bool mask)
        {
            var b = new StringBuilder("{\"reason\":").Append(Q(r.Reason.Wire())).Append(",\"revision\":").Append(Js(r.Revision));
            if (!r.Value.IsUndefined) b.Append(",\"value\":").Append(Js(r.Value));
            if (r.RuleIndex >= 0) b.Append(",\"ruleIndex\":").Append(r.RuleIndex);
            if (!r.RuleId.IsUndefined && r.RuleIndex >= 0) b.Append(",\"ruleId\":").Append(Js(r.RuleId));
            if (r.InRollout != null) b.Append(",\"inRollout\":").Append(Bool(r.InRollout.Value));
            if (r.Bucket != null) b.Append(",\"bucket\":").Append(Engine.Js.NumberToString(r.Bucket.Value));
            if (r.Reason == Reason.Error) b.Append(",\"error\":true");
            if (withTrace)
            {
                b.Append(",\"trace\":[");
                for (int i = 0; i < r.Trace.Count; i++)
                {
                    var s = r.Trace[i];
                    if (i > 0) b.Append(',');
                    var detail = mask && i == r.Trace.Count - 1 ? "<error>" : s.Detail;
                    b.Append("{\"kind\":").Append(Q(s.Kind)).Append(",\"title\":").Append(Q(s.Title)).Append(",\"detail\":").Append(Q(detail));
                    if (s.Matched != null) b.Append(",\"matched\":").Append(Bool(s.Matched.Value));
                    b.Append('}');
                }
                b.Append(']');
            }
            return b.Append('}').ToString();
        }

        internal static string CanonicalExpected(JsonValue e, bool mask)
        {
            var b = new StringBuilder("{\"reason\":").Append(Js(e.Field("reason"))).Append(",\"revision\":").Append(Js(e.Field("revision")));
            foreach (var k in new[] { "value", "ruleIndex", "ruleId", "inRollout", "bucket", "error" })
            {
                var v = e.Field(k);
                if (!v.IsUndefined) b.Append(",\"").Append(k).Append("\":").Append(Js(v));
            }
            if (e.Field("trace") is JsonValue.Arr tr)
            {
                b.Append(",\"trace\":[");
                for (int i = 0; i < tr.Items.Count; i++)
                {
                    var s = tr.Items[i];
                    if (i > 0) b.Append(',');
                    var detail = mask && i == tr.Items.Count - 1 ? new JsonValue.Str("<error>") : s.Field("detail");
                    b.Append("{\"kind\":").Append(Js(s.Field("kind"))).Append(",\"title\":").Append(Js(s.Field("title"))).Append(",\"detail\":").Append(Js(detail));
                    var m = s.Field("matched");
                    if (!m.IsUndefined) b.Append(",\"matched\":").Append(Js(m));
                    b.Append('}');
                }
                b.Append(']');
            }
            return b.Append('}').ToString();
        }

        internal static int RunCases(JsonValue doc, bool compareErrorMessages)
        {
            var bundles = ((JsonValue.Arr)doc.Field("bundles")).Items;
            var contexts = ((JsonValue.Arr)doc.Field("contexts")).Items;
            var cases = ((JsonValue.Arr)doc.Field("cases")).Items;
            var failures = new List<string>();
            for (int i = 0; i < cases.Count; i++)
            {
                var c = cases[i];
                int bi = (int)((JsonValue.Num)c.Field("bundle")).Value;
                int ci = (int)((JsonValue.Num)c.Field("context")).Value;
                string flag = ((JsonValue.Str)c.Field("flag")).Value;
                var bundle = bi >= 0 ? bundles[bi] : JsonValue.Null;
                var expected = c.Field("expected");
                bool withTrace = !expected.Field("trace").IsUndefined;
                bool mask = !expected.Field("error").IsUndefined && !compareErrorMessages;
                var got = Evaluator.Evaluate(bundle, flag, EvalContexts.Of(contexts[ci]), c.Field("fallback"));
                var g = CanonicalResult(got, withTrace, mask);
                var w = CanonicalExpected(expected, mask);
                if (compareErrorMessages && expected.Field("errorMessage") is JsonValue.Str msg && msg.Value != got.Error)
                {
                    g += " err=" + Q(got.Error ?? "");
                    w += " err=" + Q(msg.Value);
                }
                if (g != w) failures.Add($"case {i} {Js(c.Field("name"))}\n got: {g}\nwant: {w}");
            }
            if (failures.Count > 0) Assert.Fail($"{failures.Count} of {cases.Count} cases differ:\n" + string.Join("\n", failures.Take(20)));
            return cases.Count;
        }

        [Fact]
        public void EvaluateCases()
        {
            var doc = Fixtures.Load(Fixtures.Parity);
            Assert.NotNull(doc);
            Assert.Equal((double)Evaluator.Version, ((JsonValue.Num)doc!.Field("engineVersion")).Value);
            int n = RunCases(doc, false);
            _out.WriteLine($"CONFORMANCE: {n}/{n} evaluation cases identical ({Fixtures.Parity})");
            Console.WriteLine($"CONFORMANCE: {n}/{n} evaluation cases identical ({Fixtures.Parity})");
        }

        [Fact]
        public void ExtraCases()
        {
            var doc = Fixtures.Load(Fixtures.Extra);
            Assert.NotNull(doc);
            int n = RunCases(doc!, true);
            Console.WriteLine($"CONFORMANCE: {n}/{n} extra evaluation cases identical, V8 error messages included ({Fixtures.Extra})");
        }

        [Fact]
        public void Hashing()
        {
            var doc = Fixtures.Load(Fixtures.Parity)!;
            var m = ((JsonValue.Arr)doc.Field("murmur3")).Items;
            foreach (var c in m)
            {
                var input = ((JsonValue.Str)c.Field("input")).Value;
                var seed = (uint)((JsonValue.Num)c.Field("seed")).Value;
                Assert.Equal((uint)((JsonValue.Num)c.Field("hash")).Value, Evaluator.Murmur3(input, seed));
            }
            var b = ((JsonValue.Arr)doc.Field("buckets")).Items;
            foreach (var c in b)
            {
                Assert.Equal(((JsonValue.Num)c.Field("bucket")).Value, Evaluator.BucketOf(((JsonValue.Str)c.Field("seed")).Value, ((JsonValue.Str)c.Field("identity")).Value));
            }
            Console.WriteLine($"CONFORMANCE: {m.Count} murmur3 vectors and {b.Count} buckets identical");
        }

        [Fact]
        public void SupportsEngineAndClientBundle()
        {
            var doc = Fixtures.Load(Fixtures.Parity)!;
            var s = ((JsonValue.Arr)doc.Field("supportsEngine")).Items;
            foreach (var c in s) Assert.Equal(JsonValue.True.Equals(c.Field("expected")), Evaluator.SupportsEngine(c.Field("bundle").Field("engine")));
            var cb = ((JsonValue.Arr)doc.Field("clientBundle")).Items;
            foreach (var c in cb) Assert.Equal(Js(c.Field("expected")), Js(Evaluator.ClientBundle((JsonValue.Obj)c.Field("bundle"))));
            Console.WriteLine($"CONFORMANCE: {s.Count} supportsEngine and {cb.Count} clientBundle (browser view) vectors identical");
        }
    }
}
