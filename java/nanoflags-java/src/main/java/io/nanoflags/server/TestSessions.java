package io.nanoflags.server;

import java.net.http.HttpRequest;
import java.util.Collections;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * Test-session propagation for servers: the session of the request being handled is held per thread, so it follows
 * the request through the code that handles it, is invisible to every other request, and ends with the scope.
 * Nothing is stored on the client.
 *
 * <p>A servlet filter (no dependency is needed in the SDK; use {@code jakarta.servlet} or {@code javax.servlet}):
 *
 * <pre>{@code
 * public final class NanoFlagsSessionFilter implements Filter {
 *     public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain) throws IOException, ServletException {
 *         try (TestSessions.Scope scope = TestSessions.open(((HttpServletRequest) req).getHeader(TestSessions.HEADER))) {
 *             TestSessions.flagsFor(flags); // resolve the session once, before the handler runs
 *             chain.doFilter(req, res);
 *         }
 *     }
 * }
 *
 * // in a handler
 * boolean v2 = TestSessions.flagsFor(flags).boolVariation("checkout-v2", Map.of("key", userId), false);
 * HttpRequest call = TestSessions.propagate(HttpRequest.newBuilder(pricingUri)).build(); // the next service joins
 * }</pre>
 *
 * <p>Work handed to other threads does not inherit the scope: wrap it with {@link #wrap(Runnable)} /
 * {@link #wrap(Callable)}.
 */
public final class TestSessions {
    /** The header that carries a test-session token between services ({@code "x-nanoflags-session"}). */
    public static final String HEADER = Sessions.HEADER;

    private static final ThreadLocal<Scope> CURRENT = new ThreadLocal<>();

    private TestSessions() {}

    /**
     * The test session of one request. {@link #close()} restores the scope that was current when it was opened (and
     * must run on that thread). A scope opened with an absent or malformed token runs outside any session.
     */
    public static final class Scope implements AutoCloseable {
        private final String token; // null: outside any session
        private final Map<NanoFlagsClient, SessionEvaluator> evaluators;
        private final Scope previous;
        private final Thread owner;
        private boolean closed;

        private Scope(String token, Map<NanoFlagsClient, SessionEvaluator> evaluators, Scope previous) {
            this.token = token;
            this.evaluators = evaluators;
            this.previous = previous;
            this.owner = Thread.currentThread();
        }

        /** The token of this scope's session, or {@code null}. */
        public String token() { return token; }

        @Override public void close() {
            if (closed || Thread.currentThread() != owner) return;
            closed = true;
            if (previous == null) CURRENT.remove();
            else CURRENT.set(previous);
        }
    }

    private static String clean(String token) {
        if (token == null) return null;
        String t = token.trim();
        return Sessions.isToken(t) ? t : null;
    }

    /** Makes {@code token} the current test session of this thread until the returned scope is closed. */
    public static Scope open(String token) {
        String t = clean(token);
        Scope s = new Scope(t, t == null ? Collections.emptyMap() : new ConcurrentHashMap<>(), CURRENT.get());
        CURRENT.set(s);
        return s;
    }

    /** Runs {@code fn} with {@code token} as the current test session. An absent or malformed token runs it outside any session. */
    public static <T> T withSession(String token, Supplier<T> fn) {
        try (Scope ignored = open(token)) {
            return fn.get();
        }
    }

    /** {@link #withSession(String, Supplier)} for code without a result. */
    public static void withSession(String token, Runnable fn) {
        try (Scope ignored = open(token)) {
            fn.run();
        }
    }

    /** The token of the test session the current request belongs to, or {@code null}. */
    public static String currentSession() {
        Scope s = CURRENT.get();
        return s == null ? null : s.token;
    }

    /** Headers to add to downstream calls so that the next service joins the same session; empty outside a session. */
    public static Map<String, String> sessionHeaders() {
        String t = currentSession();
        return t == null ? Collections.emptyMap() : Collections.singletonMap(HEADER, t);
    }

    /** Adds {@code x-nanoflags-session} to {@code request} inside a session; returns it unchanged otherwise. */
    public static HttpRequest.Builder propagate(HttpRequest.Builder request) {
        String t = currentSession();
        if (t != null) request.setHeader(HEADER, t);
        return request;
    }

    /**
     * The evaluator for the current request: session-scoped inside {@link #open} / {@link #withSession}, otherwise
     * equivalent to the client. The session is resolved once per scope and client (the first call may wait for the
     * edge). Never throws.
     */
    public static SessionEvaluator flagsFor(NanoFlagsClient client) { return flagsFor(client, null); }

    /** {@link #flagsFor(NanoFlagsClient)} with the service sent as {@code X-NanoFlags-Service} on the lookup. */
    public static SessionEvaluator flagsFor(NanoFlagsClient client, String service) {
        Objects.requireNonNull(client, "client");
        Scope s = CURRENT.get();
        if (s == null || s.token == null) return new SessionEvaluator(client, null);
        SessionEvaluator hit = s.evaluators.get(client);
        if (hit != null) return hit;
        SessionEvaluator ev = client.session(s.token, service);
        SessionEvaluator prev = s.evaluators.putIfAbsent(client, ev);
        return prev != null ? prev : ev;
    }

    /** {@code task}, run inside the session that is current now (for executors and other threads). */
    public static Runnable wrap(Runnable task) {
        Objects.requireNonNull(task, "task");
        Scope captured = CURRENT.get();
        return () -> {
            Scope before = CURRENT.get();
            set(captured);
            try {
                task.run();
            } finally {
                set(before);
            }
        };
    }

    /** {@code task}, run inside the session that is current now (for executors and other threads). */
    public static <T> Callable<T> wrap(Callable<T> task) {
        Objects.requireNonNull(task, "task");
        Scope captured = CURRENT.get();
        return () -> {
            Scope before = CURRENT.get();
            set(captured);
            try {
                return task.call();
            } finally {
                set(before);
            }
        };
    }

    private static void set(Scope s) {
        if (s == null) CURRENT.remove();
        else CURRENT.set(s);
    }
}
