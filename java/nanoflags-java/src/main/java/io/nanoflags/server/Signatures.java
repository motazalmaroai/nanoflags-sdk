package io.nanoflags.server;

import io.nanoflags.server.engine.InvalidJsonException;
import io.nanoflags.server.engine.JsonValue;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/** Bundle signatures: the canonical string, Ed25519 verification by key id, the exact signed bytes. */
final class Signatures {
    private Signatures() {}

    /** What a signature covers (from the {@code X-NanoFlags-*} headers / the push message). */
    static final class Info {
        final String signature;
        final String kid;
        final String environmentId;
        final long revision;
        final String checksum;

        Info(String signature, String kid, String environmentId, long revision, String checksum) {
            this.signature = signature;
            this.kid = kid == null || kid.isEmpty() ? null : kid;
            this.environmentId = environmentId;
            this.revision = revision;
            this.checksum = checksum;
        }

        JsonValue.Obj toJson() {
            JsonValue.Obj.Builder b = JsonValue.Obj.builder().put("signature", new JsonValue.Str(signature));
            if (kid != null) b.put("kid", new JsonValue.Str(kid));
            return b.put("environmentId", new JsonValue.Str(environmentId))
                .put("revision", new JsonValue.Num(revision))
                .put("checksum", new JsonValue.Str(checksum))
                .build();
        }

        static Info fromJson(JsonValue v) {
            if (!(v instanceof JsonValue.Obj)) return null;
            JsonValue sig = v.field("signature");
            JsonValue env = v.field("environmentId");
            JsonValue rev = v.field("revision");
            JsonValue sum = v.field("checksum");
            JsonValue kid = v.field("kid");
            if (!(sig instanceof JsonValue.Str) || !(env instanceof JsonValue.Str) || !(rev instanceof JsonValue.Num) || !(sum instanceof JsonValue.Str)) return null;
            double r = ((JsonValue.Num) rev).value();
            if (r != Math.floor(r) || Double.isInfinite(r)) return null;
            return new Info(((JsonValue.Str) sig).value(), kid instanceof JsonValue.Str ? ((JsonValue.Str) kid).value() : null,
                ((JsonValue.Str) env).value(), (long) r, ((JsonValue.Str) sum).value());
        }
    }

    static final class Key {
        final String kid;
        final byte[] raw;

        Key(String kid, byte[] raw) {
            this.kid = kid == null || kid.isEmpty() ? null : kid;
            this.raw = raw;
        }
    }

    static List<Key> importKeys(List<Jwk> jwks) {
        List<Key> out = new ArrayList<>();
        for (Jwk k : jwks) {
            if (k == null || !k.isPublicEd25519()) continue;
            byte[] raw = base64UrlDecode(k.x());
            if (raw == null || raw.length != 32) continue;
            out.add(new Key(k.kid(), raw));
        }
        return out;
    }

    /** Base64url (padding optional; standard alphabet tolerated). {@code null} when invalid. */
    static byte[] base64UrlDecode(String s) {
        String t = s.replace('+', '-').replace('/', '_');
        while (t.endsWith("=")) t = t.substring(0, t.length() - 1);
        try {
            return Base64.getUrlDecoder().decode(t);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    static String sha256Hex(byte[] data) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
            char[] out = new char[d.length * 2];
            for (int i = 0; i < d.length; i++) {
                out[i * 2] = HEX[(d[i] >> 4) & 0xf];
                out[i * 2 + 1] = HEX[d[i] & 0xf];
            }
            return new String(out);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The signed text: {@code nanoflags-bundle-v1\n<environment>\n<revision>\n<checksum>\n<sha256 hex of the bundle text>}. */
    static byte[] canonicalString(String environmentId, long revision, String checksum, byte[] bundleText) {
        return ("nanoflags-bundle-v1\n" + environmentId + "\n" + revision + "\n" + checksum + "\n" + sha256Hex(bundleText)).getBytes(StandardCharsets.UTF_8);
    }

    /**
     * Whether {@code info.signature} is a valid signature by one of {@code keys} over the canonical string for
     * {@code bundleText}. A key id narrows the candidates; an unknown key id matches no key that has an id.
     */
    static boolean verifyBundleText(List<Key> keys, Info info, byte[] bundleText) {
        byte[] sig = base64UrlDecode(info.signature);
        if (sig == null || sig.length != 64) return false;
        byte[] msg = canonicalString(info.environmentId, info.revision, info.checksum, bundleText);
        for (Key k : keys) {
            if (info.kid != null && k.kid != null && !k.kid.equals(info.kid)) continue;
            if (Ed25519.verify(k.raw, msg, sig)) return true;
        }
        return false;
    }

    /**
     * The exact source text of the top-level member {@code name} of a JSON object (the last one when it repeats, like
     * {@code JSON.parse}), or {@code null}. The edge embeds the stored, signed bundle text byte-for-byte; hashing that
     * span avoids any re-serialisation.
     */
    static String rawMember(String text, String name) {
        return new RawScanner(text).member(name);
    }

    private static final class RawScanner {
        private final String t;
        private final int n;
        private int i;

        RawScanner(String t) {
            this.t = t;
            this.n = t.length();
        }

        private void ws() {
            while (i < n) {
                char c = t.charAt(i);
                if (c == ' ' || c == '\n' || c == '\r' || c == '\t') i++;
                else break;
            }
        }

        /** Skips a string; returns its start or -1. */
        private int str() {
            if (i >= n || t.charAt(i) != '"') return -1;
            int start = i++;
            while (i < n) {
                char c = t.charAt(i);
                if (c == '\\') i += 2;
                else if (c == '"') {
                    i++;
                    return start;
                } else i++;
            }
            return -1;
        }

        private boolean value() {
            ws();
            if (i >= n) return false;
            char c = t.charAt(i);
            if (c == '"') return str() >= 0;
            if (c == '{' || c == '[') {
                int depth = 0;
                while (i < n) {
                    char d = t.charAt(i);
                    if (d == '"') {
                        if (str() < 0) return false;
                        continue;
                    }
                    if (d == '{' || d == '[') depth++;
                    else if (d == '}' || d == ']') depth--;
                    i++;
                    if (depth == 0) return true;
                }
                return false;
            }
            int start = i;
            while (i < n && ",}] \n\r\t".indexOf(t.charAt(i)) < 0) i++;
            return i > start;
        }

        String member(String name) {
            ws();
            if (i >= n || t.charAt(i) != '{') return null;
            i++;
            String found = null;
            while (true) {
                ws();
                if (i < n && t.charAt(i) == '}') return found;
                int ks = str();
                if (ks < 0) return null;
                int ke = i;
                ws();
                if (i >= n || t.charAt(i) != ':') return null;
                i++;
                ws();
                int start = i;
                if (!value()) return null;
                try {
                    JsonValue key = JsonValue.parse(t.substring(ks, ke));
                    if (key instanceof JsonValue.Str && ((JsonValue.Str) key).value().equals(name)) found = t.substring(start, i);
                } catch (InvalidJsonException ignored) {
                    return null;
                }
                ws();
                if (i < n && t.charAt(i) == ',') i++;
                else if (i < n && t.charAt(i) == '}') return found;
                else return null;
            }
        }
    }
}
