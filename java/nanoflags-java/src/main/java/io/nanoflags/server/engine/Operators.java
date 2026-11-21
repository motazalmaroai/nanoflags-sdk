package io.nanoflags.server.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Version ({@code semver_*}) and date ({@code before} / {@code after}) operators: the engine's parseSemver,
 * compareSemver and parseInstant. Strings are UTF-16, as in JavaScript; only ASCII characters can make up a valid
 * version or date.
 */
final class Operators {
    private static final int MAX_LENGTH = 256;

    private Operators() {}

    static final class SemVer {
        final String[] core;
        final List<String> pre;

        SemVer(String[] core, List<String> pre) {
            this.core = core;
            this.pre = pre;
        }
    }

    private static boolean isDigit(char c) { return c >= '0' && c <= '9'; }

    private static boolean isIdent(char c) { return isDigit(c) || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-'; }

    private static String stripZeros(String d) {
        int i = 0;
        while (i < d.length() - 1 && d.charAt(i) == '0') i++;
        return d.substring(i);
    }

    private static boolean allDigits(String s) {
        if (s.isEmpty()) return false;
        for (int i = 0; i < s.length(); i++) if (!isDigit(s.charAt(i))) return false;
        return true;
    }

    /** Reads dot-separated identifiers from {@code from}; returns the end index, or -1. */
    private static int idents(String s, int from, boolean stopAtPlus, List<String> out) {
        int n = s.length();
        int j = from;
        int start = j;
        while (true) {
            while (j < n && isIdent(s.charAt(j))) j++;
            if (j == start) return -1;
            out.add(s.substring(start, j));
            if (j < n && s.charAt(j) == '.') {
                j++;
                start = j;
                continue;
            }
            if (j == n || (stopAtPlus && s.charAt(j) == '+')) return j;
            return -1;
        }
    }

    static SemVer parseSemver(JsonValue v) {
        if (!(v instanceof JsonValue.Str)) return null;
        String s = ((JsonValue.Str) v).value();
        int n = s.length();
        if (n == 0 || n > MAX_LENGTH) return null;
        int i = (s.charAt(0) == 'v' || s.charAt(0) == 'V') ? 1 : 0;
        String[] core = {"0", "0", "0"};
        int k = 0;
        while (true) {
            int start = i;
            while (i < n && isDigit(s.charAt(i))) i++;
            if (i == start) return null;
            core[k++] = stripZeros(s.substring(start, i));
            if (k < 3 && i < n && s.charAt(i) == '.') {
                i++;
                continue;
            }
            break;
        }
        List<String> pre = Collections.emptyList();
        if (i < n && s.charAt(i) == '-') {
            pre = new ArrayList<>();
            i = idents(s, i + 1, true, pre);
            if (i < 0) return null;
        }
        if (i < n && s.charAt(i) == '+') {
            i = idents(s, i + 1, false, new ArrayList<>());
            if (i < 0) return null;
        }
        if (i != n) return null;
        return new SemVer(core, pre);
    }

    private static int compareDigits(String a, String b) {
        if (a.length() != b.length()) return a.length() < b.length() ? -1 : 1;
        return Integer.signum(a.compareTo(b));
    }

    static int compareSemver(SemVer a, SemVer b) {
        for (int k = 0; k < 3; k++) {
            int c = compareDigits(a.core[k], b.core[k]);
            if (c != 0) return c;
        }
        List<String> pa = a.pre;
        List<String> pb = b.pre;
        if (pa.isEmpty() || pb.isEmpty()) return pa.size() == pb.size() ? 0 : pa.isEmpty() ? 1 : -1;
        for (int k = 0; k < pa.size() && k < pb.size(); k++) {
            String x = pa.get(k);
            String y = pb.get(k);
            boolean xn = allDigits(x);
            boolean yn = allDigits(y);
            int c = xn && yn ? compareDigits(stripZeros(x), stripZeros(y)) : xn ? -1 : yn ? 1 : Integer.signum(x.compareTo(y));
            if (c != 0) return c;
        }
        return pa.size() == pb.size() ? 0 : pa.size() < pb.size() ? -1 : 1;
    }

    static boolean matchSemver(String op, JsonValue actual, JsonValue expected) {
        SemVer a = parseSemver(actual);
        if (a == null) return false;
        SemVer b = parseSemver(expected);
        if (b == null) return false;
        int c = compareSemver(a, b);
        switch (op) {
            case "semver_eq": return c == 0;
            case "semver_neq": return c != 0;
            case "semver_gt": return c > 0;
            case "semver_gte": return c >= 0;
            case "semver_lt": return c < 0;
            default: return c <= 0;
        }
    }

    private static long daysFromCivil(long year, long m, long d) {
        long y = m <= 2 ? year - 1 : year;
        long era = Math.floorDiv(y, 400L);
        long yoe = y - era * 400;
        long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
        long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }

    /** Exactly {@code n} ASCII digits of {@code s} at {@code i}, or -1. */
    private static long digitsAt(String s, int i, int n) {
        if (i + n > s.length()) return -1;
        long v = 0;
        for (int j = i; j < i + n; j++) {
            char c = s.charAt(j);
            if (!isDigit(c)) return -1;
            v = v * 10 + (c - '0');
        }
        return v;
    }

    /** Unix epoch milliseconds, or NaN when {@code v} is not a point in time. */
    static double parseInstant(JsonValue v) {
        if (v instanceof JsonValue.Num) {
            double x = ((JsonValue.Num) v).value();
            if (Double.isNaN(x) || Double.isInfinite(x)) return Double.NaN;
            return Math.abs(x) >= 1e12 ? x : x * 1000;
        }
        if (!(v instanceof JsonValue.Str)) return Double.NaN;
        String s = ((JsonValue.Str) v).value();
        int n = s.length();
        if (n < 10 || n > MAX_LENGTH) return Double.NaN;
        long y = digitsAt(s, 0, 4);
        long mo = digitsAt(s, 5, 2);
        long d = digitsAt(s, 8, 2);
        if (y < 0 || mo < 0 || d < 0 || s.charAt(4) != '-' || s.charAt(7) != '-') return Double.NaN;
        if (mo < 1 || mo > 12 || d < 1) return Double.NaN;
        boolean leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
        long dim = mo == 2 ? (leap ? 29 : 28) : (mo == 4 || mo == 6 || mo == 9 || mo == 11) ? 30 : 31;
        if (d > dim) return Double.NaN;
        long ms = daysFromCivil(y, mo, d) * 86_400_000L;
        if (n == 10) return ms;
        char t = s.charAt(10);
        if (t != 'T' && t != 't' && t != ' ') return Double.NaN;
        long h = digitsAt(s, 11, 2);
        long mi = digitsAt(s, 14, 2);
        if (h < 0 || mi < 0 || s.charAt(13) != ':') return Double.NaN;
        int i = 16;
        long sec = 0;
        long frac = 0;
        if (i < n && s.charAt(i) == ':') {
            sec = digitsAt(s, i + 1, 2);
            if (sec < 0) return Double.NaN;
            i += 3;
            if (i < n && s.charAt(i) == '.') {
                int j = i + 1;
                while (j < n && isDigit(s.charAt(j))) j++;
                if (j == i + 1 || j - i - 1 > 9) return Double.NaN;
                frac = digitsAt(s.substring(i + 1, j) + "00", 0, 3);
                i = j;
            }
        }
        if (h > 23 || mi > 59 || sec > 59 || i >= n) return Double.NaN;
        ms += h * 3_600_000L + mi * 60_000L + sec * 1000L + frac;
        char z = s.charAt(i);
        if ((z == 'Z' || z == 'z') && i + 1 == n) return ms;
        if ((z == '+' || z == '-') && i + 6 == n && s.charAt(i + 3) == ':') {
            long oh = digitsAt(s, i + 1, 2);
            long om = digitsAt(s, i + 4, 2);
            if (oh < 0 || om < 0 || oh > 23 || om > 59) return Double.NaN;
            long off = (oh * 60 + om) * 60_000L;
            return z == '-' ? ms + off : ms - off;
        }
        return Double.NaN;
    }

    static boolean matchDate(String op, JsonValue actual, JsonValue expected) {
        double a = parseInstant(actual);
        if (Double.isNaN(a)) return false;
        double b = parseInstant(expected);
        if (Double.isNaN(b)) return false;
        return "before".equals(op) ? a < b : a > b;
    }
}
