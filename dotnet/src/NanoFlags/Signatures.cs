using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using NanoFlags.Engine;

namespace NanoFlags
{
    /// <summary>Bundle signatures: the canonical string, Ed25519 verification by key id, the exact signed bytes.</summary>
    internal static class Signatures
    {
        /// <summary>What a signature covers (from the X-NanoFlags-* headers / the push message).</summary>
        internal sealed class Info
        {
            internal Info(string signature, string? kid, string environmentId, long revision, string checksum)
            {
                Signature = signature;
                Kid = string.IsNullOrEmpty(kid) ? null : kid;
                EnvironmentId = environmentId;
                Revision = revision;
                Checksum = checksum;
            }

            internal string Signature { get; }
            internal string? Kid { get; }
            internal string EnvironmentId { get; }
            internal long Revision { get; }
            internal string Checksum { get; }

            internal JsonValue.Obj ToJson()
            {
                var b = new JsonValue.Obj.Builder().Put("signature", new JsonValue.Str(Signature));
                if (Kid != null) b.Put("kid", new JsonValue.Str(Kid));
                return b.Put("environmentId", new JsonValue.Str(EnvironmentId)).Put("revision", new JsonValue.Num(Revision))
                    .Put("checksum", new JsonValue.Str(Checksum)).Build();
            }

            internal static Info? FromJson(JsonValue v)
            {
                if (!(v is JsonValue.Obj)) return null;
                if (!(v.Field("signature") is JsonValue.Str sig) || !(v.Field("environmentId") is JsonValue.Str env) || !(v.Field("revision") is JsonValue.Num rev)
                    || !(v.Field("checksum") is JsonValue.Str sum)) return null;
                if (rev.Value != Math.Floor(rev.Value) || double.IsInfinity(rev.Value)) return null;
                return new Info(sig.Value, (v.Field("kid") as JsonValue.Str)?.Value, env.Value, (long)rev.Value, sum.Value);
            }
        }

        internal sealed class Key
        {
            internal Key(string? kid, byte[] raw)
            {
                Kid = string.IsNullOrEmpty(kid) ? null : kid;
                Raw = raw;
            }

            internal string? Kid { get; }
            internal byte[] Raw { get; }
        }

        internal static List<Key> ImportKeys(IEnumerable<Jwk?> jwks)
        {
            var output = new List<Key>();
            foreach (var k in jwks)
            {
                if (k == null || !k.IsPublicEd25519) continue;
                var raw = Base64UrlDecode(k.X);
                if (raw == null || raw.Length != 32) continue;
                output.Add(new Key(k.Kid, raw));
            }
            return output;
        }

        /// <summary>Base64url (padding optional; the standard alphabet is tolerated). Null when invalid.</summary>
        internal static byte[]? Base64UrlDecode(string s)
        {
            var t = s.Replace('-', '+').Replace('_', '/').TrimEnd('=');
            switch (t.Length % 4)
            {
                case 1: return null;
                case 2: t += "=="; break;
                case 3: t += "="; break;
            }
            try
            {
                return Convert.FromBase64String(t);
            }
            catch (FormatException)
            {
                return null;
            }
        }

        internal static string Sha256Hex(byte[] data)
        {
            using (var sha = SHA256.Create())
            {
                var d = sha.ComputeHash(data);
                var sb = new StringBuilder(d.Length * 2);
                foreach (var b in d) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        /// <summary>The signed text: <c>nanoflags-bundle-v1\n&lt;environment&gt;\n&lt;revision&gt;\n&lt;checksum&gt;\n&lt;sha256 hex of the bundle text&gt;</c>.</summary>
        internal static byte[] CanonicalString(string environmentId, long revision, string checksum, byte[] bundleText) =>
            Encoding.UTF8.GetBytes("nanoflags-bundle-v1\n" + environmentId + "\n" + revision.ToString(CultureInfo.InvariantCulture) + "\n" + checksum + "\n" + Sha256Hex(bundleText));

        /// <summary>Whether the signature is valid for one of the keys. A key id narrows the candidates.</summary>
        internal static bool VerifyBundleText(IReadOnlyList<Key> keys, Info info, byte[] bundleText)
        {
            var sig = Base64UrlDecode(info.Signature);
            if (sig == null || sig.Length != 64) return false;
            var msg = CanonicalString(info.EnvironmentId, info.Revision, info.Checksum, bundleText);
            foreach (var k in keys)
            {
                if (info.Kid != null && k.Kid != null && k.Kid != info.Kid) continue;
                if (Ed25519.Verify(k.Raw, msg, sig)) return true;
            }
            return false;
        }

        /// <summary>
        /// The exact source text of the top-level member <paramref name="name"/> of a JSON object (the last one when it
        /// repeats, like JSON.parse), or null. The edge embeds the stored, signed bundle text byte-for-byte.
        /// </summary>
        internal static string? RawMember(string text, string name) => new RawScanner(text).Member(name);

        private sealed class RawScanner
        {
            private readonly string _t;
            private int _i;

            internal RawScanner(string t) => _t = t;

            private void Ws()
            {
                while (_i < _t.Length && (_t[_i] == ' ' || _t[_i] == '\n' || _t[_i] == '\r' || _t[_i] == '\t')) _i++;
            }

            private int Str()
            {
                if (_i >= _t.Length || _t[_i] != '"') return -1;
                int start = _i++;
                while (_i < _t.Length)
                {
                    char c = _t[_i];
                    if (c == '\\') _i += 2;
                    else if (c == '"')
                    {
                        _i++;
                        return start;
                    }
                    else _i++;
                }
                return -1;
            }

            private bool Value()
            {
                Ws();
                if (_i >= _t.Length) return false;
                char c = _t[_i];
                if (c == '"') return Str() >= 0;
                if (c == '{' || c == '[')
                {
                    int depth = 0;
                    while (_i < _t.Length)
                    {
                        char d = _t[_i];
                        if (d == '"')
                        {
                            if (Str() < 0) return false;
                            continue;
                        }
                        if (d == '{' || d == '[') depth++;
                        else if (d == '}' || d == ']') depth--;
                        _i++;
                        if (depth == 0) return true;
                    }
                    return false;
                }
                int s = _i;
                while (_i < _t.Length && ",}] \n\r\t".IndexOf(_t[_i]) < 0) _i++;
                return _i > s;
            }

            internal string? Member(string name)
            {
                Ws();
                if (_i >= _t.Length || _t[_i] != '{') return null;
                _i++;
                string? found = null;
                while (true)
                {
                    Ws();
                    if (_i < _t.Length && _t[_i] == '}') return found;
                    int ks = Str();
                    if (ks < 0) return null;
                    int ke = _i;
                    Ws();
                    if (_i >= _t.Length || _t[_i] != ':') return null;
                    _i++;
                    Ws();
                    int start = _i;
                    if (!Value()) return null;
                    try
                    {
                        if (JsonValue.Parse(_t.Substring(ks, ke - ks)) is JsonValue.Str k && k.Value == name) found = _t.Substring(start, _i - start);
                    }
                    catch (InvalidJsonException)
                    {
                        return null;
                    }
                    Ws();
                    if (_i < _t.Length && _t[_i] == ',') _i++;
                    else if (_i < _t.Length && _t[_i] == '}') return found;
                    else return null;
                }
            }
        }
    }
}
