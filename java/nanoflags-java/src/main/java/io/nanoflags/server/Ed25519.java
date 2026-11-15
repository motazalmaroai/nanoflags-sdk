package io.nanoflags.server;

import java.math.BigInteger;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;

/**
 * Ed25519 signature verification (RFC 8032). Uses the JDK's provider when it has one (Java 15+) and otherwise a
 * self-contained implementation of the RFC's verification equation, so the SDK needs no crypto dependency on
 * Java 11. Both reject non-canonical {@code S} and invalid public keys; the cofactorless equation
 * {@code [S]B = R + [k]A} is checked by re-encoding, like Go's {@code crypto/ed25519}.
 */
final class Ed25519 {
    private Ed25519() {}

    private static final byte[] X509_PREFIX = {0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00};
    private static final boolean JDK;

    static {
        boolean ok;
        try {
            KeyFactory.getInstance("Ed25519");
            Signature.getInstance("Ed25519");
            ok = true;
        } catch (NoSuchAlgorithmException e) {
            ok = false;
        }
        JDK = ok;
    }

    /** Whether the JDK provides Ed25519 (otherwise the built-in implementation is used). */
    static boolean jdkAvailable() { return JDK; }

    static boolean verify(byte[] publicKey, byte[] message, byte[] signature) {
        if (publicKey == null || publicKey.length != 32 || signature == null || signature.length != 64) return false;
        // Both paths refuse S >= L; checked here so that the JDK path behaves identically.
        if (!scalarIsCanonical(signature)) return false;
        if (JDK) {
            try {
                byte[] der = new byte[X509_PREFIX.length + 32];
                System.arraycopy(X509_PREFIX, 0, der, 0, X509_PREFIX.length);
                System.arraycopy(publicKey, 0, der, X509_PREFIX.length, 32);
                PublicKey key = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der));
                Signature s = Signature.getInstance("Ed25519");
                s.initVerify(key);
                s.update(message);
                return s.verify(signature);
            } catch (GeneralSecurityException | RuntimeException e) {
                return false;
            }
        }
        return verifyPure(publicKey, message, signature);
    }

    /* ---------------- RFC 8032 (verification only; inputs are public, so constant time is not needed) ---------------- */

    private static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
    private static final BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
    private static final BigInteger D = BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);
    private static final BigInteger D2 = D.shiftLeft(1).mod(P);
    private static final BigInteger SQRT_M1 = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
    private static final BigInteger TWO = BigInteger.valueOf(2);
    private static final BigInteger[] BASE;

    static {
        BigInteger y = BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P);
        BigInteger x = recoverX(y, 0);
        BASE = new BigInteger[] {x, y, BigInteger.ONE, x.multiply(y).mod(P)};
    }

    static boolean scalarIsCanonical(byte[] sig) {
        return le(sig, 32, 32).compareTo(L) < 0;
    }

    static boolean verifyPure(byte[] publicKey, byte[] message, byte[] signature) {
        BigInteger[] a = decodePoint(publicKey);
        if (a == null) return false;
        BigInteger s = le(signature, 32, 32);
        if (s.compareTo(L) >= 0) return false;
        byte[] h;
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-512");
            sha.update(signature, 0, 32);
            sha.update(publicKey);
            sha.update(message);
            h = sha.digest();
        } catch (NoSuchAlgorithmException e) {
            return false;
        }
        BigInteger k = le(h, 0, 64).mod(L);
        BigInteger[] negA = {P.subtract(a[0]).mod(P), a[1], a[2], P.subtract(a[3]).mod(P)};
        BigInteger[] r = add(mul(s, BASE), mul(k, negA));
        byte[] enc = encodePoint(r);
        for (int i = 0; i < 32; i++) if (enc[i] != signature[i]) return false;
        return true;
    }

    private static BigInteger le(byte[] b, int off, int len) {
        byte[] be = new byte[len + 1];
        for (int i = 0; i < len; i++) be[len - i] = b[off + i];
        return new BigInteger(be);
    }

    private static BigInteger recoverX(BigInteger y, int sign) {
        if (y.compareTo(P) >= 0) return null;
        BigInteger y2 = y.multiply(y).mod(P);
        BigInteger x2 = y2.subtract(BigInteger.ONE).multiply(D.multiply(y2).add(BigInteger.ONE).modInverse(P)).mod(P);
        if (x2.signum() == 0) return sign == 1 ? null : BigInteger.ZERO;
        BigInteger x = x2.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
        if (x.multiply(x).subtract(x2).mod(P).signum() != 0) x = x.multiply(SQRT_M1).mod(P);
        if (x.multiply(x).subtract(x2).mod(P).signum() != 0) return null;
        if (x.testBit(0) != (sign == 1)) x = P.subtract(x);
        return x;
    }

    private static BigInteger[] decodePoint(byte[] s) {
        byte[] c = s.clone();
        int sign = (c[31] >> 7) & 1;
        c[31] &= 0x7f;
        BigInteger y = le(c, 0, 32);
        BigInteger x = recoverX(y, sign);
        if (x == null) return null;
        return new BigInteger[] {x, y, BigInteger.ONE, x.multiply(y).mod(P)};
    }

    private static byte[] encodePoint(BigInteger[] p) {
        BigInteger zi = p[2].modInverse(P);
        BigInteger x = p[0].multiply(zi).mod(P);
        BigInteger y = p[1].multiply(zi).mod(P);
        byte[] be = y.toByteArray();
        byte[] out = new byte[32];
        for (int i = 0; i < 32 && i < be.length; i++) out[i] = be[be.length - 1 - i];
        if (x.testBit(0)) out[31] |= (byte) 0x80;
        return out;
    }

    private static BigInteger[] add(BigInteger[] p, BigInteger[] q) {
        BigInteger a = p[1].subtract(p[0]).multiply(q[1].subtract(q[0])).mod(P);
        BigInteger b = p[1].add(p[0]).multiply(q[1].add(q[0])).mod(P);
        BigInteger c = p[3].multiply(D2).mod(P).multiply(q[3]).mod(P);
        BigInteger d = p[2].multiply(TWO).multiply(q[2]).mod(P);
        BigInteger e = b.subtract(a);
        BigInteger f = d.subtract(c);
        BigInteger g = d.add(c);
        BigInteger h = b.add(a);
        return new BigInteger[] {e.multiply(f).mod(P), g.multiply(h).mod(P), f.multiply(g).mod(P), e.multiply(h).mod(P)};
    }

    private static BigInteger[] mul(BigInteger s, BigInteger[] p) {
        BigInteger[] q = {BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO};
        for (int i = s.bitLength() - 1; i >= 0; i--) {
            q = add(q, q);
            if (s.testBit(i)) q = add(q, p);
        }
        return q;
    }
}
