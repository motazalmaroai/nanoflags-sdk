using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using NanoFlags.Engine;
using Xunit;

namespace NanoFlags.Tests
{
    public sealed class ClientTests : IAsyncLifetime
    {
        private const string Key = "nf_srv_0123456789abcdef";
        private FakeEdge _edge = null!;
        private readonly List<NanoFlagsClient> _clients = new List<NanoFlagsClient>();

        public async Task InitializeAsync() => _edge = await FakeEdge.StartAsync();

        public async Task DisposeAsync()
        {
            foreach (var c in _clients) await c.CloseAsync();
            await _edge.DisposeAsync();
        }

        private static Dictionary<string, object?> Ctx(params (string, object?)[] kv) => kv.ToDictionary(x => x.Item1, x => x.Item2);

        private NanoFlagsOptions Opts(bool live = true, bool streaming = true) => new NanoFlagsOptions
        {
            BaseUrl = _edge.BaseUrl,
            Service = "test-svc",
            Verify = new VerifyOptions { PublicKeys = { _edge.Key1.Jwk }, Require = true },
            Events = EventsOptions.Disabled,
            Live = live,
            Streaming = streaming,
        };

        private NanoFlagsClient Client(NanoFlagsOptions o, string key = Key)
        {
            var c = NanoFlagsClient.Create(key, o);
            _clients.Add(c);
            return c;
        }

        private static async Task Until(string what, int ms, Func<bool> cond)
        {
            var end = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < end)
            {
                if (cond()) return;
                await Task.Delay(20);
            }
            Assert.True(cond(), "timed out waiting for " + what);
        }

        private static readonly TimeSpan Ten = TimeSpan.FromSeconds(10);

        [Fact]
        public void RefusesMissingKeyAndBadBaseUrl()
        {
            Assert.Equal(ErrorCode.Config, Assert.Throws<NanoFlagsException>(() => NanoFlagsClient.Create(" ")).Code);
            Assert.Equal(ErrorCode.Config, Assert.Throws<NanoFlagsException>(() => NanoFlagsClient.Create(Key, new NanoFlagsOptions { BaseUrl = "ftp://x" })).Code);
        }

        [Fact]
        public async Task LoadsVerifiedBundleAndEvaluates()
        {
            var c = Client(Opts(false, false));
            Assert.True(await c.WaitForReadyAsync(Ten));
            Assert.True(await c.Ready);
            Assert.Equal(Status.Ready, c.Status);
            Assert.Equal(1, c.Revision);
            Assert.Equal(Transport.Poll, c.Transport);
            var pro = Ctx(("key", "u1"), ("plan", "pro"));
            var free = Ctx(("key", "u1"), ("plan", "free"));
            Assert.True(c.BoolVariation("new-checkout", pro, false));
            Assert.False(c.BoolVariation("new-checkout", free, true));
            Assert.True(c.BoolVariation("new-checkout", Ctx(("key", "u2"), ("email", "a@example.com")), false));
            Assert.Equal("blue", c.StringVariation("accent", pro, "red"));
            Assert.Equal(3, c.IntVariation("limit", pro, 9));
            Assert.Equal(3L, c.LongVariation("limit", pro, 9));
            Assert.Equal(0.25, c.DoubleVariation("ratio", pro, 9));
            Assert.Equal(9, c.IntVariation("ratio", pro, 9));
            var theme = Assert.IsType<Dictionary<string, object?>>(c.JsonVariation("theme", pro, null));
            Assert.Equal(true, theme["dark"]);
            Assert.Equal(4.0, theme["radius"]);
            Assert.Equal("{\"dark\":true,\"radius\":4}", c.JsonValueVariation("theme", pro, null).ToJson());
            Assert.False(c.BoolVariation("disabled", pro, true));

            var d = c.BoolVariationDetail("new-checkout", pro, false);
            Assert.Equal(Reason.RuleMatch, d.Reason);
            Assert.Equal("pro", d.RuleId);
            Assert.Equal(0, d.RuleIndex);
            Assert.Equal(1, d.Revision);
            Assert.Equal("config", d.Trace[0].Kind);
            Assert.Equal("Rule 01 matched", d.Trace[1].Title);
            Assert.Equal("plan = pro", d.Trace[1].Detail);

            var mismatch = c.StringVariationDetail("new-checkout", pro, "fb");
            Assert.Equal("fb", mismatch.Value);
            Assert.Equal(Reason.Error, mismatch.Reason);
            Assert.Contains("does not match the requested type", mismatch.Error);

            var missing = c.BoolVariationDetail("nope", pro, true);
            Assert.True(missing.Value);
            Assert.Equal(Reason.FlagNotFound, missing.Reason);

            var rollout = c.BoolVariationDetail("rollout", Ctx(("key", "user-42")), false);
            Assert.NotNull(rollout.Bucket);
            Assert.Equal(rollout.InRollout, rollout.Value);
            var noKey = c.BoolVariationDetail("rollout", Ctx(), true);
            Assert.False(noKey.InRollout);
            Assert.False(noKey.Value);

            var all = c.AllFlags(pro);
            Assert.Equal(new[] { "new-checkout", "accent", "limit", "ratio", "theme", "disabled", "rollout" }, all.Keys.ToArray());
            Assert.Equal(true, all["new-checkout"]);
            Assert.Equal(Reason.Off, c.AllFlagsDetail(pro)["disabled"].Reason);
            Assert.False(c.BoolVariation("new-checkout", null, false));
        }

        [Fact]
        public async Task EvaluatesWithFallbacksBeforeLoading()
        {
            _edge.BundleStatus = 500;
            var c = Client(Opts(false, false));
            Assert.False(await c.WaitForReadyAsync(Ten));
            Assert.False(await c.Ready);
            Assert.Equal(Status.NotReady, c.Status);
            Assert.Equal(ErrorCode.Http, c.LastError!.Code);
            Assert.Equal(500, c.LastError.HttpStatus);
            var d = c.BoolVariationDetail("new-checkout", Ctx(), true);
            Assert.True(d.Value);
            Assert.Equal(Reason.FlagNotFound, d.Reason);
            Assert.Equal("No configuration is loaded. The application fallback applies.", d.Trace[0].Detail);
            Assert.Empty(c.AllFlags(Ctx()));
            Assert.Equal(-1, c.Revision);
        }

        [Fact]
        public async Task RefusesUnsignedAndTamperedBundles()
        {
            _edge.Signed = false;
            var c = Client(Opts(false, false));
            Assert.False(await c.WaitForReadyAsync(Ten));
            Assert.Equal(ErrorCode.Signature, c.LastError!.Code);
            Assert.Contains("not signed", c.LastError.Message);

            _edge.Signed = true;
            _edge.TamperHttp = true;
            var e = await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync());
            Assert.Equal(ErrorCode.Signature, e.Code);
            Assert.Null(c.Bundle);

            _edge.TamperHttp = false;
            await c.RefreshAsync();
            Assert.Equal(Status.Ready, c.Status);

            _edge.Signed = false;
            var o = Opts(false, false);
            o.Verify = new VerifyOptions { PublicKeys = { _edge.Key1.Jwk } };
            Assert.True(await Client(o).WaitForReadyAsync(Ten), "unsigned is accepted when signatures are not required");
        }

        [Fact]
        public async Task SignedForAnotherEnvironmentIsRefused()
        {
            var c = Client(Opts(false, false));
            Assert.True(await c.WaitForReadyAsync(Ten));
            _edge.EnvironmentId = "env-other";
            _edge.SetFlags(2, FakeEdge.Flags, 1);
            var e = await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync());
            Assert.Contains("different environment", e.Message);
            Assert.Equal(1, c.Revision);
            Assert.Equal(Status.Ready, c.Status);
        }

        [Fact]
        public async Task ETagRevalidationReturns304AndStaleNeverGoesBackwards()
        {
            _edge.SetFlags(5, FakeEdge.Flags, 1);
            var c = Client(Opts(false, false));
            Assert.True(await c.WaitForReadyAsync(Ten));
            await c.RefreshAsync();
            await c.RefreshAsync();
            Assert.Equal(2, _edge.NotModified);
            _edge.SetFlags(4, FakeEdge.Flags, 1);
            _edge.StaleHeader = true;
            await c.RefreshAsync();
            Assert.Equal(5, c.Revision);
            Assert.Equal(Status.Stale, c.Status);
        }

        [Fact]
        public async Task UnknownKidLoadsKeysOnceRateLimited()
        {
            var k2 = new FakeEdge.Key("t2");
            _edge.Published.Add(k2);
            _edge.SigningKey = k2;
            var o = Opts(false, false);
            o.Verify = new VerifyOptions { PublicKeys = { _edge.Key1.Jwk }, FetchKeys = true, Require = true };
            var c = Client(o);
            Assert.True(await c.WaitForReadyAsync(Ten));
            Assert.Equal(1, _edge.KeysRequests);
            _edge.SigningKey = new FakeEdge.Key("t3");
            _edge.SetFlags(2, FakeEdge.Flags, 1);
            await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync());
            await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync());
            Assert.Equal(1, _edge.KeysRequests);
            Assert.Equal(1, c.Revision);
            Assert.All(_edge.Requests.Where(r => r.Path == "/v1/keys"), r => Assert.Equal("", r.Authorization));
        }

        [Fact]
        public async Task KeysFromTheEdgeWhenNoneArePinned()
        {
            var o = Opts(false, false);
            o.Verify = new VerifyOptions { FetchKeys = true, Require = true };
            Assert.True(await Client(o).WaitForReadyAsync(Ten));
            Assert.Equal(1, _edge.KeysRequests);
        }

        [Fact]
        public void VerificationDefaults()
        {
            var official = Client(new NanoFlagsOptions { Live = false, Streaming = false, PollInterval = TimeSpan.Zero, Events = EventsOptions.Disabled,
                HttpClient = new System.Net.Http.HttpClient(new System.Net.Http.HttpClientHandler { Proxy = new System.Net.WebProxy("http://127.0.0.1:9"), UseProxy = true }) });
            Assert.NotNull(official.Verifier);
            Assert.True(official.Verifier!.Require);
            Assert.Null(Client(new NanoFlagsOptions { BaseUrl = _edge.BaseUrl, Live = false, Streaming = false, Events = EventsOptions.Disabled }).Verifier);
            Assert.Null(Client(new NanoFlagsOptions { DisableVerification = true, Live = false, Streaming = false, PollInterval = TimeSpan.Zero, Events = EventsOptions.Disabled,
                HttpClient = new System.Net.Http.HttpClient(new System.Net.Http.HttpClientHandler { Proxy = new System.Net.WebProxy("http://127.0.0.1:9"), UseProxy = true }) }).Verifier);
            var priv = Jwk.FromJson(JsonValue.Parse("{\"kty\":\"OKP\",\"crv\":\"Ed25519\",\"x\":\"" + _edge.Key1.Jwk.X + "\",\"d\":\"secret\"}"))!;
            Assert.False(priv.IsPublicEd25519);
        }

        [Fact]
        public async Task LivePushAdoptsVerifiedRevisions()
        {
            var changes = new ConcurrentQueue<ChangeEvent>();
            var errors = new ConcurrentQueue<NanoFlagsException>();
            var c = Client(Opts());
            c.Changed += (_, e) => changes.Enqueue(e);
            c.Error += (_, e) => errors.Enqueue(e);
            Assert.True(await c.WaitForReadyAsync(Ten));
            await Until("live socket", 10_000, () => c.Transport == Transport.Live && _edge.SocketCount > 0);

            _edge.CommittedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 150;
            _edge.SetFlags(2, FakeEdge.Flags.Replace("\"default\":\"blue\"", "\"default\":\"green\""), 1);
            await _edge.PushAsync();
            await Until("revision 2", 10_000, () => c.Revision == 2);
            Assert.Equal("green", c.StringVariation("accent", Ctx(), "x"));
            await Until("change event", 5_000, () => changes.Any(e => e.Revision == 2));
            var ev = changes.First(e => e.Revision == 2);
            Assert.Equal(Transport.Live, ev.Transport);
            Assert.Equal(Source.Network, ev.Source);
            Assert.Equal(1, ev.PreviousRevision);
            Assert.True(ev.Latency!.Value.TotalMilliseconds >= 100);

            _edge.SetFlags(3, FakeEdge.Flags, 1);
            int before = _edge.BundleRequests;
            await _edge.PushAsync(tamper: true);
            await Until("signature error", 5_000, () => errors.Any(x => x.Code == ErrorCode.Signature));
            await Until("revision 3 over HTTP", 5_000, () => c.Revision == 3 && _edge.BundleRequests > before);
            Assert.Equal("\"" + _edge.Checksum + "-server\"", c.Snap!.ETag);

            await _edge.PushAsync(env: "env-evil");
            await Until("environment error", 5_000, () => errors.Any(x => x.Message.Contains("different environment")));
        }

        [Fact]
        public async Task CloseCode4004StopsAndKeepsConfiguration()
        {
            var errors = new ConcurrentQueue<NanoFlagsException>();
            var c = Client(Opts());
            c.Error += (_, e) => errors.Enqueue(e);
            Assert.True(await c.WaitForReadyAsync(Ten));
            await Until("live socket", 10_000, () => c.Transport == Transport.Live && _edge.SocketCount > 0);
            int connects = _edge.LiveConnects;
            await _edge.CloseSocketsAsync(4004, "environment deleted");
            await Until("environment_deleted", 10_000, () => errors.Any(x => x.Code == ErrorCode.EnvironmentDeleted));
            Assert.Equal(Status.Stale, c.Status);
            Assert.True(c.BoolVariation("new-checkout", Ctx(("plan", "pro")), false));
            await Task.Delay(1500);
            Assert.Equal(connects, _edge.LiveConnects);
        }

        [Fact]
        public async Task ReconnectsAfterDrop()
        {
            var c = Client(Opts());
            Assert.True(await c.WaitForReadyAsync(Ten));
            await Until("live socket", 10_000, () => c.Transport == Transport.Live && _edge.SocketCount > 0);
            await _edge.CloseSocketsAsync(1011, "restart");
            await Until("reconnect", 15_000, () => _edge.LiveConnects >= 2 && c.Transport == Transport.Live);
        }

        [Fact]
        public async Task SseFallbackWhenNoSocketCanBeOpened()
        {
            _edge.LiveEnabled = false;
            _edge.SseEnabled = true;
            var changes = new ConcurrentQueue<ChangeEvent>();
            var o = Opts();
            o.PollInterval = TimeSpan.FromMinutes(10);
            var c = Client(o);
            c.Changed += (_, e) => changes.Enqueue(e);
            Assert.True(await c.WaitForReadyAsync(Ten));
            await Until("stream", 10_000, () => _edge.StreamRequests >= 1);
            _edge.SetFlags(2, FakeEdge.Flags, 1);
            await Until("revision 2 announced over SSE", 20_000, () => c.Revision == 2);
            await Until("change event", 5_000, () => changes.Any(e => e.Revision == 2));
            Assert.Equal(Transport.Stream, changes.First(e => e.Revision == 2).Transport);
        }

        [Fact]
        public async Task PollsWithoutStreaming()
        {
            var o = Opts(streaming: false);
            o.PollInterval = TimeSpan.FromMilliseconds(300);
            var c = Client(o);
            Assert.True(await c.WaitForReadyAsync(Ten));
            _edge.SetFlags(2, FakeEdge.Flags, 1);
            await Until("polled revision 2", 10_000, () => c.Revision == 2);
            Assert.Equal(0, _edge.LiveConnects);
            Assert.Equal(0, _edge.StreamRequests);
        }

        [Fact]
        public async Task PersistsAndRestoresVerifiedBundleOffline()
        {
            var dir = Path.Combine(Path.GetTempPath(), "nanoflags-test-" + Guid.NewGuid().ToString("N"));
            var file = Path.Combine(dir, "flags.json");
            try
            {
                var o = Opts(false, false);
                o.Store = new FileStore(file);
                var c = Client(o);
                Assert.True(await c.WaitForReadyAsync(Ten));
                await Until("persisted", 5_000, () => File.Exists(file));
                await c.CloseAsync();
                var stored = File.ReadAllText(file, Encoding.UTF8);
                Assert.Contains("\"sig\"", stored);

                _edge.BundleStatus = 503;
                var d = Client(o);
                Assert.True(await d.WaitForReadyAsync(Ten));
                Assert.Equal(1, d.Revision);
                Assert.Equal(Status.Stale, d.Status);
                Assert.True(d.BoolVariation("new-checkout", Ctx(("plan", "pro")), false));

                File.WriteAllText(file, stored.Replace("\"default\":false", "\"default\":true"), new UTF8Encoding(false));
                var t = Client(o);
                Assert.False(await t.WaitForReadyAsync(Ten));
                Assert.Null(t.Bundle);
            }
            finally
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
            }
        }

        [Fact]
        public void BootstrapIsUsedUntilTheNetworkAnswers()
        {
            _edge.BundleStatus = 503;
            var o = Opts(false, false);
            o.BootstrapJson = "{\"schema\":1,\"revision\":7,\"flags\":{\"accent\":{\"enabled\":true,\"default\":\"pink\",\"rules\":[]}},\"segments\":{}}";
            var c = Client(o);
            Assert.True(c.IsInitialized);
            Assert.Equal("pink", c.StringVariation("accent", Ctx(), "x"));
            Assert.Equal(7, c.Revision);
            var bad = Opts(false, false);
            bad.BootstrapJson = "{nope";
            Assert.False(Client(bad).IsInitialized);
        }

        [Fact]
        public async Task NewerEngineIsRefused()
        {
            _edge.SetFlags(1, FakeEdge.Flags, 2);
            var c = Client(Opts(false, false));
            Assert.False(await c.WaitForReadyAsync(Ten));
            Assert.Equal(ErrorCode.Engine, c.LastError!.Code);
            Assert.Contains("needs evaluation engine 2", c.LastError.Message);
        }

        [Fact]
        public async Task RejectedKeyIsReported()
        {
            var c = Client(Opts(false, false), "bad-key");
            Assert.False(await c.WaitForReadyAsync(Ten));
            Assert.Equal(ErrorCode.Unauthorized, c.LastError!.Code);
            Assert.Equal(401, c.LastError.HttpStatus);
        }

        [Fact]
        public async Task OptionsErrorHandlerSeesErrorsRaisedWhileTheClientIsCreated()
        {
            _edge.BundleStatus = 503;
            var early = new ConcurrentQueue<NanoFlagsException>();
            var late = new ConcurrentQueue<NanoFlagsException>();
            var o = Opts(false, false);
            o.PollInterval = TimeSpan.Zero;
            o.BootstrapJson = "{nope";
            o.OnError = (_, e) => early.Enqueue(e);
            var c = Client(o);
            c.Error += (_, e) => late.Enqueue(e);
            await Until("bootstrap error", 5_000, () => early.Any(e => e.Code == ErrorCode.InvalidBundle));
            Assert.False(await c.WaitForReadyAsync(Ten));
            await Until("first load error", 5_000, () => early.Any(e => e.HttpStatus == 503));
            Assert.DoesNotContain(late, e => e.Code == ErrorCode.InvalidBundle);
        }

        [Fact]
        public async Task OptionsErrorHandlerSeesTheFirstLoadFailure()
        {
            var calls = new ConcurrentQueue<string>();
            var o = Opts(false, false);
            o.PollInterval = TimeSpan.Zero;
            o.OnError += (_, e) => calls.Enqueue("a:" + e.Code);
            o.OnError += (_, e) => calls.Enqueue("b:" + e.Code);
            var c = Client(o, "bad-key");
            c.Error += (_, e) => calls.Enqueue("c:" + e.Code);
            Assert.False(await c.WaitForReadyAsync(Ten));
            await Until("handlers", 5_000, () => calls.Count >= 2);
            var first = calls.ToArray();
            Assert.Equal("a:" + ErrorCode.Unauthorized, first[0]);
            Assert.Equal("b:" + ErrorCode.Unauthorized, first[1]);
            // The options are copied at Create: the same options create another client with the same handlers.
            var before = calls.Count;
            var again = Client(o, "bad-key");
            Assert.False(await again.WaitForReadyAsync(Ten));
            await Until("second client", 5_000, () => calls.Count >= before + 2);
        }

        [Fact]
        public async Task TelemetrySendsAttributeNamesAndTypesOnly()
        {
            var o = Opts(false, false);
            o.Events = new EventsOptions { SampleRate = 1, FlushInterval = TimeSpan.FromHours(1) };
            o.Random = () => 0.0;
            var c = Client(o);
            Assert.True(await c.WaitForReadyAsync(Ten));
            c.BoolVariation("new-checkout", Ctx(("key", "user-42"), ("plan", "pro"), ("email", "secret@example.com"), ("unused", "x")), false);
            c.BoolVariation("rollout", Ctx(("key", "user-42"), ("age", 33)), false);
            await c.FlushAsync();
            await Until("events", 5_000, () => !_edge.Events.IsEmpty);
            var body = _edge.Events.Last();
            Assert.Equal("test-svc", ((JsonValue.Str)body.Field("service")).Value);
            Assert.Equal("dotnet/" + NanoFlagsClient.Version, ((JsonValue.Str)body.Field("sdk")).Value);
            Assert.Equal(1.0, ((JsonValue.Num)body.Field("revision")).Value);
            var evs = ((JsonValue.Arr)body.Field("events")).Items;
            Assert.Equal(2, evs.Count);
            Assert.Equal("new-checkout", ((JsonValue.Str)evs[0].Field("flagKey")).Value);
            Assert.Equal(JsonValue.True, evs[0].Field("value"));
            Assert.Equal("rule_match", ((JsonValue.Str)evs[0].Field("reason")).Value);
            Assert.Equal("{\"plan\":\"string\",\"email\":\"string\"}", evs[0].Field("context").ToJson());
            Assert.Equal("{\"key\":\"string\"}", evs[1].Field("context").ToJson());
            var text = body.ToJson()!;
            Assert.DoesNotContain("user-42", text);
            Assert.DoesNotContain("secret@example.com", text);
            Assert.DoesNotContain("\"pro\"", text);
            Assert.All(_edge.Requests.Where(r => r.Path == "/v1/events"), r =>
            {
                Assert.Equal("Bearer " + Key, r.Authorization);
                Assert.Equal("nanoflags-dotnet/" + NanoFlagsClient.Version, r.UserAgent);
            });
        }

        [Fact]
        public async Task CustomRedactAndOptOut()
        {
            var o = Opts(false, false);
            o.Events = new EventsOptions { SampleRate = 1, FlushInterval = TimeSpan.FromHours(1), Redact = ctx => new Dictionary<string, object?> { ["tier"] = ctx["plan"] } };
            o.Random = () => 0.0;
            var c = Client(o);
            Assert.True(await c.WaitForReadyAsync(Ten));
            c.BoolVariation("new-checkout", Ctx(("plan", "pro")), false);
            await c.FlushAsync();
            await Until("events", 5_000, () => !_edge.Events.IsEmpty);
            Assert.Equal("{\"tier\":\"pro\"}", ((JsonValue.Arr)_edge.Events.First().Field("events")).Items[0].Field("context").ToJson());

            while (_edge.Events.TryDequeue(out _)) { }
            var off = Opts(false, false);
            off.Random = () => 0.0;
            var d = Client(off);
            Assert.True(await d.WaitForReadyAsync(Ten));
            d.BoolVariation("new-checkout", Ctx(("plan", "pro")), false);
            await d.FlushAsync();
            await d.CloseAsync();
            Assert.Empty(_edge.Events);
        }

        [Fact]
        public async Task StatusAndErrorEvents()
        {
            var statuses = new ConcurrentQueue<Status>();
            var errors = new ConcurrentQueue<NanoFlagsException>();
            var c = Client(Opts(false, false));
            c.StatusChanged += (_, s) => statuses.Enqueue(s);
            EventHandler<NanoFlagsException> h = (_, e) => errors.Enqueue(e);
            c.Error += h;
            Assert.True(await c.WaitForReadyAsync(Ten));
            _edge.BundleStatus = 503;
            await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync());
            await Until("stale", 5_000, () => statuses.Contains(Status.Stale));
            await Until("error", 5_000, () => errors.Count == 1);
            c.Error -= h;
            await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync());
            await Task.Delay(300);
            Assert.Single(errors);
            _edge.BundleStatus = 200;
            await c.RefreshAsync();
            Assert.Equal(Status.Ready, c.Status);
            c.Changed += (_, e) => throw new InvalidOperationException("boom");
            _edge.SetFlags(2, FakeEdge.Flags, 1);
            await c.RefreshAsync();
            Assert.Equal(2, c.Revision);
        }

        [Fact]
        public async Task CloseIsIdempotentAndEvaluationsKeepWorking()
        {
            var c = Client(Opts());
            Assert.True(await c.WaitForReadyAsync(Ten));
            c.Dispose();
            await c.CloseAsync();
            Assert.True(c.BoolVariation("new-checkout", Ctx(("plan", "pro")), false));
            await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync());
            await Until("socket closed", 5_000, () => _edge.SocketCount == 0);
        }

        [Fact]
        public async Task BrowserKeyIsAccepted()
        {
            var c = Client(Opts(false, false), "nf_pub_abc");
            Assert.True(await c.WaitForReadyAsync(Ten));
            Assert.Equal("client", c.ETagKind);
        }

        [Fact]
        public void VersionMatchesTheBuild()
        {
            var props = Fixtures.Find("dotnet/Directory.Build.props");
            Assert.NotNull(props);
            Assert.Contains("<VersionPrefix>" + NanoFlagsClient.Version + "</VersionPrefix>", File.ReadAllText(props!));
        }
    }
}
