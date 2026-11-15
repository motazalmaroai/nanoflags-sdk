package io.nanoflags.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import io.nanoflags.server.NanoFlagsOptions.EventsOptions;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Opt-in, read-only check against the real edge (https://edge.nanoflags.io): the client loads a signed bundle,
 * verifies it with the embedded production keys and opens the live socket. Nothing is changed.
 *
 * <pre>NANOFLAGS_PRODUCTION_TESTS=1 NANOFLAGS_SDK_KEY=nf_pub_… ./gradlew :nanoflags-java:test --tests '*ProductionTest*'</pre>
 */
class ProductionTest {
    @Test
    void loadsAVerifiedBundleAndOpensTheLiveSocket() throws Exception {
        String key = System.getenv("NANOFLAGS_SDK_KEY");
        assumeTrue("1".equals(System.getenv("NANOFLAGS_PRODUCTION_TESTS")) && key != null && !key.isEmpty(), "production checks are opt-in");
        try (NanoFlagsClient c = NanoFlagsClient.create(key, NanoFlagsOptions.builder().service("nanoflags-java-ci").events(EventsOptions.disabled()).build())) {
            assertTrue(c.waitForReady(Duration.ofSeconds(20)), () -> "not ready: " + c.lastError());
            assertEquals(Status.READY, c.status());
            assertTrue(c.revision() > 0);
            assertTrue(c.snap.get().sig != null, "the bundle was signature-verified");
            long end = System.currentTimeMillis() + 20_000;
            while (c.transport() != Transport.LIVE && System.currentTimeMillis() < end) Thread.sleep(100);
            assertEquals(Transport.LIVE, c.transport());
            Map<String, Object> flags = c.allFlags(Map.of("key", "ci"));
            System.out.println("PRODUCTION: r" + c.revision() + " verified, live socket open, flags " + flags.keySet());
        }
    }
}
