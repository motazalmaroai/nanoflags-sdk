package io.nanoflags.server;

import io.nanoflags.server.engine.InvalidJsonException;
import io.nanoflags.server.engine.JsonValue;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;

/** The effective verification settings and the key cache. */
final class Verifier {
    static final long KEYS_REFETCH_INTERVAL_NANOS = 60_000_000_000L;

    private final NanoFlagsClient c;
    private final List<Signatures.Key> base;
    final boolean require;
    private final boolean refetch;

    private final Object lock = new Object();
    private List<Signatures.Key> fetched = new ArrayList<>();
    private long fetchedAt; // System.nanoTime(); 0 = never
    private boolean everFetched;

    private Verifier(NanoFlagsClient c, List<Signatures.Key> base, boolean require, boolean refetch) {
        this.c = c;
        this.base = base;
        this.require = require;
        this.refetch = refetch;
    }

    /** Null when verification is off. */
    static Verifier create(NanoFlagsClient c, List<NanoFlagsException> errors) {
        NanoFlagsOptions cfg = c.cfg;
        boolean official = NanoFlagsOptions.OFFICIAL_EDGE_URL.equals(cfg.baseUrl);
        if (cfg.verifySet && cfg.verify == null) return null;
        if (!cfg.verifySet) {
            if (!official) return null;
            return new Verifier(c, Signatures.importKeys(NanoFlagsOptions.OFFICIAL_SIGNING_KEYS), true, true);
        }
        VerifyOptions o = cfg.verify;
        boolean require = o.require != null ? o.require : official;
        if (!o.publicKeys.isEmpty()) {
            for (Jwk k : o.publicKeys) {
                if (k == null || !k.isPublicEd25519()) {
                    errors.add(new NanoFlagsException(ErrorCode.CONFIG,
                        "VerifyOptions.publicKeys must contain public Ed25519 JWKs only; other entries (including private keys) were ignored."));
                    break;
                }
            }
            return new Verifier(c, Signatures.importKeys(o.publicKeys), require, o.fetchKeys);
        }
        if (o.fetchKeys || !official) return new Verifier(c, new ArrayList<>(), require, true);
        return new Verifier(c, Signatures.importKeys(NanoFlagsOptions.OFFICIAL_SIGNING_KEYS), require, true);
    }

    private List<Signatures.Key> all() {
        List<Signatures.Key> out = new ArrayList<>(base);
        out.addAll(fetched);
        return out;
    }

    /**
     * The keys to verify a signature by {@code kid} with: the pinned or embedded keys plus those fetched from
     * {@code /v1/keys}. With refetch, a key id that none of them has (a rotation) loads {@code /v1/keys} once, again at
     * most once a minute.
     */
    List<Signatures.Key> keysFor(String kid) throws InterruptedException {
        if (!refetch) return base;
        synchronized (lock) {
            List<Signatures.Key> known = all();
            if (!known.isEmpty()) {
                if (kid == null) return known;
                for (Signatures.Key k : known) if (kid.equals(k.kid)) return known;
            }
            if (everFetched && System.nanoTime() - fetchedAt < KEYS_REFETCH_INTERVAL_NANOS) return known;
            try {
                fetched = fetch();
                fetchedAt = System.nanoTime();
                everFetched = true;
                return all();
            } catch (NanoFlagsException e) {
                // Without any key the bundle cannot be checked. With the embedded keys the failed reload counts as this
                // minute's reload, so a bad key id cannot make every poll ask for keys.
                if (base.isEmpty()) throw e;
                fetchedAt = System.nanoTime();
                everFetched = true;
                return known;
            }
        }
    }

    private List<Signatures.Key> fetch() throws InterruptedException {
        // Public endpoint: the SDK key is deliberately not sent.
        HttpRequest req = HttpRequest.newBuilder(URI.create(c.cfg.baseUrl + "/v1/keys")).timeout(c.cfg.requestTimeout)
            .header("User-Agent", NanoFlagsClient.USER_AGENT).GET().build();
        try {
            HttpResponse<InputStream> res = c.http.send(req, HttpResponse.BodyHandlers.ofInputStream());
            byte[] body;
            try (InputStream in = res.body()) {
                if (res.statusCode() != 200) throw new NanoFlagsException(ErrorCode.HTTP, "signing keys request failed with HTTP " + res.statusCode(), res.statusCode(), null);
                body = in.readNBytes(1 << 20);
            }
            JsonValue doc = JsonValue.parse(body);
            JsonValue keys = doc.field("keys");
            List<Jwk> jwks = new ArrayList<>();
            if (keys instanceof JsonValue.Arr) for (JsonValue k : ((JsonValue.Arr) keys).items()) jwks.add(Jwk.fromJson(k));
            List<Signatures.Key> out = Signatures.importKeys(jwks);
            if (out.isEmpty()) throw new NanoFlagsException(ErrorCode.SIGNATURE, "the edge returned no usable signing keys");
            return out;
        } catch (IOException e) {
            throw new NanoFlagsException(ErrorCode.NETWORK, e.toString(), 0, e);
        } catch (InvalidJsonException e) {
            throw new NanoFlagsException(ErrorCode.SIGNATURE, "invalid signing keys response: " + e.getMessage());
        }
    }
}
