package io.nanoflags.server;

import io.nanoflags.server.engine.JsonValue;
import java.util.Objects;

/** A public Ed25519 key as published by {@code GET /v1/keys} (JWK, {@code kty} OKP, {@code crv} Ed25519). */
public final class Jwk {
    private final String kty;
    private final String crv;
    private final String x;
    private final String kid;
    private final String d;

    public Jwk(String kty, String crv, String x, String kid) { this(kty, crv, x, kid, null); }

    private Jwk(String kty, String crv, String x, String kid, String d) {
        this.kty = kty == null ? "" : kty;
        this.crv = crv == null ? "" : crv;
        this.x = x == null ? "" : x;
        this.kid = kid;
        this.d = d;
    }

    /** A public Ed25519 key from its base64url-encoded 32 bytes. */
    public static Jwk ed25519(String x, String kid) { return new Jwk("OKP", "Ed25519", x, kid); }

    /** Reads a JWK object ({@code {kty, crv, x, kid}}); {@code null} when it is not an object. */
    public static Jwk fromJson(JsonValue v) {
        if (!(v instanceof JsonValue.Obj)) return null;
        return new Jwk(s(v, "kty"), s(v, "crv"), s(v, "x"), s(v, "kid"), s(v, "d"));
    }

    private static String s(JsonValue v, String k) {
        JsonValue f = v.field(k);
        return f instanceof JsonValue.Str ? ((JsonValue.Str) f).value() : null;
    }

    public String kty() { return kty; }

    public String crv() { return crv; }

    public String x() { return x; }

    /** The key id, or {@code null}. */
    public String kid() { return kid; }

    /** Whether this is a public Ed25519 key (a JWK that carries the private member {@code d} is refused). */
    public boolean isPublicEd25519() { return "OKP".equals(kty) && "Ed25519".equals(crv) && !x.isEmpty() && d == null; }

    @Override public boolean equals(Object o) {
        if (!(o instanceof Jwk)) return false;
        Jwk j = (Jwk) o;
        return kty.equals(j.kty) && crv.equals(j.crv) && x.equals(j.x) && Objects.equals(kid, j.kid) && Objects.equals(d, j.d);
    }

    @Override public int hashCode() { return Objects.hash(kty, crv, x, kid); }

    @Override public String toString() { return "Jwk{kid=" + kid + ", x=" + x + "}"; }
}
