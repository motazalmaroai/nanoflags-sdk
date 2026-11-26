package io.nanoflags.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.nanoflags.server.NanoFlagsOptions.EventsOptions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Revision order (an older revision than one already verified is not adopted), the status after a rejected update,
 * the same-message check and the official edge address.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class RevisionOrderTest {
    static final String KEY = ClientTest.KEY;
    FakeEdge edge;
    final List<NanoFlagsClient> clients = new ArrayList<>();

    @BeforeEach
    void setUp() throws Exception { edge = new FakeEdge(); }

    @AfterEach
    void tearDown() {
        for (NanoFlagsClient c : clients) c.close();
        edge.close();
    }

    NanoFlagsOptions.Builder opts() {
        return NanoFlagsOptions.builder().baseUrl(edge.baseUrl()).service("test-svc")
            .verify(VerifyOptions.builder().publicKey(edge.key1.jwk).require(true).build())
            .events(EventsOptions.disabled()).live(false).streaming(false).pollInterval(Duration.ofMinutes(10));
    }

    NanoFlagsClient client(NanoFlagsOptions.Builder b) { return client(KEY, b); }

    NanoFlagsClient client(String key, NanoFlagsOptions.Builder b) {
        NanoFlagsClient c = NanoFlagsClient.create(key, b.build());
        clients.add(c);
        return c;
    }

    NanoFlagsClient liveClient() {
        NanoFlagsClient c = client(opts().live(true).streaming(true));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        ClientTest.await("live socket", 10_000, () -> c.transport() == Transport.LIVE && !edge.sockets.isEmpty());
        try {
            Thread.sleep(300); // the greeting of the socket has been handled
        } catch (InterruptedException e) {
            throw new AssertionError(e);
        }
        return c;
    }

    static List<NanoFlagsException> errorsOf(NanoFlagsClient c) {
        List<NanoFlagsException> errors = new CopyOnWriteArrayList<>();
        c.onError(errors::add);
        return errors;
    }

    /** A configuration whose only interesting content is the value of {@code accent} (and a boolean that is false by default). */
    void accent(long rev, String value) {
        edge.setFlags(rev, "{\"accent\":{\"type\":\"string\",\"enabled\":true,\"clientExposed\":true,\"default\":\"" + value + "\",\"off\":\"blue\",\"rules\":[]},"
            + "\"f\":{\"type\":\"boolean\",\"enabled\":true,\"clientExposed\":true,\"default\":false,\"off\":false,\"rules\":[]}}", 1);
    }

    static String accent(NanoFlagsClient c) { return c.stringVariation("accent", Map.of(), "x"); }

    static boolean has(List<NanoFlagsException> errors, ErrorCode code) {
        for (NanoFlagsException e : errors) if (e.code() == code) return true;
        return false;
    }

    static final class MemoryStore implements Store {
        volatile byte[] data;

        @Override public byte[] load() { return data; }

        @Override public void save(byte[] d) { data = d; }
    }

    @Test
    void olderRevisionIsNotAdoptedByFetch() {
        accent(5, "v5");
        NanoFlagsClient c = client(opts());
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        List<NanoFlagsException> errors = errorsOf(c);
        assertEquals(5, c.revision());

        accent(4, "v4");
        NanoFlagsException e = assertThrows(NanoFlagsException.class, c::refresh);
        assertEquals(ErrorCode.ROLLBACK, e.code());
        assertEquals("rollback", e.code().wire());
        assertEquals(5, c.revision());
        assertEquals("v5", accent(c));
        ClientTest.await("error listener", 5_000, () -> errors.size() == 1);
        assertTrue(errors.get(0).getMessage().contains("older than r5"));
        assertEquals(Status.STALE, c.status());
        assertEquals(ErrorCode.ROLLBACK, c.lastError().code());

        // The edge answers the current revision again: ready; newer revisions are adopted as usual.
        accent(5, "v5");
        c.refresh();
        assertEquals(Status.READY, c.status());
        assertNull(c.lastError());
        accent(6, "v6");
        c.refresh();
        assertEquals(6, c.revision());
    }

    @Test
    void olderCopyMarkedStaleByTheEdgeKeepsTheCurrentBehaviour() {
        accent(5, "v5");
        NanoFlagsClient c = client(opts());
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        List<NanoFlagsException> errors = errorsOf(c);
        accent(4, "v4");
        edge.staleHeader = true;
        c.refresh();
        assertEquals(5, c.revision());
        assertEquals(Status.STALE, c.status());
        assertTrue(errors.isEmpty());
    }

    @Test
    void higherRevisionWithOlderContentIsAdoptedNormally() {
        accent(7, "v7");
        NanoFlagsClient c = client(opts());
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        accent(8, "v5");
        c.refresh();
        assertEquals(8, c.revision());
        assertEquals("v5", accent(c));
        assertEquals(Status.READY, c.status());
    }

    @Test
    void bundleForAnotherEnvironmentDoesNotMoveTheFloor() {
        accent(5, "v5");
        NanoFlagsClient c = client(opts());
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        edge.environmentId = "env-other";
        accent(900, "v900");
        assertEquals(ErrorCode.SIGNATURE, assertThrows(NanoFlagsException.class, c::refresh).code());
        edge.environmentId = "env-test-1";
        accent(6, "v6");
        c.refresh();
        assertEquals(6, c.revision());
    }

    @Test
    void unverifiedSourcesDoNotBlockUpdates() {
        accent(5, "v5");
        String boot = "{\"schema\":1,\"revision\":9,\"flags\":{\"accent\":{\"enabled\":true,\"default\":\"orange\",\"rules\":[]}},\"segments\":{}}";
        NanoFlagsClient b = client(opts().bootstrapJson(boot).pollInterval(Duration.ofMinutes(10)));
        assertTrue(b.isInitialized());
        assertTrue(b.waitForReady(Duration.ofSeconds(10)));
        ClientTest.await("revision 5", 10_000, () -> b.revision() == 5);

        // Without verification there is nothing to anchor a revision on.
        NanoFlagsClient off = client(opts().withoutVerification());
        assertTrue(off.waitForReady(Duration.ofSeconds(10)));
        accent(4, "v4");
        off.refresh();
        assertEquals(4, off.revision());
        assertNull(off.lastError());
    }

    @Test
    void olderUnsignedAnswerIsNotAdopted() {
        accent(5, "v5");
        NanoFlagsClient c = client(opts().verify(VerifyOptions.builder().publicKey(edge.key1.jwk).require(false).build()));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        accent(4, "v4");
        edge.signed = false;
        assertEquals(ErrorCode.ROLLBACK, assertThrows(NanoFlagsException.class, c::refresh).code());
        assertEquals(5, c.revision());
        // A newer unsigned answer is still accepted with `require(false)`, as before.
        accent(6, "v6");
        c.refresh();
        assertEquals(6, c.revision());
    }

    @Test
    void storedCopyAnchorsTheFloorAcrossARestart() {
        MemoryStore store = new MemoryStore();
        accent(5, "v5");
        NanoFlagsClient first = client(opts().store(store));
        assertTrue(first.waitForReady(Duration.ofSeconds(10)));
        ClientTest.await("persisted", 5_000, () -> store.data != null);
        first.close();

        accent(4, "v4");
        NanoFlagsClient c = client(opts().store(store));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        ClientTest.await("older revision refused", 10_000, () -> c.lastError() != null && c.lastError().code() == ErrorCode.ROLLBACK);
        assertEquals(5, c.revision());
        assertEquals(Status.STALE, c.status());
        assertEquals("v5", accent(c));

        // A stored copy older than the edge's revision is the normal case: replaced, no error.
        accent(6, "v6");
        NanoFlagsClient d = client(opts().store(store));
        assertTrue(d.waitForReady(Duration.ofSeconds(10)));
        ClientTest.await("revision 6", 10_000, () -> d.revision() == 6 && d.status() == Status.READY);
        assertNull(d.lastError());
    }

    @Test
    void storedCopyOfAnotherKeyIsNotUsed() {
        MemoryStore store = new MemoryStore();
        accent(5, "v5");
        NanoFlagsClient first = client(opts().store(store));
        assertTrue(first.waitForReady(Duration.ofSeconds(10)));
        ClientTest.await("persisted", 5_000, () -> store.data != null);
        first.close();
        accent(4, "v4");
        NanoFlagsClient other = client("nf_pub_0123456789abcdef", opts().store(store));
        assertTrue(other.waitForReady(Duration.ofSeconds(10)));
        assertEquals(4, other.revision());
        assertNull(other.lastError());
    }

    @Test
    void olderPushIsNotAdoptedAndReported() {
        accent(5, "v5");
        NanoFlagsClient c = liveClient();
        List<NanoFlagsException> errors = errorsOf(c);
        accent(6, "v6");
        edge.push();
        ClientTest.await("pushed r6", 10_000, () -> c.revision() == 6);

        accent(4, "v4");
        edge.push();
        ClientTest.await("older revision refused", 10_000, () -> has(errors, ErrorCode.ROLLBACK));
        assertEquals(6, c.revision());
        assertEquals("v6", accent(c));
    }

    @Test
    void olderPushIsReportedAsStale() {
        accent(5, "v5");
        NanoFlagsClient c = liveClient();
        List<NanoFlagsException> errors = errorsOf(c);
        accent(6, "v6");
        edge.push();
        ClientTest.await("pushed r6", 10_000, () -> c.revision() == 6);
        edge.bundleStatus = 503; // the request path cannot confirm anything meanwhile
        accent(4, "v4");
        edge.push();
        ClientTest.await("older revision refused", 10_000, () -> has(errors, ErrorCode.ROLLBACK));
        ClientTest.await("stale", 5_000, () -> c.status() == Status.STALE);
        assertEquals(6, c.revision());
    }

    @Test
    void fetchTrailingAPushIsDroppedWithoutAnError() {
        accent(5, "v5");
        NanoFlagsClient c = liveClient();
        List<NanoFlagsException> errors = errorsOf(c);
        accent(6, "v6");
        edge.push();
        ClientTest.await("pushed r6", 10_000, () -> c.revision() == 6);
        // The request path still answers the previous revision for a moment.
        accent(5, "v5");
        c.refresh();
        assertEquals(6, c.revision());
        assertFalse(has(errors, ErrorCode.ROLLBACK));
        assertEquals(Status.READY, c.status());
    }

    @Test
    void rejectedSignatureTurnsStaleUntilABundleVerifies() {
        accent(3, "v3");
        NanoFlagsClient c = client(opts());
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        accent(4, "v4");
        edge.tamperHttp = true;
        assertEquals(ErrorCode.SIGNATURE, assertThrows(NanoFlagsException.class, c::refresh).code());
        assertEquals(3, c.revision());
        assertEquals(Status.STALE, c.status());
        edge.tamperHttp = false;
        c.refresh();
        assertEquals(4, c.revision());
        assertEquals(Status.READY, c.status());
    }

    @Test
    void unsignedAnswerWhilePublishingKeepsTheStatus() {
        accent(3, "v3");
        NanoFlagsClient c = client(opts());
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        accent(4, "v4");
        edge.signed = false;
        assertEquals(ErrorCode.SIGNATURE, assertThrows(NanoFlagsException.class, c::refresh).code());
        assertEquals(Status.READY, c.status());
        edge.signed = true;
        c.refresh();
        assertEquals(4, c.revision());
    }

    @Test
    void unsupportedEngineKeepsTheStatus() {
        accent(3, "v3");
        NanoFlagsClient c = client(opts());
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        edge.setFlags(4, "{}", 99);
        assertEquals(ErrorCode.ENGINE, assertThrows(NanoFlagsException.class, c::refresh).code());
        assertEquals(Status.READY, c.status());
        assertEquals(3, c.revision());
    }

    @Test
    void rejectedPushTurnsStale() {
        accent(3, "v3");
        NanoFlagsClient c = liveClient();
        List<NanoFlagsException> errors = errorsOf(c);
        accent(4, "v4");
        edge.bundleStatus = 503; // the request path cannot confirm anything meanwhile
        edge.push(true, edge.environmentId);
        ClientTest.await("signature error", 10_000, () -> has(errors, ErrorCode.SIGNATURE));
        ClientTest.await("stale", 5_000, () -> c.status() == Status.STALE);
        assertEquals(3, c.revision());
    }

    @Test
    void pushWithTheSameRevisionButOtherContentDoesNotConfirm() throws Exception {
        accent(3, "v3");
        NanoFlagsClient c = liveClient();
        String genuine = edge.bundleText;
        // Make the client stale: the request path fails, nothing else changes.
        edge.bundleStatus = 503;
        assertThrows(NanoFlagsException.class, c::refresh);
        assertEquals(Status.STALE, c.status());
        // Validly signed, same revision, same checksum text, other bytes: not the same bundle.
        edge.bundleText = genuine.replace("\"default\":\"v3\"", "\"default\":\"other\"");
        edge.push();
        Thread.sleep(400);
        assertEquals(Status.STALE, c.status());
        assertEquals("v3", accent(c));
        // The very same signed message confirms it.
        edge.bundleText = genuine;
        edge.push();
        ClientTest.await("confirmed", 10_000, () -> c.status() == Status.READY);
    }

    @Test
    void officialAddressSpellings() {
        String official = NanoFlagsOptions.OFFICIAL_EDGE_URL;
        for (String u : new String[] {"https://edge.nanoflags.io", "https://edge.nanoflags.io/", "https://edge.nanoflags.io///", "https://EDGE.nanoflags.io:443",
            "https://edge.nanoflags.io./", "https://edge.nanoflags.io:443/"}) {
            assertEquals(official, NanoFlagsOptions.builder().baseUrl(u).build().baseUrl(), u);
        }
        // Default verification: on, with signatures required.
        NanoFlagsOptions o = NanoFlagsOptions.builder().baseUrl("https://EDGE.nanoflags.io:443/").httpClient(java.net.http.HttpClient.newHttpClient()).events(EventsOptions.disabled())
            .live(false).streaming(false).pollInterval(Duration.ofMinutes(10)).build();
        NanoFlagsClient c = NanoFlagsClient.create(KEY, o);
        clients.add(c);
        assertNotNull(c.verifier);
        assertTrue(c.verifier.require);
    }

    @Test
    void otherAddressesAreLeftAsGiven() {
        String[][] cases = {
            {"https://edge.nanoflags.io.example.com", "https://edge.nanoflags.io.example.com"},
            {"http://edge.nanoflags.io", "http://edge.nanoflags.io"},
            {"https://edge.nanoflags.io/x", "https://edge.nanoflags.io/x"},
            {"https://edge.nanoflags.io/x/", "https://edge.nanoflags.io/x"},
            {"https://user@edge.nanoflags.io", "https://user@edge.nanoflags.io"},
            {"https://user:pw@edge.nanoflags.io", "https://user:pw@edge.nanoflags.io"},
            {"https://edge.nanoflags.io?x=1", "https://edge.nanoflags.io?x=1"},
            {"https://edge.nanoflags.io:8443", "https://edge.nanoflags.io:8443"},
            {"https://xedge.nanoflags.io/", "https://xedge.nanoflags.io"},
        };
        for (String[] c : cases) {
            String n = NanoFlagsOptions.builder().baseUrl(c[0]).build().baseUrl();
            assertNotEquals(NanoFlagsOptions.OFFICIAL_EDGE_URL, n, c[0]);
            assertEquals(c[1], n, c[0]);
        }
    }
}
