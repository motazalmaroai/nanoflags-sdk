# frozen_string_literal: true

require "socket"
require "openssl"
require "securerandom"
require "digest"
require "uri"

module NanoFlags
  # A minimal RFC 6455 WebSocket client for the edge's live socket (+/v1/live+), on the standard library only (TCP,
  # OpenSSL, an HTTP CONNECT tunnel through +HTTPS_PROXY+ / +HTTP_PROXY+ honouring +NO_PROXY+). It speaks what the
  # live protocol needs: text messages (fragmented or not), ping/pong and the close handshake. No extensions (no
  # compression), no redirects.
  #
  # One thread reads and writes ({Connection#recv}, {Connection#send_text}); {Connection#close} may be called from any
  # thread and makes a blocked +recv+ raise {Closed}.
  module WebSocket
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    MAX_MESSAGE = 8 * 1024 * 1024
    MAX_HEADER = 16 * 1024

    # Connecting (or the handshake) took longer than +open_timeout+.
    class TimeoutError < IOError; end

    # The handshake failed. +status+ is the HTTP status of the answer (0 when there was none).
    class HandshakeError < IOError
      attr_reader :status

      def initialize(message, status = 0)
        super(message)
        @status = status
      end
    end

    # The connection is closed. +code+ is the close code the server sent (nil when the connection simply ended).
    class Closed < IOError
      attr_reader :code, :reason

      def initialize(code = nil, reason = nil)
        super(code ? "WebSocket closed (#{code}#{reason.to_s.empty? ? "" : " #{reason}"})" : "WebSocket connection ended")
        @code = code
        @reason = reason
      end
    end

    module_function

    # Opens a connection to a +ws://+ or +wss://+ URL. +headers+ are sent with the upgrade request (never put a key
    # in the URL); +protocols+ are the offered subprotocols. Raises {HandshakeError} or a socket error.
    def connect(url, headers: {}, protocols: [], open_timeout: 10, ssl_context: nil)
      uri = URI(url)
      raise ArgumentError, "not a WebSocket URL: #{url}" unless %w[ws wss].include?(uri.scheme)

      tls = uri.scheme == "wss"
      port = uri.port || (tls ? 443 : 80)
      deadline = monotonic + open_timeout
      hostname = uri.hostname # without the brackets of an IPv6 literal
      io = open_tcp(hostname, port, tls, deadline)
      begin
        if tls
          ctx = ssl_context || default_ssl_context
          ssl = OpenSSL::SSL::SSLSocket.new(io, ctx)
          ssl.sync_close = true
          ssl.hostname = hostname
          wait_io(ssl, deadline) { ssl.connect_nonblock(exception: false) }
          ssl.post_connection_check(hostname) if ctx.verify_mode != OpenSSL::SSL::VERIFY_NONE
          io = ssl
        end
        key = [SecureRandom.random_bytes(16)].pack("m0")
        host = uri.host # bracketed for IPv6
        lines = ["GET #{uri.request_uri} HTTP/1.1", "Host: #{port == (tls ? 443 : 80) ? host : "#{host}:#{port}"}",
                 "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: #{key}", "Sec-WebSocket-Version: 13"]
        lines << "Sec-WebSocket-Protocol: #{protocols.join(", ")}" unless protocols.empty?
        headers.each do |k, v|
          raise ArgumentError, "invalid header" if "#{k}#{v}".match?(/[\r\n]/)

          lines << "#{k}: #{v}"
        end
        write_all(io, "#{lines.join("\r\n")}\r\n\r\n", deadline)
        reader = Reader.new(io)
        head = reader.read_head(deadline)
        status_line, *header_lines = head.split("\r\n")
        status = status_line.to_s[/\AHTTP\/1\.[01] (\d{3})/, 1].to_i
        res = {}
        header_lines.each do |l|
          k, v = l.split(":", 2)
          res[k.to_s.strip.downcase] = v.to_s.strip if v
        end
        raise HandshakeError.new("WebSocket upgrade refused with HTTP #{status}", status) unless status == 101
        raise HandshakeError.new("not a WebSocket upgrade", status) unless res["upgrade"].to_s.casecmp?("websocket") && res["connection"].to_s.downcase.split(/\s*,\s*/).include?("upgrade")

        expected = [Digest::SHA1.digest(key + GUID)].pack("m0")
        raise HandshakeError.new("invalid Sec-WebSocket-Accept", status) unless res["sec-websocket-accept"] == expected

        protocol = res["sec-websocket-protocol"]
        raise HandshakeError.new("unexpected subprotocol #{protocol.inspect}", status) if protocol && !protocols.include?(protocol)
        raise HandshakeError.new("extensions were not offered", status) if res["sec-websocket-extensions"]

        Connection.new(io, reader, protocol)
      rescue StandardError
        begin
          io.close
        rescue StandardError
          nil
        end
        raise
      end
    end

    def default_ssl_context
      ctx = OpenSSL::SSL::SSLContext.new
      ctx.set_params(verify_mode: OpenSSL::SSL::VERIFY_PEER)
      ctx
    end

    def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    # A TCP connection to host:port, through the environment's HTTP proxy when one applies (a CONNECT tunnel).
    def open_tcp(host, port, tls, deadline)
      proxy = URI("#{tls ? "https" : "http"}://#{host.include?(":") ? "[#{host}]" : host}:#{port}").find_proxy
      left = [deadline - monotonic, 0.001].max
      return Socket.tcp(host, port, connect_timeout: left) unless proxy

      io = Socket.tcp(proxy.hostname, proxy.port, connect_timeout: left)
      begin
        target = host.include?(":") ? "[#{host}]:#{port}" : "#{host}:#{port}"
        req = +"CONNECT #{target} HTTP/1.1\r\nHost: #{target}\r\n"
        if proxy.user
          creds = "#{URI.decode_www_form_component(proxy.user)}:#{URI.decode_www_form_component(proxy.password.to_s)}"
          req << "Proxy-Authorization: Basic #{[creds].pack("m0")}\r\n"
        end
        write_all(io, "#{req}\r\n", deadline)
        head = Reader.new(io).read_head(deadline) # the tunnel answer only: nothing follows until the client speaks
        status = head[/\AHTTP\/1\.[01] (\d{3})/, 1].to_i
        raise HandshakeError.new("proxy CONNECT failed with HTTP #{status}", 0) unless status == 200

        io
      rescue StandardError
        io.close
        raise
      end
    end

    # Runs a nonblocking operation until it completes or +deadline+ passes.
    def wait_io(io, deadline)
      loop do
        r = yield
        case r
        when :wait_readable, :wait_writable
          left = deadline - monotonic
          raise TimeoutError, "timed out" if left <= 0

          ready = r == :wait_readable ? IO.select([io], nil, nil, left) : IO.select(nil, [io], nil, left)
          raise TimeoutError, "timed out" unless ready
        else
          return r
        end
      end
    end

    def write_all(io, data, deadline)
      data = data.b
      until data.empty?
        n = wait_io(io, deadline) { io.write_nonblock(data, exception: false) }
        data = data.byteslice(n..)
      end
    end

    # Buffered nonblocking reads (OpenSSL may hold decrypted bytes that IO.select does not see).
    class Reader
      def initialize(io)
        @io = io
        @buf = "".b
      end

      def buffered = @buf.bytesize

      # Reads at least one more chunk; returns false on timeout. Raises {Closed} at the end of the stream.
      def fill(deadline)
        loop do
          r = @io.read_nonblock(65_536, exception: false)
          case r
          when nil then raise Closed
          when :wait_readable, :wait_writable
            left = deadline.nil? ? nil : deadline - WebSocket.monotonic
            return false if left && left <= 0

            ready = r == :wait_readable ? IO.select([@io], nil, nil, left) : IO.select(nil, [@io], nil, left)
            return false unless ready
          else
            @buf << r
            return true
          end
        end
      rescue IOError, SystemCallError, OpenSSL::SSL::SSLError => e
        raise e if e.is_a?(Closed)

        raise Closed
      end

      # Removes and returns +n+ bytes, or nil when they did not arrive before +deadline+.
      def take(n, deadline)
        while @buf.bytesize < n
          return nil unless fill(deadline)
        end
        @buf.slice!(0, n)
      end

      def read_head(deadline)
        loop do
          if (i = @buf.index("\r\n\r\n"))
            head = @buf.slice!(0, i + 4)
            return head.byteslice(0, i).force_encoding(Encoding::UTF_8)
          end
          raise HandshakeError, "response header too large" if @buf.bytesize > MAX_HEADER
          raise TimeoutError, "timed out" unless fill(deadline)
        end
      end
    end

    # An open WebSocket connection.
    class Connection
      attr_reader :protocol

      def initialize(io, reader, protocol)
        @io = io
        @reader = reader
        @protocol = protocol
        @write_lock = Mutex.new
        @closed = false
        @close_sent = false
        @partial = nil
        @frame = nil
      end

      def closed? = @closed

      # Sends one text message.
      def send_text(text) = send_frame(0x1, text.to_s.b)

      # The next text message (String), or nil when nothing arrived within +timeout+ seconds. Answers pings, skips
      # pongs and binary messages. Raises {Closed} (with the server's close code) when the connection ends.
      def recv(timeout)
        deadline = WebSocket.monotonic + timeout
        loop do
          raise Closed if @closed && @reader.buffered.zero?

          frame = next_frame(deadline)
          return nil if frame.nil?

          fin, opcode, payload = frame
          case opcode
          when 0x0
            raise protocol_error("unexpected continuation") unless @partial

            append(payload)
            return finish if fin
          when 0x1, 0x2
            raise protocol_error("interleaved message") if @partial

            @partial = [opcode, payload]
            check_size
            return finish if fin
          when 0x8 then handle_close(payload)
          when 0x9 then send_frame(0xA, payload)
          when 0xA then nil
          else raise protocol_error("unknown opcode #{opcode}")
          end
        end
      end

      # Starts the close handshake (best effort) and closes the socket. Safe from any thread; idempotent.
      def close(code = 1000, reason = "")
        return if @closed

        begin
          payload = [code].pack("n") + reason.to_s.b.byteslice(0, 120)
          send_frame(0x8, payload, timeout: 1) unless @close_sent
        rescue StandardError
          nil
        end
        shutdown
      end

      private

      def shutdown
        @closed = true
        begin
          @io.close
        rescue StandardError
          nil
        end
      end

      def protocol_error(why)
        close(1002, "protocol error")
        Closed.new(1002, why)
      end

      def append(payload)
        @partial[1] << payload
        check_size
      end

      def check_size
        return if @partial[1].bytesize <= MAX_MESSAGE

        close(1009, "too big")
        raise Closed.new(1009, "message too big")
      end

      def finish
        opcode, data = @partial
        @partial = nil
        return nil if opcode == 0x2 # the live protocol only uses text

        text = data.force_encoding(Encoding::UTF_8)
        raise protocol_error("invalid UTF-8") unless text.valid_encoding?

        text
      end

      def handle_close(payload)
        code = payload.bytesize >= 2 ? payload.unpack1("n") : nil
        reason = payload.bytesize > 2 ? payload.byteslice(2..).force_encoding(Encoding::UTF_8) : nil
        unless @close_sent
          begin
            send_frame(0x8, payload.bytesize >= 2 ? payload.byteslice(0, 2) : "".b, timeout: 1)
          rescue StandardError
            nil
          end
        end
        shutdown
        raise Closed.new(code, reason)
      end

      # One frame as [fin, opcode, payload], or nil on timeout. A partially received frame is kept for the next call.
      def next_frame(deadline)
        @frame ||= {}
        f = @frame
        unless f[:b0]
          head = @reader.take(2, deadline) or return nil
          f[:b0], f[:b1] = head.unpack("CC")
          raise protocol_error("reserved bits set") if f[:b0] & 0x70 != 0
          raise protocol_error("masked server frame") if f[:b1] & 0x80 != 0
        end
        unless f[:len]
          len = f[:b1] & 0x7F
          if len == 126
            ext = @reader.take(2, deadline) or return nil
            len = ext.unpack1("n")
          elsif len == 127
            ext = @reader.take(8, deadline) or return nil
            len = ext.unpack1("Q>")
          end
          opcode = f[:b0] & 0x0F
          raise protocol_error("control frame too long") if opcode >= 0x8 && (len > 125 || f[:b0] & 0x80 == 0)
          if len > MAX_MESSAGE
            close(1009, "too big")
            raise Closed.new(1009, "message too big")
          end

          f[:len] = len
        end
        payload = f[:len].zero? ? "".b : (@reader.take(f[:len], deadline) or return nil)
        @frame = nil
        [f[:b0] & 0x80 != 0, f[:b0] & 0x0F, payload]
      end

      def send_frame(opcode, payload, timeout: 10)
        payload = payload.b
        @write_lock.synchronize do
          raise Closed if @closed || @close_sent

          @close_sent = true if opcode == 0x8
          len = payload.bytesize
          head = [0x80 | opcode].pack("C")
          head << if len < 126 then [0x80 | len].pack("C")
                  elsif len < 65_536 then [0x80 | 126, len].pack("Cn")
                  else [0x80 | 127, len].pack("CQ>")
                  end
          mask = SecureRandom.random_bytes(4)
          head << mask
          WebSocket.write_all(@io, head << WebSocket.mask(payload, mask), WebSocket.monotonic + timeout)
        end
      rescue IOError, SystemCallError, OpenSSL::SSL::SSLError => e
        raise e if e.is_a?(Closed)

        shutdown
        raise Closed
      end
    end

    # XORs +data+ with the 4-byte +key+ (RFC 6455 §5.3).
    def mask(data, key)
      return data.dup if data.empty?

      k = key.unpack("C4")
      words = data.bytesize / 4
      out = if words.positive?
              kw = key.unpack1("N")
              data.byteslice(0, words * 4).unpack("N*").map { |w| w ^ kw }.pack("N*")
            else
              "".b
            end
      (words * 4...data.bytesize).each { |i| out << (data.getbyte(i) ^ k[i % 4]) }
      out
    end
  end
end
