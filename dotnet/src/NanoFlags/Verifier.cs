using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using NanoFlags.Engine;

namespace NanoFlags
{
    /// <summary>The effective verification settings and the key cache.</summary>
    internal sealed class Verifier
    {
        private static readonly TimeSpan RefetchInterval = TimeSpan.FromMinutes(1);

        private readonly NanoFlagsClient _c;
        private readonly List<Signatures.Key> _base;
        private readonly bool _refetch;
        private readonly SemaphoreSlim _lock = new SemaphoreSlim(1, 1);
        private List<Signatures.Key> _fetched = new List<Signatures.Key>();
        private Stopwatch? _fetchedAt;

        private Verifier(NanoFlagsClient c, List<Signatures.Key> keys, bool require, bool refetch)
        {
            _c = c;
            _base = keys;
            Require = require;
            _refetch = refetch;
        }

        internal bool Require { get; }

        /// <summary>Null when verification is off.</summary>
        internal static Verifier? Create(NanoFlagsClient c, List<NanoFlagsException> errors)
        {
            var cfg = c.Cfg;
            bool official = cfg.BaseUrl == NanoFlagsOptions.OfficialEdgeUrl;
            if (cfg.DisableVerification) return null;
            var o = cfg.Verify;
            if (o == null)
            {
                if (!official) return null;
                return new Verifier(c, Signatures.ImportKeys(NanoFlagsOptions.OfficialSigningKeys), true, true);
            }
            bool require = o.Require ?? official;
            if (o.PublicKeys != null && o.PublicKeys.Count > 0)
            {
                if (o.PublicKeys.Any(k => k == null || !k.IsPublicEd25519))
                {
                    errors.Add(new NanoFlagsException(ErrorCode.Config,
                        "VerifyOptions.PublicKeys must contain public Ed25519 JWKs only; other entries (including private keys) were ignored."));
                }
                return new Verifier(c, Signatures.ImportKeys(o.PublicKeys), require, o.FetchKeys);
            }
            if (o.FetchKeys || !official) return new Verifier(c, new List<Signatures.Key>(), require, true);
            return new Verifier(c, Signatures.ImportKeys(NanoFlagsOptions.OfficialSigningKeys), require, true);
        }

        private List<Signatures.Key> All() => _base.Concat(_fetched).ToList();

        /// <summary>
        /// The keys to verify a signature by <paramref name="kid"/> with. With refetch, a key id that none of the known
        /// keys has (a rotation) loads <c>/v1/keys</c> once, again at most once a minute.
        /// </summary>
        internal async Task<IReadOnlyList<Signatures.Key>> KeysForAsync(string? kid, CancellationToken ct)
        {
            if (!_refetch) return _base;
            await _lock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var known = All();
                if (known.Count > 0 && (kid == null || known.Any(k => k.Kid == kid))) return known;
                if (_fetchedAt != null && _fetchedAt.Elapsed < RefetchInterval) return known;
                try
                {
                    _fetched = await FetchAsync(ct).ConfigureAwait(false);
                    _fetchedAt = Stopwatch.StartNew();
                    return All();
                }
                catch (NanoFlagsException)
                {
                    // Without any key the bundle cannot be checked. With the embedded keys the failed reload counts as this
                    // minute's reload, so a bad key id cannot make every poll ask for keys.
                    if (_base.Count == 0) throw;
                    _fetchedAt = Stopwatch.StartNew();
                    return known;
                }
            }
            finally
            {
                _lock.Release();
            }
        }

        private async Task<List<Signatures.Key>> FetchAsync(CancellationToken ct)
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_c.Cfg.RequestTimeout);
            // Public endpoint: the SDK key is deliberately not sent.
            using var req = new HttpRequestMessage(HttpMethod.Get, _c.Cfg.BaseUrl + "/v1/keys");
            req.Headers.TryAddWithoutValidation("User-Agent", NanoFlagsClient.UserAgent);
            try
            {
                using var res = await _c.Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
                if ((int)res.StatusCode != 200) throw new NanoFlagsException(ErrorCode.Http, $"signing keys request failed with HTTP {(int)res.StatusCode}", (int)res.StatusCode);
                var body = await NanoFlagsClient.ReadLimitedAsync(res, 1 << 20, cts.Token).ConfigureAwait(false)
                    ?? throw new NanoFlagsException(ErrorCode.Signature, "the signing keys response is too large");
                var doc = JsonValue.Parse(body);
                var jwks = doc.Field("keys") is JsonValue.Arr a ? a.Items.Select(Jwk.FromJson).ToList() : new List<Jwk?>();
                var keys = Signatures.ImportKeys(jwks);
                if (keys.Count == 0) throw new NanoFlagsException(ErrorCode.Signature, "the edge returned no usable signing keys");
                return keys;
            }
            catch (InvalidJsonException e)
            {
                throw new NanoFlagsException(ErrorCode.Signature, "invalid signing keys response: " + e.Message);
            }
            catch (Exception e) when (!(e is NanoFlagsException) && !ct.IsCancellationRequested)
            {
                throw new NanoFlagsException(ErrorCode.Network, e.Message, 0, e);
            }
        }
    }
}
