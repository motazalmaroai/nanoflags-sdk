using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using NanoFlags.Engine;

namespace NanoFlags
{
    /// <summary>The state of the configuration in use.</summary>
    public enum Status
    {
        /// <summary>No configuration is loaded; every evaluation returns its fallback.</summary>
        NotReady,
        /// <summary>The configuration is known to be current.</summary>
        Ready,
        /// <summary>A configuration is in use but is not known to be current (edge unreachable, restored from the store, environment deleted, …).</summary>
        Stale,
    }

    /// <summary>How updates reach the client.</summary>
    public enum Transport
    {
        /// <summary>Pushed over the <c>/v1/live</c> WebSocket.</summary>
        Live,
        /// <summary>Announced over server-sent events (<c>/v1/stream</c>), then fetched.</summary>
        Stream,
        /// <summary>Polled (<c>/v1/bundle</c> with ETag).</summary>
        Poll,
    }

    /// <summary>Where an adopted configuration came from.</summary>
    public enum Source
    {
        /// <summary>The edge.</summary>
        Network,
        /// <summary>The persisted copy (<see cref="IStore"/>).</summary>
        Store,
        /// <summary>The bootstrap bundle of the options.</summary>
        Bootstrap,
    }

    /// <summary>Classifies the errors the client reports.</summary>
    public enum ErrorCode
    {
        /// <summary>The edge could not be reached ("network").</summary>
        Network,
        /// <summary>The SDK key was rejected ("unauthorized").</summary>
        Unauthorized,
        /// <summary>Another HTTP failure ("http").</summary>
        Http,
        /// <summary>The edge returned something that is not a bundle ("invalid_bundle").</summary>
        InvalidBundle,
        /// <summary>The store failed ("store").</summary>
        Store,
        /// <summary>Invalid configuration of the client ("config").</summary>
        Config,
        /// <summary>A bundle failed signature verification ("signature").</summary>
        Signature,
        /// <summary>A bundle needs a newer engine ("engine").</summary>
        Engine,
        /// <summary>The environment of the SDK key was deleted ("environment_deleted").</summary>
        EnvironmentDeleted,
        /// <summary>A test-session lookup failed; the session evaluator falls back to normal evaluation ("session").</summary>
        Session,
        /// <summary>A bundle was refused because its revision is older than one this client already verified ("rollback").</summary>
        Rollback,
    }

    /// <summary>Wire spellings.</summary>
    public static class Wire
    {
        /// <summary>The code as the other NanoFlags SDKs spell it ("invalid_bundle", …).</summary>
        public static string ToWire(this ErrorCode c)
        {
            switch (c)
            {
                case ErrorCode.Network: return "network";
                case ErrorCode.Unauthorized: return "unauthorized";
                case ErrorCode.Http: return "http";
                case ErrorCode.InvalidBundle: return "invalid_bundle";
                case ErrorCode.Store: return "store";
                case ErrorCode.Config: return "config";
                case ErrorCode.Signature: return "signature";
                case ErrorCode.Engine: return "engine";
                case ErrorCode.Session: return "session";
                case ErrorCode.Rollback: return "rollback";
                default: return "environment_deleted";
            }
        }

        /// <summary>"not-ready", "ready" or "stale".</summary>
        public static string ToWire(this Status s) => s == Status.Ready ? "ready" : s == Status.Stale ? "stale" : "not-ready";

        /// <summary>"live", "stream" or "poll".</summary>
        public static string ToWire(this Transport t) => t == Transport.Live ? "live" : t == Transport.Stream ? "stream" : "poll";
    }

    /// <summary>A client error. A failed update never changes the configuration in use.</summary>
    public class NanoFlagsException : Exception
    {
        /// <summary>Creates the exception.</summary>
        public NanoFlagsException(ErrorCode code, string message, int httpStatus = 0, Exception? inner = null) : base(message, inner)
        {
            Code = code;
            HttpStatus = httpStatus;
        }

        /// <summary>The kind of error.</summary>
        public ErrorCode Code { get; }

        /// <summary>The HTTP status for <see cref="ErrorCode.Unauthorized"/> and <see cref="ErrorCode.Http"/>, otherwise 0.</summary>
        public int HttpStatus { get; }

        /// <summary>An answer the edge marked unsigned while signatures are required (publisher lag): the status stays.</summary>
        internal bool IsUnsignedAnswer { get; set; }

        /// <inheritdoc/>
        public override string ToString() => $"NanoFlagsException({Code.ToWire()}): {Message}";
    }

    /// <summary>Describes a newly adopted configuration.</summary>
    public sealed class ChangeEvent : EventArgs
    {
        internal ChangeEvent(long revision, long previousRevision, string checksum, Source source, Transport transport, TimeSpan? latency)
        {
            Revision = revision;
            PreviousRevision = previousRevision;
            Checksum = checksum;
            Source = source;
            Transport = transport;
            Latency = latency;
        }

        /// <summary>The new revision.</summary>
        public long Revision { get; }

        /// <summary>-1 when no configuration was loaded before.</summary>
        public long PreviousRevision { get; }

        /// <summary>The bundle checksum ("" when unknown, e.g. a bootstrap bundle).</summary>
        public string Checksum { get; }

        /// <summary>Where it came from.</summary>
        public Source Source { get; }

        /// <summary>How it arrived.</summary>
        public Transport Transport { get; }

        /// <summary>
        /// For revisions pushed over the live socket that carry their commit time: the time from the commit in the
        /// database to this event (it compares the database's clock with this machine's).
        /// </summary>
        public TimeSpan? Latency { get; }

        /// <inheritdoc/>
        public override string ToString() => $"ChangeEvent(r{Revision}, was {PreviousRevision}, {Source}/{Transport})";
    }

    /// <summary>The full result of an evaluation: the value plus why it was served.</summary>
    public sealed class EvaluationDetail<T>
    {
        internal EvaluationDetail(string flagKey, T value, Reason reason, int ruleIndex, string? ruleId, bool? inRollout, double? bucket, long revision,
            IReadOnlyList<TraceStep> trace, string? error, JsonValue raw)
        {
            FlagKey = flagKey;
            Value = value;
            Reason = reason;
            RuleIndex = ruleIndex;
            RuleId = ruleId;
            InRollout = inRollout;
            Bucket = bucket;
            Revision = revision;
            Trace = trace;
            Error = error;
            RawValue = raw;
        }

        /// <summary>The flag key.</summary>
        public string FlagKey { get; }

        /// <summary>The value (the fallback for reasons flag_not_found and error).</summary>
        public T Value { get; }

        /// <summary>Why.</summary>
        public Reason Reason { get; }

        /// <summary>Zero-based index of the matching rule, or -1.</summary>
        public int RuleIndex { get; }

        /// <summary>The matching rule's id, or null.</summary>
        public string? RuleId { get; }

        /// <summary>For percentage rollouts: whether the context is inside the allocation.</summary>
        public bool? InRollout { get; }

        /// <summary>For percentage rollouts: the context's bucket (0–99.99).</summary>
        public double? Bucket { get; }

        /// <summary>The revision of the configuration that was evaluated (0 without one).</summary>
        public long Revision { get; }

        /// <summary>The decision step by step, exactly as the dashboard shows it.</summary>
        public IReadOnlyList<TraceStep> Trace { get; }

        /// <summary>Explains reason error (evaluation error or type mismatch).</summary>
        public string? Error { get; }

        /// <summary>The value the engine produced (the fallback for flag_not_found / error), with JavaScript types.</summary>
        public JsonValue RawValue { get; }

        /// <summary>Whether the configuration served no value at all (a malformed flag).</summary>
        public bool ValueIsUndefined => RawValue.IsUndefined;

        /// <summary>"boolean", "string", "number", "array", "object", "null" or "undefined".</summary>
        public string TypeName => RawValue.TypeName;

        /// <inheritdoc/>
        public override string ToString() => $"EvaluationDetail({FlagKey}={Value}, {Reason.Wire()}, rule={RuleId}, r{Revision}{(Error == null ? "" : ", " + Error)})";
    }

    /// <summary>A public Ed25519 key as published by <c>GET /v1/keys</c> (JWK, kty OKP, crv Ed25519).</summary>
    public sealed class Jwk
    {
        /// <summary>Creates a JWK.</summary>
        public Jwk(string kty, string crv, string x, string? kid = null) : this(kty, crv, x, kid, null) { }

        private Jwk(string? kty, string? crv, string? x, string? kid, string? d)
        {
            Kty = kty ?? "";
            Crv = crv ?? "";
            X = x ?? "";
            Kid = string.IsNullOrEmpty(kid) ? null : kid;
            D = d;
        }

        /// <summary>A public Ed25519 key from its base64url-encoded 32 bytes.</summary>
        public static Jwk Ed25519(string x, string? kid = null) => new Jwk("OKP", "Ed25519", x, kid);

        /// <summary>Reads a JWK object; null when it is not an object.</summary>
        public static Jwk? FromJson(JsonValue v)
        {
            if (!(v is JsonValue.Obj)) return null;
            string? S(string k) => (v.Field(k) as JsonValue.Str)?.Value;
            return new Jwk(S("kty"), S("crv"), S("x"), S("kid"), S("d"));
        }

        /// <summary>Key type.</summary>
        public string Kty { get; }

        /// <summary>Curve.</summary>
        public string Crv { get; }

        /// <summary>The public key, base64url.</summary>
        public string X { get; }

        /// <summary>The key id, or null.</summary>
        public string? Kid { get; }

        private string? D { get; }

        /// <summary>Whether this is a public Ed25519 key (a JWK that carries the private member <c>d</c> is refused).</summary>
        public bool IsPublicEd25519 => Kty == "OKP" && Crv == "Ed25519" && X.Length > 0 && D == null;
    }

    /// <summary>Bundle signature verification settings.</summary>
    public sealed class VerifyOptions
    {
        /// <summary>
        /// Keys to verify with. Empty: the embedded production keys on the official edge, otherwise the keys of
        /// <c>GET /v1/keys</c> on the configured edge. Pinning keys is stronger than fetching them.
        /// </summary>
        public IList<Jwk> PublicKeys { get; set; } = new List<Jwk>();

        /// <summary>Also load keys from <c>GET /v1/keys</c> (once, then at most once a minute when a bundle names an unknown key id).</summary>
        public bool FetchKeys { get; set; }

        /// <summary>Refuse bundles that carry no signature. Null: true on the official edge, false elsewhere.</summary>
        public bool? Require { get; set; }
    }

    /// <summary>Sampled evaluation telemetry and the periodic service report.</summary>
    public sealed class EventsOptions
    {
        /// <summary>Telemetry on (default). Off: no events and no service report.</summary>
        public bool Enabled { get; set; } = true;

        /// <summary>Fraction of evaluations reported, 0–1 (default 0.1).</summary>
        public double SampleRate { get; set; } = 0.1;

        /// <summary>How often queued events are sent (default 10 s).</summary>
        public TimeSpan FlushInterval { get; set; } = TimeSpan.FromSeconds(10);

        /// <summary>How often the service report goes out while no events are queued (default 60 s).</summary>
        public TimeSpan ReportInterval { get; set; } = TimeSpan.FromSeconds(60);

        /// <summary>
        /// Decides what part of the context leaves the process. Default (null): no values, only the names of the
        /// attributes the flag's rules use, mapped to the value's type (e.g. <c>{"region": "string"}</c>).
        /// </summary>
        public Func<IReadOnlyDictionary<string, object?>, IReadOnlyDictionary<string, object?>?>? Redact { get; set; }

        /// <summary>Telemetry off.</summary>
        public static EventsOptions Disabled => new EventsOptions { Enabled = false };
    }

    /// <summary>Persists the last good configuration so that a restarting process can evaluate before (or without) reaching the edge.</summary>
    /// <remarks>The client stores an opaque UTF-8 JSON document. A persisted bundle is verified again when it is loaded.</remarks>
    public interface IStore
    {
        /// <summary>The stored document, or null when nothing is stored.</summary>
        Task<byte[]?> LoadAsync(CancellationToken cancellationToken);

        /// <summary>Stores the document.</summary>
        Task SaveAsync(byte[] data, CancellationToken cancellationToken);
    }

    /// <summary>Keeps the last good configuration in a file (written atomically; owner read/write only on Unix).</summary>
    public sealed class FileStore : IStore
    {
        /// <summary>Creates the store.</summary>
        public FileStore(string path) => Path = System.IO.Path.GetFullPath(path);

        /// <summary>The file.</summary>
        public string Path { get; }

        /// <inheritdoc/>
        public Task<byte[]?> LoadAsync(CancellationToken cancellationToken)
        {
            try
            {
                return Task.FromResult<byte[]?>(File.ReadAllBytes(Path));
            }
            catch (FileNotFoundException)
            {
                return Task.FromResult<byte[]?>(null);
            }
            catch (DirectoryNotFoundException)
            {
                return Task.FromResult<byte[]?>(null);
            }
        }

        /// <inheritdoc/>
        public Task SaveAsync(byte[] data, CancellationToken cancellationToken)
        {
            var dir = System.IO.Path.GetDirectoryName(Path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var tmp = System.IO.Path.Combine(dir ?? ".", ".nanoflags-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (var f = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write))
                {
                    f.Write(data, 0, data.Length);
                }
#if NET8_0_OR_GREATER
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                File.Move(tmp, Path, true);
#else
                if (File.Exists(Path)) File.Replace(tmp, Path, null);
                else File.Move(tmp, Path);
#endif
            }
            finally
            {
                if (File.Exists(tmp)) File.Delete(tmp);
            }
            return Task.CompletedTask;
        }
    }
}
