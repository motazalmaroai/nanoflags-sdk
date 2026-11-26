using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace NanoFlags.Tests
{
    /// <summary>
    /// Revision order (an older revision than one already verified is not adopted), the status after a rejected update,
    /// the same-message check and the official edge address.
    /// </summary>
    public sealed class RevisionOrderTests : IAsyncLifetime
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

        private NanoFlagsOptions Opts(bool live = false) => new NanoFlagsOptions
        {
            BaseUrl = _edge.BaseUrl,
            Service = "test-svc",
            Verify = new VerifyOptions { PublicKeys = { _edge.Key1.Jwk }, Require = true },
            Events = EventsOptions.Disabled,
            Live = live,
            Streaming = live,
            PollInterval = TimeSpan.FromMinutes(10),
        };

        private NanoFlagsClient Client(NanoFlagsOptions o, string key = Key)
        {
            var c = NanoFlagsClient.Create(key, o);
            _clients.Add(c);
            return c;
        }

        private async Task<NanoFlagsClient> LiveClientAsync()
        {
            var c = Client(Opts(live: true));
            Assert.True(await c.WaitForReadyAsync(Ten));
            await Until("live socket", 10_000, () => c.Transport == Transport.Live && _edge.SocketCount > 0);
            await Task.Delay(300); // the greeting of the socket has been handled
            return c;
        }

        private static ConcurrentQueue<NanoFlagsException> ErrorsOf(NanoFlagsClient c)
        {
            var errors = new ConcurrentQueue<NanoFlagsException>();
            c.Error += (_, e) => errors.Enqueue(e);
            return errors;
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

        /// <summary>A configuration whose only interesting content is the value of <c>accent</c> (and a boolean that is false by default).</summary>
        private void Accent(long rev, string value) =>
            _edge.SetFlags(rev, "{\"accent\":{\"type\":\"string\",\"enabled\":true,\"clientExposed\":true,\"default\":\"" + value + "\",\"off\":\"blue\",\"rules\":[]},"
                + "\"f\":{\"type\":\"boolean\",\"enabled\":true,\"clientExposed\":true,\"default\":false,\"off\":false,\"rules\":[]}}", 1);

        private static string AccentOf(NanoFlagsClient c) => c.StringVariation("accent", new Dictionary<string, object?>(), "x");

        private sealed class MemoryStore : IStore
        {
            internal volatile byte[]? Data;

            public Task<byte[]?> LoadAsync(CancellationToken cancellationToken) => Task.FromResult(Data);

            public Task SaveAsync(byte[] data, CancellationToken cancellationToken)
            {
                Data = data;
                return Task.CompletedTask;
            }
        }

        /// <summary>Answers every request with a network failure, so that clients for the official address never leave the machine.</summary>
        private sealed class OfflineHandler : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
                throw new HttpRequestException("offline");
        }

        [Fact]
        public async Task OlderRevisionIsNotAdoptedByFetch()
        {
            Accent(5, "v5");
            var c = Client(Opts());
            Assert.True(await c.WaitForReadyAsync(Ten));
            var errors = ErrorsOf(c);
            Assert.Equal(5, c.Revision);

            Accent(4, "v4");
            var e = await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync());
            Assert.Equal(ErrorCode.Rollback, e.Code);
            Assert.Equal("rollback", e.Code.ToWire());
            Assert.Equal(5, c.Revision);
            Assert.Equal("v5", AccentOf(c));
            await Until("error listener", 5_000, () => errors.Count == 1);
            Assert.Contains("older than r5", errors.First().Message);
            Assert.Equal(Status.Stale, c.Status);
            Assert.Equal(ErrorCode.Rollback, c.LastError!.Code);

            // The edge answers the current revision again: ready; newer revisions are adopted as usual.
            Accent(5, "v5");
            await c.RefreshAsync();
            Assert.Equal(Status.Ready, c.Status);
            Assert.Null(c.LastError);
            Accent(6, "v6");
            await c.RefreshAsync();
            Assert.Equal(6, c.Revision);
        }

        [Fact]
        public async Task OlderCopyMarkedStaleByTheEdgeKeepsTheCurrentBehaviour()
        {
            Accent(5, "v5");
            var c = Client(Opts());
            Assert.True(await c.WaitForReadyAsync(Ten));
            var errors = ErrorsOf(c);
            Accent(4, "v4");
            _edge.StaleHeader = true;
            await c.RefreshAsync();
            Assert.Equal(5, c.Revision);
            Assert.Equal(Status.Stale, c.Status);
            await Task.Delay(200);
            Assert.Empty(errors);
        }

        [Fact]
        public async Task HigherRevisionWithOlderContentIsAdoptedNormally()
        {
            Accent(7, "v7");
            var c = Client(Opts());
            Assert.True(await c.WaitForReadyAsync(Ten));
            Accent(8, "v5");
            await c.RefreshAsync();
            Assert.Equal(8, c.Revision);
            Assert.Equal("v5", AccentOf(c));
            Assert.Equal(Status.Ready, c.Status);
        }

        [Fact]
        public async Task BundleForAnotherEnvironmentDoesNotMoveTheFloor()
        {
            Accent(5, "v5");
            var c = Client(Opts());
            Assert.True(await c.WaitForReadyAsync(Ten));
            _edge.EnvironmentId = "env-other";
            Accent(900, "v900");
            Assert.Equal(ErrorCode.Signature, (await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync())).Code);
            _edge.EnvironmentId = "env-test-1";
            Accent(6, "v6");
            await c.RefreshAsync();
            Assert.Equal(6, c.Revision);
        }

        [Fact]
        public async Task UnverifiedSourcesDoNotBlockUpdates()
        {
            Accent(5, "v5");
            var o = Opts();
            o.BootstrapJson = "{\"schema\":1,\"revision\":9,\"flags\":{\"accent\":{\"enabled\":true,\"default\":\"orange\",\"rules\":[]}},\"segments\":{}}";
            var b = Client(o);
            Assert.True(b.IsInitialized);
            Assert.True(await b.WaitForReadyAsync(Ten));
            await Until("revision 5", 10_000, () => b.Revision == 5);

            // Without verification there is nothing to anchor a revision on.
            var off = Opts();
            off.Verify = null;
            off.DisableVerification = true;
            var c = Client(off);
            Assert.True(await c.WaitForReadyAsync(Ten));
            Accent(4, "v4");
            await c.RefreshAsync();
            Assert.Equal(4, c.Revision);
            Assert.Null(c.LastError);
        }

        [Fact]
        public async Task OlderUnsignedAnswerIsNotAdopted()
        {
            Accent(5, "v5");
            var o = Opts();
            o.Verify = new VerifyOptions { PublicKeys = { _edge.Key1.Jwk }, Require = false };
            var c = Client(o);
            Assert.True(await c.WaitForReadyAsync(Ten));
            Accent(4, "v4");
            _edge.Signed = false;
            Assert.Equal(ErrorCode.Rollback, (await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync())).Code);
            Assert.Equal(5, c.Revision);
            // A newer unsigned answer is still accepted with Require = false, as before.
            Accent(6, "v6");
            await c.RefreshAsync();
            Assert.Equal(6, c.Revision);
        }

        [Fact]
        public async Task StoredCopyAnchorsTheFloorAcrossARestart()
        {
            var store = new MemoryStore();
            Accent(5, "v5");
            var o = Opts();
            o.Store = store;
            var first = Client(o);
            Assert.True(await first.WaitForReadyAsync(Ten));
            await Until("persisted", 5_000, () => store.Data != null);
            await first.CloseAsync();

            Accent(4, "v4");
            var c = Client(o);
            Assert.True(await c.WaitForReadyAsync(Ten));
            await Until("older revision refused", 10_000, () => c.LastError?.Code == ErrorCode.Rollback);
            Assert.Equal(5, c.Revision);
            Assert.Equal(Status.Stale, c.Status);
            Assert.Equal("v5", AccentOf(c));

            // A stored copy older than the edge's revision is the normal case: replaced, no error.
            Accent(6, "v6");
            var d = Client(o);
            Assert.True(await d.WaitForReadyAsync(Ten));
            await Until("revision 6", 10_000, () => d.Revision == 6 && d.Status == Status.Ready);
            Assert.Null(d.LastError);
        }

        [Fact]
        public async Task StoredCopyOfAnotherKeyIsNotUsed()
        {
            var store = new MemoryStore();
            Accent(5, "v5");
            var o = Opts();
            o.Store = store;
            var first = Client(o);
            Assert.True(await first.WaitForReadyAsync(Ten));
            await Until("persisted", 5_000, () => store.Data != null);
            await first.CloseAsync();
            Accent(4, "v4");
            var other = Client(o, "nf_pub_0123456789abcdef");
            Assert.True(await other.WaitForReadyAsync(Ten));
            Assert.Equal(4, other.Revision);
            Assert.Null(other.LastError);
        }

        [Fact]
        public async Task OlderPushIsNotAdoptedAndReported()
        {
            Accent(5, "v5");
            var c = await LiveClientAsync();
            var errors = ErrorsOf(c);
            Accent(6, "v6");
            await _edge.PushAsync();
            await Until("pushed r6", 10_000, () => c.Revision == 6);

            Accent(4, "v4");
            await _edge.PushAsync();
            await Until("older revision refused", 10_000, () => errors.Any(x => x.Code == ErrorCode.Rollback));
            Assert.Equal(6, c.Revision);
            Assert.Equal("v6", AccentOf(c));
        }

        [Fact]
        public async Task OlderPushIsReportedAsStale()
        {
            Accent(5, "v5");
            var c = await LiveClientAsync();
            var errors = ErrorsOf(c);
            Accent(6, "v6");
            await _edge.PushAsync();
            await Until("pushed r6", 10_000, () => c.Revision == 6);
            _edge.BundleStatus = 503; // the request path cannot confirm anything meanwhile
            Accent(4, "v4");
            await _edge.PushAsync();
            await Until("older revision refused", 10_000, () => errors.Any(x => x.Code == ErrorCode.Rollback));
            await Until("stale", 5_000, () => c.Status == Status.Stale);
            Assert.Equal(6, c.Revision);
        }

        [Fact]
        public async Task FetchTrailingAPushIsDroppedWithoutAnError()
        {
            Accent(5, "v5");
            var c = await LiveClientAsync();
            var errors = ErrorsOf(c);
            Accent(6, "v6");
            await _edge.PushAsync();
            await Until("pushed r6", 10_000, () => c.Revision == 6);
            // The request path still answers the previous revision for a moment.
            Accent(5, "v5");
            await c.RefreshAsync();
            Assert.Equal(6, c.Revision);
            await Task.Delay(200);
            Assert.DoesNotContain(errors, x => x.Code == ErrorCode.Rollback);
            Assert.Equal(Status.Ready, c.Status);
        }

        [Fact]
        public async Task RejectedSignatureTurnsStaleUntilABundleVerifies()
        {
            Accent(3, "v3");
            var c = Client(Opts());
            Assert.True(await c.WaitForReadyAsync(Ten));
            Accent(4, "v4");
            _edge.TamperHttp = true;
            Assert.Equal(ErrorCode.Signature, (await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync())).Code);
            Assert.Equal(3, c.Revision);
            Assert.Equal(Status.Stale, c.Status);
            _edge.TamperHttp = false;
            await c.RefreshAsync();
            Assert.Equal(4, c.Revision);
            Assert.Equal(Status.Ready, c.Status);
        }

        [Fact]
        public async Task UnsignedAnswerWhilePublishingKeepsTheStatus()
        {
            Accent(3, "v3");
            var c = Client(Opts());
            Assert.True(await c.WaitForReadyAsync(Ten));
            Accent(4, "v4");
            _edge.Signed = false;
            Assert.Equal(ErrorCode.Signature, (await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync())).Code);
            Assert.Equal(Status.Ready, c.Status);
            _edge.Signed = true;
            await c.RefreshAsync();
            Assert.Equal(4, c.Revision);
        }

        [Fact]
        public async Task UnsupportedEngineKeepsTheStatus()
        {
            Accent(3, "v3");
            var c = Client(Opts());
            Assert.True(await c.WaitForReadyAsync(Ten));
            _edge.SetFlags(4, "{}", 99);
            Assert.Equal(ErrorCode.Engine, (await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync())).Code);
            Assert.Equal(Status.Ready, c.Status);
            Assert.Equal(3, c.Revision);
        }

        [Fact]
        public async Task RejectedPushTurnsStale()
        {
            Accent(3, "v3");
            var c = await LiveClientAsync();
            var errors = ErrorsOf(c);
            Accent(4, "v4");
            _edge.BundleStatus = 503; // the request path cannot confirm anything meanwhile
            await _edge.PushAsync(tamper: true);
            await Until("signature error", 10_000, () => errors.Any(x => x.Code == ErrorCode.Signature));
            await Until("stale", 5_000, () => c.Status == Status.Stale);
            Assert.Equal(3, c.Revision);
        }

        [Fact]
        public async Task PushWithTheSameRevisionButOtherContentDoesNotConfirm()
        {
            Accent(3, "v3");
            var c = await LiveClientAsync();
            var genuine = _edge.BundleText;
            // Make the client stale: the request path fails, nothing else changes.
            _edge.BundleStatus = 503;
            await Assert.ThrowsAsync<NanoFlagsException>(() => c.RefreshAsync());
            Assert.Equal(Status.Stale, c.Status);
            // Validly signed, same revision, same checksum text, other bytes: not the same bundle.
            _edge.BundleText = genuine.Replace("\"default\":\"v3\"", "\"default\":\"other\"");
            await _edge.PushAsync();
            await Task.Delay(400);
            Assert.Equal(Status.Stale, c.Status);
            Assert.Equal("v3", AccentOf(c));
            // The very same signed message confirms it.
            _edge.BundleText = genuine;
            await _edge.PushAsync();
            await Until("confirmed", 10_000, () => c.Status == Status.Ready);
        }

        [Theory]
        [InlineData("https://edge.nanoflags.io")]
        [InlineData("https://edge.nanoflags.io/")]
        [InlineData("https://edge.nanoflags.io///")]
        [InlineData("https://EDGE.nanoflags.io:443")]
        [InlineData("https://edge.nanoflags.io./")]
        [InlineData("https://edge.nanoflags.io:443/")]
        public void OfficialAddressSpellings(string url)
        {
            Assert.Equal(NanoFlagsOptions.OfficialEdgeUrl, NanoFlagsOptions.NormalizeBaseUrl(url));
            // Default verification: on, with signatures required.
            var c = Client(new NanoFlagsOptions
            {
                BaseUrl = url,
                HttpClient = new HttpClient(new OfflineHandler()),
                Events = EventsOptions.Disabled,
                Live = false,
                Streaming = false,
                PollInterval = TimeSpan.FromMinutes(10),
            });
            Assert.Equal(NanoFlagsOptions.OfficialEdgeUrl, c.Cfg.BaseUrl);
            Assert.NotNull(c.Verifier);
            Assert.True(c.Verifier!.Require);
        }

        [Theory]
        [InlineData("https://edge.nanoflags.io.example.com", "https://edge.nanoflags.io.example.com")]
        [InlineData("http://edge.nanoflags.io", "http://edge.nanoflags.io")]
        [InlineData("https://edge.nanoflags.io/x", "https://edge.nanoflags.io/x")]
        [InlineData("https://edge.nanoflags.io/x/", "https://edge.nanoflags.io/x")]
        [InlineData("https://user@edge.nanoflags.io", "https://user@edge.nanoflags.io")]
        [InlineData("https://user:pw@edge.nanoflags.io", "https://user:pw@edge.nanoflags.io")]
        [InlineData("https://edge.nanoflags.io?x=1", "https://edge.nanoflags.io?x=1")]
        [InlineData("https://edge.nanoflags.io:8443", "https://edge.nanoflags.io:8443")]
        [InlineData("https://xedge.nanoflags.io/", "https://xedge.nanoflags.io")]
        public void OtherAddressesAreLeftAsGiven(string url, string expected)
        {
            var n = NanoFlagsOptions.NormalizeBaseUrl(url);
            Assert.NotEqual(NanoFlagsOptions.OfficialEdgeUrl, n);
            Assert.Equal(expected, n);
        }
    }
}
