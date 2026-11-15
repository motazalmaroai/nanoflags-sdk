using System;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;

namespace NanoFlags
{
    /// <summary>
    /// Ed25519 signature verification (RFC 8032), self-contained so that the SDK needs no native or third-party crypto
    /// on any target framework (.NET has no built-in Ed25519). Rejects non-canonical S and invalid public keys and checks
    /// the cofactorless equation [S]B = R + [k]A by re-encoding, like Go's crypto/ed25519. Inputs are public, so constant
    /// time is not needed.
    /// </summary>
    internal static class Ed25519
    {
        private static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
        private static readonly BigInteger L = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
        private static readonly BigInteger D = Mod(-121665 * Inv(121666));
        private static readonly BigInteger D2 = Mod(D * 2);
        private static readonly BigInteger SqrtM1 = BigInteger.ModPow(2, (P - 1) / 4, P);
        private static readonly BigInteger[] Base = MakeBase();

        private static BigInteger Mod(BigInteger a)
        {
            var r = a % P;
            return r.Sign < 0 ? r + P : r;
        }

        private static BigInteger Inv(BigInteger a) => BigInteger.ModPow(Mod(a), P - 2, P);

        private static BigInteger[] MakeBase()
        {
            var y = Mod(4 * Inv(5));
            var x = RecoverX(y, 0)!.Value;
            return new[] { x, y, BigInteger.One, Mod(x * y) };
        }

        private static BigInteger Le(byte[] b, int off, int len)
        {
            var tmp = new byte[len + 1];
            Array.Copy(b, off, tmp, 0, len);
            return new BigInteger(tmp);
        }

        private static BigInteger? RecoverX(BigInteger y, int sign)
        {
            if (y >= P) return null;
            var y2 = Mod(y * y);
            var x2 = Mod((y2 - 1) * Inv(D * y2 + 1));
            if (x2.IsZero) return sign == 1 ? (BigInteger?)null : BigInteger.Zero;
            var x = BigInteger.ModPow(x2, (P + 3) / 8, P);
            if (!Mod(x * x - x2).IsZero) x = Mod(x * SqrtM1);
            if (!Mod(x * x - x2).IsZero) return null;
            if ((x.IsEven ? 0 : 1) != sign) x = P - x;
            return x;
        }

        private static BigInteger[]? DecodePoint(byte[] s)
        {
            var c = (byte[])s.Clone();
            int sign = (c[31] >> 7) & 1;
            c[31] &= 0x7f;
            var y = Le(c, 0, 32);
            var x = RecoverX(y, sign);
            if (x == null) return null;
            return new[] { x.Value, y, BigInteger.One, Mod(x.Value * y) };
        }

        private static byte[] EncodePoint(BigInteger[] p)
        {
            var zi = Inv(p[2]);
            var x = Mod(p[0] * zi);
            var y = Mod(p[1] * zi);
            var le = y.ToByteArray();
            var output = new byte[32];
            Array.Copy(le, 0, output, 0, Math.Min(32, le.Length));
            if (!x.IsEven) output[31] |= 0x80;
            return output;
        }

        private static BigInteger[] Add(BigInteger[] p, BigInteger[] q)
        {
            var a = Mod((p[1] - p[0]) * (q[1] - q[0]));
            var b = Mod((p[1] + p[0]) * (q[1] + q[0]));
            var c = Mod(Mod(p[3] * D2) * q[3]);
            var d = Mod(p[2] * 2 * q[2]);
            var e = b - a;
            var f = d - c;
            var g = d + c;
            var h = b + a;
            return new[] { Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h) };
        }

        private static BigInteger[] Mul(BigInteger s, BigInteger[] p)
        {
            var q = new[] { BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero };
            var bits = s.ToByteArray();
            for (int i = bits.Length * 8 - 1; i >= 0; i--)
            {
                q = Add(q, q);
                if (((bits[i / 8] >> (i % 8)) & 1) == 1) q = Add(q, p);
            }
            return q;
        }

        internal static bool Verify(byte[] publicKey, byte[] message, byte[] signature)
        {
            if (publicKey == null || publicKey.Length != 32 || signature == null || signature.Length != 64) return false;
            var a = DecodePoint(publicKey);
            if (a == null) return false;
            var s = Le(signature, 32, 32);
            if (s >= L) return false;
            byte[] h;
            using (var sha = SHA512.Create())
            {
                var input = new byte[64 + message.Length];
                Array.Copy(signature, 0, input, 0, 32);
                Array.Copy(publicKey, 0, input, 32, 32);
                Array.Copy(message, 0, input, 64, message.Length);
                h = sha.ComputeHash(input);
            }
            var k = Le(h, 0, 64) % L;
            var negA = new[] { Mod(-a[0]), a[1], a[2], Mod(-a[3]) };
            var r = Add(Mul(s, Base), Mul(k, negA));
            var enc = EncodePoint(r);
            for (int i = 0; i < 32; i++)
            {
                if (enc[i] != signature[i]) return false;
            }
            return true;
        }
    }
}
