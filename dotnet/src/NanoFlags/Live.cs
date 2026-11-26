using System;
using System.IO;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using NanoFlags.Engine;

namespace NanoFlags
{
    /// <summary>
    /// Push transports: the live WebSocket <c>GET /v1/live</c> (the edge pushes each signed revision; ping every ~30 s,
    /// 10 s pong timeout, replaced every ~50 min, jittered exponential reconnect backoff) and, while no socket can be
    /// opened, server-sent events <c>GET /v1/stream</c> (which only announce revisions that are then fetched).
    /// </summary>
    internal sealed class Live
    {
        internal static TimeSpan Ping = TimeSpan.FromSeconds(30);
        internal static TimeSpan PongTimeout = TimeSpan.FromSeconds(10);
        private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(5);
        private static readonly TimeSpan Rotate = TimeSpan.FromMinutes(50); // the edge drops sockets older than 2 h; replace earlier
        private const int ReadLimit = 8 << 20;
        private static readonly TimeSpan StableWindow = TimeSpan.FromSeconds(30);

        private readonly NanoFlagsClient _c;
        private int _open;
        private int _streaming;
        private ClientWebSocket? _socket;
        private Task _liveTask = Task.CompletedTask;

        // SSE state (guarded by _c.Lock)
        private CancellationTokenSource? _streamCts;
        private Task _streamTask = Task.CompletedTask;

        internal Live(NanoFlagsClient c) => _c = c;

        internal bool IsOpen => Volatile.Read(ref _open) != 0;

        internal bool IsStreaming => Volatile.Read(ref _streaming) != 0;

        internal Task Completion
        {
            get
            {
                Task s;
                lock (_c.Lock) s = _streamTask;
                return Task.WhenAll(_liveTask, s);
            }
        }

        private double Rnd() => _c.Cfg.Random();

        private TimeSpan Jitter(TimeSpan d, double lo, double hi) => TimeSpan.FromMilliseconds(d.TotalMilliseconds * (lo + (hi - lo) * Rnd()));

        internal void Start()
        {
            if (!_c.Cfg.Streaming) return;
            if (_c.Cfg.Live)
            {
                _liveTask = Task.Run(LiveLoopAsync);
                return;
            }
            StartStream();
        }

        internal void Shutdown()
        {
            StopStream();
            try
            {
                _socket?.Abort();
            }
            catch (Exception)
            {
                // closing anyway
            }
        }

        private string LiveUrl() => "ws" + _c.Cfg.BaseUrl.Substring(4) + "/v1/live";

        private sealed class Result
        {
            internal bool Opened;
            internal TimeSpan OpenFor;
            internal bool Rotating;
            internal bool Deleted;
        }

        /// <summary>Keeps one live socket open; while none can be opened, SSE + polling take over.</summary>
        private async Task LiveLoopAsync()
        {
            var ct = _c.Cts.Token;
            int attempt = 0;
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    var r = await RunSocketAsync(ct).ConfigureAwait(false);
                    if (ct.IsCancellationRequested) return;
                    if (r.Deleted)
                    {
                        // Keep evaluating the last configuration; it can no longer be updated. No socket, no stream; the regular
                        // poll stays (it reports the key as rejected, and recovers if the environment turns out to exist).
                        lock (_c.Lock) _c.EnvironmentDeleted = true;
                        StopStream();
                        if (_c.Snap != null) _c.SetStatus(Status.Stale);
                        _c.EmitError(new NanoFlagsException(ErrorCode.EnvironmentDeleted,
                            "The environment of this SDK key was deleted. The last configuration stays in use; it will not be updated."));
                        _c.Reschedule();
                        return;
                    }
                    if (r.Rotating) continue; // planned replacement: no fallback, no backoff
                    if (r.Opened && r.OpenFor > StableWindow) attempt = 1;
                    else attempt++;
                    if (!r.Opened) StartStream();
                    else _c.Reschedule(); // back to the normal poll interval
                    var wait = Jitter(TimeSpan.FromMilliseconds(Math.Min(MaxBackoff.TotalMilliseconds, 1000.0 * (1L << Math.Min(attempt - 1, 10)))), 0.5, 1.5);
                    await Task.Delay(wait, ct).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // closing
            }
            catch (Exception e)
            {
                _c.Log?.LogWarning(e, "nanoflags: live loop failed");
            }
        }

        /// <summary>Closes the current socket (for a rejected key); the loop reconnects with backoff.</summary>
        internal void DropLive()
        {
            try
            {
                _socket?.Abort();
            }
            catch (Exception)
            {
                // ignore
            }
        }

        private async Task<Result> RunSocketAsync(CancellationToken ct)
        {
            var r = new Result();
            var ws = new ClientWebSocket();
            ws.Options.SetRequestHeader("Authorization", "Bearer " + _c.SdkKey); // never in the URL
            ws.Options.SetRequestHeader("User-Agent", NanoFlagsClient.UserAgent);
            ws.Options.AddSubProtocol(NanoFlagsClient.LiveProtocol);
            ws.Options.KeepAliveInterval = TimeSpan.Zero; // application-level ping below
            try
            {
                using (var connect = CancellationTokenSource.CreateLinkedTokenSource(ct))
                {
                    connect.CancelAfter(_c.Cfg.LiveConnectTimeout);
                    await ws.ConnectAsync(new Uri(LiveUrl()), connect.Token).ConfigureAwait(false);
                }
            }
            catch (Exception e)
            {
                ws.Dispose();
                if (!ct.IsCancellationRequested) _c.Log?.LogDebug("nanoflags: live socket unavailable: {Message}", e.Message);
                return r;
            }
            var openedAt = DateTime.UtcNow;
            _socket = ws;
            r.Opened = true;
            Volatile.Write(ref _open, 1);
            StopStream(); // SSE is not used while the socket is healthy
            _c.Reschedule(); // the poll becomes a safety net

            using var sockCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var sendLock = new SemaphoreSlim(1, 1);
            long lastMessage = DateTime.UtcNow.Ticks;
            bool rotated = false;

            async Task SendTextAsync(string text)
            {
                await sendLock.WaitAsync(sockCts.Token).ConfigureAwait(false);
                try
                {
                    await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(text)), WebSocketMessageType.Text, true, sockCts.Token).ConfigureAwait(false);
                }
                finally
                {
                    sendLock.Release();
                }
            }

            // Ping, pong timeout, rotation.
            var keeper = Task.Run(async () =>
            {
                var rotateAt = DateTime.UtcNow + Jitter(Rotate, 0.9, 1.1);
                try
                {
                    while (!sockCts.IsCancellationRequested)
                    {
                        var next = Jitter(Ping, 0.9, 1.1);
                        var untilRotate = rotateAt - DateTime.UtcNow;
                        if (untilRotate <= next)
                        {
                            if (untilRotate > TimeSpan.Zero) await Task.Delay(untilRotate, sockCts.Token).ConfigureAwait(false);
                            rotated = true;
                            using (var closeCts = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
                            {
                                try
                                {
                                    await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "rotate", closeCts.Token).ConfigureAwait(false);
                                    await Task.Delay(TimeSpan.FromSeconds(5), sockCts.Token).ConfigureAwait(false);
                                }
                                catch (Exception)
                                {
                                    // aborted below
                                }
                            }
                            ws.Abort();
                            return;
                        }
                        await Task.Delay(next, sockCts.Token).ConfigureAwait(false);
                        long sentAt = DateTime.UtcNow.Ticks;
                        await SendTextAsync("ping").ConfigureAwait(false);
                        // The edge answers `pong` without waking anything up; silence means a dead connection.
                        await Task.Delay(PongTimeout, sockCts.Token).ConfigureAwait(false);
                        if (Interlocked.Read(ref lastMessage) < sentAt)
                        {
                            ws.Abort();
                            return;
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    // socket ended
                }
                catch (Exception)
                {
                    ws.Abort();
                }
            });

            var buffer = new byte[16384];
            var message = new MemoryStream();
            int? closeCode = null;
            try
            {
                while (true)
                {
                    var res = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
                    Interlocked.Exchange(ref lastMessage, DateTime.UtcNow.Ticks);
                    if (res.MessageType == WebSocketMessageType.Close)
                    {
                        closeCode = (int?)ws.CloseStatus;
                        try
                        {
                            using var closeCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                            await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", closeCts.Token).ConfigureAwait(false);
                        }
                        catch (Exception)
                        {
                            // closing anyway
                        }
                        break;
                    }
                    message.Write(buffer, 0, res.Count);
                    if (message.Length > ReadLimit) break;
                    if (!res.EndOfMessage) continue;
                    var isText = res.MessageType == WebSocketMessageType.Text;
                    var data = isText ? Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length) : null;
                    message.SetLength(0);
                    if (data == null || data == "pong") continue;
                    await ApplyPushAsync(data, ct).ConfigureAwait(false);
                }
            }
            catch (Exception)
            {
                // the socket failed or was aborted
            }
            sockCts.Cancel();
            try
            {
                await keeper.ConfigureAwait(false);
            }
            catch (Exception)
            {
                // ignore
            }
            ws.Abort();
            ws.Dispose();
            _socket = null;
            Volatile.Write(ref _open, 0);
            r.OpenFor = DateTime.UtcNow - openedAt;
            r.Rotating = rotated && !ct.IsCancellationRequested;
            r.Deleted = closeCode == NanoFlagsClient.CloseEnvironmentDeleted;
            return r;
        }

        /// <summary>Applies one <c>rev</c> / <c>hello</c> message. A message that cannot be trusted changes nothing.</summary>
        internal async Task ApplyPushAsync(string data, CancellationToken ct)
        {
            JsonValue m;
            try
            {
                m = JsonValue.Parse(data);
            }
            catch (InvalidJsonException)
            {
                return;
            }
            if (!(m is JsonValue.Obj)) return;
            var t = (m.Field("t") as JsonValue.Str)?.Value;
            if (t != "rev" && t != "hello") return;
            var text = (m.Field("bundle") as JsonValue.Str)?.Value;
            // Revision 0 / no bundle: the environment has nothing published yet.
            if (!(m.Field("revision") is JsonValue.Num revN) || text == null) return;
            double revF = revN.Value;
            if (revF != Math.Floor(revF) || double.IsInfinity(revF) || revF < 1) return;
            long revision = (long)revF;
            long receivedAt = _c.VerifiedSequence();
            var cur = _c.Snap;
            // Never backwards. An older push than a verified revision is checked first (it is reported when it verifies);
            // anything else older is dropped silently.
            bool older = cur != null && revision < cur.Bundle.Revision;
            if (older)
            {
                var floor = _c.NewestVerified();
                if (_c.Verifier == null || floor == null || revision >= floor.Revision) return;
            }
            var checksum = (m.Field("checksum") as JsonValue.Str)?.Value;
            Signatures.Info? info = null;
            var v = _c.Verifier;
            if (v != null)
            {
                var sig = (m.Field("signature") as JsonValue.Str)?.Value;
                var envId = (m.Field("environmentId") as JsonValue.Str)?.Value;
                if (string.IsNullOrEmpty(sig) || string.IsNullOrEmpty(envId) || checksum == null)
                {
                    RejectPush(revision, "it carries no complete signature.");
                    return;
                }
                string? pinned;
                lock (_c.Lock) pinned = _c.PinnedEnvironment;
                if (pinned != null && pinned != envId)
                {
                    RejectPush(revision, "it was signed for a different environment.");
                    return;
                }
                info = new Signatures.Info(sig!, (m.Field("kid") as JsonValue.Str)?.Value, envId!, revision, checksum);
                bool ok;
                try
                {
                    ok = Signatures.VerifyBundleText(await v.KeysForAsync(info.Kid, ct).ConfigureAwait(false), info, Encoding.UTF8.GetBytes(text));
                }
                catch (NanoFlagsException)
                {
                    ok = false;
                }
                if (!ok)
                {
                    RejectPush(revision, "its signature does not verify.");
                    return;
                }
            }
            if (older)
            {
                var err = _c.RollbackError(revision, receivedAt, NanoFlagsClient.VerifiedSource.Live);
                if (err != null)
                {
                    _c.UpdateRejected(err);
                    _c.Trigger(); // the regular request path says what is really current (and confirms Ready again)
                }
                return;
            }
            var bundle = Bundle.Parse(text);
            if (bundle == null || bundle.Revision != revision)
            {
                _c.UpdateRejected(new NanoFlagsException(ErrorCode.InvalidBundle, "The edge pushed an invalid bundle; it was ignored."));
                return;
            }
            if (!bundle.SupportsEngine)
            {
                _c.EmitError(NanoFlagsClient.EngineError(bundle));
                return;
            }
            NanoFlagsClient.Snapshot next;
            lock (_c.AdoptLock)
            {
                cur = _c.Snap;
                if (cur != null && revision < cur.Bundle.Revision) return;
                if (cur != null && revision == cur.Bundle.Revision)
                {
                    // Already in use: the push only confirms that it is current. With verification the signed messages must be
                    // equal (a signature binds environment, revision, checksum and the bundle's bytes).
                    bool same = info != null ? cur.Sig != null && cur.Sig.Signature == info.Signature : cur.Checksum.Length == 0 || cur.Checksum == checksum;
                    if (same) _c.SetStatus(Status.Ready);
                    return;
                }
                lock (_c.Lock)
                {
                    if (info != null) _c.PinnedEnvironment = info.EnvironmentId;
                    _c.LiveRevision = revision;
                }
                // What /v1/bundle would send as ETag for this revision, so the safety poll gets a 304.
                var etag = checksum != null ? "\"" + checksum + "-" + _c.ETagKind + "\"" : null;
                next = new NanoFlagsClient.Snapshot(bundle, etag, checksum, info, text);
                TimeSpan? latency = null;
                if (m.Field("committedAt") is JsonValue.Num at && !double.IsNaN(at.Value) && !double.IsInfinity(at.Value))
                {
                    latency = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds((long)at.Value);
                }
                if (info != null) _c.NoteVerified(info, NanoFlagsClient.VerifiedSource.Live);
                _c.Adopt(next, Status.Ready, Source.Network, Transport.Live, latency);
            }
            await _c.PersistAsync(next).ConfigureAwait(false);
        }

        private void RejectPush(long revision, string why)
        {
            _c.UpdateRejected(new NanoFlagsException(ErrorCode.Signature, $"Pushed bundle r{revision} was rejected: {why} The configuration in use is unchanged."));
            _c.Trigger(); // the regular (verified) request path says what is really current
        }

        /* ---------------- SSE fallback: GET /v1/stream ---------------- */

        internal void StartStream()
        {
            lock (_c.Lock)
            {
                if (!_c.Cfg.Streaming || _streamCts != null || _c.EnvironmentDeleted || _c.Cts.IsCancellationRequested) return;
                var cts = CancellationTokenSource.CreateLinkedTokenSource(_c.Cts.Token);
                _streamCts = cts;
                Volatile.Write(ref _streaming, 1);
                _streamTask = Task.Run(() => StreamLoopAsync(cts));
            }
        }

        internal void StopStream()
        {
            CancellationTokenSource? cts;
            lock (_c.Lock)
            {
                cts = _streamCts;
                _streamCts = null;
            }
            Volatile.Write(ref _streaming, 0);
            if (cts != null)
            {
                try
                {
                    cts.Cancel();
                }
                catch (ObjectDisposedException)
                {
                    // already gone
                }
            }
        }

        /// <summary>Reads server-sent events. The stream only says "revision N exists"; the bundle is always fetched conditionally.</summary>
        private async Task StreamLoopAsync(CancellationTokenSource cts)
        {
            var ct = cts.Token;
            int attempt = 0;
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    var started = DateTime.UtcNow;
                    bool stop = await ReadStreamAsync(ct).ConfigureAwait(false);
                    if (ct.IsCancellationRequested) return;
                    if (stop)
                    {
                        lock (_c.Lock)
                        {
                            if (_streamCts == cts)
                            {
                                _streamCts = null;
                                Volatile.Write(ref _streaming, 0);
                            }
                        }
                        return;
                    }
                    attempt = DateTime.UtcNow - started > TimeSpan.FromSeconds(30) ? 0 : attempt + 1;
                    var wait = Jitter(TimeSpan.FromMilliseconds(Math.Min(30_000, 1000.0 * (1 << Math.Min(attempt, 5)))), 0.5, 1.5);
                    await Task.Delay(wait, ct).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // stopped
            }
            finally
            {
                cts.Dispose();
            }
        }

        /// <summary>True when the stream must not be retried (the key was rejected or revoked).</summary>
        private async Task<bool> ReadStreamAsync(CancellationToken ct)
        {
            HttpResponseMessage res;
            using var req = _c.Request(HttpMethod.Get, "/v1/stream");
            req.Headers.TryAddWithoutValidation("Accept", "text/event-stream");
            try
            {
                using var headers = CancellationTokenSource.CreateLinkedTokenSource(ct);
                headers.CancelAfter(_c.Cfg.RequestTimeout);
                res = await _c.Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, headers.Token).ConfigureAwait(false);
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                return false;
            }
            using (res)
            using (ct.Register(() => res.Dispose()))
            {
                int code = (int)res.StatusCode;
                if (code == 401 || code == 403) return true; // polling keeps reporting the error
                if (code != 200) return false;
                try
                {
                    using var stream = await res.Content.ReadAsStreamAsync().ConfigureAwait(false);
                    using var reader = new StreamReader(stream, Encoding.UTF8);
                    var ev = "message";
                    var data = new StringBuilder();
                    bool hasData = false;
                    string? line;
                    while ((line = await reader.ReadLineAsync().ConfigureAwait(false)) != null)
                    {
                        if (ct.IsCancellationRequested) return false;
                        if (line.Length > 64 << 10) return false;
                        if (line.Length == 0)
                        {
                            if (hasData)
                            {
                                if (ev == "revision") OnRevision(data.ToString());
                                else if (ev == "revoked")
                                {
                                    _c.Trigger();
                                    return true;
                                }
                            }
                            ev = "message";
                            data.Clear();
                            hasData = false;
                            continue;
                        }
                        if (line[0] == ':') continue;
                        int colon = line.IndexOf(':');
                        var field = colon < 0 ? line : line.Substring(0, colon);
                        var value = colon < 0 ? "" : line.Substring(colon + 1);
                        if (value.StartsWith(" ", StringComparison.Ordinal)) value = value.Substring(1);
                        if (field == "event") ev = value;
                        else if (field == "data")
                        {
                            if (hasData) data.Append('\n');
                            data.Append(value);
                            hasData = true;
                        }
                    }
                }
                catch (Exception)
                {
                    // dropped; retried with backoff
                }
                return false;
            }
        }

        private void OnRevision(string data)
        {
            JsonValue m;
            try
            {
                m = JsonValue.Parse(data);
            }
            catch (InvalidJsonException)
            {
                return;
            }
            long rev = m.Field("revision") is JsonValue.Num n ? (long)n.Value : 0;
            var checksum = (m.Field("checksum") as JsonValue.Str)?.Value ?? "";
            var cur = _c.Snap;
            if (cur == null || rev != cur.Bundle.Revision || cur.Checksum != checksum || _c.Status != Status.Ready)
            {
                _c.MarkStreamTriggered();
                _c.Trigger();
            }
        }
    }
}
