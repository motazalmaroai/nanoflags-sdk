# frozen_string_literal: true

require "openssl"

module NanoFlags
  # Bundle signature verification: Ed25519 over the canonical string
  # `"nanoflags-bundle-v1\n<environment id>\n<revision>\n<checksum>\n<sha256 hex of the bundle text>"`.
  #
  # Only PUBLIC keys are handled here; a JWK that carries a private member (`d`) is refused.
  #
  # @api private
  module Signature
    module_function

    # SubjectPublicKeyInfo prefix of a raw Ed25519 public key (RFC 8410).
    SPKI_PREFIX = ["302a300506032b6570032100"].pack("H*").freeze

    # The signature a bundle was accepted with (kept so that a persisted copy can be verified again).
    Info = Struct.new(:signature, :kid, :environment_id, :revision, :checksum) do
      def to_h = { "signature" => signature, "kid" => kid, "environmentId" => environment_id, "revision" => revision, "checksum" => checksum }

      def self.from_h(h)
        return nil unless h.is_a?(Hash) && h["signature"].is_a?(String) && h["environmentId"].is_a?(String) && h["checksum"].is_a?(String)

        rev = h["revision"]
        rev = rev.to_i if rev.is_a?(Float) && rev == rev.floor
        return nil unless rev.is_a?(Integer)

        new(h["signature"], h["kid"].is_a?(String) && !h["kid"].empty? ? h["kid"] : nil, h["environmentId"], rev, h["checksum"])
      end
    end

    Key = Struct.new(:kid, :key)

    def base64url_decode(value)
      s = value.to_s.tr("-_", "+/").sub(/=+\z/, "")
      return nil unless s.match?(%r{\A[A-Za-z0-9+/]*\z}) && s.length % 4 != 1

      (s + ("=" * ((4 - (s.length % 4)) % 4))).unpack1("m0")
    rescue ArgumentError
      nil
    end

    def public_ed25519_jwk?(jwk)
      jwk.is_a?(Hash) && jwk["kty"] == "OKP" && jwk["crv"] == "Ed25519" && jwk["x"].is_a?(String) && !jwk["x"].empty? && !jwk.key?("d")
    end

    # The public Ed25519 JWKs among +jwks+ (anything else, including private keys, is skipped).
    def import_keys(jwks)
      Array(jwks).filter_map do |jwk|
        jwk = jwk.transform_keys(&:to_s) if jwk.is_a?(Hash)
        next unless public_ed25519_jwk?(jwk)

        raw = base64url_decode(jwk["x"])
        next unless raw && raw.bytesize == 32

        begin
          Key.new(jwk["kid"].is_a?(String) && !jwk["kid"].empty? ? jwk["kid"] : nil, OpenSSL::PKey.read(SPKI_PREFIX + raw))
        rescue OpenSSL::PKey::PKeyError
          nil
        end
      end
    end

    def canonical(environment_id, revision, checksum, bundle_text)
      "nanoflags-bundle-v1\n#{environment_id}\n#{revision}\n#{checksum}\n#{OpenSSL::Digest::SHA256.hexdigest(bundle_text.b)}"
    end

    # Whether +info.signature+ is a valid signature by one of +keys+ over the canonical string for +bundle_text+.
    # A key id narrows the candidates; an unknown key id matches no key.
    def verify(keys, info, bundle_text)
      sig = base64url_decode(info.signature)
      return false unless sig && sig.bytesize == 64

      msg = canonical(info.environment_id, info.revision, info.checksum, bundle_text).b
      keys.any? do |k|
        next false if info.kid && k.kid && k.kid != info.kid

        begin
          k.key.verify(nil, sig, msg)
        rescue OpenSSL::PKey::PKeyError
          false
        end
      end
    end

    # The exact source text of the top-level member +name+ of a JSON object (the last one when it repeats, like
    # JSON.parse), or nil. The edge embeds the stored, signed bundle text byte-for-byte; hashing that span avoids any
    # re-serialisation.
    def raw_member(text, name)
      t = text.b
      n = t.bytesize
      i = 0
      ws = -> { i += 1 while i < n && " \n\r\t".include?(t.getbyte(i).chr) }
      str = lambda do
        return nil if i >= n || t.getbyte(i) != 34

        start = i
        i += 1
        while i < n
          c = t.getbyte(i)
          if c == 92
            i += 2
          elsif c == 34
            i += 1
            return [start, i]
          else
            i += 1
          end
        end
        nil
      end
      value = lambda do
        ws.()
        return false if i >= n

        c = t.getbyte(i)
        return !str.().nil? if c == 34

        if c == 123 || c == 91
          depth = 0
          while i < n
            c = t.getbyte(i)
            if c == 34
              return false if str.().nil?

              next
            end
            if c == 123 || c == 91
              depth += 1
            elsif c == 125 || c == 93
              depth -= 1
            end
            i += 1
            return true if depth.zero?
          end
          return false
        end
        start = i
        i += 1 while i < n && !",}] \n\r\t".include?(t.getbyte(i).chr)
        i > start
      end
      ws.()
      return nil if i >= n || t.getbyte(i) != 123

      i += 1
      found = nil
      loop do
        ws.()
        return found if i < n && t.getbyte(i) == 125

        key = str.()
        return nil if key.nil?

        ws.()
        return nil if i >= n || t.getbyte(i) != 58

        i += 1
        ws.()
        start = i
        return nil unless value.()

        k = begin
          Engine::Json.parse(t.byteslice(key[0], key[1] - key[0]))
        rescue StandardError
          nil
        end
        found = t.byteslice(start, i - start).force_encoding(Encoding::UTF_8) if k == name
        ws.()
        if i < n && t.getbyte(i) == 44
          i += 1
        elsif i < n && t.getbyte(i) == 125
          return found
        else
          return nil
        end
      end
    end
  end
end
