package io.nanoflags.server;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.nanoflags.server.engine.Bundle;
import io.nanoflags.server.engine.JsonValue;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.SecureRandom;
import java.util.List;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.junit.jupiter.api.Test;

class VerifyTest {
    static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    // RFC 8032, section 7.1, tests 1-3.
    static final String[][] RFC8032 = {
        {"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"},
        {"3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
            "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"},
        {"fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
            "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"},
    };

    @Test
    void rfc8032VectorsBothImplementations() {
        for (String[] v : RFC8032) {
            byte[] pk = hex(v[0]);
            byte[] msg = hex(v[1]);
            byte[] sig = hex(v[2]);
            assertTrue(Ed25519.verifyPure(pk, msg, sig), "pure " + v[0]);
            assertTrue(Ed25519.verify(pk, msg, sig), "default " + v[0]);
            byte[] bad = sig.clone();
            bad[5] ^= 1;
            assertFalse(Ed25519.verifyPure(pk, msg, bad));
            assertFalse(Ed25519.verify(pk, msg, bad));
            byte[] other = (v[1] + "00").getBytes(StandardCharsets.UTF_8);
            assertFalse(Ed25519.verifyPure(pk, other, sig));
        }
        System.out.println("Ed25519: JDK provider " + (Ed25519.jdkAvailable() ? "available" : "not available (built-in implementation in use)"));
    }

    @Test
    void randomSignaturesFromBouncyCastle() {
        SecureRandom rnd = new SecureRandom();
        for (int i = 0; i < 25; i++) {
            Ed25519PrivateKeyParameters k = new Ed25519PrivateKeyParameters(rnd);
            byte[] msg = new byte[rnd.nextInt(300)];
            rnd.nextBytes(msg);
            Ed25519Signer s = new Ed25519Signer();
            s.init(true, k);
            s.update(msg, 0, msg.length);
            byte[] sig = s.generateSignature();
            byte[] pk = k.generatePublicKey().getEncoded();
            assertTrue(Ed25519.verifyPure(pk, msg, sig));
            assertTrue(Ed25519.verify(pk, msg, sig));
            sig[40] ^= 0x10;
            assertFalse(Ed25519.verifyPure(pk, msg, sig));
            assertFalse(Ed25519.verify(pk, msg, sig));
        }
    }

    @Test
    void nonCanonicalScalarAndBadKeysAreRejected() {
        String[] v = RFC8032[0];
        byte[] pk = hex(v[0]);
        byte[] sig = hex(v[2]);
        // S + L: the same point equation, but S is not reduced (malleability).
        java.math.BigInteger l = java.math.BigInteger.ONE.shiftLeft(252).add(new java.math.BigInteger("27742317777372353535851937790883648493"));
        byte[] sLe = new byte[32];
        System.arraycopy(sig, 32, sLe, 0, 32);
        byte[] be = new byte[33];
        for (int i = 0; i < 32; i++) be[32 - i] = sLe[i];
        byte[] sum = new java.math.BigInteger(be).add(l).toByteArray();
        byte[] mall = sig.clone();
        for (int i = 0; i < 32; i++) mall[32 + i] = i < sum.length ? sum[sum.length - 1 - i] : 0;
        assertFalse(Ed25519.verifyPure(pk, new byte[0], mall));
        assertFalse(Ed25519.verify(pk, new byte[0], mall));
        assertFalse(Ed25519.verify(new byte[31], new byte[0], sig));
        assertFalse(Ed25519.verify(pk, new byte[0], new byte[63]));
        byte[] notOnCurve = new byte[32];
        notOnCurve[0] = 2; // y = 2 has no x on the curve
        assertFalse(Ed25519.verifyPure(notOnCurve, new byte[0], sig));
    }

    @Test
    void realEdgeResponseVerifiesWithTheEmbeddedKeys() throws Exception {
        JsonValue fx = JsonValue.parse(Files.readAllBytes(Paths.get("../../go/internal/testdata/signed-demo-response.json")));
        String body = ((JsonValue.Str) fx.field("body")).value();
        JsonValue h = fx.field("headers");
        JsonValue doc = JsonValue.parse(body);
        Bundle b = Bundle.of(doc.field("bundle"));
        assertNotNull(b);
        Signatures.Info info = new Signatures.Info(((JsonValue.Str) h.field("x-nanoflags-signature")).value(), ((JsonValue.Str) h.field("x-nanoflags-key-id")).value(),
            ((JsonValue.Str) h.field("x-nanoflags-environment-id")).value(), b.revision(), ((JsonValue.Str) doc.field("checksum")).value());
        String raw = Signatures.rawMember(body, "bundle");
        List<Signatures.Key> keys = Signatures.importKeys(NanoFlagsOptions.OFFICIAL_SIGNING_KEYS);
        assertEquals(1, keys.size());
        assertTrue(Signatures.verifyBundleText(keys, info, raw.getBytes(StandardCharsets.UTF_8)));
        assertFalse(Signatures.verifyBundleText(keys, info, (raw + " ").getBytes(StandardCharsets.UTF_8)));
        Signatures.Info wrongKid = new Signatures.Info(info.signature, "k9", info.environmentId, info.revision, info.checksum);
        assertFalse(Signatures.verifyBundleText(keys, wrongKid, raw.getBytes(StandardCharsets.UTF_8)));
        Signatures.Info wrongEnv = new Signatures.Info(info.signature, "k1", "other", info.revision, info.checksum);
        assertFalse(Signatures.verifyBundleText(keys, wrongEnv, raw.getBytes(StandardCharsets.UTF_8)));
        // Both implementations agree on the real signature.
        byte[] msg = Signatures.canonicalString(info.environmentId, info.revision, info.checksum, raw.getBytes(StandardCharsets.UTF_8));
        assertTrue(Ed25519.verifyPure(keys.get(0).raw, msg, Signatures.base64UrlDecode(info.signature)));
    }

    @Test
    void rawMemberReturnsTheExactSourceText() {
        assertEquals("{ \"a\" : [1, \"}\"] }", Signatures.rawMember("{\"x\":1, \"bundle\":{ \"a\" : [1, \"}\"] } }", "bundle"));
        assertEquals("2", Signatures.rawMember("{\"bundle\":1,\"bundle\":2}", "bundle"), "the last one wins, like JSON.parse");
        assertEquals("\"s\\\"q\"", Signatures.rawMember("{\"b\\u0075ndle\":\"s\\\"q\"}", "bundle"), "escaped key names");
        assertNull(Signatures.rawMember("[1]", "bundle"));
        assertNull(Signatures.rawMember("{\"bundle\":", "bundle"));
        assertNull(Signatures.rawMember("{\"other\":1}", "bundle"));
    }

    @Test
    void canonicalString() {
        byte[] c = Signatures.canonicalString("env", 5, "abc", "{}".getBytes(StandardCharsets.UTF_8));
        assertArrayEquals(("nanoflags-bundle-v1\nenv\n5\nabc\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a").getBytes(StandardCharsets.UTF_8), c);
    }
}
