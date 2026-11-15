package io.nanoflags.server;

import io.nanoflags.server.engine.Bundle;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.DoubleSupplier;
import java.util.function.Function;

/** Configuration of a {@link NanoFlagsClient}. Immutable; create one with {@link #builder()}. */
public final class NanoFlagsOptions {
    /** The hosted NanoFlags edge. With this base URL (the default) every bundle is verified and unsigned bundles are refused. */
    public static final String OFFICIAL_EDGE_URL = "https://edge.nanoflags.io";

    /**
     * The public halves of the production bundle-signing keys (safe to embed; the same list as every NanoFlags SDK).
     * A bundle signed with a key id that is not listed here (a rotation after this release) makes the client load
     * {@code GET /v1/keys} once, at most once a minute.
     */
    public static final List<Jwk> OFFICIAL_SIGNING_KEYS = Collections.singletonList(Jwk.ed25519("wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", "k1"));

    final String baseUrl;
    final String service;
    final HttpClient httpClient;
    final Duration pollInterval;
    final Duration livePollInterval;
    final boolean live;
    final boolean streaming;
    final Bundle bootstrap;
    final String bootstrapJson;
    final Store store;
    final VerifyOptions verify;
    final boolean verifySet;
    final EventsOptions events;
    final Duration requestTimeout;
    final Duration liveConnectTimeout;
    final System.Logger logger;
    final DoubleSupplier random;

    private NanoFlagsOptions(Builder b) {
        this.baseUrl = b.baseUrl;
        this.service = b.service;
        this.httpClient = b.httpClient;
        this.pollInterval = b.pollInterval;
        this.livePollInterval = b.livePollInterval;
        this.live = b.live;
        this.streaming = b.streaming;
        this.bootstrap = b.bootstrap;
        this.bootstrapJson = b.bootstrapJson;
        this.store = b.store;
        this.verify = b.verify;
        this.verifySet = b.verifySet;
        this.events = b.events;
        this.requestTimeout = b.requestTimeout;
        this.liveConnectTimeout = b.liveConnectTimeout;
        this.logger = b.logger;
        this.random = b.random;
    }

    public static Builder builder() { return new Builder(); }

    /** The defaults. */
    public static NanoFlagsOptions defaults() { return builder().build(); }

    public String baseUrl() { return baseUrl; }

    public String service() { return service; }

    public static final class Builder {
        private String baseUrl = OFFICIAL_EDGE_URL;
        private String service = "unknown";
        private HttpClient httpClient;
        private Duration pollInterval = Duration.ofSeconds(30);
        private Duration livePollInterval = Duration.ofMinutes(5);
        private boolean live = true;
        private boolean streaming = true;
        private Bundle bootstrap;
        private String bootstrapJson;
        private Store store;
        private VerifyOptions verify;
        private boolean verifySet;
        private EventsOptions events = EventsOptions.builder().build();
        private Duration requestTimeout = Duration.ofSeconds(10);
        private Duration liveConnectTimeout = Duration.ofSeconds(10);
        private System.Logger logger;
        private DoubleSupplier random = Math::random;

        private Builder() {}

        /** The edge (default {@link #OFFICIAL_EDGE_URL}). Signature verification is on by default only for the official edge. */
        public Builder baseUrl(String url) {
            String u = Objects.requireNonNull(url, "url");
            while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
            this.baseUrl = u;
            return this;
        }

        /** Names this service in "which revision is each service running" reports (default {@code "unknown"}). */
        public Builder service(String name) {
            this.service = Objects.requireNonNull(name, "name");
            return this;
        }

        /**
         * The HTTP client for every request and the WebSocket (default: a client using
         * {@link java.net.ProxySelector#getDefault()}, which honours the {@code https.proxyHost} system properties).
         */
        public Builder httpClient(HttpClient client) {
            this.httpClient = client;
            return this;
        }

        /** The polling interval without a live socket (default 30 s; {@link Duration#ZERO} disables polling). */
        public Builder pollInterval(Duration d) {
            this.pollInterval = Objects.requireNonNull(d, "d");
            return this;
        }

        /** The safety-poll interval while the live socket is healthy (default 5 min). */
        public Builder livePollInterval(Duration d) {
            this.livePollInterval = Objects.requireNonNull(d, "d");
            return this;
        }

        /** The live WebSocket (default on). Without it, updates arrive over server-sent events and polling. */
        public Builder live(boolean on) {
            this.live = on;
            return this;
        }

        /** Push updates altogether (live WebSocket and SSE; default on). Without them the client only polls. */
        public Builder streaming(boolean on) {
            this.streaming = on;
            return this;
        }

        /** Starts with a bundle obtained elsewhere (shipped with the service); used until the edge delivers something newer. */
        public Builder bootstrap(Bundle bundle) {
            this.bootstrap = bundle;
            this.bootstrapJson = null;
            return this;
        }

        /** {@link #bootstrap(Bundle)} for bundle JSON text. Invalid text is reported through {@code onError} and ignored. */
        public Builder bootstrapJson(String json) {
            this.bootstrapJson = json;
            this.bootstrap = null;
            return this;
        }

        /** Persists the last good configuration (see {@link FileStore}). Default: none. */
        public Builder store(Store store) {
            this.store = store;
            return this;
        }

        /** Configures signature verification. */
        public Builder verify(VerifyOptions options) {
            this.verify = Objects.requireNonNull(options, "options");
            this.verifySet = true;
            return this;
        }

        /** Turns signature verification off, also on the official edge. */
        public Builder withoutVerification() {
            this.verify = null;
            this.verifySet = true;
            return this;
        }

        /** Telemetry settings (default: 10 % of evaluations, attribute names and types only). */
        public Builder events(EventsOptions events) {
            this.events = Objects.requireNonNull(events, "events");
            return this;
        }

        /** Timeout of each HTTP request (default 10 s). */
        public Builder requestTimeout(Duration d) {
            this.requestTimeout = Objects.requireNonNull(d, "d");
            return this;
        }

        /** Timeout of the WebSocket handshake (default 10 s). */
        public Builder liveConnectTimeout(Duration d) {
            this.liveConnectTimeout = Objects.requireNonNull(d, "d");
            return this;
        }

        /** Logger for background activity (default {@code System.getLogger("io.nanoflags.server")}, debug level only). */
        public Builder logger(System.Logger logger) {
            this.logger = logger;
            return this;
        }

        Builder random(DoubleSupplier r) {
            this.random = r;
            return this;
        }

        public NanoFlagsOptions build() { return new NanoFlagsOptions(this); }
    }

    /** Sampled evaluation telemetry and the periodic service report. */
    public static final class EventsOptions {
        final boolean enabled;
        final double sampleRate;
        final Duration flushInterval;
        final Duration reportInterval;
        final Function<Map<String, Object>, Map<String, ?>> redact;

        private EventsOptions(EventsBuilder b) {
            this.enabled = b.enabled;
            this.sampleRate = Math.min(1, Math.max(0, b.sampleRate));
            this.flushInterval = b.flushInterval;
            this.reportInterval = b.reportInterval;
            this.redact = b.redact;
        }

        public static EventsBuilder builder() { return new EventsBuilder(); }

        /** Telemetry off entirely (no service report either). */
        public static EventsOptions disabled() { return builder().enabled(false).build(); }

        public boolean enabled() { return enabled; }

        public double sampleRate() { return sampleRate; }
    }

    public static final class EventsBuilder {
        private boolean enabled = true;
        private double sampleRate = 0.1;
        private Duration flushInterval = Duration.ofSeconds(10);
        private Duration reportInterval = Duration.ofSeconds(60);
        private Function<Map<String, Object>, Map<String, ?>> redact;

        private EventsBuilder() {}

        public EventsBuilder enabled(boolean on) {
            this.enabled = on;
            return this;
        }

        /** Fraction of evaluations reported, 0–1 (default 0.1). */
        public EventsBuilder sampleRate(double rate) {
            this.sampleRate = rate;
            return this;
        }

        /** How often queued events are sent (default 10 s). */
        public EventsBuilder flushInterval(Duration d) {
            this.flushInterval = Objects.requireNonNull(d, "d");
            return this;
        }

        /** How often the service report goes out while no events are queued (default 60 s). */
        public EventsBuilder reportInterval(Duration d) {
            this.reportInterval = Objects.requireNonNull(d, "d");
            return this;
        }

        /**
         * Decides what part of the context leaves the process. Default: no values, only the names of the attributes the
         * flag's rules use, mapped to the value's type (e.g. {@code {"region": "string"}}).
         */
        public EventsBuilder redact(Function<Map<String, Object>, Map<String, ?>> redact) {
            this.redact = redact;
            return this;
        }

        public EventsOptions build() { return new EventsOptions(this); }
    }
}
