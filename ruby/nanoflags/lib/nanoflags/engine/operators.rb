# frozen_string_literal: true

module NanoFlags
  module Engine
    # Version (`semver_*`) and date (`before` / `after`) operators: the engine's parseSemver, compareSemver and
    # parseInstant. Values are compared as ASCII bytes; any non-ASCII character makes a value invalid, exactly as the
    # TypeScript engine's character checks do. JSON numbers are Floats here, as in JavaScript.
    module Operators
      MAX_LENGTH = 256
      SEMVER_OPS = %w[semver_eq semver_neq semver_gt semver_gte semver_lt semver_lte].freeze

      module_function

      def digit?(b) = b >= 48 && b <= 57
      def ident?(b) = digit?(b) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 45

      def strip_zeros(d)
        s = d.sub(/\A0+/, "")
        s.empty? ? "0" : s
      end

      def all_digits?(s) = !s.empty? && s.each_byte.all? { |b| digit?(b) }

      def ascii(v)
        return nil unless v.is_a?(String) && v.bytesize <= MAX_LENGTH
        return nil unless v.each_byte.all? { |b| b < 0x80 }

        v.b
      end

      # Dot-separated identifiers of +s+ from +from+: [identifiers, end index], or nil.
      def idents(s, from, stop_at_plus)
        n = s.bytesize
        out = []
        j = from
        start = j
        loop do
          j += 1 while j < n && ident?(s.getbyte(j))
          return nil if j == start

          out << s.byteslice(start, j - start)
          if j < n && s.getbyte(j) == 46
            j += 1
            start = j
            next
          end
          return [out, j] if j == n || (stop_at_plus && s.getbyte(j) == 43)

          return nil
        end
      end

      # [core digit strings, prerelease identifiers], or nil.
      def parse_semver(v)
        s = ascii(v)
        return nil if s.nil? || s.empty?

        n = s.bytesize
        i = s.getbyte(0) == 118 || s.getbyte(0) == 86 ? 1 : 0
        core = []
        loop do
          start = i
          i += 1 while i < n && digit?(s.getbyte(i))
          return nil if i == start

          core << strip_zeros(s.byteslice(start, i - start))
          if core.size < 3 && i < n && s.getbyte(i) == 46
            i += 1
            next
          end
          break
        end
        core << "0" while core.size < 3
        pre = []
        if i < n && s.getbyte(i) == 45
          r = idents(s, i + 1, true)
          return nil if r.nil?

          pre, i = r
        end
        if i < n && s.getbyte(i) == 43
          r = idents(s, i + 1, false)
          return nil if r.nil?

          i = r[1]
        end
        return nil unless i == n

        [core, pre]
      end

      def compare_digits(a, b)
        return a.bytesize < b.bytesize ? -1 : 1 if a.bytesize != b.bytesize

        a <=> b
      end

      def compare_semver(a, b)
        3.times do |k|
          c = compare_digits(a[0][k], b[0][k])
          return c unless c.zero?
        end
        pa = a[1]
        pb = b[1]
        return pa.size == pb.size ? 0 : (pa.empty? ? 1 : -1) if pa.empty? || pb.empty?

        [pa.size, pb.size].min.times do |k|
          x = pa[k]
          y = pb[k]
          xn = all_digits?(x)
          yn = all_digits?(y)
          c = if xn && yn then compare_digits(strip_zeros(x), strip_zeros(y))
              elsif xn then -1
              elsif yn then 1
              else x <=> y
              end
          return c unless c.zero?
        end
        pa.size <=> pb.size
      end

      def match_semver(op, actual, expected)
        a = parse_semver(actual)
        b = parse_semver(expected)
        return false if a.nil? || b.nil?

        c = compare_semver(a, b)
        case op
        when "semver_eq" then c.zero?
        when "semver_neq" then !c.zero?
        when "semver_gt" then c.positive?
        when "semver_gte" then c >= 0
        when "semver_lt" then c.negative?
        else c <= 0
        end
      end

      def days_from_civil(year, m, d)
        y = m <= 2 ? year - 1 : year
        era = y.div(400)
        yoe = y - (era * 400)
        doy = ((153 * (m + (m > 2 ? -3 : 9))) + 2).div(5) + d - 1
        doe = (yoe * 365) + yoe.div(4) - yoe.div(100) + doy
        (era * 146_097) + doe - 719_468
      end

      def digits_at(s, i, n)
        return nil if i + n > s.bytesize

        part = s.byteslice(i, n)
        part.each_byte.all? { |b| digit?(b) } ? part.to_i : nil
      end

      # Unix epoch milliseconds (Float), or nil.
      def parse_instant(v)
        if v.is_a?(Float) || v.is_a?(Integer)
          x = v.to_f
          return nil unless x.finite?

          return x.abs >= 1e12 ? x : x * 1000
        end
        s = ascii(v)
        return nil if s.nil? || s.bytesize < 10

        n = s.bytesize
        y = digits_at(s, 0, 4)
        mo = digits_at(s, 5, 2)
        d = digits_at(s, 8, 2)
        return nil if y.nil? || mo.nil? || d.nil? || s.getbyte(4) != 45 || s.getbyte(7) != 45
        return nil if mo < 1 || mo > 12 || d < 1

        leap = (y % 4).zero? && (!(y % 100).zero? || (y % 400).zero?)
        dim = if mo == 2 then leap ? 29 : 28
              elsif [4, 6, 9, 11].include?(mo) then 30
              else 31
              end
        return nil if d > dim

        ms = days_from_civil(y, mo, d) * 86_400_000
        return ms.to_f if n == 10
        return nil unless [84, 116, 32].include?(s.getbyte(10))

        h = digits_at(s, 11, 2)
        mi = digits_at(s, 14, 2)
        return nil if h.nil? || mi.nil? || s.getbyte(13) != 58

        i = 16
        sec = 0
        frac = 0
        if i < n && s.getbyte(i) == 58
          sec = digits_at(s, i + 1, 2)
          return nil if sec.nil?

          i += 3
          if i < n && s.getbyte(i) == 46
            j = i + 1
            j += 1 while j < n && digit?(s.getbyte(j))
            return nil if j == i + 1 || j - i - 1 > 9

            frac = "#{s.byteslice(i + 1, j - i - 1)}00".byteslice(0, 3).to_i
            i = j
          end
        end
        return nil if h > 23 || mi > 59 || sec > 59 || i >= n

        ms += (h * 3_600_000) + (mi * 60_000) + (sec * 1000) + frac
        z = s.getbyte(i)
        return ms.to_f if [90, 122].include?(z) && i + 1 == n

        if [43, 45].include?(z) && i + 6 == n && s.getbyte(i + 3) == 58
          oh = digits_at(s, i + 1, 2)
          om = digits_at(s, i + 4, 2)
          return nil if oh.nil? || om.nil? || oh > 23 || om > 59

          off = ((oh * 60) + om) * 60_000
          return (z == 45 ? ms + off : ms - off).to_f
        end
        nil
      end

      def match_date(op, actual, expected)
        a = parse_instant(actual)
        b = parse_instant(expected)
        return false if a.nil? || b.nil?

        op == "before" ? a < b : a > b
      end
    end
  end
end
