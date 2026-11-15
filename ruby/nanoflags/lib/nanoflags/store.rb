# frozen_string_literal: true

require "tempfile"

module NanoFlags
  # Persistence of the last good configuration, so that a restarting process can evaluate flags before (or without)
  # reaching the edge. A store is any object with +get+ (the stored text, or nil) and +set(text)+. A store sits
  # outside the trust boundary: a signed bundle read back from it is verified again before it is used.
  module Store
    # The last good bundle in a file (written atomically, mode 0600).
    class File
      def initialize(path)
        @path = path.to_s
      end

      def get
        ::File.exist?(@path) ? ::File.binread(@path).force_encoding(Encoding::UTF_8) : nil
      end

      def set(text)
        dir = ::File.dirname(@path)
        tmp = Tempfile.create([".nanoflags-", ".json"], dir, mode: ::File::BINARY)
        begin
          tmp.chmod(0o600)
          tmp.write(text)
          tmp.close
          ::File.rename(tmp.path, @path)
        rescue StandardError
          ::File.unlink(tmp.path) if ::File.exist?(tmp.path)
          raise
        end
      end
    end

    # In memory (tests).
    class Memory
      attr_accessor :text

      def get = @text
      def set(text) = (@text = text)
    end

    # Any ActiveSupport::Cache store (`Rails.cache`, a Redis or Memcached cache store), shared by every process that
    # uses it.
    class Cache
      def initialize(cache, key: "nanoflags.bundle")
        @cache = cache
        @key = key
      end

      def get
        v = @cache.read(@key)
        v.is_a?(String) ? v : nil
      end

      def set(text) = @cache.write(@key, text)
    end
  end
end
