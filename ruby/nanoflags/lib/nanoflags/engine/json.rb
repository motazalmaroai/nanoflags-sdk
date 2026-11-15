# frozen_string_literal: true

require "json"
require "strscan"

module NanoFlags
  module Engine
    # Raised by {Json.parse} for text that `JSON.parse` rejects.
    class InvalidJsonError < ArgumentError; end

    # `JSON.parse` / `JSON.stringify` with JavaScript semantics for the engine's value model ({Js}): numbers become
    # Float (overflow becomes ±Infinity), objects become Hash in JavaScript key order, a repeated key keeps its first
    # position and its last value, and lone UTF-16 surrogates survive as WTF-8.
    module Json
      module_function

      PARSE_OPTS = begin
        opts = { allow_nan: false, max_nesting: false, create_additions: false }
        # json >= 2.13 warns about repeated keys unless told that JSON.parse semantics (last one wins) are wanted.
        opts[:allow_duplicate_key] = true if Gem::Version.new(::JSON::VERSION) >= Gem::Version.new("2.13")
        opts.freeze
      end

      # Parses JSON text exactly like JavaScript's `JSON.parse`.
      def parse(text)
        text = text.to_s
        text = text.dup.force_encoding(Encoding::UTF_8) unless text.encoding == Encoding::UTF_8
        # Fast path: the json extension, then the result is converted. Lone surrogates and invalid UTF-8 make it fail
        # (or are not representable); the exact parser below handles those.
        if text.valid_encoding?
          begin
            return convert(::JSON.parse(text, PARSE_OPTS))
          rescue ::JSON::ParserError, EncodingError, ArgumentError
            # fall through to the exact parser
          end
        end
        Parser.new(text).parse_document
      end

      def convert(v)
        case v
        when Integer then v.bit_length <= 53 ? v.to_f : Js.integer_to_float(v)
        when Array then v.map! { |e| convert(e) }
        when Hash
          v.transform_values! { |e| convert(e) }
          Js.js_order(v)
        else v
        end
      end

      # JSON.stringify(v), or nil where JSON.stringify returns undefined.
      def stringify(v) = Js.stringify(v)

      # Byte-level `JSON.parse` for the inputs the json extension refuses: lone UTF-16 surrogates are kept as their
      # three-byte WTF-8 form, invalid UTF-8 in the text becomes U+FFFD (as a TextDecoder would).
      #
      # @api private
      class Parser
        def initialize(text)
          @s = StringScanner.new(text.b)
        end

        def parse_document
          ws
          v = value(0)
          ws
          fail!("unexpected trailing data") unless @s.eos?
          v
        end

        private

        def fail!(msg)
          raise InvalidJsonError, "invalid JSON: #{msg} at offset #{@s.pos}"
        end

        def ws
          @s.skip(/[ \t\n\r]*/)
        end

        def value(depth)
          fail!("nesting too deep") if depth > 10_000
          fail!("unexpected end") if @s.eos?
          case @s.peek(1)
          when "{"
            @s.pos += 1
            h = {}
            ws
            return Js.js_order(h) if @s.skip(/\}/)

            loop do
              ws
              fail!("expected a string key") unless @s.peek(1) == '"'
              k = str
              ws
              fail!("expected ':'") unless @s.skip(/:/)
              ws
              h[k] = value(depth + 1)
              ws
              next if @s.skip(/,/)
              return Js.js_order(h) if @s.skip(/\}/)

              fail!("expected ',' or '}'")
            end
          when "["
            @s.pos += 1
            a = []
            ws
            return a if @s.skip(/\]/)

            loop do
              ws
              a << value(depth + 1)
              ws
              next if @s.skip(/,/)
              return a if @s.skip(/\]/)

              fail!("expected ',' or ']'")
            end
          when '"' then str
          when "t" then lit("true", true)
          when "f" then lit("false", false)
          when "n" then lit("null", nil)
          else
            t = @s.scan(/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)
            fail!("unexpected character") if t.nil?
            fail!("invalid number") if @s.match?(/[0-9.eE+-]/)
            t.to_f
          end
        end

        def lit(word, v)
          fail!("invalid literal") unless @s.skip(Regexp.new(Regexp.escape(word)))
          v
        end

        def hex4
          h = @s.scan(/[0-9a-fA-F]{4}/)
          h&.to_i(16)
        end

        def str
          @s.pos += 1 # opening quote
          out = +""
          loop do
            run = @s.scan(/[^"\\\x00-\x1F\x80-\xFF]+/n)
            out << run if run
            fail!("unterminated string") if @s.eos?
            c = @s.peek(1)
            if c == '"'
              @s.pos += 1
              return out.force_encoding(Encoding::UTF_8)
            end
            o = c.ord
            fail!("control character in string") if o < 0x20
            if o >= 0x80
              # One UTF-8 sequence; an invalid one becomes U+FFFD (one per byte).
              chunk = @s.peek(4)
              cp, size = Js.code_points(chunk.dup.force_encoding(Encoding::UTF_8)).first
              if (cp == 0xFFFD && size == 1) || (cp >= 0xD800 && cp <= 0xDFFF)
                out << Js::REPLACEMENT.b
                @s.pos += 1
              else
                out << chunk[0, size]
                @s.pos += size
              end
              next
            end
            @s.pos += 1 # backslash
            fail!("unterminated escape") if @s.eos?
            e = @s.getch
            case e
            when '"', "\\", "/" then out << e
            when "b" then out << "\b"
            when "f" then out << "\f"
            when "n" then out << "\n"
            when "r" then out << "\r"
            when "t" then out << "\t"
            when "u"
              u = hex4
              fail!("invalid unicode escape") if u.nil?
              if u.between?(0xD800, 0xDBFF) && @s.peek(2) == "\\u"
                save = @s.pos
                @s.pos += 2
                lo = hex4
                if lo&.between?(0xDC00, 0xDFFF)
                  out << Js.encode_unit(0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00)).b
                  next
                end
                @s.pos = save
              end
              out << Js.encode_unit(u).b
            else fail!("invalid escape")
            end
          end
        end
      end
    end
  end
end
