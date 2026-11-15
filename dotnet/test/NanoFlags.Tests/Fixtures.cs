using System;
using System.Collections.Concurrent;
using System.IO;
using NanoFlags.Engine;

namespace NanoFlags.Tests
{
    /// <summary>Locates the shared fixtures by walking up from the test binaries to the repository root.</summary>
    internal static class Fixtures
    {
        private static readonly ConcurrentDictionary<string, JsonValue> Cache = new ConcurrentDictionary<string, JsonValue>();

        internal static string? Find(string relative)
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null)
            {
                var p = Path.Combine(dir.FullName, relative);
                if (File.Exists(p)) return p;
                dir = dir.Parent;
            }
            return null;
        }

        internal static JsonValue? Load(string relative)
        {
            var p = Find(relative);
            return p == null ? null : Cache.GetOrAdd(p, f => JsonValue.Parse(File.ReadAllBytes(f)));
        }

        internal const string Parity = "packages/engine/fixtures/parity.json";
        internal const string Extra = "go/internal/testdata/extra.json";
        internal const string SignedDemo = "go/internal/testdata/signed-demo-response.json";
    }
}
