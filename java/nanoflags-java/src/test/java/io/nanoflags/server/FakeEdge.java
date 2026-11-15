package io.nanoflags.server;

import io.nanoflags.server.engine.JsonValue;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;

/**
 * A fake NanoFlags edge that signs like the real publisher (Ed25519 over the canonical string, kid in a header),
 * serves {@code /v1/bundle} (ETag / 304), {@code /v1/keys}, {@code /v1/live} (WebSocket: hello, rev, ping/pong, close
 * codes), {@code /v1/stream} (SSE) and records {@code /v1/events}.
 */
final class FakeEdge implements AutoCloseable {
    static final String FLAGS = "{\"new-checkout\":{\"type\":\"boolean\",\"enabled\":true,\"clientExposed\":true,\"default\":false,\"off\":false,\"rules\":["
        + "{\"id\":\"pro\",\"match\":\"all\",\"conditions\":[{\"attribute\":\"plan\",\"op\":\"eq\",\"value\":\"pro\"}],\"serve\":{\"type\":\"fixed\",\"value\":true}},"
        + "{\"id\":\"beta\",\"match\":\"all\",\"conditions\":[{\"op\":\"segment\",\"value\":\"beta-testers\"}],\"serve\":{\"type\":\"fixed\",\"value\":true}}]},"
        + "\"accent\":{\"type\":\"string\",\"enabled\":true,\"clientExposed\":true,\"default\":\"blue\",\"off\":\"blue\",\"rules\":[]},"
        + "\"limit\":{\"type\":\"number\",\"enabled\":true,\"clientExposed\":true,\"default\":3,\"off\":0,\"rules\":[]},"
        + "\"ratio\":{\"type\":\"number\",\"enabled\":true,\"clientExposed\":true,\"default\":0.25,\"off\":0,\"rules\":[]},"
        + "\"theme\":{\"type\":\"json\",\"enabled\":true,\"clientExposed\":true,\"default\":{\"dark\":true,\"radius\":4},\"off\":null,\"rules\":[]},"
        + "\"disabled\":{\"type\":\"boolean\",\"enabled\":false,\"clientExposed\":true,\"default\":true,\"off\":false,\"rules\":[]},"
        + "\"rollout\":{\"type\":\"boolean\",\"enabled\":true,\"clientExposed\":true,\"default\":false,\"off\":false,\"rules\":["
        + "{\"id\":\"half\",\"match\":\"all\",\"conditions\":[],\"serve\":{\"type\":\"rollout\",\"percentage\":50,\"value\":true,\"otherwise\":false}}]}}";
    static final String SEGMENTS = "{\"beta-testers\":{\"match\":\"any\",\"conditions\":[{\"attribute\":\"email\",\"op\":\"ends_with\",\"value\":\"@example.com\"}]}}";

    static final class Key {
        final String kid;
        final Ed25519PrivateKeyParameters priv = new Ed25519PrivateKeyParameters(new SecureRandom());
        final Jwk jwk;

        Key(String kid) {
            this.kid = kid;
            this.jwk = Jwk.ed25519(Base64.getUrlEncoder().withoutPadding().encodeToString(priv.generatePublicKey().getEncoded()), kid);
        }

        String sign(byte[] msg) {
            Ed25519Signer s = new Ed25519Signer();
            s.init(true, priv);
            s.update(msg, 0, msg.length);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(s.generateSignature());
        }
    }

    final MockWebServer server = new MockWebServer();
    final Key key1 = new Key("t1");
    volatile Key signingKey = key1;
    final List<Key> published = new CopyOnWriteArrayList<>(List.of(key1));
    volatile String environmentId = "env-test-1";

    volatile long revision;
    volatile String bundleText = "";
    volatile String checksum = "";
    volatile boolean signed = true;
    volatile boolean tamperHttp;
    volatile int bundleStatus = 200;
    volatile boolean staleHeader;
    volatile boolean liveEnabled = true;
    volatile boolean sseEnabled;
    volatile boolean answerPings = true;
    volatile Long committedAt;

    final AtomicInteger bundleRequests = new AtomicInteger();
    final AtomicInteger notModified = new AtomicInteger();
    final AtomicInteger keysRequests = new AtomicInteger();
    final AtomicInteger liveConnects = new AtomicInteger();
    final AtomicInteger streamRequests = new AtomicInteger();
    final AtomicInteger closedSockets = new AtomicInteger();
    final List<WebSocket> sockets = new CopyOnWriteArrayList<>();
    final List<JsonValue> events = new CopyOnWriteArrayList<>();
    final List<RecordedRequest> requests = new CopyOnWriteArrayList<>();

    FakeEdge() throws Exception {
        setFlags(1, FLAGS, 1);
        server.setDispatcher(new Dispatcher() {
            @Override public MockResponse dispatch(RecordedRequest request) { return handle(request); }
        });
        server.start();
    }

    String baseUrl() {
        String u = server.url("/").toString();
        return u.substring(0, u.length() - 1);
    }

    /** Replaces the configuration with a new revision (JSON text exactly as the publisher stores it). */
    void setFlags(long rev, String flags, Integer engine) {
        revision = rev;
        bundleText = "{\"schema\":1," + (engine != null ? "\"engine\":" + engine + "," : "") + "\"project\":\"p\",\"environment\":\"production\",\"revision\":" + rev
            + ",\"flags\":" + flags + ",\"segments\":" + SEGMENTS + "}";
        checksum = "c" + rev + "-" + Integer.toHexString(bundleText.hashCode());
    }

    String signature(String text, long rev, String sum, String env) {
        return signingKey.sign(Signatures.canonicalString(env, rev, sum, text.getBytes(StandardCharsets.UTF_8)));
    }

    String signature() { return signature(bundleText, revision, checksum, environmentId); }

    String revMessage(String type, boolean tamper, String env) {
        String text = tamper ? bundleText.replace("\"default\":false", "\"default\":true") : bundleText;
        return JsonValue.Obj.builder()
            .put("t", new JsonValue.Str(type)).put("revision", new JsonValue.Num(revision)).put("checksum", new JsonValue.Str(checksum))
            .put("signature", new JsonValue.Str(signature(bundleText, revision, checksum, env))).put("kid", new JsonValue.Str(signingKey.kid))
            .put("environmentId", new JsonValue.Str(env)).put("bundle", new JsonValue.Str(text))
            .put("committedAt", committedAt == null ? JsonValue.NULL : new JsonValue.Num(committedAt))
            .put("sentAt", new JsonValue.Num(System.currentTimeMillis()))
            .build().toJson();
    }

    /** Pushes the current revision to every connected socket. */
    void push(boolean tamper, String env) {
        String msg = revMessage("rev", tamper, env);
        for (WebSocket s : sockets) s.send(msg);
    }

    void push() { push(false, environmentId); }

    void closeSockets(int code, String reason) {
        for (WebSocket s : sockets) s.close(code, reason);
    }

    private boolean authed(RecordedRequest r) {
        String a = r.getHeader("Authorization");
        return a != null && (a.startsWith("Bearer nf_srv_") || a.startsWith("Bearer nf_pub_"));
    }

    private MockResponse handle(RecordedRequest r) {
        requests.add(r);
        String path = r.getRequestUrl() == null ? "" : r.getRequestUrl().encodedPath();
        switch (path) {
            case "/v1/keys": {
                keysRequests.incrementAndGet();
                StringBuilder keys = new StringBuilder();
                for (Key k : published) {
                    if (keys.length() > 0) keys.append(',');
                    keys.append("{\"kty\":\"OKP\",\"crv\":\"Ed25519\",\"x\":\"").append(k.jwk.x()).append("\",\"kid\":\"").append(k.kid)
                        .append("\",\"alg\":\"EdDSA\",\"use\":\"sig\",\"status\":\"active\"}");
                }
                return new MockResponse().setBody("{\"keys\":[" + keys + "]}");
            }
            case "/v1/bundle": {
                bundleRequests.incrementAndGet();
                if (!authed(r)) return new MockResponse().setResponseCode(401).setBody("{\"error\":{\"code\":\"unauthorized\",\"message\":\"x\"}}");
                if (bundleStatus != 200) return new MockResponse().setResponseCode(bundleStatus);
                String etag = "\"" + checksum + "-server\"";
                MockResponse res = new MockResponse().addHeader("ETag", etag).addHeader("X-NanoFlags-Environment-Id", environmentId)
                    .addHeader("X-NanoFlags-Signed", Boolean.toString(signed));
                if (staleHeader) res.addHeader("X-NanoFlags-Stale", "true");
                if (signed) res.addHeader("X-NanoFlags-Signature", signature()).addHeader("X-NanoFlags-Key-Id", signingKey.kid);
                if (etag.equals(r.getHeader("If-None-Match"))) {
                    notModified.incrementAndGet();
                    return res.setResponseCode(304);
                }
                String text = tamperHttp ? bundleText.replace("\"default\":false", "\"default\":true") : bundleText;
                return res.setBody("{\"revision\":" + revision + ",\"checksum\":\"" + checksum + "\",\"bundle\":" + text + "}");
            }
            case "/v1/live": {
                liveConnects.incrementAndGet();
                if (!authed(r) || !liveEnabled || r.getRequestUrl().queryParameter("key") != null) return new MockResponse().setResponseCode(503);
                return new MockResponse().addHeader("Sec-WebSocket-Protocol", NanoFlagsClient.LIVE_PROTOCOL).withWebSocketUpgrade(new WebSocketListener() {
                    @Override public void onOpen(WebSocket webSocket, Response response) {
                        sockets.add(webSocket);
                        webSocket.send(revMessage("hello", false, environmentId));
                    }

                    @Override public void onMessage(WebSocket webSocket, String text) {
                        if (text.equals("ping") && answerPings) webSocket.send("pong");
                    }

                    @Override public void onClosing(WebSocket webSocket, int code, String reason) { webSocket.close(1000, null); }

                    @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                        sockets.remove(webSocket);
                        closedSockets.incrementAndGet();
                    }

                    @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                        if (sockets.remove(webSocket)) closedSockets.incrementAndGet();
                    }
                });
            }
            case "/v1/stream": {
                streamRequests.incrementAndGet();
                if (!authed(r)) return new MockResponse().setResponseCode(401);
                if (!sseEnabled) return new MockResponse().setResponseCode(503);
                return new MockResponse().addHeader("Content-Type", "text/event-stream")
                    .setBody(": hello\n\nevent: revision\ndata: {\"revision\":" + revision + ",\"checksum\":\"" + checksum + "\"}\n\n");
            }
            case "/v1/events":
                events.add(JsonValue.parse(r.getBody().readUtf8()));
                return new MockResponse().setResponseCode(202).setBody("{\"accepted\":1,\"capped\":false}");
            default:
                return new MockResponse().setResponseCode(404);
        }
    }

    @Override
    public void close() {
        try {
            closeSockets(1001, "shutdown");
        } catch (RuntimeException ignored) {
            // ignore
        }
        try {
            server.shutdown();
        } catch (Exception ignored) {
            // ignore
        }
    }
}
