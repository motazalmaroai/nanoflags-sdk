using System;
using System.Collections.Generic;
using System.Net.Http;
using Microsoft.Extensions.Logging;
using NanoFlags.Engine;

namespace NanoFlags
{
    /// <summary>Configuration of a <see cref="NanoFlagsClient"/>.</summary>
    public sealed class NanoFlagsOptions
    {
        /// <summary>The hosted NanoFlags edge. With this base URL (the default) every bundle is verified and unsigned bundles are refused.</summary>
        public const string OfficialEdgeUrl = "https://edge.nanoflags.io";

        /// <summary>
        /// The public halves of the production bundle-signing keys (safe to embed; the same list as every NanoFlags SDK).
        /// A bundle signed with a key id that is not listed (a rotation after this release) makes the client load
        /// <c>GET /v1/keys</c> once, at most once a minute.
        /// </summary>
        public static IReadOnlyList<Jwk> OfficialSigningKeys { get; } = new[] { Jwk.Ed25519("wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", "k1") };

        /// <summary>The edge (default <see cref="OfficialEdgeUrl"/>). Signature verification is on by default only for the official edge.</summary>
        public string BaseUrl { get; set; } = OfficialEdgeUrl;

        /// <summary>Names this service in "which revision is each service running" reports (default "unknown").</summary>
        public string Service { get; set; } = "unknown";

        /// <summary>
        /// The HTTP client for every request (default: one created by the SDK, using the system proxy settings, e.g.
        /// <c>HTTPS_PROXY</c>). Its <see cref="HttpClient.Timeout"/> is not used; see <see cref="RequestTimeout"/>.
        /// </summary>
        public HttpClient? HttpClient { get; set; }

        /// <summary>The polling interval without a live socket (default 30 s; <see cref="TimeSpan.Zero"/> disables polling).</summary>
        public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(30);

        /// <summary>The safety-poll interval while the live socket is healthy (default 5 min).</summary>
        public TimeSpan LivePollInterval { get; set; } = TimeSpan.FromMinutes(5);

        /// <summary>The live WebSocket (default on). Without it, updates arrive over server-sent events and polling.</summary>
        public bool Live { get; set; } = true;

        /// <summary>Push updates altogether (live WebSocket and SSE; default on). Without them the client only polls.</summary>
        public bool Streaming { get; set; } = true;

        /// <summary>Starts with a bundle obtained elsewhere; used until the edge delivers something newer.</summary>
        public Bundle? Bootstrap { get; set; }

        /// <summary><see cref="Bootstrap"/> as JSON text. Invalid text is reported through <see cref="NanoFlagsClient.Error"/> and ignored.</summary>
        public string? BootstrapJson { get; set; }

        /// <summary>Persists the last good configuration (see <see cref="FileStore"/>). Default: none.</summary>
        public IStore? Store { get; set; }

        /// <summary>Signature verification. Null: on (embedded keys, signatures required) for the official edge, off elsewhere.</summary>
        public VerifyOptions? Verify { get; set; }

        /// <summary>Turns signature verification off, also on the official edge.</summary>
        public bool DisableVerification { get; set; }

        /// <summary>Telemetry (default: 10 % of evaluations, attribute names and types only).</summary>
        public EventsOptions Events { get; set; } = new EventsOptions();

        /// <summary>Timeout of each HTTP request (default 10 s).</summary>
        public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromSeconds(10);

        /// <summary>Timeout of the WebSocket handshake (default 10 s).</summary>
        public TimeSpan LiveConnectTimeout { get; set; } = TimeSpan.FromSeconds(10);

        /// <summary>Logger for background activity (debug level only). Default: none.</summary>
        public ILogger? Logger { get; set; }

        internal Func<double> Random { get; set; } = DefaultRandom;

        private static readonly Random Rng = new Random();

        private static double DefaultRandom()
        {
            lock (Rng) return Rng.NextDouble();
        }

        internal NanoFlagsOptions Clone() => (NanoFlagsOptions)MemberwiseClone();
    }
}
