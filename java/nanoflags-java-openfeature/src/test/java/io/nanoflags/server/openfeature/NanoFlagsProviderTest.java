package io.nanoflags.server.openfeature;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import dev.openfeature.sdk.Client;
import dev.openfeature.sdk.ErrorCode;
import dev.openfeature.sdk.EventDetails;
import dev.openfeature.sdk.FlagEvaluationDetails;
import dev.openfeature.sdk.ImmutableContext;
import dev.openfeature.sdk.MutableContext;
import dev.openfeature.sdk.OpenFeatureAPI;
import dev.openfeature.sdk.ProviderState;
import dev.openfeature.sdk.Reason;
import dev.openfeature.sdk.Value;
import io.nanoflags.server.NanoFlagsClient;
import io.nanoflags.server.NanoFlagsOptions;
import io.nanoflags.server.engine.Bundle;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

@Timeout(value = 60, unit = TimeUnit.SECONDS)
class NanoFlagsProviderTest {
    static String bundle(long rev, String accent) {
        return "{\"schema\":1,\"revision\":" + rev + ",\"flags\":{"
            + "\"new-checkout\":{\"enabled\":true,\"default\":false,\"off\":false,\"rules\":[{\"id\":\"pro\",\"match\":\"all\",\"conditions\":[{\"attribute\":\"plan\",\"op\":\"eq\",\"value\":\"pro\"}],\"serve\":{\"type\":\"fixed\",\"value\":true}}]},"
            + "\"rollout\":{\"enabled\":true,\"default\":false,\"off\":false,\"rules\":[{\"id\":\"half\",\"match\":\"all\",\"conditions\":[],\"serve\":{\"type\":\"rollout\",\"percentage\":100,\"value\":true,\"otherwise\":false}}]},"
            + "\"accent\":{\"enabled\":true,\"default\":\"" + accent + "\",\"off\":\"gray\",\"rules\":[]},"
            + "\"limit\":{\"enabled\":true,\"default\":42,\"off\":0,\"rules\":[]},"
            + "\"ratio\":{\"enabled\":true,\"default\":0.5,\"off\":0,\"rules\":[]},"
            + "\"theme\":{\"enabled\":true,\"default\":{\"dark\":true,\"sizes\":[1,2]},\"off\":null,\"rules\":[]},"
            + "\"off-flag\":{\"enabled\":false,\"default\":true,\"off\":false,\"rules\":[]}},\"segments\":{}}";
    }

    HttpServer server;
    volatile String body = "{\"revision\":1,\"checksum\":\"c1\",\"bundle\":" + bundle(1, "blue") + "}";
    NanoFlagsClient client;
    OpenFeatureAPI api;

    @BeforeEach
    void setUp() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/bundle", ex -> {
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        server.createContext("/", ex -> {
            ex.sendResponseHeaders(404, -1);
            ex.close();
        });
        server.start();
        client = NanoFlagsClient.create("nf_srv_test", NanoFlagsOptions.builder().baseUrl("http://127.0.0.1:" + server.getAddress().getPort())
            .withoutVerification().streaming(false).pollInterval(Duration.ZERO).events(NanoFlagsOptions.EventsOptions.disabled()).build());
        api = OpenFeatureAPI.createIsolated();
    }

    @AfterEach
    void tearDown() {
        api.shutdown();
        client.close();
        server.stop(0);
    }

    Client of() {
        api.setProviderAndWait(NanoFlagsProvider.builder(client).closeClient(true).build());
        return api.getClient();
    }

    @Test
    void resolvesEveryTypeWithReasonsAndVariants() {
        Client of = of();
        assertEquals("nanoflags", api.getProviderMetadata().getName());
        assertEquals(ProviderState.READY, of.getProviderState());

        FlagEvaluationDetails<Boolean> pro = of.getBooleanDetails("new-checkout", false, new ImmutableContext("u1", Map.of("plan", new Value("pro"))));
        assertTrue(pro.getValue());
        assertEquals(Reason.TARGETING_MATCH.toString(), pro.getReason());
        assertEquals("pro", pro.getVariant());
        assertEquals(1L, pro.getFlagMetadata().getLong("revision"));
        assertEquals(0, pro.getFlagMetadata().getInteger("ruleIndex"));

        FlagEvaluationDetails<Boolean> free = of.getBooleanDetails("new-checkout", true, new ImmutableContext("u1"));
        assertFalse(free.getValue());
        assertEquals(Reason.DEFAULT.toString(), free.getReason());

        FlagEvaluationDetails<Boolean> split = of.getBooleanDetails("rollout", false, new ImmutableContext("user-42"));
        assertTrue(split.getValue());
        assertEquals(Reason.SPLIT.toString(), split.getReason());
        assertEquals("half", split.getVariant());

        FlagEvaluationDetails<Boolean> off = of.getBooleanDetails("off-flag", true, new ImmutableContext());
        assertFalse(off.getValue());
        assertEquals(Reason.DISABLED.toString(), off.getReason());

        assertEquals("blue", of.getStringValue("accent", "x"));
        assertEquals(42, of.getIntegerValue("limit", 0));
        assertEquals(0.5, of.getDoubleValue("ratio", 0.0), 0);
        assertEquals(42.0, of.getDoubleValue("limit", 0.0), 0);
        Value theme = of.getObjectValue("theme", new Value());
        assertTrue(theme.asStructure().getValue("dark").asBoolean());
        assertEquals(2, theme.asStructure().getValue("sizes").asList().size());

        FlagEvaluationDetails<Integer> notInt = of.getIntegerDetails("ratio", 7);
        assertEquals(7, notInt.getValue());
        assertEquals(ErrorCode.TYPE_MISMATCH, notInt.getErrorCode());

        FlagEvaluationDetails<String> mismatch = of.getStringDetails("new-checkout", "fb");
        assertEquals("fb", mismatch.getValue());
        assertEquals(ErrorCode.TYPE_MISMATCH, mismatch.getErrorCode());
        assertEquals(Reason.ERROR.toString(), mismatch.getReason());

        FlagEvaluationDetails<Boolean> missing = of.getBooleanDetails("nope", true);
        assertTrue(missing.getValue());
        assertEquals(ErrorCode.FLAG_NOT_FOUND, missing.getErrorCode());
    }

    @Test
    void targetingKeyWinsOverAKeyAttribute() {
        MutableContext ctx = new MutableContext("tk");
        ctx.add("key", "attr");
        ctx.add("plan", "pro");
        Map<String, Object> m = NanoFlagsProvider.toContext(ctx);
        assertEquals("tk", m.get("key"));
        assertEquals("pro", m.get("plan"));
        assertNull(m.get("targetingKey"));
    }

    @Test
    void configurationChangesAreProviderEvents() throws Exception {
        Client of = of();
        List<EventDetails> changes = new CopyOnWriteArrayList<>();
        of.onProviderConfigurationChanged(changes::add);
        body = "{\"revision\":2,\"checksum\":\"c2\",\"bundle\":" + bundle(2, "green") + "}";
        client.refresh();
        long end = System.currentTimeMillis() + 10_000;
        while (changes.isEmpty() && System.currentTimeMillis() < end) Thread.sleep(20);
        assertEquals(1, changes.size());
        assertEquals(List.of("accent"), changes.get(0).getFlagsChanged());
        assertEquals("green", of.getStringValue("accent", "x"));
        assertEquals(2L, of.getStringDetails("accent", "x").getFlagMetadata().getLong("revision"));
    }

    @Test
    void notReadyWhenNothingCanBeLoaded() {
        NanoFlagsClient dead = NanoFlagsClient.create("nf_srv_test", NanoFlagsOptions.builder().baseUrl("http://127.0.0.1:9").withoutVerification()
            .streaming(false).pollInterval(Duration.ZERO).events(NanoFlagsOptions.EventsOptions.disabled()).build());
        try {
            api.setProviderAndWait("dead", NanoFlagsProvider.builder(dead).initTimeout(Duration.ofSeconds(5)).build());
        } catch (RuntimeException expected) {
            // setProviderAndWait rethrows the initialisation error
        }
        Client of = api.getClient("dead");
        assertEquals(ProviderState.ERROR, of.getProviderState());
        FlagEvaluationDetails<Boolean> d = of.getBooleanDetails("new-checkout", true);
        assertTrue(d.getValue());
        dead.close();
    }

    @Test
    void changedFlagsListsAddedRemovedAndModified() {
        Bundle a = Bundle.parse("{\"schema\":1,\"revision\":1,\"flags\":{\"x\":{\"enabled\":true},\"y\":{\"enabled\":true}},\"segments\":{}}");
        Bundle b = Bundle.parse("{\"schema\":1,\"revision\":2,\"flags\":{\"y\":{\"enabled\":false},\"z\":{\"enabled\":true}},\"segments\":{}}");
        assertEquals(List.of("y", "z", "x"), NanoFlagsProvider.changedFlags(a, b));
    }
}
