package io.nanoflags.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.nanoflags.server.NanoFlagsOptions.EventsOptions;
import io.nanoflags.server.engine.JsonValue;
import io.nanoflags.server.engine.Reason;
import java.net.URI;
import java.net.http.HttpRequest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import okhttp3.mockwebserver.MockResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

@Timeout(value = 60, unit = TimeUnit.SECONDS)
class SessionTest {
    static final String KEY = "nf_srv_0123456789abcdef";
    static final String A = "nf_ts_aaaaaaaaaaaaaaaa";
    static final String B = "nf_ts_bbbbbbbbbbbbbbbb";
    static final String ID_A = "8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11";
    FakeEdge edge;
    final List<NanoFlagsClient> clients = new ArrayList<>();
    final List<NanoFlagsException> errors = new CopyOnWriteArrayList<>();

    /** Published r1 serves "relevance-v1"; the sessions pin drafts serving their label ("<label>-vip" for plan=vip). */
    static String ranking(String label) {
        return "{\"search-ranking\":{\"type\":\"string\",\"enabled\":true,\"default\":\"" + label + "\",\"off\":\"off\",\"rules\":["
            + "{\"id\":\"vip\",\"match\":\"all\",\"conditions\":[{\"attribute\":\"plan\",\"op\":\"eq\",\"value\":\"vip\"}],\"serve\":{\"type\":\"fixed\",\"value\":\"" + label + "-vip\"}}]},"
            + "\"max-items\":{\"type\":\"number\",\"enabled\":true,\"default\":20,\"off\":0,\"rules\":[]}}";
    }

    static MockResponse session(String id, String label, String context, Duration expiresIn) {
        String bundle = "{\"schema\":1,\"engine\":1,\"revision\":0,\"flags\":" + ranking(label) + ",\"segments\":{}}";
        return new MockResponse().addHeader("Cache-Control", "no-store").setBody("{\"id\":\"" + id + "\",\"checksum\":\"s\",\"source\":\"draft\",\"revision\":null,\"context\":" + context
            + ",\"expires_at\":\"" + Instant.now().plus(expiresIn) + "\",\"bundle\":" + bundle + "}");
    }

    @BeforeEach
    void setUp() throws Exception {
        edge = new FakeEdge();
        edge.setFlags(1, ranking("relevance-v1"), 1);
        edge.sessions.put(A, () -> session(ID_A, "session-a", "{\"plan\":\"vip\",\"key\":\"synthetic-user\"}", Duration.ofMinutes(1)));
        edge.sessions.put(B, () -> session("9e4d2b63-1e70-4d4f-8e76-1f9f1f7b2c22", "session-b", "{}", Duration.ofMinutes(1)));
    }

    @AfterEach
    void tearDown() {
        for (NanoFlagsClient c : clients) c.close();
        edge.close();
    }

    NanoFlagsClient client(EventsOptions events) {
        NanoFlagsClient c = NanoFlagsClient.create(KEY, NanoFlagsOptions.builder().baseUrl(edge.baseUrl()).service("checkout-api")
            .verify(VerifyOptions.builder().publicKey(edge.key1.jwk).require(true).build()).events(events).live(false).streaming(false).random(() -> 0.0).build());
        clients.add(c);
        c.onError(errors::add);
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        return c;
    }

    NanoFlagsClient client() { return client(EventsOptions.disabled()); }

    @Test
    void evaluatesThePinnedBundleWithTheMergedContext() {
        NanoFlagsClient c = client();
        SessionEvaluator s = c.session(A);
        assertTrue(s.isActive());
        assertEquals(ID_A, s.id());
        assertTrue(s.expiresAt().isAfter(Instant.now()));
        assertEquals(0, s.revision());
        assertEquals("session-a-vip", s.stringVariation("search-ranking", null, "fb")); // plan=vip from the session
        assertEquals("session-a", s.stringVariation("search-ranking", Map.of("plan", "free"), "fb")); // the call wins
        EvaluationDetail<String> d = s.stringVariationDetail("search-ranking", Map.of(), "fb");
        assertEquals(Reason.RULE_MATCH, d.reason());
        assertEquals("vip", d.ruleId());
        assertEquals(0, d.revision());
        assertTrue(s.boolVariation("search-ranking", null, true)); // typed accessors keep their type check
        assertEquals(20, s.intVariation("max-items", null, 1));
        // The client itself is untouched.
        assertEquals("relevance-v1-vip", c.stringVariation("search-ranking", Map.of("plan", "vip"), "fb"));
        assertEquals(1, c.revision());
        assertEquals(1, edge.sessionRequests.size());
        okhttp3.mockwebserver.RecordedRequest r = edge.sessionRequests.get(0);
        assertEquals(A, r.getHeader("X-NanoFlags-Session"));
        assertEquals("checkout-api", r.getHeader("X-NanoFlags-Service"));
        assertEquals("Bearer " + KEY, r.getHeader("Authorization"));
        assertFalse(r.getPath().contains("nf_ts_"));
        assertTrue(errors.isEmpty());
    }

    @Test
    void looksUpOncePerTokenAndServiceAlsoForConcurrentCallers() throws Exception {
        NanoFlagsClient c = client();
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Future<SessionEvaluator>> fs = new ArrayList<>();
            for (int i = 0; i < 32; i++) fs.add(pool.submit(() -> c.session(A)));
            for (Future<SessionEvaluator> f : fs) assertTrue(f.get().isActive());
        } finally {
            pool.shutdownNow();
        }
        c.session(A);
        assertEquals(1, edge.sessionRequests.size());
        c.session(A, "other-service"); // permission is per service: its own lookup
        assertEquals(2, edge.sessionRequests.size());
        assertEquals("other-service", edge.sessionRequests.get(1).getHeader("X-NanoFlags-Service"));
    }

    @Test
    void unknownAndMalformedTokensFallBackWithoutErrors() {
        NanoFlagsClient c = client();
        SessionEvaluator s = c.session("nf_ts_unknown0000000");
        assertFalse(s.isActive());
        assertNull(s.id());
        assertNull(s.expiresAt());
        assertEquals(1, s.revision());
        assertEquals("relevance-v1-vip", s.stringVariation("search-ranking", Map.of("plan", "vip"), "fb"));
        c.session("nf_ts_unknown0000000"); // a miss is remembered
        for (String bad : new String[] {null, "", "has space", "line\nbreak", "x".repeat(513)}) assertFalse(c.session(bad).isActive());
        assertEquals(1, edge.sessionRequests.size());
        assertTrue(errors.isEmpty());
    }

    @Test
    void failuresAreReportedAndFallBack() throws Exception {
        NanoFlagsClient c = client();
        edge.sessions.put("nf_ts_1", () -> new MockResponse().setResponseCode(500));
        edge.sessions.put("nf_ts_2", () -> new MockResponse().setBody("{\"id\":\"x\",\"bundle\":{\"nope\":true},\"expires_at\":\"2999-01-01T00:00:00Z\"}"));
        edge.sessions.put("nf_ts_3", () -> session("old", "old", "{}", Duration.ofSeconds(-1)));
        edge.sessions.put("nf_ts_4", () -> new MockResponse().setBody("{\"id\":\"x\",\"context\":{},\"expires_at\":\"2999-01-01T00:00:00+00:00\",\"bundle\":{\"schema\":1,\"revision\":1,\"flags\":{},\"segments\":{},\"engine\":99}}"));
        edge.sessions.put("nf_ts_5", () -> new MockResponse().setResponseCode(403));
        for (String t : new String[] {"nf_ts_1", "nf_ts_2", "nf_ts_3", "nf_ts_4", "nf_ts_5"}) {
            SessionEvaluator s = c.session(t);
            assertFalse(s.isActive(), t);
            assertEquals("relevance-v1", s.stringVariation("search-ranking", null, "fb"));
        }
        ClientTest.await("errors", 5_000, () -> errors.size() == 4);
        List<ErrorCode> codes = new ArrayList<>();
        for (NanoFlagsException e : errors) codes.add(e.code());
        assertEquals(List.of(ErrorCode.SESSION, ErrorCode.SESSION, ErrorCode.ENGINE, ErrorCode.UNAUTHORIZED), codes); // expiry is not an error
        assertEquals(500, errors.get(0).httpStatus());
        // A failure is remembered for 3 s, not forever.
        c.session("nf_ts_1");
        assertEquals(5, edge.sessionRequests.size());
    }

    @Test
    void anExpiredSessionFallsBackAndIsLookedUpAgain() {
        edge.sessions.put("nf_ts_short", () -> session("short", "short", "{}", Duration.ofMillis(400)));
        NanoFlagsClient c = client();
        SessionEvaluator s = c.session("nf_ts_short");
        assertTrue(s.isActive());
        assertEquals("short", s.stringVariation("search-ranking", null, "fb"));
        ClientTest.await("expiry", 5_000, () -> !s.isActive());
        assertEquals(1, s.revision());
        assertEquals("relevance-v1", s.stringVariation("search-ranking", null, "fb"));
        assertEquals("short", s.id()); // still says which session it was
        edge.sessions.remove("nf_ts_short");
        assertFalse(c.session("nf_ts_short").isActive());
        assertEquals(2, edge.sessionRequests.size());
    }

    @Test
    void aNewPublishedRevisionDoesNotChangeAnActiveSession() {
        NanoFlagsClient c = client();
        SessionEvaluator s = c.session(B);
        edge.setFlags(2, ranking("relevance-v2"), 1);
        c.refresh();
        assertEquals("relevance-v2", c.stringVariation("search-ranking", null, "fb"));
        assertEquals("session-b", s.stringVariation("search-ranking", null, "fb"));
    }

    @Test
    void eventsCarryTheSessionId() {
        NanoFlagsClient c = client(EventsOptions.builder().sampleRate(1).flushInterval(Duration.ofHours(1)).build());
        c.session(A).stringVariation("search-ranking", null, "fb");
        c.stringVariation("search-ranking", Map.of("plan", "vip"), "fb");
        c.session("nf_ts_unknown0000000").stringVariation("search-ranking", null, "fb");
        c.flush();
        ClientTest.await("events", 5_000, () -> !edge.events.isEmpty());
        List<JsonValue> evs = ((JsonValue.Arr) edge.events.get(edge.events.size() - 1).field("events")).items();
        assertEquals(3, evs.size());
        assertEquals(ID_A, ((JsonValue.Str) evs.get(0).field("sessionId")).value());
        assertEquals("session-a-vip", ((JsonValue.Str) evs.get(0).field("value")).value());
        assertEquals(0.0, ((JsonValue.Num) evs.get(0).field("revision")).value());
        assertEquals("{\"plan\":\"string\"}", evs.get(0).field("context").toJson()); // merged context, names and types only
        assertTrue(evs.get(1).field("sessionId").isUndefined());
        assertTrue(evs.get(2).field("sessionId").isUndefined());
    }

    @Test
    void scopesAreThreadConfinedNestAndRestore() throws Exception {
        assertNull(TestSessions.currentSession());
        assertTrue(TestSessions.sessionHeaders().isEmpty());
        TestSessions.withSession(" " + A + " ", () -> {
            assertEquals(A, TestSessions.currentSession());
            assertEquals(Map.of("x-nanoflags-session", A), TestSessions.sessionHeaders());
            assertEquals(B, TestSessions.withSession(B, TestSessions::currentSession));
            assertNull(TestSessions.withSession("bad token", TestSessions::currentSession)); // malformed: outside any session
            assertEquals(A, TestSessions.currentSession());
            HttpRequest req = TestSessions.propagate(HttpRequest.newBuilder(URI.create("http://downstream.test/"))).build();
            assertEquals(A, req.headers().firstValue("x-nanoflags-session").orElse(null));
            Thread other = new Thread(() -> assertNull(TestSessions.currentSession()));
            other.start();
            try {
                other.join();
            } catch (InterruptedException e) {
                throw new AssertionError(e);
            }
            String[] seen = new String[1];
            Thread wrapped = new Thread(TestSessions.wrap((Runnable) () -> seen[0] = TestSessions.currentSession()));
            wrapped.start();
            try {
                wrapped.join();
            } catch (InterruptedException e) {
                throw new AssertionError(e);
            }
            assertEquals(A, seen[0]);
        });
        assertNull(TestSessions.currentSession());
        assertTrue(TestSessions.propagate(HttpRequest.newBuilder(URI.create("http://downstream.test/"))).build().headers().map().isEmpty());
    }

    @Test
    void flagsForIsolatesConcurrentRequests() throws Exception {
        NanoFlagsClient c = client();
        String[] tokens = {A, B, null, "nf_ts_unknown0000000"};
        String[] want = {"session-a-vip", "session-b", "relevance-v1", "relevance-v1"};
        ExecutorService pool = Executors.newFixedThreadPool(12);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<String>> fs = new ArrayList<>();
            for (int i = 0; i < 90; i++) {
                int n = i;
                fs.add(pool.submit(() -> {
                    start.await();
                    return TestSessions.withSession(tokens[n % 4], () -> {
                        SessionEvaluator f = TestSessions.flagsFor(c);
                        if (tokens[n % 4] != null) assertSame(f, TestSessions.flagsFor(c)); // resolved once per request
                        Thread.yield();
                        String v = f.stringVariation("search-ranking", null, "fb");
                        assertEquals(tokens[n % 4], TestSessions.currentSession()); // an unknown session is still propagated
                        return v;
                    });
                }));
            }
            start.countDown();
            for (int i = 0; i < fs.size(); i++) assertEquals(want[i % 4], fs.get(i).get(), "request " + i);
        } finally {
            pool.shutdownNow();
        }
        assertFalse(TestSessions.flagsFor(c).isActive());
        assertEquals(3, edge.sessionRequests.size());
    }

    @Test
    void asyncLookupAndClose() throws Exception {
        NanoFlagsClient c = client();
        assertTrue(c.sessionAsync(A).get(10, TimeUnit.SECONDS).isActive());
        c.close();
        assertFalse(c.session(B).isActive());
        assertEquals("relevance-v1", c.session(A).stringVariation("search-ranking", null, "fb"));
    }
}
