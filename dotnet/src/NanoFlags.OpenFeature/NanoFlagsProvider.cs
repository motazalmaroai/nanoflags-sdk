using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NanoFlags.Engine;
using OfConstant = global::OpenFeature.Constant;
using OfModel = global::OpenFeature.Model;

namespace NanoFlags.OpenFeature
{
    /// <summary>
    /// The OpenFeature (https://openfeature.dev) provider for NanoFlags. It evaluates locally with a
    /// <see cref="NanoFlagsClient"/> (no network call per evaluation) and turns the client's status and updates into
    /// provider events.
    /// </summary>
    /// <remarks>
    /// <code>
    /// var flags = NanoFlagsClient.Create(Environment.GetEnvironmentVariable("NANOFLAGS_SDK_KEY")!);
    /// await Api.Instance.SetProviderAsync(new NanoFlagsProvider(flags, closeClient: true));
    /// var client = Api.Instance.GetClient();
    /// bool on = await client.GetBooleanValueAsync("new-checkout", false, EvaluationContext.Builder().SetTargetingKey("user-42").Build());
    /// </code>
    /// Mapping: the targeting key becomes the NanoFlags <c>key</c> (the bucketing identity) and wins over an attribute
    /// called "key"; reason off → DISABLED, default → DEFAULT, a fixed-value rule → TARGETING_MATCH, a percentage
    /// rollout → SPLIT; the variant is the matching rule's id; flag metadata carries <c>revision</c> (and
    /// <c>ruleIndex</c>). Missing flags are FLAG_NOT_FOUND (PROVIDER_NOT_READY while nothing is loaded), served values of
    /// another type TYPE_MISMATCH. Events: PROVIDER_READY, PROVIDER_STALE, PROVIDER_ERROR and
    /// PROVIDER_CONFIGURATION_CHANGED with the keys of the flags that changed.
    /// </remarks>
    public sealed class NanoFlagsProvider : global::OpenFeature.FeatureProvider
    {
        internal const string Name = "nanoflags";

        private readonly bool _closeClient;
        private readonly TimeSpan _initTimeout;
        private readonly object _lock = new object();
        private Bundle? _last;
        private bool _subscribed;
        private int _shut;

        /// <summary>A provider for <paramref name="client"/>.</summary>
        /// <param name="client">The NanoFlags client.</param>
        /// <param name="closeClient">Close the client when the provider shuts down (default: the client is yours and stays open).</param>
        /// <param name="initTimeout">How long initialisation waits for the first configuration (default 10 s).</param>
        public NanoFlagsProvider(NanoFlagsClient client, bool closeClient = false, TimeSpan? initTimeout = null)
        {
            Client = client ?? throw new ArgumentNullException(nameof(client));
            _closeClient = closeClient;
            _initTimeout = initTimeout ?? TimeSpan.FromSeconds(10);
        }

        /// <summary>The wrapped client.</summary>
        public NanoFlagsClient Client { get; }

        /// <inheritdoc/>
        public override OfModel.Metadata GetMetadata() => new OfModel.Metadata(Name);

        /// <inheritdoc/>
        public override async Task InitializeAsync(OfModel.EvaluationContext context, CancellationToken cancellationToken = default)
        {
            lock (_lock)
            {
                _last = Client.Bundle;
                if (!_subscribed)
                {
                    _subscribed = true;
                    Client.StatusChanged += OnStatus;
                    Client.Changed += OnChanged;
                    Client.Error += OnError;
                }
            }
            if (!await Client.WaitForReadyAsync(_initTimeout, cancellationToken).ConfigureAwait(false))
            {
                var e = Client.LastError;
                throw new global::OpenFeature.Error.FeatureProviderException(OfConstant.ErrorType.ProviderNotReady,
                    e != null ? "NanoFlags could not load a configuration: " + e.Message : "NanoFlags has no configuration loaded yet.", e);
            }
        }

        /// <inheritdoc/>
        public override async Task ShutdownAsync(CancellationToken cancellationToken = default)
        {
            if (Interlocked.Exchange(ref _shut, 1) != 0) return;
            Client.StatusChanged -= OnStatus;
            Client.Changed -= OnChanged;
            Client.Error -= OnError;
            if (_closeClient) await Client.CloseAsync().ConfigureAwait(false);
        }

        private void OnStatus(object? sender, Status s)
        {
            if (s == Status.Ready) Emit(OfConstant.ProviderEventTypes.ProviderReady, "The configuration is current.", null);
            else if (s == Status.Stale) Emit(OfConstant.ProviderEventTypes.ProviderStale, "The configuration in use is not known to be current.", null);
        }

        private void OnChanged(object? sender, ChangeEvent e)
        {
            Bundle? prev, now;
            lock (_lock)
            {
                prev = _last;
                now = Client.Bundle;
                _last = now;
            }
            if (prev != null) Emit(OfConstant.ProviderEventTypes.ProviderConfigurationChanged, $"Revision {e.Revision} is now in use.", ChangedFlags(prev, now));
        }

        private void OnError(object? sender, NanoFlagsException e)
        {
            if (Client.Status == Status.NotReady) Emit(OfConstant.ProviderEventTypes.ProviderError, e.Message, null);
        }

        private void Emit(OfConstant.ProviderEventTypes type, string message, List<string>? flags)
        {
            if (Volatile.Read(ref _shut) != 0) return;
            var payload = new OfModel.ProviderEventPayload { ProviderName = Name, Type = type, Message = message, FlagsChanged = flags ?? new List<string>() };
            EventChannel.Writer.TryWrite(payload);
        }

        /// <summary>The flags whose configuration differs between two bundles.</summary>
        internal static List<string> ChangedFlags(Bundle? a, Bundle? b)
        {
            var output = new List<string>();
            if (b == null) return output;
            var fa = a?.Value.Field("flags") ?? JsonValue.Obj.Empty;
            var fb = b.Value.Field("flags");
            var keys = new List<string>();
            if (fb is JsonValue.Obj ob) keys.AddRange(ob.Keys);
            if (fa is JsonValue.Obj oa) keys.AddRange(oa.Keys.Where(k => !keys.Contains(k)));
            foreach (var k in keys)
            {
                if (fa.Field(k).ToJson() != fb.Field(k).ToJson()) output.Add(k);
            }
            return output;
        }

        /// <summary>Maps an OpenFeature context onto a NanoFlags context.</summary>
        internal static Dictionary<string, object?> ToContext(OfModel.EvaluationContext? ctx)
        {
            var output = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (ctx == null) return output;
            foreach (var kv in ctx.AsDictionary())
            {
                if (kv.Key != "targetingKey") output[kv.Key] = FromValue(kv.Value);
            }
            if (!string.IsNullOrEmpty(ctx.TargetingKey)) output["key"] = ctx.TargetingKey;
            return output;
        }

        private static object? FromValue(OfModel.Value? v)
        {
            if (v == null || v.IsNull) return null;
            if (v.IsBoolean) return v.AsBoolean;
            if (v.IsNumber) return v.AsDouble;
            if (v.IsString) return v.AsString;
            if (v.IsDateTime) return v.AsDateTime;
            if (v.IsList) return v.AsList!.Select(FromValue).ToList();
            if (v.IsStructure)
            {
                var d = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var kv in v.AsStructure!.AsDictionary()) d[kv.Key] = FromValue(kv.Value);
                return d;
            }
            return v.AsObject;
        }

        /// <summary>A JSON value as an OpenFeature value (numbers as doubles, objects as structures).</summary>
        internal static OfModel.Value ToValue(JsonValue v)
        {
            switch (v)
            {
                case JsonValue.Bool b: return new OfModel.Value(b.Value);
                case JsonValue.Num n: return new OfModel.Value(n.Value);
                case JsonValue.Str s: return new OfModel.Value(s.Value);
                case JsonValue.Arr a: return new OfModel.Value(a.Items.Select(ToValue).ToList());
                case JsonValue.Obj o:
                    var d = new Dictionary<string, OfModel.Value>(StringComparer.Ordinal);
                    foreach (var k in o.Keys)
                    {
                        var x = o.Get(k)!;
                        if (!x.IsUndefined) d[k] = ToValue(x);
                    }
                    return new OfModel.Value(new OfModel.Structure(d));
                default: return new OfModel.Value();
            }
        }

        private static OfModel.ImmutableMetadata Meta(long revision, int ruleIndex)
        {
            var d = new Dictionary<string, object> { ["revision"] = revision <= int.MaxValue ? (object)(int)revision : (double)revision };
            if (ruleIndex >= 0) d["ruleIndex"] = ruleIndex;
            return new OfModel.ImmutableMetadata(d);
        }

        private OfModel.ResolutionDetails<T> Resolve<T>(string flag, T def, OfModel.EvaluationContext? ctx, string kind, Func<JsonValue, bool> accepts, Func<JsonValue, T> convert)
        {
            var d = Client.Evaluate(flag, ToContext(ctx));
            OfModel.ResolutionDetails<T> Fail(OfConstant.ErrorType type, string? message) =>
                new OfModel.ResolutionDetails<T>(flag, def, type, OfConstant.Reason.Error, null, message, Meta(d.Revision, -1));
            switch (d.Reason)
            {
                case Reason.FlagNotFound:
                    if (Client.Bundle == null) return Fail(OfConstant.ErrorType.ProviderNotReady, "NanoFlags has no configuration loaded yet.");
                    return Fail(OfConstant.ErrorType.FlagNotFound, $"Flag \"{flag}\" is not in the loaded configuration (r{d.Revision}).");
                case Reason.Error:
                    return Fail(OfConstant.ErrorType.General, d.Error);
            }
            if (!accepts(d.RawValue)) return Fail(OfConstant.ErrorType.TypeMismatch, $"Flag \"{flag}\" has a {d.TypeName} value; a {kind} was requested.");
            string reason = d.Reason == Reason.Off ? OfConstant.Reason.Disabled
                : d.Reason == Reason.Default ? OfConstant.Reason.Default
                : d.InRollout != null ? OfConstant.Reason.Split : OfConstant.Reason.TargetingMatch;
            return new OfModel.ResolutionDetails<T>(flag, convert(d.RawValue), OfConstant.ErrorType.None, reason, d.RuleId, null, Meta(d.Revision, d.RuleIndex));
        }

        private static bool Finite(JsonValue v) => v is JsonValue.Num n && !double.IsNaN(n.Value) && !double.IsInfinity(n.Value);

        /// <inheritdoc/>
        public override Task<OfModel.ResolutionDetails<bool>> ResolveBooleanValueAsync(string flagKey, bool defaultValue, OfModel.EvaluationContext? context = null, CancellationToken cancellationToken = default) =>
            Task.FromResult(Resolve(flagKey, defaultValue, context, "boolean", v => v is JsonValue.Bool, v => ((JsonValue.Bool)v).Value));

        /// <inheritdoc/>
        public override Task<OfModel.ResolutionDetails<string>> ResolveStringValueAsync(string flagKey, string defaultValue, OfModel.EvaluationContext? context = null, CancellationToken cancellationToken = default) =>
            Task.FromResult(Resolve(flagKey, defaultValue, context, "string", v => v is JsonValue.Str, v => ((JsonValue.Str)v).Value));

        /// <inheritdoc/>
        public override Task<OfModel.ResolutionDetails<int>> ResolveIntegerValueAsync(string flagKey, int defaultValue, OfModel.EvaluationContext? context = null, CancellationToken cancellationToken = default) =>
            Task.FromResult(Resolve(flagKey, defaultValue, context, "integer",
                v => Finite(v) && v is JsonValue.Num n && n.Value == Math.Floor(n.Value) && n.Value >= int.MinValue && n.Value <= int.MaxValue, v => (int)((JsonValue.Num)v).Value));

        /// <inheritdoc/>
        public override Task<OfModel.ResolutionDetails<double>> ResolveDoubleValueAsync(string flagKey, double defaultValue, OfModel.EvaluationContext? context = null, CancellationToken cancellationToken = default) =>
            Task.FromResult(Resolve(flagKey, defaultValue, context, "number", Finite, v => ((JsonValue.Num)v).Value));

        /// <inheritdoc/>
        public override Task<OfModel.ResolutionDetails<OfModel.Value>> ResolveStructureValueAsync(string flagKey, OfModel.Value defaultValue, OfModel.EvaluationContext? context = null, CancellationToken cancellationToken = default) =>
            Task.FromResult(Resolve(flagKey, defaultValue, context, "object", v => !v.IsUndefined, ToValue));
    }
}
