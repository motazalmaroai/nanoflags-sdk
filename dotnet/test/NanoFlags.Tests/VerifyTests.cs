using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text;
using NanoFlags.Engine;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;
using Xunit;

namespace NanoFlags.Tests
{
    public class VerifyTests
    {
        private static byte[] Hex(string s) => Enumerable.Range(0, s.Length / 2).Select(i => Convert.ToByte(s.Substring(i * 2, 2), 16)).ToArray();

        // RFC 8032, section 7.1, tests 1-3.
        private static readonly string[][] Rfc8032 =
        {
            new[] { "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
                "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b" },
            new[] { "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
                "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00" },
            new[] { "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
                "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a" },
        };

        [Fact]
        public void Rfc8032Vectors()
        {
            foreach (var v in Rfc8032)
            {
                var pk = Hex(v[0]);
                var msg = Hex(v[1]);
                var sig = Hex(v[2]);
                Assert.True(Ed25519.Verify(pk, msg, sig));
                var bad = (byte[])sig.Clone();
                bad[5] ^= 1;
                Assert.False(Ed25519.Verify(pk, msg, bad));
                Assert.False(Ed25519.Verify(pk, msg.Concat(new byte[] { 0 }).ToArray(), sig));
            }
        }

        [Fact]
        public void RandomSignaturesFromBouncyCastle()
        {
            var rnd = new SecureRandom();
            for (int i = 0; i < 25; i++)
            {
                var gen = new Ed25519KeyPairGenerator();
                gen.Init(new Ed25519KeyGenerationParameters(rnd));
                var pair = gen.GenerateKeyPair();
                var msg = new byte[rnd.Next(300)];
                rnd.NextBytes(msg);
                var s = new Ed25519Signer();
                s.Init(true, pair.Private);
                s.BlockUpdate(msg, 0, msg.Length);
                var sig = s.GenerateSignature();
                var pk = ((Ed25519PublicKeyParameters)pair.Public).GetEncoded();
                Assert.True(Ed25519.Verify(pk, msg, sig));
                sig[40] ^= 0x10;
                Assert.False(Ed25519.Verify(pk, msg, sig));
            }
        }

        [Fact]
        public void NonCanonicalScalarAndBadKeysAreRejected()
        {
            var pk = Hex(Rfc8032[0][0]);
            var sig = Hex(Rfc8032[0][2]);
            var l = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
            var s = new BigInteger(sig.Skip(32).Concat(new byte[] { 0 }).ToArray()) + l;
            var sb = s.ToByteArray();
            var mall = (byte[])sig.Clone();
            for (int i = 0; i < 32; i++) mall[32 + i] = i < sb.Length ? sb[i] : (byte)0;
            Assert.False(Ed25519.Verify(pk, Array.Empty<byte>(), mall));
            Assert.False(Ed25519.Verify(new byte[31], Array.Empty<byte>(), sig));
            Assert.False(Ed25519.Verify(pk, Array.Empty<byte>(), new byte[63]));
            var notOnCurve = new byte[32];
            notOnCurve[0] = 2;
            Assert.False(Ed25519.Verify(notOnCurve, Array.Empty<byte>(), sig));
        }

        [Fact]
        public void RealEdgeResponseVerifiesWithTheEmbeddedKeys()
        {
            var fx = Fixtures.Load(Fixtures.SignedDemo)!;
            var body = ((JsonValue.Str)fx.Field("body")).Value;
            var h = fx.Field("headers");
            var doc = JsonValue.Parse(body);
            var b = Bundle.Of(doc.Field("bundle"))!;
            var info = new Signatures.Info(((JsonValue.Str)h.Field("x-nanoflags-signature")).Value, ((JsonValue.Str)h.Field("x-nanoflags-key-id")).Value,
                ((JsonValue.Str)h.Field("x-nanoflags-environment-id")).Value, b.Revision, ((JsonValue.Str)doc.Field("checksum")).Value);
            var raw = Signatures.RawMember(body, "bundle")!;
            var keys = Signatures.ImportKeys(NanoFlagsOptions.OfficialSigningKeys);
            Assert.Single(keys);
            Assert.True(Signatures.VerifyBundleText(keys, info, Encoding.UTF8.GetBytes(raw)));
            Assert.False(Signatures.VerifyBundleText(keys, info, Encoding.UTF8.GetBytes(raw + " ")));
            Assert.False(Signatures.VerifyBundleText(keys, new Signatures.Info(info.Signature, "k9", info.EnvironmentId, info.Revision, info.Checksum), Encoding.UTF8.GetBytes(raw)));
            Assert.False(Signatures.VerifyBundleText(keys, new Signatures.Info(info.Signature, "k1", "other", info.Revision, info.Checksum), Encoding.UTF8.GetBytes(raw)));
        }

        [Fact]
        public void RawMemberReturnsTheExactSourceText()
        {
            Assert.Equal("{ \"a\" : [1, \"}\"] }", Signatures.RawMember("{\"x\":1, \"bundle\":{ \"a\" : [1, \"}\"] } }", "bundle"));
            Assert.Equal("2", Signatures.RawMember("{\"bundle\":1,\"bundle\":2}", "bundle"));
            Assert.Equal("\"s\\\"q\"", Signatures.RawMember("{\"b\\u0075ndle\":\"s\\\"q\"}", "bundle"));
            Assert.Null(Signatures.RawMember("[1]", "bundle"));
            Assert.Null(Signatures.RawMember("{\"bundle\":", "bundle"));
            Assert.Null(Signatures.RawMember("{\"other\":1}", "bundle"));
        }

        [Fact]
        public void CanonicalString()
        {
            Assert.Equal("nanoflags-bundle-v1\nenv\n5\nabc\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
                Encoding.UTF8.GetString(Signatures.CanonicalString("env", 5, "abc", Encoding.UTF8.GetBytes("{}"))));
        }

        [Fact]
        public void Base64UrlAcceptsBothAlphabets()
        {
            Assert.Equal(new byte[] { 0xfb, 0xff }, Signatures.Base64UrlDecode("-_8"));
            Assert.Equal(new byte[] { 0xfb, 0xff }, Signatures.Base64UrlDecode("+/8="));
            Assert.Null(Signatures.Base64UrlDecode("a"));
        }
    }

    public class NumberTests
    {
        [Fact]
        public void ShortestRoundTripMatchesTheRuntimeOnRandomDoubles()
        {
            var rnd = new Random(42);
            var buf = new byte[8];
            for (int i = 0; i < 20000; i++)
            {
                rnd.NextBytes(buf);
                double x = BitConverter.ToDouble(buf, 0);
                if (double.IsNaN(x) || double.IsInfinity(x)) continue;
                var s = Js.NumberToString(x);
                Assert.Equal(x, double.Parse(s, CultureInfo.InvariantCulture));
                // .NET Core 3.0+ "R" is the shortest round-trip representation, like JavaScript's.
                var r = x.ToString("R", CultureInfo.InvariantCulture);
                Assert.Equal(Digits(r), Digits(s));
                Assert.Equal(x, DoubleConv.ParseDecimal(r));
            }
        }

        private static string Digits(string s)
        {
            var m = s.Split('e', 'E')[0].Replace("-", "").Replace(".", "").TrimStart('0').TrimEnd('0');
            return m;
        }

        [Theory]
        [InlineData(0.1, "0.1")]
        [InlineData(1e21, "1e+21")]
        [InlineData(1e-7, "1e-7")]
        [InlineData(123456789012345680000.0, "123456789012345680000")]
        [InlineData(0.000001, "0.000001")]
        [InlineData(-1.5e-10, "-1.5e-10")]
        [InlineData(5e-324, "5e-324")]
        [InlineData(1.7976931348623157e308, "1.7976931348623157e+308")]
        [InlineData(2.5, "2.5")]
        public void JavaScriptNumberToString(double x, string expected) => Assert.Equal(expected, Js.NumberToString(x));

        [Theory]
        [InlineData("  12  ", 12.0)]
        [InlineData("0x1F", 31.0)]
        [InlineData("0b101", 5.0)]
        [InlineData("1e400", double.PositiveInfinity)]
        [InlineData("-1e400", double.NegativeInfinity)]
        [InlineData("1e-400", 0.0)]
        [InlineData(".5", 0.5)]
        [InlineData("", 0.0)]
        public void StringToNumber(string s, double expected) => Assert.Equal(expected, Js.StringToNumber(s));

        [Fact]
        public void StringToNumberRejects()
        {
            foreach (var s in new[] { "1d", "0x", "abc", "1e", "Infinityx", "0b2" }) Assert.True(double.IsNaN(Js.StringToNumber(s)), s);
        }

        [Theory]
        [InlineData(12.345, "12.35")]
        [InlineData(1.005, "1.00")]
        [InlineData(0.0, "0.00")]
        [InlineData(99.99, "99.99")]
        [InlineData(0.125, "0.13")]
        public void ToFixed2(double x, string expected) => Assert.Equal(expected, DoubleConv.ToFixed2(x));

        [Fact]
        public void NfcNormalisationIsAppliedBeforeHashing()
        {
            // "é" precomposed and decomposed hash identically.
            Assert.Equal(Evaluator.Murmur3("café"), Evaluator.Murmur3("café"));
        }

        [Fact]
        public void DeepOrCyclicContextsFailEvaluationNotTheProcess()
        {
            var d = new System.Collections.Generic.Dictionary<string, object?>();
            d["self"] = d;
            var bundle = JsonValue.Parse("{\"schema\":1,\"revision\":1,\"flags\":{\"f\":{\"enabled\":true,\"default\":1,\"rules\":[{\"match\":\"all\",\"conditions\":[{\"attribute\":\"self\",\"op\":\"eq\",\"value\":1}],\"serve\":{\"type\":\"fixed\",\"value\":2}}]}},\"segments\":{}}");
            var r = Evaluator.Evaluate(bundle, "f", EvalContexts.Of(d), new JsonValue.Num(0));
            Assert.Equal(Reason.Error, r.Reason);
        }
    }
}
