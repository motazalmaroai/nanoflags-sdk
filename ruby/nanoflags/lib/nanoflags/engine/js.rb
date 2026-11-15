# frozen_string_literal: true

module NanoFlags
  module Engine
    # JavaScript `undefined`: an absent value (a missing property, a flag that serves nothing). Distinct from +nil+
    # (JSON null).
    UNDEFINED = Object.new
    def UNDEFINED.inspect = "UNDEFINED"
    def UNDEFINED.to_s = "undefined"
    UNDEFINED.freeze

    # A function value. Only ever produced by reading a String / Array prototype method by name (e.g. `"ab".match`),
    # which a malformed configuration can make the engine do.
    JsFunction = Struct.new(:name)

    # The TypeError the TypeScript engine would throw for a malformed configuration (the message matches V8's).
    class JsTypeError < StandardError; end

    # The JavaScript value semantics the engine depends on.
    #
    # The reference engine is TypeScript: its results depend on truthiness, loose property access, `Number()`,
    # `String()`, `JSON.stringify` and UTF-16 string semantics. This module reproduces exactly those for the value
    # model of this gem, so the Ruby engine returns the same results as every other NanoFlags engine for the same JSON
    # (asserted by the shared parity fixtures):
    #
    # - `undefined` is {UNDEFINED}, `null` is +nil+, booleans are +true+/+false+, numbers are Float (always),
    # - strings are UTF-8; a lone UTF-16 surrogate (only expressible as a `\u` escape in JSON) is kept in its
    #   three-byte WTF-8 form (such a string is not +valid_encoding?+),
    # - arrays are Array, objects are Hash with String keys in JavaScript order (array-index keys ascending first).
    #
    # @api private
    module Js
      module_function

      STRING_METHODS = %w[
        anchor at big blink bold charAt charCodeAt codePointAt concat constructor endsWith fixed fontcolor fontsize
        includes indexOf isWellFormed italics lastIndexOf link localeCompare match matchAll normalize padEnd padStart
        repeat replace replaceAll search slice small split strike sub substr substring sup toLocaleLowerCase
        toLocaleUpperCase toLowerCase toString toUpperCase toWellFormed trim trimEnd trimLeft trimRight trimStart valueOf
      ].to_h { |m| [m, true] }.freeze

      ARRAY_METHODS = %w[
        at concat constructor copyWithin entries every fill filter find findIndex findLast findLastIndex flat flatMap
        forEach includes indexOf join keys lastIndexOf map pop push reduce reduceRight reverse shift slice some sort
        splice toLocaleString toReversed toSorted toSpliced toString unshift values with
      ].to_h { |m| [m, true] }.freeze

      # Object.prototype members, as `${words[name]}` renders them in describeCondition.
      OBJECT_PROTO_STRINGS = {
        "constructor" => "function Object() { [native code] }",
        "__defineGetter__" => "function __defineGetter__() { [native code] }",
        "__defineSetter__" => "function __defineSetter__() { [native code] }",
        "hasOwnProperty" => "function hasOwnProperty() { [native code] }",
        "__lookupGetter__" => "function __lookupGetter__() { [native code] }",
        "__lookupSetter__" => "function __lookupSetter__() { [native code] }",
        "isPrototypeOf" => "function isPrototypeOf() { [native code] }",
        "propertyIsEnumerable" => "function propertyIsEnumerable() { [native code] }",
        "toString" => "function toString() { [native code] }",
        "valueOf" => "function valueOf() { [native code] }",
        "__proto__" => "[object Object]",
        "toLocaleString" => "function toLocaleString() { [native code] }"
      }.freeze

      WS = "\u0009-\u000D    -     　﻿"
      TRIM_RE = /\A[#{WS}]+|[#{WS}]+\z/
      DECIMAL_RE = /\A[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\z/
      RADIX_RE = /\A0([xXoObB])(.+)\z/m
      UTF8 = Encoding::UTF_8
      REPLACEMENT = "�"

      def undefined?(v) = v.equal?(UNDEFINED)
      def nullish?(v) = v.nil? || v.equal?(UNDEFINED)

      # "null", "array", or the JavaScript `typeof` ("undefined", "boolean", "number", "string", "object", "function").
      def type_name(v)
        case v
        when UNDEFINED then "undefined"
        when nil then "null"
        when true, false then "boolean"
        when Float, Integer then "number"
        when String then "string"
        when Array then "array"
        when JsFunction then "function"
        else "object"
        end
      end

      # ToBoolean.
      def truthy?(v)
        case v
        when nil, false, UNDEFINED then false
        when true then true
        when Float, Integer then !(v.zero? || (v.is_a?(Float) && v.nan?))
        when String then !v.empty?
        else true
        end
      end

      # ---------------------------------------------------------------- numbers

      # Number::toString(x) for radix 10 (shortest round-trip digits), as String(x) produces it.
      def number_to_string(x)
        x = x.to_f
        return "NaN" if x.nan?
        return "0" if x.zero?
        return(x.positive? ? "Infinity" : "-Infinity") if x.infinite?

        sign = x.negative? ? "-" : ""
        a = x.abs
        return sign + a.to_i.to_s if a < 9_007_199_254_740_992.0 && a == a.floor

        r = a.to_s # shortest round-trip digits (dtoa mode 0), like JavaScript
        mantissa, exp = r.split("e")
        int_part, frac_part = mantissa.split(".")
        frac_part ||= ""
        if int_part.delete("0").empty?
          stripped = frac_part.sub(/\A0+/, "")
          point = exp.to_i - (frac_part.length - stripped.length)
          digits = stripped
        else
          digits = (int_part + frac_part).sub(/\A0+/, "")
          point = int_part.length + exp.to_i
        end
        digits = digits.sub(/0+\z/, "")
        digits = "0" if digits.empty?
        k = digits.length
        n = point
        out =
          if k <= n && n <= 21
            digits + ("0" * (n - k))
          elsif n.positive? && n <= 21
            "#{digits[0, n]}.#{digits[n..]}"
          elsif n > -6 && n <= 0
            "0.#{"0" * -n}#{digits}"
          else
            e = n - 1
            es = (e.negative? ? "-" : "+") + e.abs.to_s
            k == 1 ? "#{digits}e#{es}" : "#{digits[0]}.#{digits[1..]}e#{es}"
          end
        sign + out
      end

      # String.prototype.trim (ECMAScript white space and line terminators).
      def trim(s)
        return s.b.gsub(/\A[\t\n\v\f\r ]+|[\t\n\v\f\r ]+\z/n, "").force_encoding(UTF8) unless s.valid_encoding?

        s.gsub(TRIM_RE, "")
      end

      # ECMAScript StringToNumber: `Number(s)`.
      def string_to_number(input)
        s = trim(input)
        return 0.0 if s.empty?
        return Float::INFINITY if s == "Infinity" || s == "+Infinity"
        return -Float::INFINITY if s == "-Infinity"
        return Float::NAN unless s.valid_encoding?

        if (m = RADIX_RE.match(s))
          base = { "x" => 16, "o" => 8, "b" => 2 }.fetch(m[1].downcase)
          pattern = { 16 => /\A[0-9a-fA-F]+\z/, 8 => /\A[0-7]+\z/, 2 => /\A[01]+\z/ }.fetch(base)
          return Float::NAN unless pattern.match?(m[2])

          return integer_to_float(m[2].to_i(base))
        end
        return Float::NAN unless DECIMAL_RE.match?(s)

        s.to_f
      end

      # The double nearest to the integer i, rounding half to even.
      def integer_to_float(i)
        l = i.bit_length
        return i.to_f if l <= 53
        return Float::INFINITY if l > 1024

        shift = l - 53
        mantissa = i >> shift
        round = (i >> (shift - 1)) & 1
        sticky = (i & ((1 << (shift - 1)) - 1)) != 0
        mantissa += 1 if round == 1 && (sticky || mantissa.odd?)
        Math.ldexp(mantissa.to_f, shift)
      end

      # ToNumber(ToPrimitive(v, number)).
      def to_number(v)
        case v
        when UNDEFINED then Float::NAN
        when nil, false then 0.0
        when true then 1.0
        when Float then v
        when Integer then v.to_f
        when String then string_to_number(v)
        else string_to_number(to_str(v))
        end
      end

      # ---------------------------------------------------------------- strings

      # String(v).
      def to_str(v)
        case v
        when UNDEFINED then "undefined"
        when nil then "null"
        when true then "true"
        when false then "false"
        when Float, Integer then number_to_string(v)
        when String then v
        when Array then join(v, ",")
        when JsFunction then "function #{v.name}() { [native code] }"
        else "[object Object]"
        end
      end

      # Array.prototype.join.
      def join(items, sep)
        items.map { |e| nullish?(e) ? "" : to_str(e) }.join(sep)
      end

      # The code points of a WTF-8 string with their byte width: lone surrogates included, invalid bytes as U+FFFD.
      def code_points(s)
        out = []
        b = s.bytes
        n = b.length
        i = 0
        while i < n
          c = b[i]
          if c < 0x80
            out << [c, 1]
            i += 1
            next
          end
          need = if c >= 0xF0 then 3 elsif c >= 0xE0 then 2 elsif c >= 0xC2 then 1 else -1 end
          if need.negative? || c > 0xF4 || i + need >= n
            out << [0xFFFD, 1]
            i += 1
            next
          end
          cp = c & (0x3F >> need)
          ok = true
          (1..need).each do |j|
            x = b[i + j]
            if (x & 0xC0) != 0x80
              ok = false
              break
            end
            cp = (cp << 6) | (x & 0x3F)
          end
          min = [0, 0x80, 0x800, 0x10000][need]
          if !ok || cp < min || cp > 0x10FFFF
            out << [0xFFFD, 1]
            i += 1
            next
          end
          out << [cp, need + 1]
          i += need + 1
        end
        out
      end

      # UTF-16 code units of a WTF-8 string.
      def to_units(s)
        units = []
        code_points(s).each do |cp, _|
          if cp >= 0x10000
            cp -= 0x10000
            units << (0xD800 + (cp >> 10)) << (0xDC00 + (cp & 0x3FF))
          else
            units << cp
          end
        end
        units
      end

      # One code point (lone surrogates in WTF-8) as a UTF-8 string.
      def encode_unit(u)
        bytes =
          if u < 0x80 then [u]
          elsif u < 0x800 then [0xC0 | (u >> 6), 0x80 | (u & 0x3F)]
          elsif u < 0x10000 then [0xE0 | (u >> 12), 0x80 | ((u >> 6) & 0x3F), 0x80 | (u & 0x3F)]
          else [0xF0 | (u >> 18), 0x80 | ((u >> 12) & 0x3F), 0x80 | ((u >> 6) & 0x3F), 0x80 | (u & 0x3F)]
          end
        bytes.pack("C*").force_encoding(UTF8)
      end

      # UTF-16 code units joined back into a string (pairs combined).
      def units_to_string(units)
        out = +""
        i = 0
        while i < units.length
          u = units[i]
          if u >= 0xD800 && u <= 0xDBFF && i + 1 < units.length && units[i + 1] >= 0xDC00 && units[i + 1] <= 0xDFFF
            out << encode_unit(0x10000 + ((u - 0xD800) << 10) + (units[i + 1] - 0xDC00))
            i += 2
            next
          end
          out << encode_unit(u)
          i += 1
        end
        out.force_encoding(UTF8)
      end

      # JavaScript's string length (UTF-16 code units).
      def utf16_length(s)
        return s.bytesize if s.ascii_only?
        return s.length + s.count("\u{10000}-\u{10FFFF}") if s.valid_encoding?

        to_units(s).length
      end

      # `s[i]`: the code unit at index i as a one-unit string, or UNDEFINED.
      def utf16_at(s, i)
        units = to_units(s)
        i < units.length ? encode_unit(units[i]) : UNDEFINED
      end

      def well_formed?(a, b) = a.valid_encoding? && b.valid_encoding?

      # String.prototype.includes.
      def includes?(h, n)
        # For well-formed strings a code-unit match always starts and ends on code point boundaries.
        return h.include?(n) if well_formed?(h, n)

        hu = to_units(h)
        nu = to_units(n)
        return true if nu.empty?

        (0..(hu.length - nu.length)).any? { |i| hu[i, nu.length] == nu }
      end

      def starts_with?(h, n)
        return h.start_with?(n) if well_formed?(h, n)

        hu = to_units(h)
        nu = to_units(n)
        nu.length <= hu.length && hu[0, nu.length] == nu
      end

      def ends_with?(h, n)
        return h.end_with?(n) if well_formed?(h, n)

        hu = to_units(h)
        nu = to_units(n)
        nu.length <= hu.length && hu[hu.length - nu.length, nu.length] == nu
      end

      # ---------------------------------------------------------------- JSON.stringify

      # JSON.stringify(v), or nil where JSON.stringify returns undefined.
      def stringify(v)
        return nil if v.equal?(UNDEFINED) || v.is_a?(JsFunction)

        out = +""
        write_json(v, out)
        out.force_encoding(UTF8)
      end

      def write_json(v, out)
        case v
        when nil then out << "null"
        when true then out << "true"
        when false then out << "false"
        when Float, Integer
          f = v.to_f
          out << (f.nan? || f.infinite? ? "null" : number_to_string(f))
        when String then out << quote(v)
        when Array
          out << "["
          v.each_with_index do |e, i|
            out << "," if i.positive?
            if e.equal?(UNDEFINED) || e.is_a?(JsFunction)
              out << "null"
            else
              write_json(e, out)
            end
          end
          out << "]"
        when Hash
          out << "{"
          first = true
          v.each do |k, e|
            next if e.equal?(UNDEFINED) || e.is_a?(JsFunction)

            out << "," unless first
            first = false
            out << quote(k.to_s) << ":"
            write_json(e, out)
          end
          out << "}"
        else out << "null"
        end
      end

      QUOTE_NEEDED = /["\\\x00-\x1F]|\xED[\xA0-\xBF]/n
      QUOTE_ESCAPES = { '"' => '\\"', "\\" => "\\\\", "\b" => "\\b", "\f" => "\\f", "\n" => "\\n", "\r" => "\\r", "\t" => "\\t" }.freeze

      # JSON.stringify of a string (well-formed JSON.stringify: lone surrogates are escaped).
      def quote(s)
        b = s.b
        return "\"#{s}\"" unless QUOTE_NEEDED.match?(b)

        escaped = b.gsub(/["\\\x00-\x1F]|\xED[\xA0-\xBF][\x80-\xBF]/n) do |c|
          if (e = QUOTE_ESCAPES[c])
            e
          elsif c.bytesize == 1
            format("\\u%04x", c.ord)
          else
            x = c.bytes
            format("\\u%04x", ((x[0] & 0x0F) << 12) | ((x[1] & 0x3F) << 6) | (x[2] & 0x3F))
          end
        end
        "\"#{escaped.force_encoding(UTF8)}\""
      end

      # ---------------------------------------------------------------- property access

      # A canonical array index (0 … 2^32-2), or -1.
      def array_index(k)
        return -1 if k.empty? || k.length > 10 || (k.length > 1 && k.start_with?("0")) || !k.match?(/\A[0-9]+\z/)

        n = k.to_i
        n < 4_294_967_295 ? n : -1
      end

      # The property read `v[name]` for the fixed property names the engine reads. Plain objects only expose own
      # properties here: none of those names exist on Object.prototype. Raises JsTypeError for null and undefined.
      def get(v, name)
        case v
        when nil, UNDEFINED
          raise JsTypeError, "Cannot read properties of #{to_str(v)} (reading '#{name}')"
        when Hash
          v.fetch(name, UNDEFINED)
        when String
          return utf16_length(v).to_f if name == "length"

          n = array_index(name)
          return utf16_at(v, n) if n >= 0
          return JsFunction.new(name) if STRING_METHODS.key?(name)

          UNDEFINED
        when Array
          return v.length.to_f if name == "length"

          n = array_index(name)
          return(n < v.length ? v[n] : UNDEFINED) if n >= 0
          return JsFunction.new(name) if ARRAY_METHODS.key?(name)

          UNDEFINED
        else
          UNDEFINED
        end
      end

      # The engine's `own(obj, key)`: an own-property lookup that never reads inherited members.
      def own(obj, key)
        case obj
        when Hash then obj.fetch(key, UNDEFINED)
        when Array, String then key == "length" || array_index(key) >= 0 ? get(obj, key) : UNDEFINED
        else UNDEFINED
        end
      end

      # ---------------------------------------------------------------- conversion

      # A Hash in JavaScript own-property order (array-index keys ascending first).
      def js_order(h)
        return h unless h.each_key.any? { |k| array_index(k) >= 0 }

        index, names = h.partition { |k, _| array_index(k) >= 0 }
        index.sort_by! { |k, _| k.to_i }
        (index + names).to_h
      end

      # Converts Ruby data to an engine value: nil, booleans, Integer and Float (as Float), String (as UTF-8),
      # Symbol (its name), Array, Hash (String or Symbol keys), Time / Date / DateTime (ISO 8601 in UTC, as
      # `Date.toJSON()`), and anything with +to_h+ or +as_json+. Anything else becomes its +to_s+.
      def from_ruby(x, depth = 0)
        case x
        when nil, true, false, Float, UNDEFINED then x
        when Integer then x.to_f
        when String then utf8(x)
        when Symbol then x.to_s
        else
          return nil if depth > 32

          case x
          when Array then x.map { |e| from_ruby(e, depth + 1) }
          when Hash then js_order(x.each_with_object({}) { |(k, e), m| m[utf8(k.to_s)] = from_ruby(e, depth + 1) })
          when Time then x.getutc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")
          else
            if defined?(::DateTime) && x.is_a?(::DateTime)
              x.new_offset(0).strftime("%Y-%m-%dT%H:%M:%S.%LZ")
            elsif defined?(::Date) && x.is_a?(::Date)
              x.strftime("%Y-%m-%dT00:00:00.000Z")
            elsif x.respond_to?(:as_json)
              from_ruby(x.as_json, depth + 1)
            elsif x.respond_to?(:to_h)
              from_ruby(x.to_h, depth + 1)
            else
              utf8(x.to_s)
            end
          end
        end
      end

      def utf8(s)
        return s if s.encoding == UTF8 && (s.ascii_only? || s.valid_encoding?)

        if s.encoding == Encoding::BINARY || s.encoding == UTF8
          s.dup.force_encoding(UTF8).scrub(REPLACEMENT)
        else
          s.encode(UTF8, invalid: :replace, undef: :replace, replace: REPLACEMENT)
        end
      end

      # Converts an engine value to plain Ruby data: nil (also for undefined), booleans, Integer (whole numbers up to
      # 2^53) or Float, String, Array and Hash (in configuration order).
      def to_ruby(v)
        case v
        when Float then v.finite? && v == v.floor && v.abs <= 9_007_199_254_740_992.0 ? v.to_i : v
        when Array then v.map { |e| to_ruby(e) }
        when Hash
          v.each_with_object({}) do |(k, e), m|
            m[k] = to_ruby(e) unless e.equal?(UNDEFINED) || e.is_a?(JsFunction)
          end
        when UNDEFINED, JsFunction then nil
        else v
        end
      end
    end
  end
end
