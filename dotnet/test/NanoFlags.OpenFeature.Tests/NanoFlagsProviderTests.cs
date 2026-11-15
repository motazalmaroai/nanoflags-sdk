using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

using OpenFeature;
using OpenFeature.Constant;
using OpenFeature.Model;
using Xunit;

namespace NanoFlags.OpenFeature.Tests
{
    public sealed class NanoFlagsProviderTests : IAsyncLifetime
    {
        private static string Bundle(long rev, string accent) =>
            "{\"schema\":1,\"revision\":" + rev + ",\"flags\":{"
            + "\"new-checkout\":{\"enabled\":true,\"default\":false,\"off\":false,\"rules\":[{\"id\":\"pro\",\"match\":\"all\",\"conditions\":[{\"attribute\":\"plan\",\"op\":\"eq\",\"value\":\"pro\"}],\"serve\":{\"type\":\"fixed\",\"value\":true}}]},"
            + "\"rollout\":{\"enabled\":true,\"default\":false,\"off\":false,\"rules\":[{\"id\":\"half\",\"match\":\"all\",\"conditions\":[],\"serve\":{\"type\":\"rollout\",\"percentage\":100,\"value\":true,\"otherwise\":false}}]},"
            + "\"accent\":{\"enabled\":true,\"default\":\"" + accent + "\",\"off\":\"gray\",\"rules\":[]},"
            + "\"limit\":{\"enabled\":true,\"default\":42,\"off\":0,\"rules\":[]},"
            + "\"ratio\":{\"enabled\":true,\"default\":0.5,\"off\":0,\"rules\":[]},"
            + "\"theme\":{\"enabled\":true,\"default\":{\"dark\":true,\"sizes\":[1,2]},\"off\":null,\"rules\":[]},"
            + "\"off-flag\":{\"enabled\":false,\"default\":true,\"off\":false,\"rules\":[]}},\"segments\":{}}";

        private sealed class Stub : HttpMessageHandler
        {
            internal volatile string Body = "";
            internal volatile int Status = 200;

            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                var res = new HttpResponseMessage((HttpStatusCode)(request.RequestUri!.AbsolutePath == "/v1/bundle" ? Status : 404));
                if (request.RequestUri.AbsolutePath == "/v1/bundle") res.Content = new StringContent(Body, Encoding.UTF8, "application/json");
                return Task.FromResult(res);
            }
        }

        private readonly Stub _stub = new Stub();
        private NanoFlagsClient _client = null!;
        private readonly string _domain = "nanoflags-" + Guid.NewGuid().ToString("N");

        private static NanoFlagsOptions Options(HttpMessageHandler h) => new NanoFlagsOptions
        {
            BaseUrl = "http://edge.test",
            HttpClient = new HttpClient(h),
            DisableVerification = true,
            Streaming = false,
            PollInterval = TimeSpan.Zero,
            Events = EventsOptions.Disabled,
        };

        public Task InitializeAsync()
        {
            _stub.Body = "{\"revision\":1,\"checksum\":\"c1\",\"bundle\":" + Bundle(1, "blue") + "}";
            _client = NanoFlagsClient.Create("nf_srv_test", Options(_stub));
            return Task.CompletedTask;
        }

        public async Task DisposeAsync() => await _client.CloseAsync();

        private async Task<FeatureClient> Of()
        {
            await Api.Instance.SetProviderAsync(_domain, new NanoFlagsProvider(_client));
            return Api.Instance.GetClient(_domain);
        }

        private static EvaluationContext Ctx(string key, params (string, string)[] attrs)
        {
            var b = EvaluationContext.Builder().SetTargetingKey(key);
            foreach (var (k, v) in attrs) b.Set(k, v);
            return b.Build();
        }

        [Fact]
        public async Task ResolvesEveryTypeWithReasonsAndVariants()
        {
            var of = await Of();
            Assert.Equal(ProviderStatus.Ready, of.ProviderStatus);
            Assert.Equal("nanoflags", Api.Instance.GetProviderMetadata(_domain)!.Name);

            var pro = await of.GetBooleanDetailsAsync("new-checkout", false, Ctx("u1", ("plan", "pro")));
            Assert.True(pro.Value);
            Assert.Equal(Reason.TargetingMatch, pro.Reason);
            Assert.Equal("pro", pro.Variant);
            Assert.Equal(1, pro.FlagMetadata!.GetInt("revision"));
            Assert.Equal(0, pro.FlagMetadata.GetInt("ruleIndex"));

            var free = await of.GetBooleanDetailsAsync("new-checkout", true, Ctx("u1"));
            Assert.False(free.Value);
            Assert.Equal(Reason.Default, free.Reason);

            var split = await of.GetBooleanDetailsAsync("rollout", false, Ctx("user-42"));
            Assert.True(split.Value);
            Assert.Equal(Reason.Split, split.Reason);
            Assert.Equal("half", split.Variant);

            var off = await of.GetBooleanDetailsAsync("off-flag", true);
            Assert.False(off.Value);
            Assert.Equal(Reason.Disabled, off.Reason);

            Assert.Equal("blue", await of.GetStringValueAsync("accent", "x"));
            Assert.Equal(42, await of.GetIntegerValueAsync("limit", 0));
            Assert.Equal(0.5, await of.GetDoubleValueAsync("ratio", 0));
            Assert.Equal(42.0, await of.GetDoubleValueAsync("limit", 0));
            var theme = await of.GetObjectValueAsync("theme", new Value());
            Assert.True(theme.AsStructure!.GetValue("dark").AsBoolean);
            Assert.Equal(2, theme.AsStructure.GetValue("sizes").AsList!.Count);

            var notInt = await of.GetIntegerDetailsAsync("ratio", 7);
            Assert.Equal(7, notInt.Value);
            Assert.Equal(ErrorType.TypeMismatch, notInt.ErrorType);

            var mismatch = await of.GetStringDetailsAsync("new-checkout", "fb");
            Assert.Equal("fb", mismatch.Value);
            Assert.Equal(ErrorType.TypeMismatch, mismatch.ErrorType);
            Assert.Equal(Reason.Error, mismatch.Reason);

            var missing = await of.GetBooleanDetailsAsync("nope", true);
            Assert.True(missing.Value);
            Assert.Equal(ErrorType.FlagNotFound, missing.ErrorType);
        }

        [Fact]
        public void TargetingKeyWinsOverAKeyAttribute()
        {
            var m = NanoFlagsProvider.ToContext(EvaluationContext.Builder().SetTargetingKey("tk").Set("key", "attr").Set("plan", "pro").Set("n", 3).Build());
            Assert.Equal("tk", m["key"]);
            Assert.Equal("pro", m["plan"]);
            Assert.Equal(3.0, m["n"]);
        }

        [Fact]
        public async Task ConfigurationChangesAreProviderEvents()
        {
            var of = await Of();
            var changes = new ConcurrentQueue<ProviderEventPayload?>();
            of.AddHandler(ProviderEventTypes.ProviderConfigurationChanged, p => changes.Enqueue(p));
            _stub.Body = "{\"revision\":2,\"checksum\":\"c2\",\"bundle\":" + Bundle(2, "green") + "}";
            await _client.RefreshAsync();
            var end = DateTime.UtcNow.AddSeconds(10);
            while (changes.IsEmpty && DateTime.UtcNow < end) await Task.Delay(20);
            Assert.Single(changes);
            Assert.Equal(new[] { "accent" }, changes.First()!.FlagsChanged);
            Assert.Equal("green", await of.GetStringValueAsync("accent", "x"));
        }

        [Fact]
        public async Task NotReadyWhenNothingCanBeLoaded()
        {
            var dead = new Stub { Status = 503 };
            using var c = NanoFlagsClient.Create("nf_srv_test", Options(dead));
            var domain = _domain + "-dead";
            try
            {
                await Api.Instance.SetProviderAsync(domain, new NanoFlagsProvider(c, initTimeout: TimeSpan.FromSeconds(5)));
            }
            catch (Exception)
            {
                // initialisation errors may surface here, depending on the SDK version
            }
            var of = Api.Instance.GetClient(domain);
            Assert.Equal(ProviderStatus.Error, of.ProviderStatus);
            var d = await of.GetBooleanDetailsAsync("new-checkout", true);
            Assert.True(d.Value);
        }

        [Fact]
        public void ChangedFlagsListsAddedRemovedAndModified()
        {
            var a = NanoFlags.Engine.Bundle.Parse("{\"schema\":1,\"revision\":1,\"flags\":{\"x\":{\"enabled\":true},\"y\":{\"enabled\":true}},\"segments\":{}}");
            var b = NanoFlags.Engine.Bundle.Parse("{\"schema\":1,\"revision\":2,\"flags\":{\"y\":{\"enabled\":false},\"z\":{\"enabled\":true}},\"segments\":{}}");
            Assert.Equal(new[] { "y", "z", "x" }, NanoFlagsProvider.ChangedFlags(a, b));
        }
    }
}
