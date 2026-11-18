using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NanoFlags.Engine;

namespace NanoFlags
{
    /// <summary>
    /// The client's cache of test-session lookups (<c>GET /v1/session</c>), keyed by service and token. A resolved session
    /// is cached until it expires, an unknown token for 15 s, a failed lookup for 3 s. Concurrent callers share one
    /// request. Bounded to <see cref="MaxSessions"/> entries.
    /// </summary>
    internal sealed class Sessions
    {
        internal const string Header = "x-nanoflags-session";
        internal const int MaxSessions = 1000;
        internal static readonly TimeSpan MissTtl = TimeSpan.FromSeconds(15);
        internal static readonly TimeSpan ErrorTtl = TimeSpan.FromSeconds(3);

        /// <summary>One resolved test session. Immutable.</summary>
        internal sealed class State
        {
            internal State(string id, Bundle bundle, IReadOnlyDictionary<string, object?> context, DateTimeOffset expiresAt)
            {
                Id = id;
                Snap = new NanoFlagsClient.Snapshot(bundle, null, null, null, null);
                Context = context;
                ExpiresAt = expiresAt;
            }

            internal string Id { get; }
            internal NanoFlagsClient.Snapshot Snap { get; }
            /// <summary>The session's synthetic context as plain .NET data.</summary>
            internal IReadOnlyDictionary<string, object?> Context { get; }
            internal DateTimeOffset ExpiresAt { get; }
            internal bool Live => DateTimeOffset.UtcNow < ExpiresAt;
        }

        private sealed class Entry
        {
            internal readonly TaskCompletionSource<State?> Tcs = new TaskCompletionSource<State?>(TaskCreationOptions.RunContinuationsAsynchronously);
            internal long UntilTicks = long.MaxValue; // UTC ticks; MaxValue while in flight
        }

        private readonly NanoFlagsClient _c;
        private readonly Dictionary<string, Entry> _entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        private readonly LinkedList<string> _order = new LinkedList<string>(); // insertion order: oldest first

        internal Sessions(NanoFlagsClient c) => _c = c;

        internal static bool IsToken(string? v)
        {
            if (string.IsNullOrEmpty(v) || v!.Length > 512) return false;
            foreach (var ch in v)
            {
                if (ch < 0x21 || ch > 0x7e) return false;
            }
            return true;
        }

        private static readonly Task<State?> None = Task.FromResult<State?>(null);

        /// <summary>The session (null: none). Never faults.</summary>
        internal Task<State?> Resolve(string? token, string? service)
        {
            if (!IsToken(token) || _c.Closed) return None;
            var name = !string.IsNullOrEmpty(service) ? service! : _c.Cfg.Service == "unknown" ? "" : _c.Cfg.Service;
            var key = name + "\n" + token;
            long now = DateTime.UtcNow.Ticks;
            Entry e;
            lock (_entries)
            {
                if (_c.Closed) return None;
                if (_entries.TryGetValue(key, out var hit))
                {
                    if (now < Volatile.Read(ref hit.UntilTicks)) return hit.Tcs.Task;
                    _entries.Remove(key);
                    _order.Remove(key);
                }
                if (_entries.Count >= MaxSessions)
                {
                    foreach (var k in _entries.Where(kv => now >= Volatile.Read(ref kv.Value.UntilTicks)).Select(kv => kv.Key).ToList())
                    {
                        _entries.Remove(k);
                        _order.Remove(k);
                    }
                    // Still full: drop the oldest entries.
                    while (_entries.Count >= MaxSessions && _order.First != null)
                    {
                        _entries.Remove(_order.First.Value);
                        _order.RemoveFirst();
                    }
                }
                e = new Entry();
                _entries[key] = e;
                _order.AddLast(key);
            }
            _ = CompleteAsync(e, token!, name);
            return e.Tcs.Task;
        }

        private async Task CompleteAsync(Entry e, string token, string service)
        {
            State? state = null;
            bool failed = false;
            try
            {
                state = await FetchAsync(token, service).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                failed = true;
                if (!_c.Closed)
                {
                    _c.EmitError(ex as NanoFlagsException ?? new NanoFlagsException(ErrorCode.Session, "Could not load the test session: " + ex.Message, 0, ex));
                }
            }
            var until = state != null ? state.ExpiresAt.UtcTicks : DateTime.UtcNow.Add(failed ? ErrorTtl : MissTtl).Ticks;
            Volatile.Write(ref e.UntilTicks, until);
            e.Tcs.TrySetResult(state);
        }

        internal void Clear()
        {
            lock (_entries)
            {
                _entries.Clear();
                _order.Clear();
            }
        }

        /// <summary>null for "no such session" (unknown, expired, revoked, service not permitted).</summary>
        private async Task<State?> FetchAsync(string token, string service)
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(_c.Cts.Token);
            cts.CancelAfter(_c.Cfg.RequestTimeout);
            using var req = _c.Request(HttpMethod.Get, "/v1/session");
            req.Headers.TryAddWithoutValidation("X-NanoFlags-Session", token);
            req.Headers.TryAddWithoutValidation("Cache-Control", "no-store");
            if (service.Length > 0) req.Headers.TryAddWithoutValidation("X-NanoFlags-Service", service);
            using var res = await _c.Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
            int code = (int)res.StatusCode;
            if (code == 404) return null;
            if (code < 200 || code > 299)
            {
                throw new NanoFlagsException(code == 401 || code == 403 ? ErrorCode.Unauthorized : ErrorCode.Session, $"Session request failed with HTTP {code}.", code);
            }
            var invalid = new NanoFlagsException(ErrorCode.Session, "The edge returned an invalid session.");
            var bytes = await NanoFlagsClient.ReadLimitedAsync(res, NanoFlagsClient.MaxBundleBytes, cts.Token).ConfigureAwait(false);
            if (bytes == null) throw invalid;
            JsonValue body;
            try
            {
                body = JsonValue.Parse(Encoding.UTF8.GetString(bytes));
            }
            catch (InvalidJsonException)
            {
                throw invalid;
            }
            var bundle = Bundle.Of(body.Field("bundle"));
            DateTimeOffset expiresAt = default;
            bool okExp = body.Field("expires_at") is JsonValue.Str exp
                && DateTimeOffset.TryParse(exp.Value.Trim(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out expiresAt);
            if (!(body.Field("id") is JsonValue.Str id) || bundle == null || !okExp) throw invalid;
            if (!bundle.SupportsEngine) throw NanoFlagsClient.EngineError(bundle);
            if (DateTimeOffset.UtcNow >= expiresAt) return null;
            IReadOnlyDictionary<string, object?> context = new Dictionary<string, object?>();
            if (body.Field("context") is JsonValue.Obj ctx && ctx.ToObject() is IDictionary<string, object?> d)
            {
                context = new Dictionary<string, object?>(d, StringComparer.Ordinal);
            }
            return new State(id.Value, bundle, context, expiresAt);
        }
    }
}
