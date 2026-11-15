package io.nanoflags.server.openfeature;

import dev.openfeature.sdk.ErrorCode;
import dev.openfeature.sdk.EvaluationContext;
import dev.openfeature.sdk.EventProvider;
import dev.openfeature.sdk.ImmutableMetadata;
import dev.openfeature.sdk.ImmutableStructure;
import dev.openfeature.sdk.Metadata;
import dev.openfeature.sdk.ProviderEvaluation;
import dev.openfeature.sdk.ProviderEventDetails;
import dev.openfeature.sdk.Reason;
import dev.openfeature.sdk.Value;
import dev.openfeature.sdk.exceptions.ProviderNotReadyError;
import io.nanoflags.server.EvaluationDetail;
import io.nanoflags.server.NanoFlagsClient;
import io.nanoflags.server.NanoFlagsException;
import io.nanoflags.server.Status;
import io.nanoflags.server.Subscription;
import io.nanoflags.server.engine.Bundle;
import io.nanoflags.server.engine.JsonValue;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * The <a href="https://openfeature.dev">OpenFeature</a> provider for NanoFlags. It evaluates locally with a
 * {@link NanoFlagsClient} (no network call per evaluation) and turns the client's status and updates into provider
 * events.
 *
 * <pre>{@code
 * NanoFlagsClient flags = NanoFlagsClient.create(System.getenv("NANOFLAGS_SDK_KEY"));
 * OpenFeatureAPI.getInstance().setProviderAndWait(NanoFlagsProvider.builder(flags).closeClient(true).build());
 * Client of = OpenFeatureAPI.getInstance().getClient();
 * boolean on = of.getBooleanValue("new-checkout", false, new ImmutableContext("user-42"));
 * }</pre>
 *
 * <p>Mapping: the targeting key becomes the NanoFlags {@code key} (the bucketing identity) and wins over an attribute
 * called "key"; reason off → DISABLED, default → DEFAULT, a fixed-value rule → TARGETING_MATCH, a percentage
 * rollout → SPLIT; the variant is the matching rule's id; flag metadata carries {@code revision} (and
 * {@code ruleIndex}). Missing flags are FLAG_NOT_FOUND (PROVIDER_NOT_READY while nothing is loaded), served values of
 * another type TYPE_MISMATCH. Events: PROVIDER_READY, PROVIDER_STALE, PROVIDER_ERROR and
 * PROVIDER_CONFIGURATION_CHANGED with the keys of the flags that changed.
 */
public final class NanoFlagsProvider extends EventProvider {
    static final String NAME = "nanoflags";

    private final NanoFlagsClient client;
    private final boolean closeClient;
    private final Duration initTimeout;
    private final Object lock = new Object();
    private final List<Subscription> subscriptions = new ArrayList<>();
    private Bundle last;
    private volatile boolean shut;

    private NanoFlagsProvider(Builder b) {
        this.client = b.client;
        this.closeClient = b.closeClient;
        this.initTimeout = b.initTimeout;
    }

    /** A provider for {@code client} with the defaults (the client stays open on shutdown; 10 s init timeout). */
    public NanoFlagsProvider(NanoFlagsClient client) { this(builder(client)); }

    public static Builder builder(NanoFlagsClient client) { return new Builder(client); }

    public static final class Builder {
        private final NanoFlagsClient client;
        private boolean closeClient;
        private Duration initTimeout = Duration.ofSeconds(10);

        private Builder(NanoFlagsClient client) { this.client = Objects.requireNonNull(client, "client"); }

        /** Close the NanoFlags client when the provider shuts down (default: the client is yours and stays open). */
        public Builder closeClient(boolean close) {
            this.closeClient = close;
            return this;
        }

        /** How long {@code initialize} waits for the first configuration (default 10 s). */
        public Builder initTimeout(Duration timeout) {
            this.initTimeout = Objects.requireNonNull(timeout, "timeout");
            return this;
        }

        public NanoFlagsProvider build() { return new NanoFlagsProvider(this); }
    }

    /** The wrapped client. */
    public NanoFlagsClient client() { return client; }

    @Override
    public Metadata getMetadata() { return () -> NAME; }

    @Override
    public void initialize(EvaluationContext evaluationContext) throws Exception {
        synchronized (lock) {
            last = client.bundle();
            subscriptions.add(client.onStatus(s -> {
                if (s == Status.READY) emit(EventKind.READY, "The configuration is current.", null);
                else if (s == Status.STALE) emit(EventKind.STALE, "The configuration in use is not known to be current.", null);
            }));
            subscriptions.add(client.onChange(e -> {
                Bundle prev;
                Bundle now;
                synchronized (lock) {
                    prev = last;
                    now = client.bundle();
                    last = now;
                }
                if (prev != null) emit(EventKind.CHANGED, "Revision " + e.revision() + " is now in use.", changedFlags(prev, now));
            }));
            subscriptions.add(client.onError(err -> {
                if (client.status() == Status.NOT_READY) emit(EventKind.ERROR, err.getMessage(), null);
            }));
        }
        if (!client.waitForReady(initTimeout)) {
            NanoFlagsException e = client.lastError();
            throw new ProviderNotReadyError(e != null ? "NanoFlags could not load a configuration: " + e.getMessage() : "NanoFlags has no configuration loaded yet.");
        }
    }

    @Override
    public void shutdown() {
        if (shut) return;
        shut = true;
        synchronized (lock) {
            for (Subscription s : subscriptions) s.close();
            subscriptions.clear();
        }
        if (closeClient) client.close();
        super.shutdown();
    }

    private enum EventKind { READY, STALE, ERROR, CHANGED }

    private void emit(EventKind kind, String message, List<String> flags) {
        if (shut) return;
        ProviderEventDetails.ProviderEventDetailsBuilder<?, ?> b = ProviderEventDetails.builder().message(message);
        if (flags != null) b.flagsChanged(flags);
        ProviderEventDetails d = b.build();
        try {
            switch (kind) {
                case READY: emitProviderReady(d); break;
                case STALE: emitProviderStale(d); break;
                case ERROR: emitProviderError(d); break;
                default: emitProviderConfigurationChanged(d); break;
            }
        } catch (RuntimeException ignored) {
            // not attached to an API yet
        }
    }

    /** The flags whose configuration differs between two bundles. */
    static List<String> changedFlags(Bundle a, Bundle b) {
        List<String> out = new ArrayList<>();
        if (b == null) return out;
        JsonValue fa = a == null ? JsonValue.Obj.EMPTY : a.value().field("flags");
        JsonValue fb = b.value().field("flags");
        Set<String> keys = new LinkedHashSet<>();
        if (fb instanceof JsonValue.Obj) keys.addAll(((JsonValue.Obj) fb).keys());
        if (fa instanceof JsonValue.Obj) keys.addAll(((JsonValue.Obj) fa).keys());
        for (String k : keys) {
            if (!Objects.equals(fa.field(k).toJson(), fb.field(k).toJson())) out.add(k);
        }
        return out;
    }

    /** Maps an OpenFeature context onto a NanoFlags context. */
    static Map<String, Object> toContext(EvaluationContext ctx) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (ctx == null) return out;
        for (Map.Entry<String, Object> e : ctx.asObjectMap().entrySet()) {
            if (!EvaluationContext.TARGETING_KEY.equals(e.getKey())) out.put(e.getKey(), e.getValue());
        }
        String tk = ctx.getTargetingKey();
        if (tk != null && !tk.isEmpty()) out.put("key", tk);
        return out;
    }

    private <T> ProviderEvaluation<T> resolve(String flag, T def, EvaluationContext ctx, String kind, Predicate<JsonValue> accepts, Function<JsonValue, T> convert) {
        EvaluationDetail<Object> d = client.evaluate(flag, toContext(ctx), null);
        ImmutableMetadata.ImmutableMetadataBuilder meta = ImmutableMetadata.builder().addLong("revision", d.revision());
        switch (d.reason()) {
            case FLAG_NOT_FOUND:
                if (client.bundle() == null) return fail(def, ErrorCode.PROVIDER_NOT_READY, "NanoFlags has no configuration loaded yet.", meta);
                return fail(def, ErrorCode.FLAG_NOT_FOUND, "Flag \"" + flag + "\" is not in the loaded configuration (r" + d.revision() + ").", meta);
            case ERROR:
                return fail(def, ErrorCode.GENERAL, d.error(), meta);
            default:
                break;
        }
        JsonValue raw = d.rawValue();
        if (!accepts.test(raw)) {
            return fail(def, ErrorCode.TYPE_MISMATCH, "Flag \"" + flag + "\" has a " + raw.typeName() + " value; a " + kind + " was requested.", meta);
        }
        Reason reason;
        switch (d.reason()) {
            case OFF: reason = Reason.DISABLED; break;
            case DEFAULT: reason = Reason.DEFAULT; break;
            default: reason = d.inRollout() != null ? Reason.SPLIT : Reason.TARGETING_MATCH; break;
        }
        if (d.ruleIndex() >= 0) meta.addInteger("ruleIndex", d.ruleIndex());
        return ProviderEvaluation.<T>builder().value(convert.apply(raw)).variant(d.ruleId()).reason(reason.toString()).flagMetadata(meta.build()).build();
    }

    private static <T> ProviderEvaluation<T> fail(T def, ErrorCode code, String message, ImmutableMetadata.ImmutableMetadataBuilder meta) {
        return ProviderEvaluation.<T>builder().value(def).reason(Reason.ERROR.toString()).errorCode(code).errorMessage(message).flagMetadata(meta.build()).build();
    }

    private static boolean finite(JsonValue v) {
        return v instanceof JsonValue.Num && !Double.isNaN(((JsonValue.Num) v).value()) && !Double.isInfinite(((JsonValue.Num) v).value());
    }

    private static double num(JsonValue v) { return ((JsonValue.Num) v).value(); }

    @Override
    public ProviderEvaluation<Boolean> getBooleanEvaluation(String key, Boolean defaultValue, EvaluationContext ctx) {
        return resolve(key, defaultValue, ctx, "boolean", v -> v instanceof JsonValue.Bool, v -> ((JsonValue.Bool) v).value());
    }

    @Override
    public ProviderEvaluation<String> getStringEvaluation(String key, String defaultValue, EvaluationContext ctx) {
        return resolve(key, defaultValue, ctx, "string", v -> v instanceof JsonValue.Str, v -> ((JsonValue.Str) v).value());
    }

    @Override
    public ProviderEvaluation<Integer> getIntegerEvaluation(String key, Integer defaultValue, EvaluationContext ctx) {
        return resolve(key, defaultValue, ctx, "integer",
            v -> finite(v) && num(v) == Math.floor(num(v)) && num(v) >= Integer.MIN_VALUE && num(v) <= Integer.MAX_VALUE, v -> (int) num(v));
    }

    @Override
    public ProviderEvaluation<Long> getLongEvaluation(String key, Long defaultValue, EvaluationContext ctx) {
        return resolve(key, defaultValue, ctx, "integer", v -> finite(v) && num(v) == Math.floor(num(v)) && Math.abs(num(v)) <= 9.007199254740992E15, v -> (long) num(v));
    }

    @Override
    public ProviderEvaluation<Double> getDoubleEvaluation(String key, Double defaultValue, EvaluationContext ctx) {
        return resolve(key, defaultValue, ctx, "number", NanoFlagsProvider::finite, NanoFlagsProvider::num);
    }

    @Override
    public ProviderEvaluation<Value> getObjectEvaluation(String key, Value defaultValue, EvaluationContext ctx) {
        return resolve(key, defaultValue, ctx, "object", v -> !v.isUndefined(), NanoFlagsProvider::toValue);
    }

    /** A JSON value as an OpenFeature {@link Value} (numbers as doubles, objects as structures in configuration order). */
    static Value toValue(JsonValue v) {
        if (v instanceof JsonValue.Bool) return new Value(((JsonValue.Bool) v).value());
        if (v instanceof JsonValue.Num) return new Value(((JsonValue.Num) v).value());
        if (v instanceof JsonValue.Str) return new Value(((JsonValue.Str) v).value());
        if (v instanceof JsonValue.Arr) {
            List<Value> out = new ArrayList<>();
            for (JsonValue x : ((JsonValue.Arr) v).items()) out.add(toValue(x));
            return new Value(out);
        }
        if (v instanceof JsonValue.Obj) {
            JsonValue.Obj o = (JsonValue.Obj) v;
            Map<String, Value> m = new LinkedHashMap<>();
            for (String k : o.keys()) {
                JsonValue x = o.get(k);
                if (!x.isUndefined()) m.put(k, toValue(x));
            }
            return new Value(new ImmutableStructure(m));
        }
        return new Value();
    }
}
