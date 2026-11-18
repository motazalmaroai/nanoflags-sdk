package io.nanoflags.server;

import io.nanoflags.server.engine.Bundle;
import io.nanoflags.server.engine.InvalidJsonException;
import io.nanoflags.server.engine.JsonValue;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * The client's cache of test-session lookups ({@code GET /v1/session}), keyed by service and token. A resolved
 * session is cached until it expires, an unknown token for 15 s, a failed lookup for 3 s. Concurrent callers share one
 * request. Bounded to {@link #MAX_SESSIONS} entries.
 */
final class Sessions {
    static final String HEADER = "x-nanoflags-session";
    static final int MAX_SESSIONS = 1000;
    static final long MISS_TTL_MS = 15_000;
    static final long ERROR_TTL_MS = 3_000;

    /** One resolved test session. Immutable. */
    static final class State {
        final String id;
        final NanoFlagsClient.Snapshot snap;
        /** The session's synthetic context as plain Java data, in configuration order. */
        final Map<String, Object> context;
        final Instant expiresAt;

        State(String id, Bundle bundle, Map<String, Object> context, Instant expiresAt) {
            this.id = id;
            this.snap = new NanoFlagsClient.Snapshot(bundle, null, null, null, null);
            this.context = context;
            this.expiresAt = expiresAt;
        }

        boolean live() { return Instant.now().isBefore(expiresAt); }
    }

    private static final class Entry {
        final CompletableFuture<State> future = new CompletableFuture<>();
        volatile long untilMs = Long.MAX_VALUE; // in flight
    }

    private final NanoFlagsClient c;
    private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>(); // insertion order: oldest first

    Sessions(NanoFlagsClient c) { this.c = c; }

    static boolean isToken(String v) {
        if (v == null || v.isEmpty() || v.length() > 512) return false;
        for (int i = 0; i < v.length(); i++) {
            char ch = v.charAt(i);
            if (ch < 0x21 || ch > 0x7e) return false;
        }
        return true;
    }

    /** The session ({@code null}: none). Never completes exceptionally. */
    CompletableFuture<State> resolve(String token, String service) {
        if (!isToken(token) || c.closed.get()) return CompletableFuture.completedFuture(null);
        String name = service != null && !service.isEmpty() ? service : "unknown".equals(c.cfg.service) ? "" : c.cfg.service;
        String key = name + "\n" + token;
        long now = System.currentTimeMillis();
        Entry e;
        synchronized (entries) {
            if (c.closed.get()) return CompletableFuture.completedFuture(null);
            e = entries.get(key);
            if (e != null && now < e.untilMs) return e.future;
            entries.remove(key);
            if (entries.size() >= MAX_SESSIONS) {
                entries.values().removeIf(x -> now >= x.untilMs);
                // Still full: drop the oldest entries.
                Iterator<Entry> it = entries.values().iterator();
                while (entries.size() >= MAX_SESSIONS && it.hasNext()) {
                    it.next();
                    it.remove();
                }
            }
            e = new Entry();
            entries.put(key, e);
        }
        Entry entry = e;
        fetch(token, name).whenComplete((state, err) -> {
            boolean failed = err != null;
            if (failed) report(err);
            State st = failed ? null : state;
            entry.untilMs = st != null ? st.expiresAt.toEpochMilli() : System.currentTimeMillis() + (failed ? ERROR_TTL_MS : MISS_TTL_MS);
            entry.future.complete(st);
        });
        return entry.future;
    }

    void clear() {
        synchronized (entries) {
            entries.clear();
        }
    }

    private void report(Throwable err) {
        if (c.closed.get()) return;
        Throwable t = err instanceof java.util.concurrent.CompletionException && err.getCause() != null ? err.getCause() : err;
        c.emitError(t instanceof NanoFlagsException ? (NanoFlagsException) t
            : new NanoFlagsException(ErrorCode.SESSION, "Could not load the test session: " + t, 0, t));
    }

    private CompletableFuture<State> fetch(String token, String service) {
        HttpRequest.Builder req = c.request("/v1/session").GET().header("X-NanoFlags-Session", token).header("Cache-Control", "no-store");
        if (!service.isEmpty()) req.header("X-NanoFlags-Service", service);
        try {
            return c.http.sendAsync(req.build(), HttpResponse.BodyHandlers.ofInputStream()).thenApply(res -> {
                try {
                    return parse(res);
                } catch (IOException ex) {
                    throw new java.io.UncheckedIOException(ex);
                }
            });
        } catch (RuntimeException ex) {
            CompletableFuture<State> f = new CompletableFuture<>();
            f.completeExceptionally(ex);
            return f;
        }
    }

    /** {@code null} for "no such session" (unknown, expired, revoked, service not permitted). */
    private static State parse(HttpResponse<InputStream> res) throws IOException {
        int code = res.statusCode();
        if (code == 404) {
            res.body().close();
            return null;
        }
        if (code < 200 || code > 299) {
            res.body().close();
            throw new NanoFlagsException(code == 401 || code == 403 ? ErrorCode.UNAUTHORIZED : ErrorCode.SESSION, "Session request failed with HTTP " + code + ".", code, null);
        }
        NanoFlagsException invalid = new NanoFlagsException(ErrorCode.SESSION, "The edge returned an invalid session.");
        byte[] bytes = readLimited(res.body(), NanoFlagsClient.MAX_BUNDLE_BYTES);
        if (bytes == null) throw invalid;
        JsonValue body;
        try {
            body = JsonValue.parse(new String(bytes, StandardCharsets.UTF_8));
        } catch (InvalidJsonException e) {
            throw invalid;
        }
        JsonValue id = body.field("id");
        JsonValue exp = body.field("expires_at");
        Bundle bundle = Bundle.of(body.field("bundle"));
        Instant expiresAt = null;
        if (exp instanceof JsonValue.Str) {
            try {
                expiresAt = OffsetDateTime.parse(((JsonValue.Str) exp).value().trim()).toInstant();
            } catch (DateTimeParseException e) {
                expiresAt = null;
            }
        }
        if (!(id instanceof JsonValue.Str) || bundle == null || expiresAt == null) throw invalid;
        if (!bundle.supportsEngine()) throw NanoFlagsClient.engineError(bundle);
        if (!Instant.now().isBefore(expiresAt)) return null;
        JsonValue ctx = body.field("context");
        Map<String, Object> context = Collections.emptyMap();
        if (ctx instanceof JsonValue.Obj) {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) ctx.toJava();
            context = Collections.unmodifiableMap(new LinkedHashMap<>(m));
        }
        return new State(((JsonValue.Str) id).value(), bundle, context, expiresAt);
    }

    private static byte[] readLimited(InputStream in, int limit) throws IOException {
        try (InputStream body = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = body.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > limit) return null;
            }
            return out.toByteArray();
        }
    }
}
