package io.nanoflags.engine

/**
 * Version (`semver_*`) and date (`before` / `after`) operators: the engine's parseSemver, compareSemver and parseInstant.
 * Strings are UTF-16, as in JavaScript; only ASCII characters can make up a valid version or date.
 */
internal object Operators {
    private const val MAX_LENGTH = 256

    class SemVer(val core: Array<String>, val pre: List<String>)

    private fun isDigit(c: Char) = c in '0'..'9'
    private fun isIdent(c: Char) = isDigit(c) || c in 'A'..'Z' || c in 'a'..'z' || c == '-'
    private fun stripZeros(d: String): String {
        var i = 0
        while (i < d.length - 1 && d[i] == '0') i++
        return d.substring(i)
    }
    private fun allDigits(s: String) = s.isNotEmpty() && s.all { isDigit(it) }

    fun parseSemver(v: JsonValue): SemVer? {
        if (v !is JsonValue.Str) return null
        val s = v.value
        if (s.isEmpty() || s.length > MAX_LENGTH) return null
        val n = s.length
        var i = if (s[0] == 'v' || s[0] == 'V') 1 else 0
        val core = ArrayList<String>(3)
        while (true) {
            val start = i
            while (i < n && isDigit(s[i])) i++
            if (i == start) return null
            core.add(stripZeros(s.substring(start, i)))
            if (core.size < 3 && i < n && s[i] == '.') { i++; continue }
            break
        }
        while (core.size < 3) core.add("0")
        fun idents(from: Int, stopAtPlus: Boolean): Pair<List<String>, Int>? {
            val out = ArrayList<String>()
            var j = from
            var start = j
            while (true) {
                while (j < n && isIdent(s[j])) j++
                if (j == start) return null
                out.add(s.substring(start, j))
                if (j < n && s[j] == '.') { j++; start = j; continue }
                if (j == n || (stopAtPlus && s[j] == '+')) return out to j
                return null
            }
        }
        var pre: List<String> = emptyList()
        if (i < n && s[i] == '-') {
            val r = idents(i + 1, true) ?: return null
            pre = r.first
            i = r.second
        }
        if (i < n && s[i] == '+') {
            val r = idents(i + 1, false) ?: return null
            i = r.second
        }
        if (i != n) return null
        return SemVer(core.toTypedArray(), pre)
    }

    private fun compareDigits(a: String, b: String): Int =
        if (a.length != b.length) (if (a.length < b.length) -1 else 1) else Integer.signum(a.compareTo(b))

    fun compareSemver(a: SemVer, b: SemVer): Int {
        for (k in 0 until 3) {
            val c = compareDigits(a.core[k], b.core[k])
            if (c != 0) return c
        }
        val pa = a.pre
        val pb = b.pre
        if (pa.isEmpty() || pb.isEmpty()) return if (pa.size == pb.size) 0 else if (pa.isEmpty()) 1 else -1
        for (k in 0 until minOf(pa.size, pb.size)) {
            val x = pa[k]
            val y = pb[k]
            val xn = allDigits(x)
            val yn = allDigits(y)
            val c = when {
                xn && yn -> compareDigits(stripZeros(x), stripZeros(y))
                xn -> -1
                yn -> 1
                else -> Integer.signum(x.compareTo(y))
            }
            if (c != 0) return c
        }
        return if (pa.size == pb.size) 0 else if (pa.size < pb.size) -1 else 1
    }

    fun matchSemver(op: String, actual: JsonValue, expected: JsonValue): Boolean {
        val a = parseSemver(actual) ?: return false
        val b = parseSemver(expected) ?: return false
        val c = compareSemver(a, b)
        return when (op) {
            "semver_eq" -> c == 0
            "semver_neq" -> c != 0
            "semver_gt" -> c > 0
            "semver_gte" -> c >= 0
            "semver_lt" -> c < 0
            else -> c <= 0
        }
    }

    private fun daysFromCivil(year: Long, m: Long, d: Long): Long {
        val y = if (m <= 2) year - 1 else year
        val era = Math.floorDiv(y, 400L)
        val yoe = y - era * 400
        val doy = (153 * (m + (if (m > 2) -3 else 9)) + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    private fun digitsAt(s: String, i: Int, n: Int): Long? {
        if (i + n > s.length) return null
        var v = 0L
        for (j in i until i + n) {
            if (!isDigit(s[j])) return null
            v = v * 10 + (s[j] - '0')
        }
        return v
    }

    fun parseInstant(v: JsonValue): Double? {
        if (v is JsonValue.Num) {
            val x = v.value
            if (x.isNaN() || x.isInfinite()) return null
            return if (Math.abs(x) >= 1e12) x else x * 1000
        }
        if (v !is JsonValue.Str) return null
        val s = v.value
        val n = s.length
        if (n < 10 || n > MAX_LENGTH) return null
        val y = digitsAt(s, 0, 4) ?: return null
        val mo = digitsAt(s, 5, 2) ?: return null
        val d = digitsAt(s, 8, 2) ?: return null
        if (s[4] != '-' || s[7] != '-' || mo < 1 || mo > 12 || d < 1) return null
        val leap = y % 4 == 0L && (y % 100 != 0L || y % 400 == 0L)
        val dim = when (mo) { 2L -> if (leap) 29L else 28L; 4L, 6L, 9L, 11L -> 30L; else -> 31L }
        if (d > dim) return null
        var ms = daysFromCivil(y, mo, d) * 86_400_000L
        if (n == 10) return ms.toDouble()
        if (s[10] != 'T' && s[10] != 't' && s[10] != ' ') return null
        val h = digitsAt(s, 11, 2) ?: return null
        val mi = digitsAt(s, 14, 2) ?: return null
        if (s[13] != ':') return null
        var i = 16
        var sec = 0L
        var frac = 0L
        if (i < n && s[i] == ':') {
            sec = digitsAt(s, i + 1, 2) ?: return null
            i += 3
            if (i < n && s[i] == '.') {
                var j = i + 1
                while (j < n && isDigit(s[j])) j++
                if (j == i + 1 || j - i - 1 > 9) return null
                frac = (s.substring(i + 1, j) + "00").substring(0, 3).toLong()
                i = j
            }
        }
        if (h > 23 || mi > 59 || sec > 59 || i >= n) return null
        ms += h * 3_600_000L + mi * 60_000L + sec * 1000L + frac
        val z = s[i]
        if ((z == 'Z' || z == 'z') && i + 1 == n) return ms.toDouble()
        if ((z == '+' || z == '-') && i + 6 == n && s[i + 3] == ':') {
            val oh = digitsAt(s, i + 1, 2) ?: return null
            val om = digitsAt(s, i + 4, 2) ?: return null
            if (oh > 23 || om > 59) return null
            val off = (oh * 60 + om) * 60_000L
            return (if (z == '-') ms + off else ms - off).toDouble()
        }
        return null
    }

    fun matchDate(op: String, actual: JsonValue, expected: JsonValue): Boolean {
        val a = parseInstant(actual) ?: return false
        val b = parseInstant(expected) ?: return false
        return if (op == "before") a < b else a > b
    }
}
