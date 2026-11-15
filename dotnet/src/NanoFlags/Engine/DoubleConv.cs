using System;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace NanoFlags.Engine
{
    /// <summary>
    /// Exact, runtime-independent conversions between decimal text and IEEE-754 doubles, so that number parsing and
    /// formatting match JavaScript bit for bit on every .NET runtime (including .NET Framework, whose own double
    /// formatting and parsing are not always correctly rounded).
    /// </summary>
    internal static class DoubleConv
    {
        private static readonly BigInteger Two53 = BigInteger.One << 53;
        private static readonly BigInteger Two52 = BigInteger.One << 52;

        /// <summary>x = mantissa · 10^exp10 exactly (x finite, positive).</summary>
        internal static void Exact(double x, out BigInteger mantissa, out int exp10)
        {
            long bits = BitConverter.DoubleToInt64Bits(x);
            int e = (int)((bits >> 52) & 0x7FF);
            long m = bits & 0xFFFFFFFFFFFFFL;
            if (e == 0) e = 1;
            else m |= 1L << 52;
            e -= 1075; // x = m · 2^e
            if (e >= 0)
            {
                mantissa = new BigInteger(m) << e;
                exp10 = 0;
            }
            else
            {
                mantissa = new BigInteger(m) * BigInteger.Pow(5, -e);
                exp10 = e;
            }
        }

        /// <summary>The correctly rounded (half-even) double nearest to digits · 10^exp10 (digits ≥ 0).</summary>
        internal static double ToDouble(BigInteger digits, long exp10)
        {
            if (digits.IsZero) return 0.0;
            int len = digits.ToString(CultureInfo.InvariantCulture).Length;
            if (exp10 + len > 310) return double.PositiveInfinity;
            if (exp10 + len < -330) return 0.0;
            BigInteger num = digits, den = BigInteger.One;
            if (exp10 >= 0) num *= BigInteger.Pow(10, (int)exp10);
            else den = BigInteger.Pow(10, (int)-exp10);
            // Binary exponent s such that 2^52 <= num / (den · 2^s) < 2^53.
            long s = BitLength(num) - BitLength(den) - 53;
            while (true)
            {
                var q = Quotient(num, den, s, out _);
                if (q >= Two53) s++;
                else if (q < Two52) s--;
                else break;
            }
            if (s < -1074) s = -1074; // subnormal: fewer mantissa bits
            var mant = Quotient(num, den, s, out var remTwice);
            // remTwice: compare 2·remainder with the divisor; >0 above half, 0 exactly half, <0 below.
            if (remTwice > 0 || (remTwice == 0 && !mant.IsEven)) mant += 1;
            if (mant == Two53)
            {
                mant >>= 1;
                s++;
            }
            if (s > 971) return double.PositiveInfinity;
            long bits;
            if (mant >= Two52) bits = ((s + 1075) << 52) | (long)(mant - Two52);
            else bits = (long)mant; // subnormal, s == -1074
            return BitConverter.Int64BitsToDouble(bits);
        }

        /// <summary>floor(num / (den · 2^s)), with the sign of 2·remainder − divisor.</summary>
        private static BigInteger Quotient(BigInteger num, BigInteger den, long s, out int remTwice)
        {
            BigInteger n = num, d = den;
            if (s >= 0) d <<= (int)s;
            else n <<= (int)-s;
            var q = BigInteger.DivRem(n, d, out var r);
            remTwice = (r * 2).CompareTo(d);
            return q;
        }

        private static long BitLength(BigInteger v)
        {
            long n = 0;
            var bytes = v.ToByteArray();
            int top = bytes.Length - 1;
            while (top > 0 && bytes[top] == 0) top--;
            n = top * 8L;
            int b = bytes[top];
            while (b != 0)
            {
                n++;
                b >>= 1;
            }
            return n;
        }

        /// <summary>
        /// Parses a validated decimal literal (<c>[+-] digits [. digits] [e [+-] digits]</c>, at least one digit) to
        /// the nearest double.
        /// </summary>
        internal static double ParseDecimal(string s)
        {
            int i = 0;
            bool neg = false;
            if (i < s.Length && (s[i] == '+' || s[i] == '-'))
            {
                neg = s[i] == '-';
                i++;
            }
            var digits = new StringBuilder();
            long exp = 0;
            while (i < s.Length && s[i] >= '0' && s[i] <= '9') digits.Append(s[i++]);
            if (i < s.Length && s[i] == '.')
            {
                i++;
                while (i < s.Length && s[i] >= '0' && s[i] <= '9')
                {
                    digits.Append(s[i++]);
                    exp--;
                }
            }
            if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
            {
                i++;
                bool eneg = false;
                if (i < s.Length && (s[i] == '+' || s[i] == '-'))
                {
                    eneg = s[i] == '-';
                    i++;
                }
                long e = 0;
                while (i < s.Length && s[i] >= '0' && s[i] <= '9')
                {
                    if (e < 100_000_000) e = e * 10 + (s[i] - '0');
                    i++;
                }
                exp += eneg ? -e : e;
            }
            // Strip leading zeros (they do not change the value) and trailing zeros (into the exponent).
            var ds = digits.ToString().TrimStart('0');
            int trail = 0;
            while (trail < ds.Length && ds[ds.Length - 1 - trail] == '0') trail++;
            ds = ds.Substring(0, ds.Length - trail);
            exp += trail;
            double v = ds.Length == 0 ? 0.0 : ToDouble(BigInteger.Parse(ds, CultureInfo.InvariantCulture), exp);
            return neg ? -v : v;
        }

        /// <summary>Rounds mantissa · 10^exp10 to <paramref name="p"/> significant digits (half-even).</summary>
        internal static string RoundDigits(string digits, int p, bool halfEven, out int carry)
        {
            carry = 0;
            if (digits.Length <= p) return digits;
            var keep = digits.Substring(0, p).ToCharArray();
            char first = digits[p];
            bool restNonZero = false;
            for (int j = p + 1; j < digits.Length; j++)
            {
                if (digits[j] != '0')
                {
                    restNonZero = true;
                    break;
                }
            }
            bool up;
            if (first > '5') up = true;
            else if (first < '5') up = false;
            else if (restNonZero) up = true;
            else up = !halfEven || ((keep[p - 1] - '0') % 2 == 1);
            if (up)
            {
                int k = p - 1;
                while (k >= 0)
                {
                    if (keep[k] == '9')
                    {
                        keep[k] = '0';
                        k--;
                    }
                    else
                    {
                        keep[k]++;
                        break;
                    }
                }
                if (k < 0)
                {
                    carry = 1;
                    return "1" + new string(keep);
                }
            }
            return new string(keep);
        }

        /// <summary>
        /// The shortest decimal digits (no trailing zeros) that round-trip to <paramref name="x"/> (finite, positive),
        /// correctly rounded, and the decimal point position <paramref name="n"/> (value = 0.digits · 10^n).
        /// </summary>
        internal static string Shortest(double x, out int n)
        {
            Exact(x, out var mant, out var exp10);
            string all = mant.ToString(CultureInfo.InvariantCulture);
            int pointPos = all.Length + exp10; // value = 0.all · 10^pointPos
            for (int p = 1; p <= 17; p++)
            {
                var r = RoundDigits(all, p, true, out var carry);
                // r has p (+carry) digits; value = 0.r · 10^(pointPos + carry)
                int np = pointPos + carry;
                var trimmed = r.TrimEnd('0');
                if (trimmed.Length == 0) continue;
                long e10 = np - (long)trimmed.Length;
                if (ToDouble(BigInteger.Parse(trimmed, CultureInfo.InvariantCulture), e10) == x)
                {
                    n = np;
                    return trimmed;
                }
            }
            n = pointPos;
            return all.TrimEnd('0');
        }

        /// <summary><c>x.toFixed(2)</c> for 0 ≤ x &lt; 1e21 (exact decimal expansion, then half-up, like V8).</summary>
        internal static string ToFixed2(double x)
        {
            if (x == 0) return "0.00";
            Exact(x, out var mant, out var exp10);
            BigInteger scaled; // x · 100, rounded half-up
            if (exp10 >= -2)
            {
                scaled = mant * BigInteger.Pow(10, exp10 + 2);
            }
            else
            {
                var div = BigInteger.Pow(10, -exp10 - 2);
                scaled = BigInteger.DivRem(mant, div, out var rem);
                if (rem * 2 >= div) scaled += 1;
            }
            var s = scaled.ToString(CultureInfo.InvariantCulture).PadLeft(3, '0');
            return s.Substring(0, s.Length - 2) + "." + s.Substring(s.Length - 2);
        }
    }
}
