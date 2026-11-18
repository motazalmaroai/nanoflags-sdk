using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using NanoFlags.Engine;

namespace NanoFlags
{
    /// <summary>
    /// Evaluates NanoFlags feature flags locally against an in-memory configuration that it keeps current in the
    /// background (live WebSocket, then server-sent events, then polling with ETag).
    /// </summary>
    /// <remarks>
    /// Evaluations never perform I/O, never block and never throw: on any problem they return the fallback. A client is
    /// thread-safe; create one per SDK key at startup (e.g. as a singleton), share it, and dispose it on shutdown.
    /// <code>
    /// var flags = NanoFlagsClient.Create(Environment.GetEnvironmentVariable("NANOFLAGS_SDK_KEY")!,
    ///     new NanoFlagsOptions { Service = "checkout-api" });
    /// await flags.WaitForReadyAsync(TimeSpan.FromSeconds(5));
    /// bool on = flags.BoolVariation("new-checkout", new Dictionary&lt;string, object?&gt; { ["key"] = "user-42" }, false);
    /// </code>
    /// </remarks>
    public sealed class NanoFlagsClient : IDisposable
    {
        /// <summary>The version of this SDK, reported to the edge as <c>dotnet/&lt;version&gt;</c>.</summary>
        public const string Version = "0.2.0";

        /// <summary>The newest bundle format (<c>bundle.engine</c>) this SDK evaluates. Newer bundles are refused.</summary>
        public const int SupportedEngineVersion = Evaluator.Version;

        /// <summary>The WebSocket close code with which the edge says that the environment was deleted.</summary>
        public const int CloseEnvironmentDeleted = 4004;

        /// <summary>The WebSocket subprotocol of <c>GET /v1/live</c>.</summary>
        public const string LiveProtocol = "nanoflags.v1";

        internal const string UserAgent = "nanoflags-dotnet/" + Version;
        internal const string SdkLabel = "dotnet/" + Version;
        internal const int MaxBundleBytes = 16 << 20;

        internal sealed class Snapshot
        {
            internal Snapshot(Bundle bundle, string? etag, string? checksum, Signatures.Info? sig, string? raw)
            {
                Bundle = bundle;
                ETag = etag ?? "";
                Checksum = checksum ?? "";
                Sig = sig;
                Raw = raw;
            }

            internal Bundle Bundle { get; }
            internal string ETag { get; }
            internal string Checksum { get; }
            internal Signatures.Info? Sig { get; }
            internal string? Raw { get; }
        }

        internal readonly NanoFlagsOptions Cfg;
        internal readonly string SdkKey;
        internal readonly HttpClient Http;
        private readonly bool _ownsHttp;
        internal readonly ILogger? Log;
        private readonly string _id;
        private readonly bool _browserKey;
        internal readonly Verifier? Verifier;
        internal readonly EventQueue Events;
        internal readonly Sessions Sessions;
        internal readonly Dispatcher Dispatcher;
        private readonly Live _live;

        private Snapshot? _snap;
        private int _status = (int)Status.NotReady;
        private int _closed;
        internal readonly CancellationTokenSource Cts = new CancellationTokenSource();
        private readonly TaskCompletionSource<bool> _ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        private readonly SemaphoreSlim _syncLock = new SemaphoreSlim(1, 1); // single flight for bundle requests
        internal readonly object AdoptLock = new object(); // compare-and-adopt decisions (never held during I/O)
        internal readonly object Lock = new object(); // guards the fields below
        private int _failures;
        private NanoFlagsException? _lastError;
        internal string? PinnedEnvironment;
        internal long LiveRevision;
        internal bool EnvironmentDeleted;
        private bool _streamTriggered;

        private readonly SemaphoreSlim _wake = new SemaphoreSlim(0);
        private bool _kickPending;
        private bool _reschedPending;
        private readonly Task _loop;

        private NanoFlagsClient(string sdkKey, NanoFlagsOptions cfg)
        {
            Cfg = cfg;
            SdkKey = sdkKey;
            Log = cfg.Logger;
            if (cfg.HttpClient != null)
            {
                Http = cfg.HttpClient;
            }
            else
            {
                Http = new HttpClient(CreateHandler()) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
                _ownsHttp = true;
            }
            _id = Evaluator.Murmur3(cfg.BaseUrl + "|" + sdkKey).ToString("x8", CultureInfo.InvariantCulture);
            _browserKey = sdkKey.StartsWith("nf_pub_", StringComparison.Ordinal);
            Dispatcher = new Dispatcher();
            var cfgErrors = new List<NanoFlagsException>();
            Verifier = Verifier.Create(this, cfgErrors);
            Events = new EventQueue(this);
            Sessions = new Sessions(this);
            _live = new Live(this);
            foreach (var e in cfgErrors) EmitError(e);
            var boot = cfg.Bootstrap;
            if (cfg.BootstrapJson != null)
            {
                boot = Bundle.Parse(cfg.BootstrapJson);
                if (boot == null) EmitError(new NanoFlagsException(ErrorCode.InvalidBundle, "The bootstrap bundle is invalid and was ignored."));
            }
            if (boot != null)
            {
                if (!boot.SupportsEngine) EmitError(EngineError(boot));
                else Adopt(new Snapshot(boot, null, null, null, null), Status.Ready, Source.Bootstrap, Transport.Poll, null);
            }
            _loop = Task.Run(RunAsync);
        }

        private static HttpMessageHandler CreateHandler()
        {
#if NET8_0_OR_GREATER
            return new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5), AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate };
#else
            return new HttpClientHandler { AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate };
#endif
        }

        /// <summary>
        /// Creates a client for <paramref name="sdkKey"/> (<c>nf_srv_…</c> on servers; <c>nf_pub_…</c> keys work too but
        /// only see client-exposed flags) and starts loading the configuration in the background. Use
        /// <see cref="Ready"/> or <see cref="WaitForReadyAsync"/> to wait for the first load.
        /// </summary>
        /// <exception cref="NanoFlagsException">Code <see cref="ErrorCode.Config"/> for an invalid configuration.</exception>
        public static NanoFlagsClient Create(string sdkKey, NanoFlagsOptions? options = null)
        {
            var cfg = (options ?? new NanoFlagsOptions()).Clone();
            if (string.IsNullOrWhiteSpace(sdkKey)) throw new NanoFlagsException(ErrorCode.Config, "An SDK key is required.");
            cfg.BaseUrl = (cfg.BaseUrl ?? "").TrimEnd('/');
            if (!cfg.BaseUrl.StartsWith("https://", StringComparison.Ordinal) && !cfg.BaseUrl.StartsWith("http://", StringComparison.Ordinal))
            {
                throw new NanoFlagsException(ErrorCode.Config, "The base URL must be an http(s) URL, got \"" + cfg.BaseUrl + "\".");
            }
            cfg.Events ??= new EventsOptions();
            return new NanoFlagsClient(sdkKey.Trim(), cfg);
        }

        /* ---------------- lifecycle ---------------- */

        /// <summary>
        /// Completes once the first load attempt has finished (or a configuration was adopted earlier, e.g. from a
        /// bootstrap bundle): true when a configuration is in use, false otherwise (<see cref="LastError"/> says why).
        /// Never faults.
        /// </summary>
        public Task<bool> Ready => _ready.Task.ContinueWith(_ => IsInitialized, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);

        /// <summary>Waits for <see cref="Ready"/> at most <paramref name="timeout"/>; true when a configuration is in use. Never throws on timeout.</summary>
        public async Task<bool> WaitForReadyAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
        {
            var delay = Task.Delay(timeout, cancellationToken);
            await Task.WhenAny(_ready.Task, delay).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return IsInitialized;
        }

        /// <summary>Blocking <see cref="WaitForReadyAsync"/>.</summary>
        public bool WaitForReady(TimeSpan timeout)
        {
            _ready.Task.Wait(timeout);
            return IsInitialized;
        }

        internal void MarkReady() => _ready.TrySetResult(true);

        /// <summary>Whether a configuration is in use.</summary>
        public bool IsInitialized => Volatile.Read(ref _snap) != null;

        internal Snapshot? Snap => Volatile.Read(ref _snap);

        internal bool Closed => Volatile.Read(ref _closed) != 0;

        /// <summary>The state of the configuration in use.</summary>
        public Status Status => (Status)Volatile.Read(ref _status);

        /// <summary>The revision in use, or -1 when no configuration is loaded.</summary>
        public long Revision => Snap?.Bundle.Revision ?? -1;

        /// <summary>How updates reach the client right now.</summary>
        public Transport Transport => _live.IsOpen ? Transport.Live : _live.IsStreaming ? Transport.Stream : Transport.Poll;

        /// <summary>The configuration in use (null when none is loaded). Bundles are immutable.</summary>
        public Bundle? Bundle => Snap?.Bundle;

        /// <summary>The error of the last failed request (null after a success).</summary>
        public NanoFlagsException? LastError
        {
            get
            {
                lock (Lock) return _lastError;
            }
        }

        /// <summary>Every newly adopted configuration. Handlers run one at a time, in order, on a thread of the client.</summary>
        public event EventHandler<ChangeEvent>? Changed;

        /// <summary>Background errors (failed requests, rejected signatures, …). They never change the configuration in use.</summary>
        public event EventHandler<NanoFlagsException>? Error;

        /// <summary>Status changes.</summary>
        public event EventHandler<Status>? StatusChanged;

        /// <summary>Revalidates the configuration now; completes when the request has finished.</summary>
        /// <exception cref="NanoFlagsException">The request failed.</exception>
        public async Task RefreshAsync(CancellationToken cancellationToken = default)
        {
            if (Closed) throw new NanoFlagsException(ErrorCode.Config, "The client is closed.");
            var e = await SyncNowAsync(false, cancellationToken).ConfigureAwait(false);
            if (e != null) throw e;
        }

        /// <summary>Sends queued telemetry and the service report now (best effort).</summary>
        public Task FlushAsync(CancellationToken cancellationToken = default) => Events.FlushAsync(Cfg.RequestTimeout, cancellationToken);

        /// <summary>
        /// Stops every background activity (after a best-effort final telemetry flush) and waits for it to end.
        /// Evaluations keep working on the last configuration. Idempotent.
        /// </summary>
        public async Task CloseAsync()
        {
            if (Interlocked.Exchange(ref _closed, 1) != 0) return;
            try
            {
                await Events.FlushAsync(TimeSpan.FromSeconds(2), CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // best effort
            }
            Cts.Cancel();
            _wake.Release();
            _live.Shutdown();
            try
            {
                await Task.WhenAny(Task.WhenAll(_loop, _live.Completion, Events.Completion), Task.Delay(5000)).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // ignore
            }
            Sessions.Clear();
            MarkReady();
            Dispatcher.Shutdown();
            if (_ownsHttp) Http.Dispose();
        }

        /// <summary>Synchronous <see cref="CloseAsync"/>.</summary>
        public void Dispose() => Task.Run(CloseAsync).GetAwaiter().GetResult();

        /* ---------------- adoption ---------------- */

        internal void SetStatus(Status s)
        {
            if (Interlocked.Exchange(ref _status, (int)s) != (int)s)
            {
                var h = StatusChanged;
                if (h != null) Dispatcher.Post(() => h(this, s));
            }
        }

        /// <summary>Swaps the configuration in use atomically. Callers hold <see cref="AdoptLock"/> or are the constructor.</summary>
        internal void Adopt(Snapshot next, Status status, Source source, Transport transport, TimeSpan? latency)
        {
            var prev = Interlocked.Exchange(ref _snap, next);
            SetStatus(status);
            MarkReady();
            if (prev != null && prev.Bundle.Revision == next.Bundle.Revision && prev.Checksum == next.Checksum) return;
            var ev = new ChangeEvent(next.Bundle.Revision, prev?.Bundle.Revision ?? -1, next.Checksum, source, transport, latency);
            var h = Changed;
            if (h != null) Dispatcher.Post(() => h(this, ev));
        }

        internal static NanoFlagsException EngineError(Bundle b) =>
            new NanoFlagsException(ErrorCode.Engine, $"Bundle r{b.Revision} needs evaluation engine {b.Engine.ToJson() ?? "undefined"}; this SDK supports up to {Evaluator.Version}. " +
                "Upgrade the NanoFlags .NET SDK. The configuration in use is unchanged.");

        internal void EmitError(NanoFlagsException e)
        {
            Log?.LogDebug("nanoflags: {Message}", e.Message);
            var h = Error;
            if (h != null) Dispatcher.Post(() => h(this, e));
        }

        /* ---------------- background loop ---------------- */

        private async Task RunAsync()
        {
            var ct = Cts.Token;
            try
            {
                await RestoreAsync(ct).ConfigureAwait(false);
                await SyncNowAsync(false, ct).ConfigureAwait(false);
                MarkReady();
                if (Closed) return;
                Events.Start();
                _live.Start();
                while (!ct.IsCancellationRequested)
                {
                    int delay = Cfg.PollInterval <= TimeSpan.Zero ? System.Threading.Timeout.Infinite : NextDelayMs();
                    await _wake.WaitAsync(delay, ct).ConfigureAwait(false);
                    bool kick, resched;
                    lock (Lock)
                    {
                        kick = _kickPending;
                        resched = _reschedPending;
                        _kickPending = false;
                        _reschedPending = false;
                    }
                    if (ct.IsCancellationRequested) return;
                    if (!kick && resched) continue;
                    await SyncNowAsync(kick, ct).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // closing
            }
            catch (Exception e)
            {
                Log?.LogWarning(e, "nanoflags: background loop failed");
            }
            finally
            {
                MarkReady();
            }
        }

        internal void Reschedule()
        {
            lock (Lock) _reschedPending = true;
            _wake.Release();
        }

        internal void Trigger()
        {
            lock (Lock) _kickPending = true;
            _wake.Release();
        }

        internal void MarkStreamTriggered()
        {
            lock (Lock) _streamTriggered = true;
        }

        private int NextDelayMs()
        {
            int f;
            lock (Lock) f = _failures;
            double interval = Cfg.PollInterval.TotalMilliseconds;
            if (_live.IsOpen && Cfg.LivePollInterval.TotalMilliseconds > interval) interval = Cfg.LivePollInterval.TotalMilliseconds;
            double b = interval;
            if (f > 0) b = Math.Min(Cfg.PollInterval.TotalMilliseconds, 1000.0 * (1L << Math.Min(f - 1, 10)));
            double d = b * (0.8 + 0.4 * Cfg.Random());
            return (int)Math.Min(int.MaxValue, Math.Max(250, d));
        }

        /* ---------------- polling: GET /v1/bundle ---------------- */

        internal HttpRequestMessage Request(HttpMethod method, string path)
        {
            var req = new HttpRequestMessage(method, Cfg.BaseUrl + path);
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + SdkKey);
            req.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            return req;
        }

        internal static string? Header(HttpResponseMessage res, string name)
        {
            if (res.Headers.TryGetValues(name, out var v)) return v.FirstOrDefault();
            if (res.Content != null && res.Content.Headers.TryGetValues(name, out var c)) return c.FirstOrDefault();
            return null;
        }

        /// <summary>One conditional bundle request; adopts what it returns. Returns the error, or null.</summary>
        internal async Task<NanoFlagsException?> SyncNowAsync(bool fromStream, CancellationToken ct)
        {
            await _syncLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (Cts.IsCancellationRequested) return new NanoFlagsException(ErrorCode.Config, "The client is closed.");
                Transport transport;
                lock (Lock)
                {
                    transport = _streamTriggered || fromStream ? Transport.Stream : Transport.Poll;
                    _streamTriggered = false;
                }
                NanoFlagsException ne;
                try
                {
                    await SyncOnceAsync(transport, ct).ConfigureAwait(false);
                    lock (Lock)
                    {
                        _failures = 0;
                        _lastError = null;
                    }
                    return null;
                }
                catch (NanoFlagsException e)
                {
                    ne = e;
                }
                catch (Exception e) when (!(e is OperationCanceledException) || (!Cts.IsCancellationRequested && !ct.IsCancellationRequested))
                {
                    ne = new NanoFlagsException(ErrorCode.Network, "Could not reach the NanoFlags edge: " + (e is OperationCanceledException ? "the request timed out" : e.Message), 0, e);
                }
                lock (Lock)
                {
                    _lastError = ne;
                    if (ne.Code != ErrorCode.Engine) _failures++;
                }
                if (ne.Code != ErrorCode.Engine && ne.Code != ErrorCode.Signature)
                {
                    // A rejected update changes nothing: same configuration, same status. Anything else: stale.
                    if (ne.Code == ErrorCode.Unauthorized) _live.DropLive();
                    if (Snap != null) SetStatus(Status.Stale);
                }
                EmitError(ne);
                return ne;
            }
            finally
            {
                _syncLock.Release();
            }
        }

        private async Task SyncOnceAsync(Transport transport, CancellationToken ct)
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct, Cts.Token);
            cts.CancelAfter(Cfg.RequestTimeout);
            using var req = Request(HttpMethod.Get, "/v1/bundle");
            var cur = Snap;
            if (cur != null && cur.ETag.Length > 0) req.Headers.TryAddWithoutValidation("If-None-Match", cur.ETag);
            using var res = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
            bool servedStale = Header(res, "X-NanoFlags-Stale") == "true";
            int code = (int)res.StatusCode;
            if (code == 304)
            {
                if (cur != null) SetStatus(servedStale ? Status.Stale : Status.Ready);
                return;
            }
            if (code == 401 || code == 403) throw new NanoFlagsException(ErrorCode.Unauthorized, "The SDK key was rejected (unknown or revoked).", code);
            if (code < 200 || code > 299) throw new NanoFlagsException(ErrorCode.Http, $"Bundle request failed with HTTP {code}.", code);
            var bytes = await ReadLimitedAsync(res, MaxBundleBytes, cts.Token).ConfigureAwait(false);
            if (bytes == null) throw new NanoFlagsException(ErrorCode.InvalidBundle, $"The edge returned a bundle larger than {MaxBundleBytes} bytes.");
            var text = Encoding.UTF8.GetString(bytes);
            JsonValue body;
            try
            {
                body = JsonValue.Parse(text);
            }
            catch (InvalidJsonException)
            {
                throw new NanoFlagsException(ErrorCode.InvalidBundle, "The edge returned an invalid bundle.");
            }
            var bundle = Bundle.Of(body.Field("bundle")) ?? throw new NanoFlagsException(ErrorCode.InvalidBundle, "The edge returned an invalid bundle.");
            var checksum = (body.Field("checksum") as JsonValue.Str)?.Value ?? "";
            var etag = Header(res, "ETag") ?? "";
            var next = await CheckSignatureAsync(res, text, body, bundle, etag, checksum, cts.Token).ConfigureAwait(false);
            if (!bundle.SupportsEngine) throw EngineError(bundle);
            lock (AdoptLock)
            {
                cur = Snap;
                // The edge is serving its last-known-good copy: never go backwards because of it.
                if (servedStale && cur != null && cur.Bundle.Revision >= bundle.Revision)
                {
                    SetStatus(Status.Stale);
                    return;
                }
                // A revision that was pushed while this request was under way wins.
                long pushed;
                lock (Lock) pushed = LiveRevision;
                if (cur != null && bundle.Revision < pushed && cur.Bundle.Revision >= pushed) return;
                Adopt(next, servedStale ? Status.Stale : Status.Ready, Source.Network, transport, null);
            }
            await PersistAsync(next).ConfigureAwait(false);
        }

        internal static async Task<byte[]?> ReadLimitedAsync(HttpResponseMessage res, int limit, CancellationToken ct)
        {
            using var stream = await res.Content.ReadAsStreamAsync().ConfigureAwait(false);
            using var buf = new MemoryStream();
            var chunk = new byte[16384];
            int n;
            while ((n = await stream.ReadAsync(chunk, 0, chunk.Length, ct).ConfigureAwait(false)) > 0)
            {
                buf.Write(chunk, 0, n);
                if (buf.Length > limit) return null;
            }
            return buf.ToArray();
        }

        private static NanoFlagsException Reject(long rev, string why) =>
            new NanoFlagsException(ErrorCode.Signature, $"Bundle r{rev} was rejected: {why} The configuration in use is unchanged.");

        /// <summary>Verifies the response's signature (when verification is on) and returns the snapshot to adopt.</summary>
        private async Task<Snapshot> CheckSignatureAsync(HttpResponseMessage res, string text, JsonValue body, Bundle bundle, string etag, string checksum, CancellationToken ct)
        {
            var v = Verifier;
            if (v == null) return new Snapshot(bundle, etag, checksum, null, null);
            long rev = bundle.Revision;
            if (Header(res, "X-NanoFlags-Signed") != "true")
            {
                if (v.Require) throw Reject(rev, "it is not signed (the edge is still distributing it) and unsigned bundles are refused; fetching again shortly.");
                return new Snapshot(bundle, etag, checksum, null, null);
            }
            var signature = Header(res, "X-NanoFlags-Signature") ?? "";
            var envId = Header(res, "X-NanoFlags-Environment-Id") ?? "";
            var kid = Header(res, "X-NanoFlags-Key-Id");
            if (signature.Length == 0 || envId.Length == 0 || !(body.Field("checksum") is JsonValue.Str)) throw Reject(rev, "the signature headers are incomplete.");
            long revision = rev;
            if (body.Field("revision") is JsonValue.Num r)
            {
                if (r.Value != rev) throw Reject(rev, "the signed revision does not match the bundle.");
                revision = (long)r.Value;
            }
            string? pinned;
            lock (Lock) pinned = PinnedEnvironment;
            if (pinned != null && pinned != envId) throw Reject(rev, "it was signed for a different environment.");
            var info = new Signatures.Info(signature, kid, envId, revision, checksum);
            IReadOnlyList<Signatures.Key> keys;
            try
            {
                keys = await v.KeysForAsync(info.Kid, ct).ConfigureAwait(false);
            }
            catch (NanoFlagsException e)
            {
                throw Reject(rev, "the signing keys could not be loaded (" + e.Message + ").");
            }
            // The edge embeds the stored bundle text byte-for-byte; re-serialisation is the fallback.
            var raw = Signatures.RawMember(text, "bundle");
            bool verified = raw != null && Signatures.VerifyBundleText(keys, info, Encoding.UTF8.GetBytes(raw));
            if (!verified)
            {
                var again = bundle.ToJson();
                if (again != raw && Signatures.VerifyBundleText(keys, info, Encoding.UTF8.GetBytes(again)))
                {
                    verified = true;
                    raw = again;
                }
            }
            if (!verified) throw Reject(rev, "its signature does not verify.");
            lock (Lock) PinnedEnvironment = envId;
            return new Snapshot(bundle, etag, checksum, info, raw);
        }

        /* ---------------- persistence ---------------- */

        internal static string IsoNow() => DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

        internal async Task PersistAsync(Snapshot s)
        {
            var store = Cfg.Store;
            if (store == null) return;
            var raw = s.Raw ?? s.Bundle.ToJson();
            var doc = new StringBuilder("{\"v\":1,\"id\":").Append(new JsonValue.Str(_id).ToJson());
            if (s.ETag.Length > 0) doc.Append(",\"etag\":").Append(new JsonValue.Str(s.ETag).ToJson());
            if (s.Checksum.Length > 0) doc.Append(",\"checksum\":").Append(new JsonValue.Str(s.Checksum).ToJson());
            doc.Append(",\"savedAt\":").Append(new JsonValue.Str(IsoNow()).ToJson());
            doc.Append(",\"bundle\":").Append(raw);
            if (s.Sig != null) doc.Append(",\"sig\":").Append(s.Sig.ToJson().ToJson());
            doc.Append('}');
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await store.SaveAsync(Encoding.UTF8.GetBytes(doc.ToString()), cts.Token).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                EmitError(new NanoFlagsException(ErrorCode.Store, "Could not persist the bundle: " + e.Message, 0, e));
            }
        }

        private async Task RestoreAsync(CancellationToken ct)
        {
            var store = Cfg.Store;
            if (store == null) return;
            byte[]? data;
            try
            {
                data = await store.LoadAsync(ct).ConfigureAwait(false);
            }
            catch (Exception e) when (!(e is OperationCanceledException))
            {
                EmitError(new NanoFlagsException(ErrorCode.Store, "Could not read the persisted bundle: " + e.Message, 0, e));
                return;
            }
            if (data == null || data.Length == 0) return;
            var text = Encoding.UTF8.GetString(data);
            JsonValue p;
            try
            {
                p = JsonValue.Parse(text);
            }
            catch (InvalidJsonException)
            {
                return;
            }
            if (!new JsonValue.Num(1).Equals(p.Field("v")) || !new JsonValue.Str(_id).Equals(p.Field("id"))) return;
            // The exact bytes that were signed.
            var raw = Signatures.RawMember(text, "bundle");
            var bundle = raw == null ? null : Bundle.Parse(raw);
            if (bundle == null) return;
            if (!bundle.SupportsEngine)
            {
                EmitError(EngineError(bundle));
                return;
            }
            if (Snap is Snapshot c0 && c0.Bundle.Revision >= bundle.Revision) return;
            var etag = (p.Field("etag") as JsonValue.Str)?.Value ?? "";
            var checksum = (p.Field("checksum") as JsonValue.Str)?.Value ?? "";
            var next = new Snapshot(bundle, etag, checksum, null, null);
            var v = Verifier;
            if (v != null)
            {
                // The store is outside the trust boundary: a signed copy must verify again, and with Require an unsigned copy is not used at all.
                var s = Signatures.Info.FromJson(p.Field("sig"));
                if (s != null && s.Revision == bundle.Revision)
                {
                    bool ok;
                    try
                    {
                        ok = Signatures.VerifyBundleText(await v.KeysForAsync(s.Kid, ct).ConfigureAwait(false), s, Encoding.UTF8.GetBytes(raw!));
                    }
                    catch (NanoFlagsException)
                    {
                        ok = false;
                    }
                    if (!ok)
                    {
                        EmitError(new NanoFlagsException(ErrorCode.Signature, "The persisted bundle failed signature verification and was ignored."));
                        return;
                    }
                    next = new Snapshot(bundle, etag, checksum, s, raw);
                    lock (Lock) PinnedEnvironment ??= s.EnvironmentId;
                }
                else if (v.Require)
                {
                    return;
                }
            }
            lock (AdoptLock)
            {
                if (Snap is Snapshot c1 && c1.Bundle.Revision >= bundle.Revision) return;
                // A restored bundle is usable but not known to be current: stale until the edge confirms it.
                Adopt(next, Status.Stale, Source.Store, Transport.Poll, null);
            }
        }

        internal string ETagKind => _browserKey ? "client" : "server";

        /* ---------------- evaluation ---------------- */

        private static readonly IReadOnlyDictionary<string, object?> EmptyContext = new Dictionary<string, object?>();

        private static bool IsFinite(JsonValue v) => v is JsonValue.Num n && !double.IsNaN(n.Value) && !double.IsInfinity(n.Value);

        private static bool IsInt(JsonValue v) => IsFinite(v) && v is JsonValue.Num n && n.Value == Math.Floor(n.Value) && n.Value >= int.MinValue && n.Value <= int.MaxValue;

        private static bool IsLong(JsonValue v) => IsFinite(v) && v is JsonValue.Num n && n.Value == Math.Floor(n.Value) && Math.Abs(n.Value) <= 9007199254740992.0;

        /// <summary>
        /// Evaluates against the configuration in use, or, with a live <paramref name="scope"/>, against the session's
        /// pinned bundle with the context <c>{...session.context, ...ctx}</c> (the call's attributes win).
        /// </summary>
        private EngineResult Eval(Sessions.State? scope, string key, IReadOnlyDictionary<string, object?>? ctx, JsonValue fallback, Func<JsonValue, bool>? accepts, bool record)
        {
            var s = scope != null ? scope.Snap : Snap;
            var c = ctx ?? EmptyContext;
            if (scope != null && scope.Context.Count > 0)
            {
                var merged = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var kv in scope.Context) merged[kv.Key] = kv.Value;
                foreach (var kv in c) merged[kv.Key] = kv.Value;
                c = merged;
            }
            var res = Evaluator.Evaluate(s == null ? JsonValue.Null : s.Bundle.Value, key, EvalContexts.Of(c), fallback);
            if (accepts != null && res.Reason != Reason.FlagNotFound && res.Reason != Reason.Error && !accepts(res.Value))
            {
                var msg = $"Flag \"{key}\" has a {res.Value.TypeName} value, which does not match the requested type.";
                var trace = res.Trace.ToList();
                trace.Add(new TraceStep("result", "Returned the fallback", msg));
                res = new EngineResult(key, fallback, Reason.Error, trace.AsReadOnly(), res.Revision, error: msg);
            }
            if (record) Events.Record(res, c, s, scope?.Id);
            return res;
        }

        private static EvaluationDetail<T> Detail<T>(EngineResult r, T value)
        {
            string? ruleId = null;
            if (r.RuleIndex >= 0) ruleId = r.RuleId is JsonValue.Str s ? s.Value : r.RuleId.ToJson();
            long rev = IsFinite(r.Revision) ? (long)((JsonValue.Num)r.Revision).Value : 0;
            return new EvaluationDetail<T>(r.FlagKey, value, r.Reason, r.RuleIndex, ruleId, r.InRollout, r.Bucket, rev, r.Trace, r.Error, r.Value);
        }

        private static bool Failed(EngineResult r) => r.Reason == Reason.Error || r.Reason == Reason.FlagNotFound;

        /// <summary>The boolean value of flag <paramref name="key"/>, or <paramref name="fallback"/> when it is missing, not loaded, or serves another type.</summary>
        public bool BoolVariation(string key, IReadOnlyDictionary<string, object?>? context, bool fallback) => BoolVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="BoolVariation"/> with the full evaluation result.</summary>
        public EvaluationDetail<bool> BoolVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, bool fallback) => BoolVariationDetail(null, key, context, fallback);

        internal EvaluationDetail<bool> BoolVariationDetail(Sessions.State? scope, string key, IReadOnlyDictionary<string, object?>? context, bool fallback)
        {
            var r = Eval(scope, key, context, JsonValue.Bool.Of(fallback), v => v is JsonValue.Bool, true);
            return Detail(r, r.Value is JsonValue.Bool b ? b.Value : fallback);
        }

        /// <summary>The string value of flag <paramref name="key"/>, or <paramref name="fallback"/>.</summary>
        public string StringVariation(string key, IReadOnlyDictionary<string, object?>? context, string fallback) => StringVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="StringVariation"/> with the full evaluation result.</summary>
        public EvaluationDetail<string> StringVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, string fallback) => StringVariationDetail(null, key, context, fallback);

        internal EvaluationDetail<string> StringVariationDetail(Sessions.State? scope, string key, IReadOnlyDictionary<string, object?>? context, string fallback)
        {
            var r = Eval(scope, key, context, fallback == null ? JsonValue.Null : new JsonValue.Str(fallback), v => v is JsonValue.Str, true);
            return Detail(r, !Failed(r) && r.Value is JsonValue.Str s ? s.Value : fallback!);
        }

        /// <summary>The (finite) numeric value of flag <paramref name="key"/>, or <paramref name="fallback"/>.</summary>
        public double DoubleVariation(string key, IReadOnlyDictionary<string, object?>? context, double fallback) => DoubleVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="DoubleVariation"/> with the full evaluation result.</summary>
        public EvaluationDetail<double> DoubleVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, double fallback) => DoubleVariationDetail(null, key, context, fallback);

        internal EvaluationDetail<double> DoubleVariationDetail(Sessions.State? scope, string key, IReadOnlyDictionary<string, object?>? context, double fallback)
        {
            var r = Eval(scope, key, context, new JsonValue.Num(fallback), IsFinite, true);
            return Detail(r, IsFinite(r.Value) ? ((JsonValue.Num)r.Value).Value : fallback);
        }

        /// <summary>The value of a number flag that serves whole numbers in the <see cref="int"/> range, or <paramref name="fallback"/>.</summary>
        public int IntVariation(string key, IReadOnlyDictionary<string, object?>? context, int fallback) => IntVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="IntVariation"/> with the full evaluation result.</summary>
        public EvaluationDetail<int> IntVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, int fallback) => IntVariationDetail(null, key, context, fallback);

        internal EvaluationDetail<int> IntVariationDetail(Sessions.State? scope, string key, IReadOnlyDictionary<string, object?>? context, int fallback)
        {
            var r = Eval(scope, key, context, new JsonValue.Num(fallback), IsInt, true);
            return Detail(r, IsInt(r.Value) ? (int)((JsonValue.Num)r.Value).Value : fallback);
        }

        /// <summary>The value of a number flag that serves whole numbers (|n| ≤ 2^53), or <paramref name="fallback"/>.</summary>
        public long LongVariation(string key, IReadOnlyDictionary<string, object?>? context, long fallback) => LongVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="LongVariation"/> with the full evaluation result.</summary>
        public EvaluationDetail<long> LongVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, long fallback) => LongVariationDetail(null, key, context, fallback);

        internal EvaluationDetail<long> LongVariationDetail(Sessions.State? scope, string key, IReadOnlyDictionary<string, object?>? context, long fallback)
        {
            var r = Eval(scope, key, context, new JsonValue.Num(fallback), IsLong, true);
            return Detail(r, IsLong(r.Value) ? (long)((JsonValue.Num)r.Value).Value : fallback);
        }

        /// <summary>
        /// The value of a JSON flag as plain .NET data (null, bool, double, string, List&lt;object?&gt;,
        /// Dictionary&lt;string, object?&gt; in configuration order), or <paramref name="fallback"/>.
        /// </summary>
        public object? JsonVariation(string key, IReadOnlyDictionary<string, object?>? context, object? fallback) => JsonVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="JsonVariation"/> with the full evaluation result.</summary>
        public EvaluationDetail<object?> JsonVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, object? fallback) => JsonVariationDetail(null, key, context, fallback);

        internal EvaluationDetail<object?> JsonVariationDetail(Sessions.State? scope, string key, IReadOnlyDictionary<string, object?>? context, object? fallback)
        {
            var r = Eval(scope, key, context, JsonValue.Of(fallback), v => !v.IsUndefined, true);
            return Detail(r, Failed(r) ? fallback : r.Value.ToObject());
        }

        /// <summary><see cref="JsonVariation"/> with JavaScript-typed values.</summary>
        public JsonValue JsonValueVariation(string key, IReadOnlyDictionary<string, object?>? context, JsonValue? fallback) => JsonValueVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="JsonValueVariation"/> with the full evaluation result.</summary>
        public EvaluationDetail<JsonValue> JsonValueVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, JsonValue? fallback) => JsonValueVariationDetail(null, key, context, fallback);

        internal EvaluationDetail<JsonValue> JsonValueVariationDetail(Sessions.State? scope, string key, IReadOnlyDictionary<string, object?>? context, JsonValue? fallback)
        {
            var fb = fallback ?? JsonValue.Null;
            var r = Eval(scope, key, context, fb, v => !v.IsUndefined, true);
            return Detail(r, Failed(r) ? fb : r.Value);
        }

        /// <summary>The full engine result without any type check.</summary>
        public EvaluationDetail<object?> Evaluate(string key, IReadOnlyDictionary<string, object?>? context, object? fallback = null) => Evaluate(null, key, context, null);

        internal EvaluationDetail<object?> Evaluate(Sessions.State? scope, string key, IReadOnlyDictionary<string, object?>? context, object? fallback)
        {
            var r = Eval(scope, key, context, JsonValue.Of(fallback), null, true);
            return Detail(r, Failed(r) ? fallback : r.Value.ToObject());
        }

        /* ---------------- test sessions ---------------- */

        /// <summary>The header that carries a test-session token between services (<c>"x-nanoflags-session"</c>).</summary>
        public const string SessionHeader = Sessions.Header;

        /// <summary>
        /// Whether <paramref name="token"/> can be a test-session token: an opaque string that only has to be safe to put in
        /// a header (1 to 512 printable ASCII characters, no spaces).
        /// </summary>
        public static bool IsSessionToken(string? token) => Sessions.IsToken(token);

        /// <summary>
        /// Resolves a test session (<c>GET /v1/session</c>, once per token and service until the session expires; concurrent
        /// callers share one request) and returns an evaluator scoped to it. Pass the incoming <c>x-nanoflags-session</c>
        /// header value. Never throws: an absent, malformed, unknown, expired or not permitted token, a failed lookup
        /// (reported through <see cref="Error"/> with <see cref="ErrorCode.Session"/>), or <paramref name="cancellationToken"/>
        /// ending first yields an evaluator whose <see cref="SessionEvaluator.IsActive"/> is false and that behaves like the client.
        /// </summary>
        /// <param name="token">The session token.</param>
        /// <param name="service">Sent as <c>X-NanoFlags-Service</c> (null: <see cref="NanoFlagsOptions.Service"/>); a session may be limited to certain services.</param>
        /// <param name="cancellationToken">Ends the wait (not the shared lookup).</param>
        public async Task<SessionEvaluator> SessionAsync(string? token, string? service = null, CancellationToken cancellationToken = default)
        {
            try
            {
                var lookup = Sessions.Resolve(token, service);
                if (!lookup.IsCompleted && cancellationToken.CanBeCanceled)
                {
                    var cancelled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                    using (cancellationToken.Register(() => cancelled.TrySetResult(true)))
                    {
                        if (await Task.WhenAny(lookup, cancelled.Task).ConfigureAwait(false) != lookup) return new SessionEvaluator(this, null);
                    }
                }
                return new SessionEvaluator(this, await lookup.ConfigureAwait(false));
            }
            catch (Exception)
            {
                return new SessionEvaluator(this, null); // never thrown: lookups complete normally
            }
        }

        /// <summary>Synchronous <see cref="SessionAsync"/> (blocks on the first call per token, at most the request timeout).</summary>
        public SessionEvaluator Session(string? token, string? service = null)
        {
            var lookup = Sessions.Resolve(token, service);
            if (lookup.IsCompleted) return new SessionEvaluator(this, lookup.Result);
            return Task.Run(() => SessionAsync(token, service)).GetAwaiter().GetResult();
        }

        /// <summary>Every flag of the configuration in use, as plain .NET values (no telemetry). Empty without a configuration.</summary>
        public IReadOnlyDictionary<string, object?> AllFlags(IReadOnlyDictionary<string, object?>? context)
        {
            var output = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var kv in AllFlagsDetail(context)) output[kv.Key] = kv.Value.Value;
            return output;
        }

        /// <summary><see cref="AllFlags"/> with the full evaluation result of every flag.</summary>
        public IReadOnlyDictionary<string, EvaluationDetail<object?>> AllFlagsDetail(IReadOnlyDictionary<string, object?>? context)
        {
            var output = new Dictionary<string, EvaluationDetail<object?>>(StringComparer.Ordinal);
            var s = Snap;
            if (s == null) return output;
            var c = EvalContexts.Of(context ?? EmptyContext);
            foreach (var k in s.Bundle.FlagKeys)
            {
                var r = s.Bundle.Evaluate(k, c, JsonValue.Null);
                if (r.Reason == Reason.FlagNotFound) continue; // keys whose entry is not a flag at all
                output[k] = Detail(r, r.Value.ToObject());
            }
            return output;
        }

        /// <inheritdoc/>
        public override string ToString() => $"NanoFlagsClient({Cfg.BaseUrl}, status={Status.ToWire()}, revision={Revision}, transport={Transport.ToWire()})";
    }
}
