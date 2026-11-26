package io.nanoflags.server;

import io.nanoflags.server.engine.Bundle;
import io.nanoflags.server.engine.InvalidJsonException;
import io.nanoflags.server.engine.JsonValue;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Push transports: the live WebSocket {@code GET /v1/live} (the edge pushes each signed revision; ping every
 * ~30 s, 10 s pong timeout, replaced every ~50 min, jittered exponential reconnect backoff) and, while no socket can
 * be opened, server-sent events {@code GET /v1/stream} (which only announce revisions that are then fetched).
 */
final class Live {
    static final long PING_MS = 30_000;
    static final long PONG_TIMEOUT_MS = 10_000;
    static final long MAX_BACKOFF_MS = 5 * 60_000;
    static final long ROTATE_MS = 50 * 60_000; // the edge drops sockets older than 2 h; replace earlier
    static final int READ_LIMIT = 8 << 20;
    static final long STABLE_WINDOW_MS = 30_000;

    private final NanoFlagsClient c;
    private final AtomicBoolean liveOpen = new AtomicBoolean();
    private final AtomicBoolean streaming = new AtomicBoolean();
    private volatile Thread liveThread;
    private volatile WebSocket socket;
    private volatile CompletableFuture<Integer> socketClosed;

    // SSE state (guarded by c.lock)
    private Thread streamThread;
    private InputStream streamBody;

    Live(NanoFlagsClient c) { this.c = c; }

    boolean isOpen() { return liveOpen.get(); }

    boolean isStreaming() { return streaming.get(); }

    static long jitter(long ms, double lo, double hi) { return (long) (ms * (lo + (hi - lo) * ThreadLocalRandom.current().nextDouble())); }

    void start() {
        if (!c.cfg.streaming) return;
        if (c.cfg.live) {
            Thread t = NanoFlagsClient.daemon("nanoflags-live").newThread(this::liveLoop);
            liveThread = t;
            t.start();
            return;
        }
        startStream();
    }

    void shutdown() {
        stopStream();
        kill();
        Thread t = liveThread;
        if (t != null) t.interrupt();
    }

    void join() {
        Thread t = liveThread;
        if (t != null && t != Thread.currentThread()) {
            try {
                t.join(5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        Thread s;
        synchronized (c.lock) {
            s = streamThread;
        }
        if (s != null) {
            try {
                s.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private boolean sleep(long ms) {
        try {
            return !c.closedLatch.await(ms, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            return false;
        }
    }

    private String liveUrl() { return "ws" + c.cfg.baseUrl.substring(4) + "/v1/live"; }

    /** Keeps one live socket open; while none can be opened, SSE + polling take over. */
    private void liveLoop() {
        int attempt = 0;
        while (!c.closed.get()) {
            Result r = runSocket();
            if (c.closed.get()) return;
            if (r.deleted) {
                // Keep evaluating the last configuration; it can no longer be updated. No socket, no stream; the regular poll
                // stays (it reports the key as rejected, and recovers if the environment turns out to exist after all).
                synchronized (c.lock) {
                    c.environmentDeleted = true;
                }
                stopStream();
                if (c.snap.get() != null) c.setStatus(Status.STALE);
                c.emitError(new NanoFlagsException(ErrorCode.ENVIRONMENT_DELETED,
                    "The environment of this SDK key was deleted. The last configuration stays in use; it will not be updated."));
                c.reschedule();
                return;
            }
            if (r.rotating) continue; // planned replacement: no fallback, no backoff
            if (r.opened && r.openForMs > STABLE_WINDOW_MS) attempt = 1;
            else attempt++;
            if (!r.opened) startStream();
            else c.reschedule(); // back to the normal poll interval
            long wait = jitter(Math.min(MAX_BACKOFF_MS, 1000L << Math.min(attempt - 1, 10)), 0.5, 1.5);
            if (!sleep(wait)) return;
        }
    }

    private static final class Result {
        boolean opened;
        long openForMs;
        boolean rotating;
        boolean deleted;
    }

    /** Closes the current socket (for a rejected key); the loop reconnects with backoff. */
    void dropLive() {
        WebSocket ws = socket;
        if (ws != null) ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye").whenComplete((x, e) -> kill());
    }

    private void kill() {
        WebSocket ws = socket;
        if (ws != null) ws.abort();
        CompletableFuture<Integer> f = socketClosed;
        if (f != null) f.complete(-1);
    }

    private final class Listener implements WebSocket.Listener {
        final CompletableFuture<Integer> closed;
        final LinkedBlockingQueue<String> inbox;
        final AtomicLong lastMessage;
        private final StringBuilder buf = new StringBuilder();

        Listener(CompletableFuture<Integer> closed, LinkedBlockingQueue<String> inbox, AtomicLong lastMessage) {
            this.closed = closed;
            this.inbox = inbox;
            this.lastMessage = lastMessage;
        }

        @Override public void onOpen(WebSocket ws) { ws.request(1); }

        @Override
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            lastMessage.set(System.nanoTime());
            buf.append(data);
            if (buf.length() > READ_LIMIT) {
                buf.setLength(0);
                ws.abort();
                closed.complete(-1);
                return null;
            }
            if (last) {
                String m = buf.toString();
                buf.setLength(0);
                if (!m.equals("pong")) inbox.add(m);
            }
            ws.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket ws, ByteBuffer data, boolean last) {
            lastMessage.set(System.nanoTime());
            ws.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onPing(WebSocket ws, ByteBuffer message) {
            lastMessage.set(System.nanoTime());
            ws.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onPong(WebSocket ws, ByteBuffer message) {
            lastMessage.set(System.nanoTime());
            ws.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            closed.complete(statusCode);
            return null;
        }

        @Override public void onError(WebSocket ws, Throwable error) { closed.complete(-1); }
    }

    /** Connects once and serves the socket until it ends. */
    private Result runSocket() {
        Result r = new Result();
        CompletableFuture<Integer> closed = new CompletableFuture<>();
        LinkedBlockingQueue<String> inbox = new LinkedBlockingQueue<>();
        AtomicLong lastMessage = new AtomicLong(System.nanoTime());
        WebSocket ws;
        Duration connect = c.cfg.liveConnectTimeout;
        try {
            ws = c.http.newWebSocketBuilder()
                .header("Authorization", "Bearer " + c.sdkKey) // never in the URL
                .header("User-Agent", NanoFlagsClient.USER_AGENT)
                .subprotocols(NanoFlagsClient.LIVE_PROTOCOL)
                .connectTimeout(connect)
                .buildAsync(URI.create(liveUrl()), new Listener(closed, inbox, lastMessage))
                .get(connect.toMillis() + 2000, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            return r;
        } catch (ExecutionException | TimeoutException | RuntimeException e) {
            c.log.log(System.Logger.Level.DEBUG, "nanoflags: live socket unavailable: {0}", String.valueOf(e.getCause() != null ? e.getCause() : e));
            return r;
        }
        long openedAt = System.nanoTime();
        socket = ws;
        socketClosed = closed;
        if (c.closed.get()) {
            kill();
            return r;
        }
        r.opened = true;
        liveOpen.set(true);
        stopStream(); // SSE is not used while the socket is healthy
        c.reschedule(); // the poll becomes a safety net

        AtomicBoolean rotated = new AtomicBoolean();
        List<ScheduledFuture<?>> timers = new ArrayList<>();
        try {
            timers.add(c.scheduler.schedule(() -> {
                rotated.set(true);
                ws.sendClose(WebSocket.NORMAL_CLOSURE, "rotate");
                c.scheduler.schedule(() -> {
                    ws.abort();
                    closed.complete(-1);
                }, 5, TimeUnit.SECONDS);
            }, jitter(ROTATE_MS, 0.9, 1.1), TimeUnit.MILLISECONDS));
            schedulePing(ws, closed, lastMessage, timers);
        } catch (java.util.concurrent.RejectedExecutionException e) {
            kill(); // closing
        }

        while (!closed.isDone()) {
            String m;
            try {
                m = inbox.poll(250, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                kill();
                break;
            }
            if (m != null) applyPush(m);
        }
        for (String m; (m = inbox.poll()) != null; ) if (!c.closed.get()) applyPush(m);
        synchronized (timers) {
            for (ScheduledFuture<?> t : timers) t.cancel(false);
        }
        ws.abort();
        socket = null;
        socketClosed = null;
        liveOpen.set(false);
        r.openForMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - openedAt);
        r.rotating = rotated.get() && !c.closed.get();
        Integer code = closed.getNow(-1);
        r.deleted = code != null && code == NanoFlagsClient.CLOSE_ENVIRONMENT_DELETED;
        return r;
    }

    /** Text {@code ping} every ~30 s; the edge answers {@code pong}; silence for 10 s means a dead connection. */
    private void schedulePing(WebSocket ws, CompletableFuture<Integer> closed, AtomicLong lastMessage, List<ScheduledFuture<?>> timers) {
        if (closed.isDone()) return;
        ScheduledFuture<?> f = c.scheduler.schedule(() -> {
            if (closed.isDone()) return;
            long sentAt = System.nanoTime();
            ws.sendText("ping", true).whenComplete((x, err) -> {
                if (err != null) {
                    ws.abort();
                    closed.complete(-1);
                    return;
                }
                try {
                    ScheduledFuture<?> check = c.scheduler.schedule(() -> {
                        if (closed.isDone()) return;
                        if (lastMessage.get() - sentAt < 0) {
                            ws.abort();
                            closed.complete(-1);
                        } else {
                            schedulePing(ws, closed, lastMessage, timers);
                        }
                    }, PONG_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                    synchronized (timers) {
                        timers.add(check);
                    }
                } catch (java.util.concurrent.RejectedExecutionException ignored) {
                    // closing
                }
            });
        }, jitter(PING_MS, 0.9, 1.1), TimeUnit.MILLISECONDS);
        synchronized (timers) {
            timers.add(f);
        }
    }

    private static String str(JsonValue v) { return v instanceof JsonValue.Str ? ((JsonValue.Str) v).value() : null; }

    /** Applies one {@code rev} / {@code hello} message. A message that cannot be trusted changes nothing. */
    void applyPush(String data) {
        JsonValue m;
        try {
            m = JsonValue.parse(data);
        } catch (InvalidJsonException e) {
            return;
        }
        if (!(m instanceof JsonValue.Obj)) return;
        String t = str(m.field("t"));
        if (!"rev".equals(t) && !"hello".equals(t)) return;
        JsonValue revV = m.field("revision");
        String text = str(m.field("bundle"));
        // Revision 0 / no bundle: the environment has nothing published yet.
        if (!(revV instanceof JsonValue.Num) || text == null) return;
        double revF = ((JsonValue.Num) revV).value();
        if (revF != Math.floor(revF) || Double.isInfinite(revF) || revF < 1) return;
        long revision = (long) revF;
        long receivedAt = c.verifiedSequence();
        NanoFlagsClient.Snapshot cur = c.snap.get();
        // Never backwards. An older push than a verified revision is checked first (it is reported when it verifies);
        // anything else older is dropped silently.
        boolean older = cur != null && revision < cur.bundle.revision();
        if (older) {
            NanoFlagsClient.Verified floor = c.newestVerified();
            if (c.verifier == null || floor == null || revision >= floor.revision) return;
        }
        String checksum = str(m.field("checksum"));
        Signatures.Info info = null;
        Verifier v = c.verifier;
        if (v != null) {
            String sig = str(m.field("signature"));
            String envId = str(m.field("environmentId"));
            if (sig == null || sig.isEmpty() || envId == null || envId.isEmpty() || checksum == null) {
                rejectPush(revision, "it carries no complete signature.");
                return;
            }
            String pinned;
            synchronized (c.lock) {
                pinned = c.pinnedEnvironment;
            }
            if (pinned != null && !pinned.equals(envId)) {
                rejectPush(revision, "it was signed for a different environment.");
                return;
            }
            info = new Signatures.Info(sig, str(m.field("kid")), envId, revision, checksum);
            boolean ok;
            try {
                ok = Signatures.verifyBundleText(v.keysFor(info.kid), info, text.getBytes(StandardCharsets.UTF_8));
            } catch (NanoFlagsException | InterruptedException e) {
                ok = false;
            }
            if (!ok) {
                rejectPush(revision, "its signature does not verify.");
                return;
            }
        }
        if (older) {
            NanoFlagsException err = c.rollbackError(revision, receivedAt, NanoFlagsClient.VerifiedSource.LIVE);
            if (err != null) {
                c.updateRejected(err);
                c.trigger(); // the regular request path says what is really current (and confirms READY again)
            }
            return;
        }
        Bundle bundle = Bundle.parse(text);
        if (bundle == null || bundle.revision() != revision) {
            c.updateRejected(new NanoFlagsException(ErrorCode.INVALID_BUNDLE, "The edge pushed an invalid bundle; it was ignored."));
            return;
        }
        if (!bundle.supportsEngine()) {
            c.emitError(NanoFlagsClient.engineError(bundle));
            return;
        }
        NanoFlagsClient.Snapshot next;
        synchronized (c.adoptLock) {
            cur = c.snap.get();
            if (cur != null && revision < cur.bundle.revision()) return;
            if (cur != null && revision == cur.bundle.revision()) {
                // Already in use: the push only confirms that it is current. With verification the signed messages must be
                // equal (a signature binds environment, revision, checksum and the bundle's bytes); equal revision numbers
                // and checksum text alone are not enough.
                boolean same = info != null ? cur.sig != null && cur.sig.signature.equals(info.signature) : cur.checksum.isEmpty() || cur.checksum.equals(checksum);
                if (same) c.setStatus(Status.READY);
                return;
            }
            synchronized (c.lock) {
                if (info != null) c.pinnedEnvironment = info.environmentId;
                c.liveRevision = revision;
            }
            // What /v1/bundle would send as ETag for this revision, so the safety poll gets a 304.
            String etag = checksum != null ? "\"" + checksum + "-" + c.etagKind() + "\"" : null;
            next = new NanoFlagsClient.Snapshot(bundle, etag, checksum, info, text);
            Duration latency = null;
            JsonValue at = m.field("committedAt");
            if (at instanceof JsonValue.Num && !Double.isNaN(((JsonValue.Num) at).value())) {
                latency = Duration.ofMillis(System.currentTimeMillis() - (long) ((JsonValue.Num) at).value());
            }
            if (info != null) c.noteVerified(info, NanoFlagsClient.VerifiedSource.LIVE);
            c.adopt(next, Status.READY, Source.NETWORK, Transport.LIVE, latency);
        }
        c.persist(next);
    }

    private void rejectPush(long revision, String why) {
        c.updateRejected(new NanoFlagsException(ErrorCode.SIGNATURE, "Pushed bundle r" + revision + " was rejected: " + why + " The configuration in use is unchanged."));
        c.trigger(); // the regular (verified) request path says what is really current
    }

    /* ---------------- SSE fallback: GET /v1/stream ---------------- */

    void startStream() {
        synchronized (c.lock) {
            if (!c.cfg.streaming || streamThread != null || c.environmentDeleted || c.closed.get()) return;
            Thread t = NanoFlagsClient.daemon("nanoflags-stream").newThread(this::streamLoop);
            streamThread = t;
            streaming.set(true);
            t.start();
        }
    }

    void stopStream() {
        Thread t;
        InputStream in;
        synchronized (c.lock) {
            t = streamThread;
            in = streamBody;
            streamThread = null;
            streamBody = null;
        }
        streaming.set(false);
        if (t != null) t.interrupt();
        if (in != null) {
            try {
                in.close();
            } catch (IOException ignored) {
                // closing anyway
            }
        }
    }

    private boolean current() {
        synchronized (c.lock) {
            return streamThread == Thread.currentThread() && !c.closed.get();
        }
    }

    /** Reads server-sent events. The stream only says "revision N exists"; the bundle is always fetched conditionally. */
    private void streamLoop() {
        int attempt = 0;
        while (current()) {
            long started = System.nanoTime();
            boolean stop = readStream();
            if (!current()) return;
            if (stop) {
                synchronized (c.lock) {
                    if (streamThread == Thread.currentThread()) {
                        streamThread = null;
                        streaming.set(false);
                    }
                }
                return;
            }
            if (System.nanoTime() - started > TimeUnit.SECONDS.toNanos(30)) attempt = 0;
            else attempt++;
            long wait = jitter(Math.min(30_000, 1000L << Math.min(attempt, 5)), 0.5, 1.5);
            if (!sleep(wait)) return;
        }
    }

    /** Returns true when the stream must not be retried (the key was rejected or revoked). */
    private boolean readStream() {
        HttpResponse<InputStream> res;
        try {
            res = c.http.send(c.request("/v1/stream").header("Accept", "text/event-stream").GET().build(), HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException | RuntimeException e) {
            return false;
        } catch (InterruptedException e) {
            return false;
        }
        InputStream body = res.body();
        synchronized (c.lock) {
            if (streamThread != Thread.currentThread()) {
                closeQuietly(body);
                return false;
            }
            streamBody = body;
        }
        try {
            if (res.statusCode() == 401 || res.statusCode() == 403) return true; // polling keeps reporting the error
            if (res.statusCode() != 200) return false;
            BufferedReader in = new BufferedReader(new InputStreamReader(body, StandardCharsets.UTF_8));
            String event = "message";
            StringBuilder data = new StringBuilder();
            boolean hasData = false;
            String line;
            while ((line = in.readLine()) != null) {
                if (line.length() > 64 << 10) return false;
                if (line.isEmpty()) {
                    if (hasData) {
                        if (event.equals("revision")) onRevision(data.toString());
                        else if (event.equals("revoked")) {
                            c.trigger();
                            return true;
                        }
                    }
                    event = "message";
                    data.setLength(0);
                    hasData = false;
                    continue;
                }
                if (line.startsWith(":")) continue;
                int colon = line.indexOf(':');
                String field = colon < 0 ? line : line.substring(0, colon);
                String value = colon < 0 ? "" : line.substring(colon + 1);
                if (value.startsWith(" ")) value = value.substring(1);
                if (field.equals("event")) event = value;
                else if (field.equals("data")) {
                    if (hasData) data.append('\n');
                    data.append(value);
                    hasData = true;
                }
            }
            return false;
        } catch (IOException e) {
            return false;
        } finally {
            synchronized (c.lock) {
                if (streamBody == body) streamBody = null;
            }
            closeQuietly(body);
        }
    }

    private static void closeQuietly(InputStream in) {
        try {
            in.close();
        } catch (IOException ignored) {
            // ignore
        }
    }

    private void onRevision(String data) {
        JsonValue m;
        try {
            m = JsonValue.parse(data);
        } catch (InvalidJsonException e) {
            return;
        }
        JsonValue rev = m.field("revision");
        long r = rev instanceof JsonValue.Num ? (long) ((JsonValue.Num) rev).value() : 0;
        String checksum = str(m.field("checksum"));
        NanoFlagsClient.Snapshot cur = c.snap.get();
        if (cur == null || r != cur.bundle.revision() || !cur.checksum.equals(checksum == null ? "" : checksum) || c.status() != Status.READY) {
            c.markStreamTriggered();
            c.trigger();
        }
    }
}
