package io.nanoflags.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import io.nanoflags.server.NanoFlagsOptions.EventsOptions;
import io.nanoflags.server.engine.JsonValue;
import io.nanoflags.server.engine.Reason;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

@Timeout(value = 60, unit = TimeUnit.SECONDS)
class ClientTest {
    static final String KEY = "nf_srv_0123456789abcdef";
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
            .events(EventsOptions.disabled());
    }

    NanoFlagsClient client(NanoFlagsOptions.Builder b) {
        NanoFlagsClient c = NanoFlagsClient.create(KEY, b.build());
        clients.add(c);
        return c;
    }

    static void await(String what, long ms, BooleanSupplier cond) {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            if (cond.getAsBoolean()) return;
            try {
                Thread.sleep(20);
            } catch (InterruptedException e) {
                throw new AssertionError(e);
            }
        }
        if (!cond.getAsBoolean()) fail("timed out waiting for " + what);
    }

    @Test
    void refusesMissingKeyAndBadBaseUrl() {
        NanoFlagsException e = assertThrows(NanoFlagsException.class, () -> NanoFlagsClient.create(" "));
        assertEquals(ErrorCode.CONFIG, e.code());
        e = assertThrows(NanoFlagsException.class, () -> NanoFlagsClient.create(KEY, NanoFlagsOptions.builder().baseUrl("ftp://x").build()));
        assertEquals(ErrorCode.CONFIG, e.code());
    }

    @Test
    void loadsVerifiedBundleAndEvaluates() {
        NanoFlagsClient c = client(opts().live(false).streaming(false));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        assertTrue(c.ready().join());
        assertEquals(Status.READY, c.status());
        assertEquals(1, c.revision());
        assertEquals(Transport.POLL, c.transport());
        Map<String, Object> pro = Map.of("key", "u1", "plan", "pro");
        Map<String, Object> free = Map.of("key", "u1", "plan", "free");
        assertTrue(c.boolVariation("new-checkout", pro, false));
        assertFalse(c.boolVariation("new-checkout", free, true));
        assertTrue(c.boolVariation("new-checkout", Map.of("key", "u2", "email", "a@example.com"), false), "segment rule");
        assertEquals("blue", c.stringVariation("accent", pro, "red"));
        assertEquals(3, c.intVariation("limit", pro, 9));
        assertEquals(3L, c.longVariation("limit", pro, 9));
        assertEquals(0.25, c.doubleVariation("ratio", pro, 9), 0);
        assertEquals(9, c.intVariation("ratio", pro, 9), "0.25 is not an int");
        @SuppressWarnings("unchecked")
        Map<String, Object> theme = (Map<String, Object>) c.jsonVariation("theme", pro, null);
        assertEquals(Map.of("dark", true, "radius", 4.0), theme);
        assertEquals("{\"dark\":true,\"radius\":4}", c.jsonValueVariation("theme", pro, JsonValue.NULL).toJson());
        assertFalse(c.boolVariation("disabled", pro, true));

        EvaluationDetail<Boolean> d = c.boolVariationDetail("new-checkout", pro, false);
        assertEquals(Reason.RULE_MATCH, d.reason());
        assertEquals("pro", d.ruleId());
        assertEquals(0, d.ruleIndex());
        assertEquals(1, d.revision());
        assertEquals("config", d.trace().get(0).kind());
        assertEquals("Rule 01 matched", d.trace().get(1).title());
        assertEquals("plan = pro", d.trace().get(1).detail());

        EvaluationDetail<String> mismatch = c.stringVariationDetail("new-checkout", pro, "fb");
        assertEquals("fb", mismatch.value());
        assertEquals(Reason.ERROR, mismatch.reason());
        assertTrue(mismatch.error().contains("does not match the requested type"));

        EvaluationDetail<Boolean> missing = c.boolVariationDetail("nope", pro, true);
        assertTrue(missing.value());
        assertEquals(Reason.FLAG_NOT_FOUND, missing.reason());

        EvaluationDetail<Boolean> rollout = c.boolVariationDetail("rollout", Map.of("key", "user-42"), false);
        assertNotNull(rollout.bucket());
        assertNotNull(rollout.inRollout());
        assertEquals(rollout.inRollout(), rollout.value());
        EvaluationDetail<Boolean> noKey = c.boolVariationDetail("rollout", Map.of(), true);
        assertEquals(Boolean.FALSE, noKey.inRollout());
        assertFalse(noKey.value());

        Map<String, Object> all = c.allFlags(pro);
        assertEquals(List.of("new-checkout", "accent", "limit", "ratio", "theme", "disabled", "rollout"), new ArrayList<>(all.keySet()));
        assertEquals(true, all.get("new-checkout"));
        assertEquals(Reason.OFF, c.allFlagsDetail(pro).get("disabled").reason());
        // Null and empty contexts are fine.
        assertFalse(c.boolVariation("new-checkout", null, false));
    }

    @Test
    void evaluatesBeforeLoadingWithFallbacks() {
        edge.bundleStatus = 500;
        NanoFlagsClient c = client(opts().live(false).streaming(false));
        assertFalse(c.waitForReady(Duration.ofSeconds(10)));
        assertFalse(c.ready().join());
        assertEquals(Status.NOT_READY, c.status());
        assertEquals(ErrorCode.HTTP, c.lastError().code());
        assertEquals(500, c.lastError().httpStatus());
        EvaluationDetail<Boolean> d = c.boolVariationDetail("new-checkout", Map.of(), true);
        assertTrue(d.value());
        assertEquals(Reason.FLAG_NOT_FOUND, d.reason());
        assertEquals("No configuration is loaded. The application fallback applies.", d.trace().get(0).detail());
        assertTrue(c.allFlags(Map.of()).isEmpty());
        assertEquals(-1, c.revision());
    }

    @Test
    void refusesUnsignedAndTamperedBundles() {
        edge.signed = false;
        NanoFlagsClient c = client(opts().live(false).streaming(false));
        assertFalse(c.waitForReady(Duration.ofSeconds(10)));
        assertEquals(ErrorCode.SIGNATURE, c.lastError().code());
        assertTrue(c.lastError().getMessage().contains("not signed"));

        edge.signed = true;
        edge.tamperHttp = true;
        NanoFlagsException e = assertThrows(NanoFlagsException.class, c::refresh);
        assertEquals(ErrorCode.SIGNATURE, e.code());
        assertNull(c.bundle());

        edge.tamperHttp = false;
        c.refresh();
        assertEquals(Status.READY, c.status());
        assertEquals(1, c.revision());

        // Unsigned is accepted when verification does not require signatures (self-hosted edge default).
        edge.signed = false;
        NanoFlagsClient lax = client(opts().verify(VerifyOptions.builder().publicKey(edge.key1.jwk).build()).live(false).streaming(false));
        assertTrue(lax.waitForReady(Duration.ofSeconds(10)));
    }

    @Test
    void signedForAnotherEnvironmentIsRefused() {
        NanoFlagsClient c = client(opts().live(false).streaming(false));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        edge.environmentId = "env-other";
        edge.setFlags(2, FakeEdge.FLAGS, 1);
        NanoFlagsException e = assertThrows(NanoFlagsException.class, c::refresh);
        assertEquals(ErrorCode.SIGNATURE, e.code());
        assertTrue(e.getMessage().contains("different environment"));
        assertEquals(1, c.revision());
        assertEquals(Status.READY, c.status(), "a rejected update changes nothing");
    }

    @Test
    void etagRevalidationReturns304() {
        NanoFlagsClient c = client(opts().live(false).streaming(false));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        c.refresh();
        c.refresh();
        assertEquals(2, edge.notModified.get());
        assertEquals(Status.READY, c.status());
    }

    @Test
    void servedStaleNeverGoesBackwards() {
        edge.setFlags(5, FakeEdge.FLAGS, 1);
        NanoFlagsClient c = client(opts().live(false).streaming(false));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        edge.setFlags(4, FakeEdge.FLAGS, 1);
        edge.staleHeader = true;
        c.refresh();
        assertEquals(5, c.revision());
        assertEquals(Status.STALE, c.status());
    }

    @Test
    void unknownKidLoadsKeysOnceRateLimited() {
        FakeEdge.Key k2 = new FakeEdge.Key("t2");
        edge.published.add(k2);
        edge.signingKey = k2;
        NanoFlagsClient c = client(opts().verify(VerifyOptions.builder().publicKey(edge.key1.jwk).fetchKeys(true).require(true).build()).live(false).streaming(false));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        assertEquals(1, edge.keysRequests.get());
        // A key nobody publishes: no second /v1/keys request within the minute.
        edge.signingKey = new FakeEdge.Key("t3");
        edge.setFlags(2, FakeEdge.FLAGS, 1);
        assertThrows(NanoFlagsException.class, c::refresh);
        assertThrows(NanoFlagsException.class, c::refresh);
        assertEquals(1, edge.keysRequests.get());
        assertEquals(1, c.revision());
        // /v1/keys is public: the SDK key is never sent there.
        for (okhttp3.mockwebserver.RecordedRequest r : edge.requests) {
            if (r.getPath().startsWith("/v1/keys")) assertNull(r.getHeader("Authorization"));
        }
    }

    @Test
    void keysFromTheEdgeWhenNoneArePinned() {
        NanoFlagsClient c = client(opts().verify(VerifyOptions.builder().fetchKeys(true).require(true).build()).live(false).streaming(false));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        assertEquals(1, edge.keysRequests.get());
    }

    @Test
    void privateJwkIsReportedAndIgnored() {
        Jwk priv = Jwk.fromJson(JsonValue.parse("{\"kty\":\"OKP\",\"crv\":\"Ed25519\",\"x\":\"" + edge.key1.jwk.x() + "\",\"d\":\"secret\",\"kid\":\"t1\"}"));
        NanoFlagsClient c = client(opts().verify(VerifyOptions.builder().publicKey(priv).publicKey(edge.key1.jwk).require(true).build()).live(false).streaming(false));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)), "the public key still verifies");
        // The constructor's config error is emitted before any listener exists; check it on a fresh verifier.
        List<NanoFlagsException> cfgErrors = new ArrayList<>();
        assertFalse(priv.isPublicEd25519());
        assertNotNull(Verifier.create(c, cfgErrors));
        assertEquals(ErrorCode.CONFIG, cfgErrors.get(0).code());
    }

    @Test
    void officialEdgeDefaultsVerifyWithEmbeddedKeys() {
        NanoFlagsClient c = NanoFlagsClient.create(KEY, NanoFlagsOptions.builder().events(EventsOptions.disabled()).live(false).streaming(false)
            .pollInterval(Duration.ZERO).baseUrl("https://edge.nanoflags.io").httpClient(java.net.http.HttpClient.newBuilder().proxy(
                java.net.ProxySelector.of(new java.net.InetSocketAddress("127.0.0.1", 9))).build()).build());
        clients.add(c);
        assertNotNull(c.verifier);
        assertTrue(c.verifier.require);
        NanoFlagsClient off = NanoFlagsClient.create(KEY, NanoFlagsOptions.builder().withoutVerification().events(EventsOptions.disabled()).live(false)
            .streaming(false).pollInterval(Duration.ZERO).baseUrl(edge.baseUrl()).build());
        clients.add(off);
        assertNull(off.verifier);
        NanoFlagsClient selfHosted = client(NanoFlagsOptions.builder().baseUrl(edge.baseUrl()).events(EventsOptions.disabled()).live(false).streaming(false));
        assertNull(selfHosted.verifier, "verification is off by default on other edges");
    }

    @Test
    void livePushAdoptsVerifiedRevisions() {
        List<ChangeEvent> changes = new CopyOnWriteArrayList<>();
        List<NanoFlagsException> errors = new CopyOnWriteArrayList<>();
        NanoFlagsClient c = client(opts());
        c.onChange(changes::add);
        c.onError(errors::add);
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        await("live socket", 10_000, () -> c.transport() == Transport.LIVE && !edge.sockets.isEmpty());

        edge.committedAt = System.currentTimeMillis() - 150;
        edge.setFlags(2, FakeEdge.FLAGS.replace("\"default\":\"blue\"", "\"default\":\"green\""), 1);
        edge.push();
        await("revision 2", 10_000, () -> c.revision() == 2);
        assertEquals("green", c.stringVariation("accent", Map.of(), "x"));
        await("change event", 5_000, () -> changes.stream().anyMatch(e -> e.revision() == 2));
        ChangeEvent e = changes.stream().filter(x -> x.revision() == 2).findFirst().get();
        assertEquals(Transport.LIVE, e.transport());
        assertEquals(Source.NETWORK, e.source());
        assertEquals(1, e.previousRevision());
        assertTrue(e.latency().isPresent());
        assertTrue(e.latency().get().toMillis() >= 100);

        // A tampered push is refused; the regular request path is asked what is current.
        edge.setFlags(3, FakeEdge.FLAGS, 1);
        int before = edge.bundleRequests.get();
        edge.push(true, edge.environmentId);
        await("signature error", 5_000, () -> errors.stream().anyMatch(x -> x.code() == ErrorCode.SIGNATURE));
        await("verified fetch", 5_000, () -> edge.bundleRequests.get() > before);
        await("revision 3 over HTTP", 5_000, () -> c.revision() == 3);

        // The safety poll after a push gets 304 (the push set the ETag).
        assertEquals("\"" + edge.checksum + "-server\"", c.snap.get().etag);
    }

    @Test
    void pushForAnotherEnvironmentIsRefused() {
        List<NanoFlagsException> errors = new CopyOnWriteArrayList<>();
        NanoFlagsClient c = client(opts());
        c.onError(errors::add);
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        await("live socket", 10_000, () -> !edge.sockets.isEmpty() && c.transport() == Transport.LIVE);
        edge.setFlags(2, FakeEdge.FLAGS, 1);
        edge.push(false, "env-evil");
        await("signature error", 5_000, () -> errors.stream().anyMatch(x -> x.getMessage().contains("different environment")));
    }

    @Test
    void closeCode4004StopsAndKeepsConfiguration() {
        List<NanoFlagsException> errors = new CopyOnWriteArrayList<>();
        NanoFlagsClient c = client(opts());
        c.onError(errors::add);
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        await("live socket", 10_000, () -> !edge.sockets.isEmpty() && c.transport() == Transport.LIVE);
        int connects = edge.liveConnects.get();
        edge.closeSockets(4004, "environment deleted");
        await("environment_deleted", 10_000, () -> errors.stream().anyMatch(x -> x.code() == ErrorCode.ENVIRONMENT_DELETED));
        assertEquals(Status.STALE, c.status());
        assertTrue(c.boolVariation("new-checkout", Map.of("plan", "pro"), false), "last configuration stays in use");
        sleep(1500);
        assertEquals(connects, edge.liveConnects.get(), "no reconnect");
    }

    @Test
    void reconnectsAfterDrop() {
        NanoFlagsClient c = client(opts());
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        await("live socket", 10_000, () -> !edge.sockets.isEmpty() && c.transport() == Transport.LIVE);
        edge.closeSockets(1011, "restart");
        await("reconnect", 15_000, () -> edge.liveConnects.get() >= 2 && c.transport() == Transport.LIVE);
    }

    @Test
    void sseFallbackWhenNoSocketCanBeOpened() {
        edge.liveEnabled = false;
        edge.sseEnabled = true;
        List<ChangeEvent> changes = new CopyOnWriteArrayList<>();
        NanoFlagsClient c = client(opts().pollInterval(Duration.ofMinutes(10)));
        c.onChange(changes::add);
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        await("stream", 10_000, () -> edge.streamRequests.get() >= 1);
        edge.setFlags(2, FakeEdge.FLAGS, 1);
        await("revision 2 announced over SSE", 20_000, () -> c.revision() == 2);
        await("change event", 5_000, () -> changes.stream().anyMatch(e -> e.revision() == 2));
        assertEquals(Transport.STREAM, changes.stream().filter(e -> e.revision() == 2).findFirst().get().transport());
    }

    @Test
    void pollsWithoutStreaming() {
        NanoFlagsClient c = client(opts().streaming(false).pollInterval(Duration.ofMillis(300)));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        edge.setFlags(2, FakeEdge.FLAGS, 1);
        await("polled revision 2", 10_000, () -> c.revision() == 2);
        assertEquals(0, edge.liveConnects.get());
        assertEquals(0, edge.streamRequests.get());
    }

    @Test
    void persistsAndRestoresVerifiedBundleOffline(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("flags.json");
        NanoFlagsClient c = client(opts().live(false).streaming(false).store(new FileStore(file)));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        await("persisted", 5_000, () -> Files.exists(file));
        c.close();
        String stored = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
        assertTrue(stored.contains("\"sig\""));

        // The edge is down: the restored copy is used, stale.
        edge.bundleStatus = 503;
        List<ChangeEvent> changes = new CopyOnWriteArrayList<>();
        NanoFlagsClient d = client(opts().live(false).streaming(false).store(new FileStore(file)));
        d.onChange(changes::add);
        assertTrue(d.waitForReady(Duration.ofSeconds(10)));
        assertEquals(1, d.revision());
        assertEquals(Status.STALE, d.status());
        assertTrue(d.boolVariation("new-checkout", Map.of("plan", "pro"), false));

        // A tampered copy is refused.
        Files.write(file, stored.replace("\"default\":false", "\"default\":true").getBytes(StandardCharsets.UTF_8));
        NanoFlagsClient t = client(opts().live(false).streaming(false).store(new FileStore(file)));
        assertFalse(t.waitForReady(Duration.ofSeconds(10)));
        assertNull(t.bundle());
    }

    @Test
    void bootstrapIsUsedUntilTheNetworkAnswers() {
        edge.bundleStatus = 503;
        String boot = "{\"schema\":1,\"revision\":7,\"flags\":{\"accent\":{\"enabled\":true,\"default\":\"pink\",\"rules\":[]}},\"segments\":{}}";
        NanoFlagsClient c = client(opts().live(false).streaming(false).bootstrapJson(boot));
        assertTrue(c.isInitialized(), "bootstrap is adopted synchronously");
        assertEquals("pink", c.stringVariation("accent", Map.of(), "x"));
        assertEquals(7, c.revision());

        NanoFlagsClient bad = client(opts().live(false).streaming(false).bootstrapJson("{nope"));
        assertFalse(bad.isInitialized());
    }

    @Test
    void newerEngineIsRefused() {
        edge.setFlags(1, FakeEdge.FLAGS, 2);
        NanoFlagsClient c = client(opts().live(false).streaming(false));
        assertFalse(c.waitForReady(Duration.ofSeconds(10)));
        assertEquals(ErrorCode.ENGINE, c.lastError().code());
        assertTrue(c.lastError().getMessage().contains("needs evaluation engine 2"));
    }

    @Test
    void rejectedKeyIsReported() {
        NanoFlagsClient c = NanoFlagsClient.create("bad-key", opts().live(false).streaming(false).build());
        clients.add(c);
        assertFalse(c.waitForReady(Duration.ofSeconds(10)));
        assertEquals(ErrorCode.UNAUTHORIZED, c.lastError().code());
        assertEquals(401, c.lastError().httpStatus());
    }

    @Test
    void telemetrySendsAttributeNamesAndTypesOnly() {
        NanoFlagsClient c = client(opts().live(false).streaming(false)
            .events(EventsOptions.builder().sampleRate(1).flushInterval(Duration.ofHours(1)).build()).random(() -> 0.0));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        c.boolVariation("new-checkout", Map.of("key", "user-42", "plan", "pro", "email", "secret@example.com", "unused", "x"), false);
        c.boolVariation("rollout", Map.of("key", "user-42", "age", 33), false);
        c.flush();
        await("events", 5_000, () -> !edge.events.isEmpty());
        JsonValue body = edge.events.get(edge.events.size() - 1);
        assertEquals("test-svc", ((JsonValue.Str) body.field("service")).value());
        assertEquals("java/" + NanoFlagsClient.VERSION, ((JsonValue.Str) body.field("sdk")).value());
        assertEquals(1.0, ((JsonValue.Num) body.field("revision")).value());
        List<JsonValue> evs = ((JsonValue.Arr) body.field("events")).items();
        assertEquals(2, evs.size());
        JsonValue e0 = evs.get(0);
        assertEquals("new-checkout", ((JsonValue.Str) e0.field("flagKey")).value());
        assertEquals(JsonValue.TRUE, e0.field("value"));
        assertEquals("rule_match", ((JsonValue.Str) e0.field("reason")).value());
        assertEquals(0.0, ((JsonValue.Num) e0.field("ruleIndex")).value());
        assertEquals("{\"plan\":\"string\",\"email\":\"string\"}", e0.field("context").toJson());
        assertEquals("{\"key\":\"string\"}", evs.get(1).field("context").toJson());
        String text = body.toJson();
        assertFalse(text.contains("user-42"));
        assertFalse(text.contains("secret@example.com"));
        assertFalse(text.contains("\"pro\""));
        for (okhttp3.mockwebserver.RecordedRequest r : edge.requests) {
            if (r.getPath().equals("/v1/events")) {
                assertEquals("Bearer " + KEY, r.getHeader("Authorization"));
                assertEquals("nanoflags-java/" + NanoFlagsClient.VERSION, r.getHeader("User-Agent"));
            }
        }
    }

    @Test
    void customRedactAndOptOut() {
        NanoFlagsClient c = client(opts().live(false).streaming(false).random(() -> 0.0)
            .events(EventsOptions.builder().sampleRate(1).flushInterval(Duration.ofHours(1)).redact(ctx -> Map.of("tier", String.valueOf(ctx.get("plan")))).build()));
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        c.boolVariation("new-checkout", Map.of("plan", "pro"), false);
        c.flush();
        await("events", 5_000, () -> !edge.events.isEmpty());
        assertEquals("{\"tier\":\"pro\"}", ((JsonValue.Arr) edge.events.get(0).field("events")).items().get(0).field("context").toJson());

        edge.events.clear();
        NanoFlagsClient off = client(opts().live(false).streaming(false).random(() -> 0.0).events(EventsOptions.disabled()));
        assertTrue(off.waitForReady(Duration.ofSeconds(10)));
        off.boolVariation("new-checkout", Map.of("plan", "pro"), false);
        off.flush();
        off.close();
        assertTrue(edge.events.isEmpty());
    }

    @Test
    void statusAndErrorListeners() {
        List<Status> statuses = new CopyOnWriteArrayList<>();
        List<NanoFlagsException> errors = new CopyOnWriteArrayList<>();
        NanoFlagsClient c = client(opts().live(false).streaming(false));
        c.onStatus(statuses::add);
        Subscription sub = c.onError(errors::add);
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        edge.bundleStatus = 503;
        assertThrows(NanoFlagsException.class, c::refresh);
        await("stale", 5_000, () -> statuses.contains(Status.STALE));
        await("error", 5_000, () -> errors.size() == 1);
        sub.close();
        assertThrows(NanoFlagsException.class, c::refresh);
        sleep(300);
        assertEquals(1, errors.size(), "unsubscribed");
        edge.bundleStatus = 200;
        c.refresh();
        await("ready again", 5_000, () -> c.status() == Status.READY);
        // A throwing listener does not break the client.
        c.onChange(e -> { throw new IllegalStateException("boom"); });
        edge.setFlags(2, FakeEdge.FLAGS, 1);
        c.refresh();
        assertEquals(2, c.revision());
    }

    @Test
    void closeIsIdempotentAndEvaluationsKeepWorking() {
        NanoFlagsClient c = client(opts());
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        c.close();
        c.close();
        assertTrue(c.boolVariation("new-checkout", Map.of("plan", "pro"), false));
        assertThrows(NanoFlagsException.class, c::refresh);
        await("socket closed", 5_000, () -> edge.sockets.isEmpty());
    }

    @Test
    void browserKeyIsAccepted() {
        NanoFlagsClient c = NanoFlagsClient.create("nf_pub_abc", opts().live(false).streaming(false).build());
        clients.add(c);
        assertTrue(c.waitForReady(Duration.ofSeconds(10)));
        assertEquals("client", c.etagKind());
    }

    @Test
    void versionMatchesTheBuild() {
        String v = System.getProperty("nanoflags.version");
        assertNotNull(v, "the build passes nanoflags.version");
        assertEquals(v, NanoFlagsClient.VERSION);
    }

    static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            throw new AssertionError(e);
        }
    }
}
