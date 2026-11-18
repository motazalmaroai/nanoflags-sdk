using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using NanoFlags.Engine;

namespace NanoFlags
{
    /// <summary>
    /// Samples evaluations and sends them, with the periodic service report ("this service runs revision N"), to
    /// <c>POST /v1/events</c>. Off the hot path: evaluation only appends to a bounded list; telemetry is never retried
    /// and never affects evaluation. By default events carry the names of the attributes the flag's rules use and the
    /// type of their values, never values.
    /// </summary>
    internal sealed class EventQueue
    {
        internal const int MaxQueue = 500;
        internal const int MaxBatch = 50;
        internal const int MaxValueChars = 1024;

        private readonly NanoFlagsClient _c;
        private readonly EventsOptions _opts;
        private readonly double _sampleRate;
        private readonly object _lock = new object();
        private readonly List<JsonValue.Obj> _queue = new List<JsonValue.Obj>();
        private DateTime _lastReport = DateTime.MinValue;

        internal EventQueue(NanoFlagsClient c)
        {
            _c = c;
            _opts = c.Cfg.Events;
            _sampleRate = Math.Min(1, Math.Max(0, double.IsNaN(_opts.SampleRate) ? 0 : _opts.SampleRate));
        }

        internal Task Completion { get; private set; } = Task.CompletedTask;

        internal void Start()
        {
            if (!_opts.Enabled || _opts.FlushInterval <= TimeSpan.Zero) return;
            Completion = Task.Run(LoopAsync);
        }

        private async Task LoopAsync()
        {
            var ct = _c.Cts.Token;
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(_opts.FlushInterval, ct).ConfigureAwait(false);
                    bool idle;
                    lock (_lock) idle = _queue.Count == 0 && _lastReport != DateTime.MinValue && DateTime.UtcNow - _lastReport < _opts.ReportInterval;
                    if (!idle) await FlushAsync(_c.Cfg.RequestTimeout, ct).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // closing
            }
        }

        internal void Record(EngineResult r, IReadOnlyDictionary<string, object?> ctx, NanoFlagsClient.Snapshot? s, string? sessionId = null)
        {
            if (!_opts.Enabled || _c.Closed || _sampleRate <= 0 || _c.Cfg.Random() >= _sampleRate) return;
            try
            {
                lock (_lock)
                {
                    if (_queue.Count >= MaxQueue) return; // bounded: drop instead of growing
                }
                var e = new JsonValue.Obj.Builder()
                    .Put("flagKey", new JsonValue.Str(r.FlagKey))
                    .Put("value", EventValue(r.Value))
                    .Put("reason", new JsonValue.Str(r.Reason.Wire()));
                if (r.RuleIndex >= 0) e.Put("ruleIndex", new JsonValue.Num(r.RuleIndex));
                double rev = r.Revision is JsonValue.Num n && !double.IsNaN(n.Value) && !double.IsInfinity(n.Value) ? Math.Floor(n.Value) : 0;
                e.Put("revision", new JsonValue.Num(rev));
                JsonValue context;
                if (_opts.Redact != null)
                {
                    var red = _opts.Redact(new Dictionary<string, object?>(ToDictionary(ctx), StringComparer.Ordinal));
                    context = red == null ? JsonValue.Obj.Empty : JsonValue.Of(red);
                }
                else
                {
                    context = DefaultRedact(s, r.FlagKey, ctx);
                }
                e.Put("context", context);
                e.Put("at", new JsonValue.Str(NanoFlagsClient.IsoNow()));
                if (sessionId != null) e.Put("sessionId", new JsonValue.Str(sessionId));
                e.Put("sampleRate", new JsonValue.Num(_sampleRate));
                var built = e.Build();
                lock (_lock)
                {
                    if (_queue.Count < MaxQueue) _queue.Add(built);
                }
            }
            catch (Exception)
            {
                // telemetry must never affect evaluation
            }
        }

        private static Dictionary<string, object?> ToDictionary(IReadOnlyDictionary<string, object?> ctx)
        {
            var d = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var kv in ctx) d[kv.Key] = kv.Value;
            return d;
        }

        internal static JsonValue EventValue(JsonValue v)
        {
            if (v is JsonValue.Str s) return s.Value.Length > MaxValueChars ? new JsonValue.Str(s.Value.Substring(0, MaxValueChars)) : v;
            var text = v.ToJson();
            if (text == null) return JsonValue.Null;
            if ((v is JsonValue.Obj || v is JsonValue.Arr) && text.Length > MaxValueChars) return JsonValue.Null;
            return v;
        }

        /// <summary>No attribute values: only the names of the attributes the flag's rules use that were present, mapped to the value's type.</summary>
        internal static JsonValue.Obj DefaultRedact(NanoFlagsClient.Snapshot? s, string flagKey, IReadOnlyDictionary<string, object?> ctx)
        {
            if (s == null || ctx.Count == 0) return JsonValue.Obj.Empty;
            var b = new JsonValue.Obj.Builder();
            foreach (var n in s.Bundle.AttributesUsedBy(flagKey))
            {
                if (ctx.TryGetValue(n, out var v)) b.Put(n, new JsonValue.Str(JsonValue.Of(v).TypeName));
            }
            return b.Build();
        }

        /// <summary>Sends up to one batch of queued events with the service report (best effort, never throws).</summary>
        internal async Task FlushAsync(TimeSpan timeout, CancellationToken ct)
        {
            if (!_opts.Enabled) return;
            var batch = new List<JsonValue>();
            lock (_lock)
            {
                int n = Math.Min(_queue.Count, MaxBatch);
                for (int i = 0; i < n; i++)
                {
                    var e = _queue[i];
                    var k = ((JsonValue.Str)e.Get("flagKey")!).Value;
                    if (k.Length > 63)
                    {
                        var b = new JsonValue.Obj.Builder();
                        foreach (var name in e.Keys) b.Put(name, name == "flagKey" ? new JsonValue.Str(k.Substring(0, 63)) : e.Get(name)!);
                        e = b.Build();
                    }
                    batch.Add(e);
                }
                _queue.RemoveRange(0, n);
                _lastReport = DateTime.UtcNow;
            }
            var body = new JsonValue.Obj.Builder()
                .Put("service", new JsonValue.Str(_c.Cfg.Service))
                .Put("sdk", new JsonValue.Str(NanoFlagsClient.SdkLabel))
                .Put("revision", new JsonValue.Num(Math.Max(0, _c.Revision)))
                .Put("events", new JsonValue.Arr(batch))
                .Build();
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(timeout);
                using var req = _c.Request(HttpMethod.Post, "/v1/events");
                req.Content = new StringContent(body.ToJson()!, Encoding.UTF8, "application/json");
                using var res = await _c.Http.SendAsync(req, cts.Token).ConfigureAwait(false);
                if ((int)res.StatusCode >= 300) _c.Log?.LogDebug("nanoflags: events request failed with HTTP {Status}", (int)res.StatusCode);
            }
            catch (Exception e)
            {
                // dropped by design: telemetry is never retried
                _c.Log?.LogDebug("nanoflags: events request failed: {Message}", e.Message);
            }
        }
    }
}
