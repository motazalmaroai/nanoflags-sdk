using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Xunit;
using Xunit.Abstractions;

namespace NanoFlags.Tests
{
    /// <summary>
    /// Opt-in, read-only check against the real edge (https://edge.nanoflags.io): the client loads a signed bundle,
    /// verifies it with the embedded production keys and opens the live socket. Nothing is changed.
    /// <c>NANOFLAGS_PRODUCTION_TESTS=1 NANOFLAGS_SDK_KEY=nf_pub_… dotnet test --filter ProductionTests</c>
    /// </summary>
    public class ProductionTests
    {
        private readonly ITestOutputHelper _out;

        public ProductionTests(ITestOutputHelper output) => _out = output;

        [Fact]
        public async Task LoadsAVerifiedBundleAndOpensTheLiveSocket()
        {
            var key = Environment.GetEnvironmentVariable("NANOFLAGS_SDK_KEY");
            if (Environment.GetEnvironmentVariable("NANOFLAGS_PRODUCTION_TESTS") != "1" || string.IsNullOrEmpty(key))
            {
                _out.WriteLine("skipped: production checks are opt-in (NANOFLAGS_PRODUCTION_TESTS=1, NANOFLAGS_SDK_KEY)");
                return;
            }
            using var c = NanoFlagsClient.Create(key, new NanoFlagsOptions { Service = "nanoflags-dotnet-ci", Events = EventsOptions.Disabled });
            Assert.True(await c.WaitForReadyAsync(TimeSpan.FromSeconds(20)), "not ready: " + c.LastError);
            Assert.Equal(Status.Ready, c.Status);
            Assert.True(c.Revision > 0);
            Assert.NotNull(c.Snap!.Sig);
            var end = DateTime.UtcNow.AddSeconds(20);
            while (c.Transport != Transport.Live && DateTime.UtcNow < end) await Task.Delay(100);
            Assert.Equal(Transport.Live, c.Transport);
            var flags = c.AllFlags(new Dictionary<string, object?> { ["key"] = "ci" });
            var line = $"PRODUCTION: r{c.Revision} verified, live socket open, flags [{string.Join(", ", flags.Keys)}]";
            _out.WriteLine(line);
            Console.WriteLine(line);
        }
    }
}
