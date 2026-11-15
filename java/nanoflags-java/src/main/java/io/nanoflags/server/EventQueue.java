package io.nanoflags.server;

import io.nanoflags.server.engine.EngineResult;
import io.nanoflags.server.engine.JsonValue;
import java.io.InputStream;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Samples evaluations and sends them, with the periodic service report ("this service runs revision N"), to
 * {@code POST /v1/events}. Off the hot path: evaluation only appends to a bounded list; telemetry is never retried
 * and never affects evaluation. By default events carry the names of the attributes the flag's rules use and the
 * type of their values, never values.
 */
final class EventQueue {
    static final int MAX_QUEUE = 500;
    static final int MAX_BATCH = 50;
    static final int MAX_VALUE_CHARS = 1024;

    private final NanoFlagsClient c;
    private final NanoFlagsOptions.EventsOptions opts;
    private final Object lock = new Object();
    private final List<JsonValue.Obj> queue = new ArrayList<>();
    private long lastReport; // System.nanoTime(); 0 = never

    EventQueue(NanoFlagsClient c) {
        this.c = c;
        this.opts = c.cfg.events;
    }

    void start() {
        if (!opts.enabled || opts.flushInterval.isZero() || opts.flushInterval.isNegative()) return;
        long ms = opts.flushInterval.toMillis();
        c.scheduler.scheduleWithFixedDelay(() -> {
            boolean idle;
            synchronized (lock) {
                idle = queue.isEmpty() && lastReport != 0 && System.nanoTime() - lastReport < opts.reportInterval.toNanos();
            }
            if (!idle) flush(c.cfg.requestTimeout);
        }, ms, ms, TimeUnit.MILLISECONDS);
    }

    void record(EngineResult r, Map<String, ?> ctx, NanoFlagsClient.Snapshot s) {
        if (!opts.enabled || c.closed.get() || opts.sampleRate <= 0 || c.cfg.random.getAsDouble() >= opts.sampleRate) return;
        try {
            synchronized (lock) {
                if (queue.size() >= MAX_QUEUE) return; // bounded: drop instead of growing
            }
            JsonValue.Obj.Builder e = JsonValue.Obj.builder()
                .put("flagKey", new JsonValue.Str(r.flagKey()))
                .put("value", eventValue(r.value()))
                .put("reason", new JsonValue.Str(r.reason().wire()));
            if (r.ruleIndex() >= 0) e.put("ruleIndex", new JsonValue.Num(r.ruleIndex()));
            double rev = r.revision() instanceof JsonValue.Num ? ((JsonValue.Num) r.revision()).value() : 0;
            e.put("revision", new JsonValue.Num(Double.isNaN(rev) || Double.isInfinite(rev) ? 0 : Math.floor(rev)));
            JsonValue context;
            if (opts.redact != null) {
                Map<String, ?> red = opts.redact.apply(new LinkedHashMap<>(ctx));
                context = red == null ? JsonValue.Obj.EMPTY : JsonValue.of(red);
            } else {
                context = defaultRedact(s, r.flagKey(), ctx);
            }
            e.put("context", context);
            e.put("at", new JsonValue.Str(NanoFlagsClient.isoNow()));
            e.put("sampleRate", new JsonValue.Num(opts.sampleRate));
            JsonValue.Obj built = e.build();
            synchronized (lock) {
                if (queue.size() < MAX_QUEUE) queue.add(built);
            }
        } catch (RuntimeException ignored) {
            // telemetry must never affect evaluation
        }
    }

    static JsonValue eventValue(JsonValue v) {
        if (v instanceof JsonValue.Str) {
            String s = ((JsonValue.Str) v).value();
            return s.length() > MAX_VALUE_CHARS ? new JsonValue.Str(s.substring(0, MAX_VALUE_CHARS)) : v;
        }
        String text = v.toJson();
        if (text == null) return JsonValue.NULL;
        if ((v instanceof JsonValue.Obj || v instanceof JsonValue.Arr) && text.length() > MAX_VALUE_CHARS) return JsonValue.NULL;
        return v;
    }

    /** No attribute values: only the names of the attributes the flag's rules use that were present, mapped to the value's type. */
    static JsonValue.Obj defaultRedact(NanoFlagsClient.Snapshot s, String flagKey, Map<String, ?> ctx) {
        if (s == null || ctx.isEmpty()) return JsonValue.Obj.EMPTY;
        JsonValue.Obj.Builder out = JsonValue.Obj.builder();
        for (String n : s.bundle.attributesUsedBy(flagKey)) {
            if (ctx.containsKey(n)) out.put(n, new JsonValue.Str(JsonValue.of(ctx.get(n)).typeName()));
        }
        return out.build();
    }

    /** Sends up to one batch of queued events with the service report (best effort, never throws). */
    void flush(java.time.Duration timeout) {
        if (!opts.enabled) return;
        List<JsonValue> batch = new ArrayList<>();
        synchronized (lock) {
            int n = Math.min(queue.size(), MAX_BATCH);
            for (int i = 0; i < n; i++) {
                JsonValue.Obj e = queue.get(i);
                String k = ((JsonValue.Str) e.get("flagKey")).value();
                if (k.length() > 63) {
                    JsonValue.Obj.Builder b = JsonValue.Obj.builder();
                    for (String name : e.keys()) b.put(name, name.equals("flagKey") ? new JsonValue.Str(k.substring(0, 63)) : e.get(name));
                    e = b.build();
                }
                batch.add(e);
            }
            queue.subList(0, n).clear();
            lastReport = System.nanoTime();
        }
        long rev = Math.max(0, c.revision());
        JsonValue.Obj body = JsonValue.Obj.builder()
            .put("service", new JsonValue.Str(c.cfg.service))
            .put("sdk", new JsonValue.Str(NanoFlagsClient.SDK_LABEL))
            .put("revision", new JsonValue.Num(rev))
            .put("events", new JsonValue.Arr(batch))
            .build();
        try {
            HttpRequest req = c.request("/v1/events").timeout(timeout).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body.toJson(), StandardCharsets.UTF_8)).build();
            HttpResponse<InputStream> res = c.http.send(req, HttpResponse.BodyHandlers.ofInputStream());
            try (InputStream in = res.body()) {
                in.readNBytes(64 << 10);
            }
            if (res.statusCode() >= 300) c.log.log(System.Logger.Level.DEBUG, "nanoflags: events request failed with HTTP {0}", res.statusCode());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            // dropped by design: telemetry is never retried
            c.log.log(System.Logger.Level.DEBUG, "nanoflags: events request failed: {0}", e.toString());
        }
    }

    int queued() {
        synchronized (lock) {
            return queue.size();
        }
    }
}
