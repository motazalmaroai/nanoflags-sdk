using System;
using System.Collections.Generic;
using NanoFlags.Engine;

namespace NanoFlags
{
    /// <summary>
    /// Evaluates flags for one test session. While <see cref="IsActive"/>, flags are evaluated against the session's pinned
    /// bundle with the session's context overlaid by the call's context (the call's attributes win), and sampled events
    /// carry the session id. When the session is unknown, not permitted for this service, or expired, it evaluates exactly
    /// like the client (<see cref="IsActive"/> is false). Like the client it never performs I/O and never throws.
    /// Obtain one with <see cref="NanoFlagsClient.SessionAsync"/> or <see cref="NanoFlagsSession.FlagsForAsync"/>.
    /// </summary>
    public sealed class SessionEvaluator
    {
        private readonly NanoFlagsClient _client;
        private readonly Sessions.State? _state;

        internal SessionEvaluator(NanoFlagsClient client, Sessions.State? state)
        {
            _client = client;
            _state = state;
        }

        private Sessions.State? Scope => _state != null && _state.Live ? _state : null;

        /// <summary>True while the session is known and has not expired. Re-evaluated on every read.</summary>
        public bool IsActive => Scope != null;

        /// <summary>The session id, or null when the session could not be resolved.</summary>
        public string? Id => _state?.Id;

        /// <summary>When the session expires, or null when it could not be resolved.</summary>
        public DateTimeOffset? ExpiresAt => _state?.ExpiresAt;

        /// <summary>The revision evaluations currently run against: the pinned one while active, otherwise the client's (-1 when none is loaded).</summary>
        public long Revision => Scope?.Snap.Bundle.Revision ?? _client.Revision;

        /// <summary>The client this evaluator belongs to.</summary>
        public NanoFlagsClient Client => _client;

        /// <summary><see cref="NanoFlagsClient.BoolVariation"/> within the session.</summary>
        public bool BoolVariation(string key, IReadOnlyDictionary<string, object?>? context, bool fallback) => BoolVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="NanoFlagsClient.BoolVariationDetail(string, IReadOnlyDictionary{string, object?}?, bool)"/> within the session.</summary>
        public EvaluationDetail<bool> BoolVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, bool fallback) => _client.BoolVariationDetail(Scope, key, context, fallback);

        /// <summary><see cref="NanoFlagsClient.StringVariation"/> within the session.</summary>
        public string StringVariation(string key, IReadOnlyDictionary<string, object?>? context, string fallback) => StringVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="NanoFlagsClient.StringVariationDetail(string, IReadOnlyDictionary{string, object?}?, string)"/> within the session.</summary>
        public EvaluationDetail<string> StringVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, string fallback) => _client.StringVariationDetail(Scope, key, context, fallback);

        /// <summary><see cref="NanoFlagsClient.DoubleVariation"/> within the session.</summary>
        public double DoubleVariation(string key, IReadOnlyDictionary<string, object?>? context, double fallback) => DoubleVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="NanoFlagsClient.DoubleVariationDetail(string, IReadOnlyDictionary{string, object?}?, double)"/> within the session.</summary>
        public EvaluationDetail<double> DoubleVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, double fallback) => _client.DoubleVariationDetail(Scope, key, context, fallback);

        /// <summary><see cref="NanoFlagsClient.IntVariation"/> within the session.</summary>
        public int IntVariation(string key, IReadOnlyDictionary<string, object?>? context, int fallback) => IntVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="NanoFlagsClient.IntVariationDetail(string, IReadOnlyDictionary{string, object?}?, int)"/> within the session.</summary>
        public EvaluationDetail<int> IntVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, int fallback) => _client.IntVariationDetail(Scope, key, context, fallback);

        /// <summary><see cref="NanoFlagsClient.LongVariation"/> within the session.</summary>
        public long LongVariation(string key, IReadOnlyDictionary<string, object?>? context, long fallback) => LongVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="NanoFlagsClient.LongVariationDetail(string, IReadOnlyDictionary{string, object?}?, long)"/> within the session.</summary>
        public EvaluationDetail<long> LongVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, long fallback) => _client.LongVariationDetail(Scope, key, context, fallback);

        /// <summary><see cref="NanoFlagsClient.JsonVariation"/> within the session.</summary>
        public object? JsonVariation(string key, IReadOnlyDictionary<string, object?>? context, object? fallback) => JsonVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="NanoFlagsClient.JsonVariationDetail(string, IReadOnlyDictionary{string, object?}?, object?)"/> within the session.</summary>
        public EvaluationDetail<object?> JsonVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, object? fallback) => _client.JsonVariationDetail(Scope, key, context, fallback);

        /// <summary><see cref="NanoFlagsClient.JsonValueVariation"/> within the session.</summary>
        public JsonValue JsonValueVariation(string key, IReadOnlyDictionary<string, object?>? context, JsonValue? fallback) => JsonValueVariationDetail(key, context, fallback).Value;

        /// <summary><see cref="NanoFlagsClient.JsonValueVariationDetail(string, IReadOnlyDictionary{string, object?}?, JsonValue?)"/> within the session.</summary>
        public EvaluationDetail<JsonValue> JsonValueVariationDetail(string key, IReadOnlyDictionary<string, object?>? context, JsonValue? fallback) => _client.JsonValueVariationDetail(Scope, key, context, fallback);

        /// <summary><see cref="NanoFlagsClient.Evaluate(string, IReadOnlyDictionary{string, object?}?, object?)"/> within the session.</summary>
        public EvaluationDetail<object?> Evaluate(string key, IReadOnlyDictionary<string, object?>? context, object? fallback = null) => _client.Evaluate(Scope, key, context, fallback);

        /// <inheritdoc/>
        public override string ToString() => $"SessionEvaluator({(_state == null ? "none" : _state.Id)}, active={IsActive})";
    }
}
