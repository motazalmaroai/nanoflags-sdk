using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using NanoFlags.Engine;
using Xunit;

namespace NanoFlags.Tests
{
    public sealed class SessionTests : IAsyncLifetime
    {
        private const string Key = "nf_srv_0123456789abcdef";
        private const string A = "nf_ts_aaaaaaaaaaaaaaaa";
        private const string B = "nf_ts_bbbbbbbbbbbbbbbb";
        private const string Unknown = "nf_ts_unknown0000000";
        private const string IdA = "8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11";
        private FakeEdge _edge = null!;
        private readonly List<NanoFlagsClient> _clients = new List<NanoFlagsClient>();
        private readonly ConcurrentQueue<NanoFlagsException> _errors = new ConcurrentQueue<NanoFlagsException>();

        /// <summary>Published r1 serves "relevance-v1"; the sessions pin drafts serving their label ("&lt;label&gt;-vip" for plan=vip).</summary>
        private static string Ranking(string label) =>
            "{\"search-ranking\":{\"type\":\"string\",\"enabled\":true,\"default\":\"" + label + "\",\"off\":\"off\",\"rules\":["
            + "{\"id\":\"vip\",\"match\":\"all\",\"conditions\":[{\"attribute\":\"plan\",\"op\":\"eq\",\"value\":\"vip\"}],\"serve\":{\"type\":\"fixed\",\"value\":\"" + label + "-vip\"}}]},"
            + "\"max-items\":{\"type\":\"number\",\"enabled\":true,\"default\":20,\"off\":0,\"rules\":[]}}";

        private static Func<(int, string)> SessionBody(string id, string label, string context, TimeSpan expiresIn) => () =>
        {
            var bundle = "{\"schema\":1,\"engine\":1,\"revision\":0,\"flags\":" + Ranking(label) + ",\"segments\":{}}";
            var exp = DateTimeOffset.UtcNow.Add(expiresIn).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
            return (200, "{\"id\":\"" + id + "\",\"checksum\":\"s\",\"source\":\"draft\",\"revision\":null,\"context\":" + context + ",\"expires_at\":\"" + exp + "\",\"bundle\":" + bundle + "}");
        };

        public async Task InitializeAsync()
        {
            _edge = await FakeEdge.StartAsync();
            _edge.SetFlags(1, Ranking("relevance-v1"), 1);
            _edge.Sessions[A] = SessionBody(IdA, "session-a", "{\"plan\":\"vip\",\"key\":\"synthetic-user\"}", TimeSpan.FromMinutes(1));
            _edge.Sessions[B] = SessionBody("9e4d2b63-1e70-4d4f-8e76-1f9f1f7b2c22", "session-b", "{}", TimeSpan.FromMinutes(1));
        }

        public async Task DisposeAsync()
        {
            foreach (var c in _clients) await c.CloseAsync();
            await _edge.DisposeAsync();
        }

        private async Task<NanoFlagsClient> Client(EventsOptions? events = null)
        {
            var c = NanoFlagsClient.Create(Key, new NanoFlagsOptions
            {
                BaseUrl = _edge.BaseUrl,
                Service = "checkout-api",
                Verify = new VerifyOptions { PublicKeys = { _edge.Key1.Jwk }, Require = true },
                Events = events ?? EventsOptions.Disabled,
                Live = false,
                Streaming = false,
                Random = () => 0.0,
            });
            _clients.Add(c);
            c.Error += (_, e) => _errors.Enqueue(e);
            Assert.True(await c.WaitForReadyAsync(TimeSpan.FromSeconds(10)));
            return c;
        }

        private static Dictionary<string, object?> Ctx(params (string, object?)[] kv) => kv.ToDictionary(x => x.Item1, x => x.Item2);

        private static async Task Until(string what, int ms, Func<bool> cond)
        {
            var end = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < end && !cond()) await Task.Delay(20);
            Assert.True(cond(), "timed out waiting for " + what);
        }

        [Fact]
        public async Task EvaluatesThePinnedBundleWithTheMergedContext()
        {
            var c = await Client();
            var s = await c.SessionAsync(A);
            Assert.True(s.IsActive);
            Assert.Equal(IdA, s.Id);
            Assert.True(s.ExpiresAt > DateTimeOffset.UtcNow);
            Assert.Equal(0, s.Revision);
            Assert.Equal("session-a-vip", s.StringVariation("search-ranking", null, "fb")); // plan=vip from the session
            Assert.Equal("session-a", s.StringVariation("search-ranking", Ctx(("plan", "free")), "fb")); // the call wins
            var d = s.StringVariationDetail("search-ranking", null, "fb");
            Assert.Equal(Reason.RuleMatch, d.Reason);
            Assert.Equal("vip", d.RuleId);
            Assert.True(s.BoolVariation("search-ranking", null, true)); // typed accessors keep their type check
            Assert.Equal(20, s.IntVariation("max-items", null, 1));
            Assert.Equal("relevance-v1-vip", c.StringVariation("search-ranking", Ctx(("plan", "vip")), "fb")); // the client is untouched
            Assert.Equal(1, c.Revision);
            var h = Assert.Single(_edge.SessionRequests);
            Assert.Equal(A, h["X-NanoFlags-Session"].ToString());
            Assert.Equal("checkout-api", h["X-NanoFlags-Service"].ToString());
            Assert.Equal("Bearer " + Key, h["Authorization"].ToString());
            Assert.True(c.Session(A).IsActive);
            Assert.Single(_edge.SessionRequests); // the sync variant uses the cache
            Assert.Empty(_errors);
        }

        [Fact]
        public async Task LooksUpOncePerTokenAndServiceAlsoForConcurrentCallers()
        {
            var c = await Client();
            var all = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ => Task.Run(() => c.SessionAsync(A))));
            Assert.All(all, s => Assert.True(s.IsActive));
            Assert.Single(_edge.SessionRequests);
            await c.SessionAsync(A, "other-service"); // permission is per service: its own lookup
            Assert.Equal(2, _edge.SessionRequests.Count);
            Assert.Equal("other-service", _edge.SessionRequests.Last()["X-NanoFlags-Service"].ToString());
        }

        [Fact]
        public async Task UnknownAndMalformedTokensFallBackWithoutErrors()
        {
            var c = await Client();
            var s = await c.SessionAsync(Unknown);
            Assert.False(s.IsActive);
            Assert.Null(s.Id);
            Assert.Null(s.ExpiresAt);
            Assert.Equal(1, s.Revision);
            Assert.Equal("relevance-v1-vip", s.StringVariation("search-ranking", Ctx(("plan", "vip")), "fb"));
            await c.SessionAsync(Unknown); // a miss is remembered
            foreach (var bad in new[] { null, "", "has space", "line\nbreak", new string('x', 513) }) Assert.False((await c.SessionAsync(bad)).IsActive);
            Assert.Single(_edge.SessionRequests);
            Assert.Empty(_errors);
        }

        [Fact]
        public async Task FailuresAreReportedAndFallBack()
        {
            var c = await Client();
            _edge.Sessions["nf_ts_1"] = () => (500, "boom");
            _edge.Sessions["nf_ts_2"] = () => (200, "{\"id\":\"x\",\"bundle\":{\"nope\":true},\"expires_at\":\"2999-01-01T00:00:00Z\"}");
            _edge.Sessions["nf_ts_3"] = SessionBody("old", "old", "{}", TimeSpan.FromSeconds(-1));
            _edge.Sessions["nf_ts_4"] = () => (200, "{\"id\":\"x\",\"context\":{},\"expires_at\":\"2999-01-01T00:00:00+00:00\",\"bundle\":{\"schema\":1,\"revision\":1,\"flags\":{},\"segments\":{},\"engine\":99}}");
            _edge.Sessions["nf_ts_5"] = () => (403, "{}");
            foreach (var t in new[] { "nf_ts_1", "nf_ts_2", "nf_ts_3", "nf_ts_4", "nf_ts_5" })
            {
                var s = await c.SessionAsync(t);
                Assert.False(s.IsActive, t);
                Assert.Equal("relevance-v1", s.StringVariation("search-ranking", null, "fb"));
            }
            await Until("errors", 5000, () => _errors.Count == 4);
            Assert.Equal(new[] { ErrorCode.Session, ErrorCode.Session, ErrorCode.Engine, ErrorCode.Unauthorized }, _errors.Select(e => e.Code).ToArray()); // expiry is not an error
            Assert.Equal(500, _errors.First().HttpStatus);
            Assert.Equal("session", ErrorCode.Session.ToWire());
        }

        [Fact]
        public async Task AnExpiredSessionFallsBackAndIsLookedUpAgain()
        {
            _edge.Sessions["nf_ts_short"] = SessionBody("short", "short", "{}", TimeSpan.FromMilliseconds(400));
            var c = await Client();
            var s = await c.SessionAsync("nf_ts_short");
            Assert.True(s.IsActive);
            Assert.Equal("short", s.StringVariation("search-ranking", null, "fb"));
            await Until("expiry", 5000, () => !s.IsActive);
            Assert.Equal(1, s.Revision);
            Assert.Equal("relevance-v1", s.StringVariation("search-ranking", null, "fb"));
            Assert.Equal("short", s.Id); // still says which session it was
            _edge.Sessions.TryRemove("nf_ts_short", out _);
            Assert.False((await c.SessionAsync("nf_ts_short")).IsActive);
            Assert.Equal(2, _edge.SessionRequests.Count);
        }

        [Fact]
        public async Task ANewPublishedRevisionDoesNotChangeAnActiveSession()
        {
            var c = await Client();
            var s = await c.SessionAsync(B);
            _edge.SetFlags(2, Ranking("relevance-v2"), 1);
            await c.RefreshAsync();
            Assert.Equal("relevance-v2", c.StringVariation("search-ranking", null, "fb"));
            Assert.Equal("session-b", s.StringVariation("search-ranking", null, "fb"));
        }

        [Fact]
        public async Task EventsCarryTheSessionId()
        {
            var c = await Client(new EventsOptions { SampleRate = 1, FlushInterval = TimeSpan.FromHours(1) });
            (await c.SessionAsync(A)).StringVariation("search-ranking", null, "fb");
            c.StringVariation("search-ranking", Ctx(("plan", "vip")), "fb");
            (await c.SessionAsync(Unknown)).StringVariation("search-ranking", null, "fb");
            await c.FlushAsync();
            await Until("events", 5000, () => !_edge.Events.IsEmpty);
            var evs = ((JsonValue.Arr)_edge.Events.Last().Field("events")).Items;
            Assert.Equal(3, evs.Count);
            Assert.Equal(IdA, ((JsonValue.Str)evs[0].Field("sessionId")).Value);
            Assert.Equal("session-a-vip", ((JsonValue.Str)evs[0].Field("value")).Value);
            Assert.Equal(0.0, ((JsonValue.Num)evs[0].Field("revision")).Value);
            Assert.Equal("{\"plan\":\"string\"}", evs[0].Field("context").ToJson()); // merged context, names and types only
            Assert.True(evs[1].Field("sessionId").IsUndefined);
            Assert.True(evs[2].Field("sessionId").IsUndefined);
        }

        [Fact]
        public async Task ScopesFollowTheAsyncFlowNestAndRestore()
        {
            Assert.Null(NanoFlagsSession.CurrentSession);
            Assert.Empty(NanoFlagsSession.Headers());
            await NanoFlagsSession.RunAsync(" " + A + " ", async () =>
            {
                await Task.Delay(1);
                Assert.Equal(A, NanoFlagsSession.CurrentSession);
                Assert.Equal(A, await Task.Run(() => NanoFlagsSession.CurrentSession)); // flows into tasks it starts
                Assert.Equal(A, NanoFlagsSession.Headers()[NanoFlagsSession.Header]);
                Assert.Equal(B, NanoFlagsSession.Run(B, () => NanoFlagsSession.CurrentSession));
                Assert.Null(NanoFlagsSession.Run("bad token", () => NanoFlagsSession.CurrentSession)); // malformed: outside any session
                Assert.Equal(A, NanoFlagsSession.CurrentSession);
            });
            Assert.Null(NanoFlagsSession.CurrentSession);
        }

        [Fact]
        public async Task FlagsForIsolatesConcurrentFlows()
        {
            var c = await Client();
            string?[] tokens = { A, B, null, Unknown };
            string[] want = { "session-a-vip", "session-b", "relevance-v1", "relevance-v1" };
            var results = await Task.WhenAll(Enumerable.Range(0, 90).Select(i => Task.Run(() => NanoFlagsSession.RunAsync(tokens[i % 4], async () =>
            {
                await Task.Delay(i % 5);
                var f = await NanoFlagsSession.FlagsForAsync(c);
                await Task.Delay((i * 7) % 4);
                Assert.Equal(tokens[i % 4], NanoFlagsSession.CurrentSession); // an unknown session is still propagated
                if (tokens[i % 4] != null) Assert.Same(f, NanoFlagsSession.FlagsFor(c)); // resolved once per flow
                return (i, f.StringVariation("search-ranking", null, "fb"), NanoFlagsSession.FlagsFor(c).StringVariation("search-ranking", null, "fb"));
            }))));
            foreach (var (i, value, sync) in results)
            {
                Assert.Equal(want[i % 4], value);
                Assert.Equal(value, sync);
            }
            Assert.False(NanoFlagsSession.FlagsFor(c).IsActive);
            Assert.Equal(3, _edge.SessionRequests.Count);
        }

        /// <summary>The README's ASP.NET Core middleware and the outgoing handler, end to end.</summary>
        [Fact]
        public async Task AspNetCoreMiddlewareAndHandlerPropagateTheSession()
        {
            var flags = await Client();
            var seen = new ConcurrentDictionary<string, string>();
            await using var downstream = await StartAppAsync(app => app.Run(async http =>
            {
                seen[http.Request.Path] = http.Request.Headers[NanoFlagsSession.Header].ToString();
                await http.Response.WriteAsync("ok");
            }));
            using var outgoing = new HttpClient(new NanoFlagsSessionHandler(new HttpClientHandler()));
            await using var api = await StartAppAsync(app =>
            {
                app.Use(async (http, next) =>
                {
                    using (NanoFlagsSession.Begin(http.Request.Headers[NanoFlagsSession.Header].FirstOrDefault()))
                    {
                        await NanoFlagsSession.FlagsForAsync(flags);
                        await next();
                    }
                });
                app.Run(async http =>
                {
                    await Task.Yield();
                    var value = NanoFlagsSession.FlagsFor(flags).StringVariation("search-ranking", null, "fb");
                    await outgoing.GetStringAsync(downstream.Url + http.Request.Path);
                    await http.Response.WriteAsync(value);
                });
            });
            using var http = new HttpClient();
            string?[] tokens = { A, B, null, Unknown };
            string[] want = { "session-a-vip", "session-b", "relevance-v1", "relevance-v1" };
            await Task.WhenAll(Enumerable.Range(0, 40).Select(async i =>
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, api.Url + "/r" + i);
                if (tokens[i % 4] != null) req.Headers.Add("X-NanoFlags-Session", tokens[i % 4]);
                using var res = await http.SendAsync(req);
                Assert.Equal(want[i % 4], await res.Content.ReadAsStringAsync());
                Assert.Equal(tokens[i % 4] ?? "", seen["/r" + i]);
            }));
            Assert.Equal(3, _edge.SessionRequests.Count);
        }

        [Fact]
        public async Task WaitHonoursCancellationAndClose()
        {
            var gate = new ManualResetEventSlim();
            _edge.Sessions["nf_ts_slow"] = () =>
            {
                gate.Wait(TimeSpan.FromSeconds(10));
                return SessionBody("slow", "slow", "{}", TimeSpan.FromMinutes(1))();
            };
            var c = await Client();
            using (var cts = new CancellationTokenSource(50)) Assert.False((await c.SessionAsync("nf_ts_slow", null, cts.Token)).IsActive);
            gate.Set();
            await Until("lookup", 5000, () => c.Session("nf_ts_slow").IsActive);
            await c.CloseAsync();
            Assert.False((await c.SessionAsync(B)).IsActive);
        }

        private sealed class App : IAsyncDisposable
        {
            internal App(WebApplication app, string url)
            {
                Web = app;
                Url = url;
            }

            internal WebApplication Web { get; }
            internal string Url { get; }

            public async ValueTask DisposeAsync()
            {
                await Web.StopAsync();
                await Web.DisposeAsync();
            }
        }

        private static async Task<App> StartAppAsync(Action<WebApplication> configure)
        {
            var builder = WebApplication.CreateSlimBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            var app = builder.Build();
            configure(app);
            await app.StartAsync();
            return new App(app, app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First().TrimEnd('/'));
        }
    }
}
