package io.nanoflags.server;

import io.nanoflags.server.engine.Bundle;
import io.nanoflags.server.engine.Engine;
import io.nanoflags.server.engine.EngineResult;
import io.nanoflags.server.engine.EvalContext;
import io.nanoflags.server.engine.InvalidJsonException;
import io.nanoflags.server.engine.JsonValue;
import io.nanoflags.server.engine.Reason;
import io.nanoflags.server.engine.TraceStep;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.function.Predicate;

/**
 * Evaluates NanoFlags feature flags locally against an in-memory configuration that it keeps current in the
 * background (live WebSocket, then server-sent events, then polling with ETag).
 *
 * <p>Evaluations never perform I/O, never block and never throw: on any problem they return the fallback. A client
 * is safe for concurrent use; create one per SDK key at startup, share it, and {@link #close()} it on shutdown.
 *
 * <pre>{@code
 * NanoFlagsClient flags = NanoFlagsClient.create(System.getenv("NANOFLAGS_SDK_KEY"),
 *     NanoFlagsOptions.builder().service("checkout-api").build());
 * flags.waitForReady(Duration.ofSeconds(5));
 * boolean on = flags.boolVariation("new-checkout", Map.of("key", "user-42", "plan", "pro"), false);
 * }</pre>
 */
public final class NanoFlagsClient implements AutoCloseable {
    /** The version of this SDK, reported to the edge as {@code java/<version>}. */
    public static final String VERSION = BuildInfo.VERSION;
    /** The newest bundle format ({@code bundle.engine}) this SDK evaluates. Newer bundles are refused. */
    public static final int SUPPORTED_ENGINE_VERSION = Engine.VERSION;
    /** The WebSocket close code with which the edge says that the environment was deleted. */
    public static final int CLOSE_ENVIRONMENT_DELETED = 4004;
    /** The WebSocket subprotocol of {@code GET /v1/live}. */
    public static final String LIVE_PROTOCOL = "nanoflags.v1";

    static final String USER_AGENT = "nanoflags-java/" + VERSION;
    static final String SDK_LABEL = "java/" + VERSION;
    static final int MAX_BUNDLE_BYTES = 16 << 20;
    private static final DateTimeFormatter ISO_MILLIS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    /** One adopted configuration. */
    static final class Snapshot {
        final Bundle bundle;
        final String etag;
        final String checksum;
        final Signatures.Info sig;
        /** The signed bundle text (null when unsigned). */
        final String raw;

        Snapshot(Bundle bundle, String etag, String checksum, Signatures.Info sig, String raw) {
            this.bundle = bundle;
            this.etag = etag == null ? "" : etag;
            this.checksum = checksum == null ? "" : checksum;
            this.sig = sig;
            this.raw = raw;
        }
    }

    final NanoFlagsOptions cfg;
    final String sdkKey;
    final HttpClient http;
    final System.Logger log;
    private final String id;
    private final boolean browserKey;
    final Verifier verifier;
    final EventQueue events;
    final Listeners listeners;
    final ScheduledExecutorService scheduler;
    private final Live live;

    final AtomicReference<Snapshot> snap = new AtomicReference<>();
    private final AtomicReference<Status> status = new AtomicReference<>(Status.NOT_READY);
    final AtomicBoolean closed = new AtomicBoolean();
    final CountDownLatch closedLatch = new CountDownLatch(1);
    private final CompletableFuture<Boolean> ready = new CompletableFuture<>();

    private final ReentrantLock syncLock = new ReentrantLock(); // single flight for bundle requests
    final Object adoptLock = new Object(); // compare-and-adopt decisions (never held during I/O)
    final Object lock = new Object(); // guards the fields below
    private int failures;
    private NanoFlagsException lastError;
    String pinnedEnvironment;
    long liveRevision;
    boolean environmentDeleted;
    private boolean streamTriggered;

    private final Object loopLock = new Object();
    private boolean kickPending;
    private boolean reschedPending;
    private final Thread pollThread;

    private NanoFlagsClient(String sdkKey, NanoFlagsOptions cfg) {
        this.cfg = cfg;
        this.sdkKey = sdkKey;
        this.log = cfg.logger != null ? cfg.logger : System.getLogger("io.nanoflags.server");
        this.http = cfg.httpClient != null ? cfg.httpClient
            : HttpClient.newBuilder().connectTimeout(cfg.requestTimeout).proxy(ProxySelector.getDefault()).followRedirects(HttpClient.Redirect.NORMAL).build();
        this.id = String.format("%08x", Engine.murmur3(cfg.baseUrl + "|" + sdkKey));
        this.browserKey = sdkKey.startsWith("nf_pub_");
        this.listeners = new Listeners();
        ScheduledThreadPoolExecutor s = new ScheduledThreadPoolExecutor(1, daemon("nanoflags-timer"));
        s.setRemoveOnCancelPolicy(true);
        this.scheduler = s;
        List<NanoFlagsException> cfgErrors = new ArrayList<>();
        this.verifier = Verifier.create(this, cfgErrors);
        this.events = new EventQueue(this);
        this.live = new Live(this);
        for (NanoFlagsException e : cfgErrors) emitError(e);
        Bundle boot = cfg.bootstrap;
        if (cfg.bootstrapJson != null) {
            boot = Bundle.parse(cfg.bootstrapJson);
            if (boot == null) emitError(new NanoFlagsException(ErrorCode.INVALID_BUNDLE, "The bootstrap bundle is invalid and was ignored."));
        }
        if (boot != null) {
            if (!boot.supportsEngine()) emitError(engineError(boot));
            else adopt(new Snapshot(boot, null, null, null, null), Status.READY, Source.BOOTSTRAP, Transport.POLL, null);
        }
        this.pollThread = daemon("nanoflags-poll").newThread(this::run);
        this.pollThread.start();
    }

    /** A client with the default options. See {@link #create(String, NanoFlagsOptions)}. */
    public static NanoFlagsClient create(String sdkKey) { return create(sdkKey, NanoFlagsOptions.defaults()); }

    /**
     * Creates a client for {@code sdkKey} ({@code nf_srv_…} on servers; {@code nf_pub_…} keys work too but only see
     * client-exposed flags) and starts loading the configuration in the background. Use {@link #ready()} or
     * {@link #waitForReady(Duration)} to wait for the first load.
     *
     * @throws NanoFlagsException with code {@link ErrorCode#CONFIG} for an invalid configuration
     */
    public static NanoFlagsClient create(String sdkKey, NanoFlagsOptions options) {
        Objects.requireNonNull(options, "options");
        if (sdkKey == null || sdkKey.trim().isEmpty()) throw new NanoFlagsException(ErrorCode.CONFIG, "An SDK key is required.");
        if (!options.baseUrl.startsWith("https://") && !options.baseUrl.startsWith("http://")) {
            throw new NanoFlagsException(ErrorCode.CONFIG, "The base URL must be an http(s) URL, got \"" + options.baseUrl + "\".");
        }
        return new NanoFlagsClient(sdkKey.trim(), options);
    }

    static java.util.concurrent.ThreadFactory daemon(String name) {
        AtomicInteger n = new AtomicInteger();
        return r -> {
            Thread t = new Thread(r, n.getAndIncrement() == 0 ? name : name + "-" + n.get());
            t.setDaemon(true);
            return t;
        };
    }

    /* ---------------- lifecycle ---------------- */

    /**
     * Completes once the first load attempt has finished (or a configuration was adopted earlier, for example from a
     * bootstrap bundle): {@code true} when a configuration is in use, {@code false} otherwise ({@link #lastError()}
     * says why). Never completes exceptionally.
     */
    public CompletableFuture<Boolean> ready() { return ready.thenApply(b -> snap.get() != null); }

    /** Blocks until {@link #ready()} completes or {@code timeout} passes; true when a configuration is in use. Never throws. */
    public boolean waitForReady(Duration timeout) {
        try {
            ready.get(Math.max(0, timeout.toMillis()), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            // timeout
        }
        return snap.get() != null;
    }

    /** Whether a configuration is in use. */
    public boolean isInitialized() { return snap.get() != null; }

    void markReady() { ready.complete(Boolean.TRUE); }

    /** The state of the configuration in use. */
    public Status status() { return status.get(); }

    /** The revision in use, or -1 when no configuration is loaded. */
    public long revision() {
        Snapshot s = snap.get();
        return s == null ? -1 : s.bundle.revision();
    }

    /** How updates reach the client right now. */
    public Transport transport() {
        if (live.isOpen()) return Transport.LIVE;
        if (live.isStreaming()) return Transport.STREAM;
        return Transport.POLL;
    }

    /** The configuration in use ({@code null} when none is loaded). Bundles are immutable. */
    public Bundle bundle() {
        Snapshot s = snap.get();
        return s == null ? null : s.bundle;
    }

    /** The error of the last failed request ({@code null} after a success). */
    public NanoFlagsException lastError() {
        synchronized (lock) {
            return lastError;
        }
    }

    /** Registers {@code listener} for every newly adopted configuration. Listeners run one at a time, in order, on a thread of the client. */
    public Subscription onChange(Consumer<ChangeEvent> listener) { return listeners.add(listeners.change, listener); }

    /** Registers {@code listener} for background errors (failed requests, rejected signatures, …). They never change the configuration in use. */
    public Subscription onError(Consumer<NanoFlagsException> listener) { return listeners.add(listeners.errors, listener); }

    /** Registers {@code listener} for status changes. */
    public Subscription onStatus(Consumer<Status> listener) { return listeners.add(listeners.status, listener); }

    /** Revalidates the configuration now; returns when the request has finished. @throws NanoFlagsException when it failed */
    public void refresh() {
        if (closed.get()) throw new NanoFlagsException(ErrorCode.CONFIG, "The client is closed.");
        NanoFlagsException e = syncNow(false);
        if (e != null) throw e;
    }

    /** Sends queued telemetry and the service report now (best effort). */
    public void flush() { events.flush(cfg.requestTimeout); }

    /**
     * Stops every background activity (after a best-effort final telemetry flush) and waits for it to end.
     * Evaluations keep working on the last configuration. Idempotent.
     */
    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        try {
            events.flush(Duration.ofSeconds(2));
        } catch (RuntimeException ignored) {
            // best effort
        }
        closedLatch.countDown();
        synchronized (loopLock) {
            loopLock.notifyAll();
        }
        live.shutdown();
        pollThread.interrupt();
        join(pollThread);
        live.join();
        scheduler.shutdownNow();
        markReady();
        listeners.shutdown();
    }

    private static void join(Thread t) {
        if (t == null || t == Thread.currentThread()) return;
        try {
            t.join(5000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /* ---------------- adoption ---------------- */

    void setStatus(Status s) {
        if (status.getAndSet(s) != s) listeners.emit(listeners.status, s);
    }

    /** Swaps the configuration in use atomically. Callers hold {@link #adoptLock} or are the constructor. */
    void adopt(Snapshot next, Status st, Source source, Transport transport, Duration latency) {
        Snapshot prev = snap.getAndSet(next);
        setStatus(st);
        markReady();
        if (prev != null && prev.bundle.revision() == next.bundle.revision() && prev.checksum.equals(next.checksum)) return;
        listeners.emit(listeners.change, new ChangeEvent(next.bundle.revision(), prev == null ? -1 : prev.bundle.revision(), next.checksum, source, transport, latency));
    }

    static NanoFlagsException engineError(Bundle b) {
        String e = b.engine().toJson();
        return new NanoFlagsException(ErrorCode.ENGINE, "Bundle r" + b.revision() + " needs evaluation engine " + (e == null ? "undefined" : e) + "; this SDK supports up to "
            + Engine.VERSION + ". Upgrade the NanoFlags Java SDK. The configuration in use is unchanged.");
    }

    void emitError(NanoFlagsException e) {
        log.log(System.Logger.Level.DEBUG, "nanoflags: {0}", e.getMessage());
        listeners.emit(listeners.errors, e);
    }

    /* ---------------- background loop ---------------- */

    private void run() {
        try {
            restore();
            syncNow(false);
            markReady();
            if (closed.get()) return;
            events.start();
            live.start();
            while (!closed.get()) {
                boolean kick;
                synchronized (loopLock) {
                    long delay = cfg.pollInterval.isZero() || cfg.pollInterval.isNegative() ? 0 : nextDelayMs();
                    long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(delay);
                    while (!kickPending && !reschedPending && !closed.get()) {
                        long left = delay == 0 ? 0 : TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
                        if (delay != 0 && left <= 0) break;
                        loopLock.wait(delay == 0 ? 0 : left);
                    }
                    if (closed.get()) return;
                    kick = kickPending;
                    boolean resched = reschedPending;
                    kickPending = false;
                    reschedPending = false;
                    if (!kick && resched) continue;
                }
                syncNow(kick);
            }
        } catch (InterruptedException e) {
            // closing
        } catch (RuntimeException e) {
            log.log(System.Logger.Level.WARNING, "nanoflags: background loop failed", e);
        }
    }

    void reschedule() {
        synchronized (loopLock) {
            reschedPending = true;
            loopLock.notifyAll();
        }
    }

    void markStreamTriggered() {
        synchronized (lock) {
            streamTriggered = true;
        }
    }

    void trigger() {
        synchronized (loopLock) {
            kickPending = true;
            loopLock.notifyAll();
        }
    }

    private long nextDelayMs() {
        int f;
        synchronized (lock) {
            f = failures;
        }
        long interval = cfg.pollInterval.toMillis();
        if (live.isOpen() && cfg.livePollInterval.toMillis() > interval) interval = cfg.livePollInterval.toMillis();
        long base = interval;
        if (f > 0) {
            // After failures, catch up quickly: 1s, 2s, 4s … capped at the poll interval.
            long backoff = 1000L << Math.min(f - 1, 10);
            base = Math.min(cfg.pollInterval.toMillis(), backoff);
        }
        long d = (long) (base * (0.8 + 0.4 * ThreadLocalRandom.current().nextDouble()));
        return Math.max(250, d);
    }

    /* ---------------- polling: GET /v1/bundle ---------------- */

    HttpRequest.Builder request(String path) {
        return HttpRequest.newBuilder(URI.create(cfg.baseUrl + path))
            .timeout(cfg.requestTimeout)
            .header("Authorization", "Bearer " + sdkKey)
            .header("User-Agent", USER_AGENT);
    }

    /** One conditional bundle request; adopts what it returns. Returns the error, or null. */
    NanoFlagsException syncNow(boolean fromStream) {
        syncLock.lock();
        try {
            if (closed.get()) return new NanoFlagsException(ErrorCode.CONFIG, "The client is closed.");
            Transport transport;
            synchronized (lock) {
                transport = streamTriggered || fromStream ? Transport.STREAM : Transport.POLL;
                streamTriggered = false;
            }
            NanoFlagsException ne;
            try {
                syncOnce(transport);
                synchronized (lock) {
                    failures = 0;
                    lastError = null;
                }
                return null;
            } catch (NanoFlagsException e) {
                ne = e;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new NanoFlagsException(ErrorCode.NETWORK, "Interrupted.", 0, e);
            } catch (IOException | RuntimeException e) {
                if (closed.get()) return new NanoFlagsException(ErrorCode.NETWORK, "The client is closed.", 0, e);
                ne = new NanoFlagsException(ErrorCode.NETWORK, "Could not reach the NanoFlags edge: " + e, 0, e);
            }
            synchronized (lock) {
                lastError = ne;
                if (ne.code() != ErrorCode.ENGINE) failures++;
            }
            if (ne.code() != ErrorCode.ENGINE && ne.code() != ErrorCode.SIGNATURE) {
                // A rejected update changes nothing: same configuration, same status. Anything else: stale.
                if (ne.code() == ErrorCode.UNAUTHORIZED) live.dropLive();
                if (snap.get() != null) setStatus(Status.STALE);
            }
            emitError(ne);
            return ne;
        } finally {
            syncLock.unlock();
        }
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

    private void syncOnce(Transport transport) throws IOException, InterruptedException {
        HttpRequest.Builder req = request("/v1/bundle").GET();
        Snapshot cur = snap.get();
        if (cur != null && !cur.etag.isEmpty()) req.header("If-None-Match", cur.etag);
        HttpResponse<InputStream> res = http.send(req.build(), HttpResponse.BodyHandlers.ofInputStream());
        boolean servedStale = "true".equals(res.headers().firstValue("X-NanoFlags-Stale").orElse(null));
        int code = res.statusCode();
        if (code == 304) {
            res.body().close();
            if (cur != null) setStatus(servedStale ? Status.STALE : Status.READY);
            return;
        }
        if (code == 401 || code == 403) {
            res.body().close();
            throw new NanoFlagsException(ErrorCode.UNAUTHORIZED, "The SDK key was rejected (unknown or revoked).", code, null);
        }
        if (code < 200 || code > 299) {
            res.body().close();
            throw new NanoFlagsException(ErrorCode.HTTP, "Bundle request failed with HTTP " + code + ".", code, null);
        }
        byte[] bytes = readLimited(res.body(), MAX_BUNDLE_BYTES);
        if (bytes == null) throw new NanoFlagsException(ErrorCode.INVALID_BUNDLE, "The edge returned a bundle larger than " + MAX_BUNDLE_BYTES + " bytes.");
        String text = new String(bytes, StandardCharsets.UTF_8);
        JsonValue body;
        try {
            body = JsonValue.parse(text);
        } catch (InvalidJsonException e) {
            throw new NanoFlagsException(ErrorCode.INVALID_BUNDLE, "The edge returned an invalid bundle.");
        }
        Bundle bundle = Bundle.of(body.field("bundle"));
        if (bundle == null) throw new NanoFlagsException(ErrorCode.INVALID_BUNDLE, "The edge returned an invalid bundle.");
        JsonValue cs = body.field("checksum");
        String checksum = cs instanceof JsonValue.Str ? ((JsonValue.Str) cs).value() : "";
        String etag = res.headers().firstValue("ETag").orElse("");
        Snapshot next = checkSignature(res, text, body, bundle, etag, checksum);
        if (!bundle.supportsEngine()) throw engineError(bundle);
        synchronized (adoptLock) {
            cur = snap.get();
            // The edge is serving its last-known-good copy: never go backwards because of it.
            if (servedStale && cur != null && cur.bundle.revision() >= bundle.revision()) {
                setStatus(Status.STALE);
                return;
            }
            // A revision that was pushed while this request was under way wins.
            long pushed;
            synchronized (lock) {
                pushed = liveRevision;
            }
            if (cur != null && bundle.revision() < pushed && cur.bundle.revision() >= pushed) return;
            adopt(next, servedStale ? Status.STALE : Status.READY, Source.NETWORK, transport, null);
        }
        persist(next);
    }

    /** Verifies the response's signature (when verification is on) and returns the snapshot to adopt. */
    private Snapshot checkSignature(HttpResponse<?> res, String text, JsonValue body, Bundle bundle, String etag, String checksum) throws InterruptedException {
        Verifier v = verifier;
        if (v == null) return new Snapshot(bundle, etag, checksum, null, null);
        long rev = bundle.revision();
        if (!"true".equals(res.headers().firstValue("X-NanoFlags-Signed").orElse(null))) {
            if (v.require) throw reject(rev, "it is not signed (the edge is still distributing it) and unsigned bundles are refused; fetching again shortly.");
            return new Snapshot(bundle, etag, checksum, null, null);
        }
        String signature = res.headers().firstValue("X-NanoFlags-Signature").orElse("");
        String envId = res.headers().firstValue("X-NanoFlags-Environment-Id").orElse("");
        String kid = res.headers().firstValue("X-NanoFlags-Key-Id").orElse("");
        JsonValue cs = body.field("checksum");
        if (signature.isEmpty() || envId.isEmpty() || !(cs instanceof JsonValue.Str)) throw reject(rev, "the signature headers are incomplete.");
        long revision = rev;
        JsonValue r = body.field("revision");
        if (r instanceof JsonValue.Num) {
            double d = ((JsonValue.Num) r).value();
            if (d != (double) rev) throw reject(rev, "the signed revision does not match the bundle.");
            revision = (long) d;
        }
        String pinned;
        synchronized (lock) {
            pinned = pinnedEnvironment;
        }
        if (pinned != null && !pinned.equals(envId)) throw reject(rev, "it was signed for a different environment.");
        Signatures.Info info = new Signatures.Info(signature, kid, envId, revision, checksum);
        List<Signatures.Key> keys;
        try {
            keys = v.keysFor(info.kid);
        } catch (NanoFlagsException e) {
            throw reject(rev, "the signing keys could not be loaded (" + e.getMessage() + ").");
        }
        // The edge embeds the stored bundle text byte-for-byte; re-serialisation is the fallback.
        String raw = Signatures.rawMember(text, "bundle");
        boolean verified = raw != null && Signatures.verifyBundleText(keys, info, raw.getBytes(StandardCharsets.UTF_8));
        if (!verified) {
            String again = bundle.toJson();
            if (!again.equals(raw) && Signatures.verifyBundleText(keys, info, again.getBytes(StandardCharsets.UTF_8))) {
                verified = true;
                raw = again;
            }
        }
        if (!verified) throw reject(rev, "its signature does not verify.");
        synchronized (lock) {
            pinnedEnvironment = envId;
        }
        return new Snapshot(bundle, etag, checksum, info, raw);
    }

    private static NanoFlagsException reject(long rev, String why) {
        return new NanoFlagsException(ErrorCode.SIGNATURE, "Bundle r" + rev + " was rejected: " + why + " The configuration in use is unchanged.");
    }

    /* ---------------- persistence ---------------- */

    void persist(Snapshot s) {
        Store store = cfg.store;
        if (store == null) return;
        String raw = s.raw != null ? s.raw : s.bundle.toJson();
        StringBuilder doc = new StringBuilder("{\"v\":1,\"id\":").append(new JsonValue.Str(id).toJson());
        if (!s.etag.isEmpty()) doc.append(",\"etag\":").append(new JsonValue.Str(s.etag).toJson());
        if (!s.checksum.isEmpty()) doc.append(",\"checksum\":").append(new JsonValue.Str(s.checksum).toJson());
        doc.append(",\"savedAt\":").append(new JsonValue.Str(isoNow()).toJson());
        doc.append(",\"bundle\":").append(raw);
        if (s.sig != null) doc.append(",\"sig\":").append(s.sig.toJson().toJson());
        doc.append('}');
        try {
            store.save(doc.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException | RuntimeException e) {
            emitError(new NanoFlagsException(ErrorCode.STORE, "Could not persist the bundle: " + e, 0, e));
        }
    }

    private void restore() {
        Store store = cfg.store;
        if (store == null) return;
        byte[] data;
        try {
            data = store.load();
        } catch (IOException | RuntimeException e) {
            emitError(new NanoFlagsException(ErrorCode.STORE, "Could not read the persisted bundle: " + e, 0, e));
            return;
        }
        if (data == null || data.length == 0) return;
        String text = new String(data, StandardCharsets.UTF_8);
        JsonValue p;
        try {
            p = JsonValue.parse(text);
        } catch (InvalidJsonException e) {
            return;
        }
        if (!new JsonValue.Num(1).equals(p.field("v")) || !new JsonValue.Str(id).equals(p.field("id"))) return;
        // The exact bytes that were signed.
        String raw = Signatures.rawMember(text, "bundle");
        Bundle bundle = raw == null ? null : Bundle.parse(raw);
        if (bundle == null) return;
        if (!bundle.supportsEngine()) {
            emitError(engineError(bundle));
            return;
        }
        Snapshot cur = snap.get();
        if (cur != null && cur.bundle.revision() >= bundle.revision()) return;
        String etag = p.field("etag") instanceof JsonValue.Str ? ((JsonValue.Str) p.field("etag")).value() : "";
        String checksum = p.field("checksum") instanceof JsonValue.Str ? ((JsonValue.Str) p.field("checksum")).value() : "";
        Snapshot next = new Snapshot(bundle, etag, checksum, null, null);
        Verifier v = verifier;
        if (v != null) {
            // The store is outside the trust boundary: a signed copy must verify again, and with require an unsigned copy is not used at all.
            Signatures.Info s = Signatures.Info.fromJson(p.field("sig"));
            if (s != null && s.revision == bundle.revision()) {
                boolean ok;
                try {
                    ok = Signatures.verifyBundleText(v.keysFor(s.kid), s, raw.getBytes(StandardCharsets.UTF_8));
                } catch (NanoFlagsException | InterruptedException e) {
                    ok = false;
                }
                if (!ok) {
                    emitError(new NanoFlagsException(ErrorCode.SIGNATURE, "The persisted bundle failed signature verification and was ignored."));
                    return;
                }
                next = new Snapshot(bundle, etag, checksum, s, raw);
                synchronized (lock) {
                    if (pinnedEnvironment == null) pinnedEnvironment = s.environmentId;
                }
            } else if (v.require) {
                return;
            }
        }
        synchronized (adoptLock) {
            cur = snap.get();
            if (cur != null && cur.bundle.revision() >= bundle.revision()) return;
            // A restored bundle is usable but not known to be current: stale until the edge confirms it.
            adopt(next, Status.STALE, Source.STORE, Transport.POLL, null);
        }
    }

    static String isoNow() { return ISO_MILLIS.format(Instant.now()); }

    String etagKind() { return browserKey ? "client" : "server"; }

    /* ---------------- evaluation ---------------- */

    private static boolean isFinite(JsonValue v) {
        return v instanceof JsonValue.Num && !Double.isNaN(((JsonValue.Num) v).value()) && !Double.isInfinite(((JsonValue.Num) v).value());
    }

    private static boolean isInt(JsonValue v) {
        if (!isFinite(v)) return false;
        double d = ((JsonValue.Num) v).value();
        return d == Math.floor(d) && d >= Integer.MIN_VALUE && d <= Integer.MAX_VALUE;
    }

    private static boolean isLong(JsonValue v) {
        if (!isFinite(v)) return false;
        double d = ((JsonValue.Num) v).value();
        return d == Math.floor(d) && Math.abs(d) <= 9.007199254740992E15;
    }

    private EngineResult eval(String key, Map<String, ?> ctx, JsonValue fallback, Predicate<JsonValue> accepts, boolean record) {
        Snapshot s = snap.get();
        Map<String, ?> c = ctx == null ? Collections.emptyMap() : ctx;
        EngineResult res;
        try {
            res = Engine.evaluate(s == null ? JsonValue.NULL : s.bundle.value(), key, EvalContext.of(c), fallback);
        } catch (RuntimeException e) { // a context whose map throws on access
            String msg = String.valueOf(e.getMessage());
            res = new EngineResult(key, fallback, Reason.ERROR, -1, JsonValue.UNDEFINED, null, null, null,
                Collections.singletonList(new TraceStep("result", "Returned the fallback", "Evaluation error: " + msg)), msg);
        }
        if (accepts != null && res.reason() != Reason.FLAG_NOT_FOUND && res.reason() != Reason.ERROR && !accepts.test(res.value())) {
            String msg = "Flag \"" + key + "\" has a " + res.value().typeName() + " value, which does not match the requested type.";
            List<TraceStep> trace = new ArrayList<>(res.trace());
            trace.add(new TraceStep("result", "Returned the fallback", msg));
            res = new EngineResult(key, fallback, Reason.ERROR, -1, JsonValue.UNDEFINED, null, null, res.revision(), trace, msg);
        }
        if (record) events.record(res, c, s);
        return res;
    }

    private static <T> EvaluationDetail<T> detail(EngineResult r, T value) {
        String ruleId = null;
        if (r.ruleIndex() >= 0) ruleId = r.ruleId() instanceof JsonValue.Str ? ((JsonValue.Str) r.ruleId()).value() : r.ruleId().toJson();
        long rev = isFinite(r.revision()) ? (long) ((JsonValue.Num) r.revision()).value() : 0L;
        return new EvaluationDetail<>(r.flagKey(), value, r.reason(), r.ruleIndex(), ruleId, r.inRollout(), r.bucket(), rev, r.trace(), r.error(), r.value());
    }

    private static boolean failed(EngineResult r) { return r.reason() == Reason.ERROR || r.reason() == Reason.FLAG_NOT_FOUND; }

    /** The boolean value of flag {@code key} for {@code context}, or {@code fallback} when it is missing, not loaded, or serves another type. */
    public boolean boolVariation(String key, Map<String, ?> context, boolean fallback) { return boolVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<Boolean> boolVariationDetail(String key, Map<String, ?> context, boolean fallback) {
        EngineResult r = eval(key, context, JsonValue.Bool.of(fallback), v -> v instanceof JsonValue.Bool, true);
        return detail(r, r.value() instanceof JsonValue.Bool ? ((JsonValue.Bool) r.value()).value() : fallback);
    }

    /** The string value of flag {@code key}, or {@code fallback}. */
    public String stringVariation(String key, Map<String, ?> context, String fallback) { return stringVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<String> stringVariationDetail(String key, Map<String, ?> context, String fallback) {
        EngineResult r = eval(key, context, fallback == null ? JsonValue.NULL : new JsonValue.Str(fallback), v -> v instanceof JsonValue.Str, true);
        return detail(r, failed(r) || !(r.value() instanceof JsonValue.Str) ? fallback : ((JsonValue.Str) r.value()).value());
    }

    /** The (finite) numeric value of flag {@code key}, or {@code fallback}. */
    public double doubleVariation(String key, Map<String, ?> context, double fallback) { return doubleVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<Double> doubleVariationDetail(String key, Map<String, ?> context, double fallback) {
        EngineResult r = eval(key, context, new JsonValue.Num(fallback), NanoFlagsClient::isFinite, true);
        return detail(r, isFinite(r.value()) ? ((JsonValue.Num) r.value()).value() : fallback);
    }

    /** The value of a number flag that serves whole numbers in the {@code int} range, or {@code fallback}. */
    public int intVariation(String key, Map<String, ?> context, int fallback) { return intVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<Integer> intVariationDetail(String key, Map<String, ?> context, int fallback) {
        EngineResult r = eval(key, context, new JsonValue.Num(fallback), NanoFlagsClient::isInt, true);
        return detail(r, isInt(r.value()) ? (int) ((JsonValue.Num) r.value()).value() : fallback);
    }

    /** The value of a number flag that serves whole numbers (|n| ≤ 2^53), or {@code fallback}. */
    public long longVariation(String key, Map<String, ?> context, long fallback) { return longVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<Long> longVariationDetail(String key, Map<String, ?> context, long fallback) {
        EngineResult r = eval(key, context, new JsonValue.Num(fallback), NanoFlagsClient::isLong, true);
        return detail(r, isLong(r.value()) ? (long) ((JsonValue.Num) r.value()).value() : fallback);
    }

    /**
     * The value of a JSON flag as plain Java data ({@code null}, {@link Boolean}, {@link Double}, {@link String},
     * {@link List}, {@link Map} in configuration order), or {@code fallback}. Any served value is accepted except none at all.
     */
    public Object jsonVariation(String key, Map<String, ?> context, Object fallback) { return jsonVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<Object> jsonVariationDetail(String key, Map<String, ?> context, Object fallback) {
        EngineResult r = eval(key, context, JsonValue.of(fallback), v -> !v.isUndefined(), true);
        return detail(r, failed(r) ? fallback : r.value().toJava());
    }

    /** {@link #jsonVariation} with JavaScript-typed values ({@link JsonValue}). */
    public JsonValue jsonValueVariation(String key, Map<String, ?> context, JsonValue fallback) { return jsonValueVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<JsonValue> jsonValueVariationDetail(String key, Map<String, ?> context, JsonValue fallback) {
        JsonValue fb = fallback == null ? JsonValue.NULL : fallback;
        EngineResult r = eval(key, context, fb, v -> !v.isUndefined(), true);
        return detail(r, failed(r) ? fb : r.value());
    }

    /** The full engine result without any type check ({@code fallback} is converted with {@link JsonValue#of(Object)}). */
    public EvaluationDetail<Object> evaluate(String key, Map<String, ?> context, Object fallback) {
        EngineResult r = eval(key, context, JsonValue.of(fallback), null, true);
        return detail(r, failed(r) ? fallback : r.value().toJava());
    }

    /** Every flag of the configuration in use, as plain Java values (no telemetry). Empty without a configuration. */
    public Map<String, Object> allFlags(Map<String, ?> context) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, EvaluationDetail<Object>> e : allFlagsDetail(context).entrySet()) out.put(e.getKey(), e.getValue().value());
        return out;
    }

    public Map<String, EvaluationDetail<Object>> allFlagsDetail(Map<String, ?> context) {
        Map<String, EvaluationDetail<Object>> out = new LinkedHashMap<>();
        Snapshot s = snap.get();
        if (s == null) return out;
        EvalContext c = EvalContext.of(context == null ? Collections.<String, Object>emptyMap() : context);
        for (String k : s.bundle.flagKeys()) {
            EngineResult r = s.bundle.evaluate(k, c, JsonValue.NULL);
            if (r.reason() == Reason.FLAG_NOT_FOUND) continue; // keys whose entry is not a flag at all
            out.put(k, detail(r, r.value().toJava()));
        }
        return out;
    }

    @Override public String toString() {
        return "NanoFlagsClient{" + cfg.baseUrl + ", status=" + status() + ", revision=" + revision() + ", transport=" + transport() + "}";
    }
}
