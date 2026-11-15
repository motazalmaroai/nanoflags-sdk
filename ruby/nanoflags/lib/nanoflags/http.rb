# frozen_string_literal: true

require "net/http"
require "uri"

module NanoFlags
  # HTTP for the client: blocking requests and a server-sent event reader on Net::HTTP. Proxy settings come from the
  # environment (`HTTPS_PROXY`, `NO_PROXY`), the CA store from OpenSSL's defaults (`SSL_CERT_FILE`). Redirects are
  # never followed.
  #
  # Any object with the same two methods can be passed as the client's +http:+ option.
  module HTTP
    # A complete response; header names are lower-case.
    Response = Struct.new(:status, :headers, :body) do
      def header(name) = headers[name.to_s.downcase]
      def ok? = status.between?(200, 299)
    end

    # Incremental text/event-stream parser.
    class SseParser
      def initialize
        @buffer = +""
        @event = "message"
        @data = []
      end

      # Feeds a chunk; yields each complete event as (event, data).
      def feed(chunk)
        @buffer << chunk.b
        while (p = @buffer.index("\n"))
          line = @buffer.slice!(0, p + 1).chomp.delete_suffix("\r").force_encoding(Encoding::UTF_8)
          if line.empty?
            yield @event, @data.join("\n") unless @data.empty?
            @event = "message"
            @data = []
            next
          end
          next if line.start_with?(":")

          field, value = line.split(":", 2)
          value = value.to_s.delete_prefix(" ")
          case field
          when "event" then @event = value
          when "data" then @data << value
          end
        end
        @buffer.clear if @buffer.bytesize > 65_536
      end
    end

    # The default transport.
    class NetHttp
      MAX_BODY = 16 * 1024 * 1024

      def initialize(user_agent: nil)
        @user_agent = user_agent
      end

      # Performs one request and returns a {Response}. Raises on transport failures (no connection, timeout).
      def call(method, url, headers, body, timeout)
        uri = URI(url)
        http = connection(uri, timeout, timeout)
        http.start do |h|
          req = Net::HTTPGenericRequest.new(method, !body.nil?, method != "HEAD", uri.request_uri, headers)
          req.body = body if body
          h.request(req) do |res|
            buf = +""
            res.read_body do |chunk|
              buf << chunk
              raise IOError, "response body larger than 16 MiB" if buf.bytesize > MAX_BODY
            end
            return Response.new(res.code.to_i, res.each_header.to_h, buf.force_encoding(Encoding::UTF_8))
          end
        end
      end

      # Reads a server-sent event stream, yielding (event, data) until it ends, the block returns +:stop+, nothing
      # arrives for +read_timeout+ seconds, or +on_open+'s closer is called (from any thread). Returns the HTTP status
      # (0 when no response arrived).
      def stream(url, headers, open_timeout:, read_timeout:, on_open: nil)
        uri = URI(url)
        http = connection(uri, open_timeout, read_timeout)
        status = 0
        # Thrown through Net::HTTP, :stop skips reading the rest of the (endless) body; `start` closes the socket.
        catch(:stop) do
          http.start do |h|
            on_open&.call(-> { h.finish if h.started? })
            req = Net::HTTP::Get.new(uri.request_uri, headers)
            h.request(req) do |res|
              status = res.code.to_i
              next unless status == 200

              parser = SseParser.new
              res.read_body do |chunk|
                parser.feed(chunk) { |event, data| throw :stop if yield(event, data) == :stop }
              end
            end
          end
        end
        status
      rescue IOError, Errno::EBADF
        status # closed from another thread
      end

      private

      def connection(uri, open_timeout, read_timeout)
        http = Net::HTTP.new(uri.host, uri.port)
        http.use_ssl = uri.scheme == "https"
        http.open_timeout = open_timeout
        http.read_timeout = read_timeout
        http.write_timeout = open_timeout if http.respond_to?(:write_timeout=)
        http.ssl_timeout = open_timeout if http.use_ssl?
        http.keep_alive_timeout = 2
        http
      end
    end
  end
end
