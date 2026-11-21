using System;
using System.Collections.Generic;

namespace NanoFlags.Engine
{
    /// <summary>
    /// Version (<c>semver_*</c>) and date (<c>before</c> / <c>after</c>) operators: the engine's parseSemver,
    /// compareSemver and parseInstant. Strings are UTF-16, as in JavaScript; only ASCII characters can make up a valid
    /// version or date. Comparisons are ordinal.
    /// </summary>
    internal static class Operators
    {
        private const int MaxLength = 256;

        internal sealed class SemVer
        {
            internal readonly string[] Core;
            internal readonly List<string> Pre;

            internal SemVer(string[] core, List<string> pre)
            {
                Core = core;
                Pre = pre;
            }
        }

        private static bool IsDigit(char c) => c >= '0' && c <= '9';

        private static bool IsIdent(char c) => IsDigit(c) || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-';

        private static string StripZeros(string d)
        {
            int i = 0;
            while (i < d.Length - 1 && d[i] == '0') i++;
            return d.Substring(i);
        }

        private static bool AllDigits(string s)
        {
            if (s.Length == 0) return false;
            foreach (var c in s) if (!IsDigit(c)) return false;
            return true;
        }

        private static int Idents(string s, int from, bool stopAtPlus, List<string> output)
        {
            int n = s.Length;
            int j = from;
            int start = j;
            while (true)
            {
                while (j < n && IsIdent(s[j])) j++;
                if (j == start) return -1;
                output.Add(s.Substring(start, j - start));
                if (j < n && s[j] == '.')
                {
                    j++;
                    start = j;
                    continue;
                }
                if (j == n || (stopAtPlus && s[j] == '+')) return j;
                return -1;
            }
        }

        internal static SemVer? ParseSemver(JsonValue v)
        {
            if (!(v is JsonValue.Str str)) return null;
            string s = str.Value;
            int n = s.Length;
            if (n == 0 || n > MaxLength) return null;
            int i = (s[0] == 'v' || s[0] == 'V') ? 1 : 0;
            var core = new[] { "0", "0", "0" };
            int k = 0;
            while (true)
            {
                int start = i;
                while (i < n && IsDigit(s[i])) i++;
                if (i == start) return null;
                core[k++] = StripZeros(s.Substring(start, i - start));
                if (k < 3 && i < n && s[i] == '.')
                {
                    i++;
                    continue;
                }
                break;
            }
            var pre = new List<string>();
            if (i < n && s[i] == '-')
            {
                i = Idents(s, i + 1, true, pre);
                if (i < 0) return null;
            }
            if (i < n && s[i] == '+')
            {
                i = Idents(s, i + 1, false, new List<string>());
                if (i < 0) return null;
            }
            if (i != n) return null;
            return new SemVer(core, pre);
        }

        private static int CompareDigits(string a, string b)
        {
            if (a.Length != b.Length) return a.Length < b.Length ? -1 : 1;
            return Math.Sign(string.CompareOrdinal(a, b));
        }

        internal static int CompareSemver(SemVer a, SemVer b)
        {
            for (int k = 0; k < 3; k++)
            {
                int c = CompareDigits(a.Core[k], b.Core[k]);
                if (c != 0) return c;
            }
            var pa = a.Pre;
            var pb = b.Pre;
            if (pa.Count == 0 || pb.Count == 0) return pa.Count == pb.Count ? 0 : pa.Count == 0 ? 1 : -1;
            for (int k = 0; k < pa.Count && k < pb.Count; k++)
            {
                string x = pa[k], y = pb[k];
                bool xn = AllDigits(x), yn = AllDigits(y);
                int c = xn && yn ? CompareDigits(StripZeros(x), StripZeros(y)) : xn ? -1 : yn ? 1 : Math.Sign(string.CompareOrdinal(x, y));
                if (c != 0) return c;
            }
            return pa.Count == pb.Count ? 0 : pa.Count < pb.Count ? -1 : 1;
        }

        internal static bool MatchSemver(string op, JsonValue actual, JsonValue expected)
        {
            var a = ParseSemver(actual);
            if (a == null) return false;
            var b = ParseSemver(expected);
            if (b == null) return false;
            int c = CompareSemver(a, b);
            switch (op)
            {
                case "semver_eq": return c == 0;
                case "semver_neq": return c != 0;
                case "semver_gt": return c > 0;
                case "semver_gte": return c >= 0;
                case "semver_lt": return c < 0;
                default: return c <= 0;
            }
        }

        private static long DaysFromCivil(long year, long m, long d)
        {
            long y = m <= 2 ? year - 1 : year;
            long era = (y >= 0 ? y : y - 399) / 400;
            long yoe = y - era * 400;
            long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
            long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
            return era * 146097 + doe - 719468;
        }

        private static long DigitsAt(string s, int i, int n)
        {
            if (i + n > s.Length) return -1;
            long v = 0;
            for (int j = i; j < i + n; j++)
            {
                char c = s[j];
                if (!IsDigit(c)) return -1;
                v = v * 10 + (c - '0');
            }
            return v;
        }

        /// <summary>Unix epoch milliseconds, or null when <paramref name="v"/> is not a point in time.</summary>
        internal static double? ParseInstant(JsonValue v)
        {
            if (v is JsonValue.Num num)
            {
                double x = num.Value;
                if (double.IsNaN(x) || double.IsInfinity(x)) return null;
                return Math.Abs(x) >= 1e12 ? x : x * 1000;
            }
            if (!(v is JsonValue.Str str)) return null;
            string s = str.Value;
            int n = s.Length;
            if (n < 10 || n > MaxLength) return null;
            long y = DigitsAt(s, 0, 4), mo = DigitsAt(s, 5, 2), d = DigitsAt(s, 8, 2);
            if (y < 0 || mo < 0 || d < 0 || s[4] != '-' || s[7] != '-') return null;
            if (mo < 1 || mo > 12 || d < 1) return null;
            bool leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
            long dim = mo == 2 ? (leap ? 29 : 28) : (mo == 4 || mo == 6 || mo == 9 || mo == 11) ? 30 : 31;
            if (d > dim) return null;
            long ms = DaysFromCivil(y, mo, d) * 86_400_000L;
            if (n == 10) return ms;
            char t = s[10];
            if (t != 'T' && t != 't' && t != ' ') return null;
            long h = DigitsAt(s, 11, 2), mi = DigitsAt(s, 14, 2);
            if (h < 0 || mi < 0 || s[13] != ':') return null;
            int i = 16;
            long sec = 0, frac = 0;
            if (i < n && s[i] == ':')
            {
                sec = DigitsAt(s, i + 1, 2);
                if (sec < 0) return null;
                i += 3;
                if (i < n && s[i] == '.')
                {
                    int j = i + 1;
                    while (j < n && IsDigit(s[j])) j++;
                    if (j == i + 1 || j - i - 1 > 9) return null;
                    frac = DigitsAt(s.Substring(i + 1, j - i - 1) + "00", 0, 3);
                    i = j;
                }
            }
            if (h > 23 || mi > 59 || sec > 59 || i >= n) return null;
            ms += h * 3_600_000L + mi * 60_000L + sec * 1000L + frac;
            char z = s[i];
            if ((z == 'Z' || z == 'z') && i + 1 == n) return ms;
            if ((z == '+' || z == '-') && i + 6 == n && s[i + 3] == ':')
            {
                long oh = DigitsAt(s, i + 1, 2), om = DigitsAt(s, i + 4, 2);
                if (oh < 0 || om < 0 || oh > 23 || om > 59) return null;
                long off = (oh * 60 + om) * 60_000L;
                return z == '-' ? ms + off : ms - off;
            }
            return null;
        }

        internal static bool MatchDate(string op, JsonValue actual, JsonValue expected)
        {
            var a = ParseInstant(actual);
            if (a == null) return false;
            var b = ParseInstant(expected);
            if (b == null) return false;
            return op == "before" ? a.Value < b.Value : a.Value > b.Value;
        }
    }
}
