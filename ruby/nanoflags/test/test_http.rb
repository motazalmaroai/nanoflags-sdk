# frozen_string_literal: true

require_relative "test_helper"
require "socket"

# The Net::HTTP transport against a real local HTTP server (plain TCP).
class TestHttp < Minitest::Test
  def setup
    @server = TCPServer.new("127.0.0.1", 0)
    @port = @server.addr[1]
    @base = "http://127.0.0.1:#{@port}"
    @requests = Queue.new
    @thread = Thread.new do
      loop do
        sock = @server.accept
        Thread.new(sock) { |s| serve(s) }
      end
    rescue IOError, Errno::EBADF
      nil
    end
  end

  def teardown
    @server.close
    @thread.join(1)
  end

  def serve(sock)
    line = sock.gets.to_s
    headers = {}
    while (h = sock.gets) && h != "\r\n"
      k, v = h.split(":", 2)
      headers[k.downcase] = v.strip
    end
    body = headers["content-length"] ? sock.read(headers["content-length"].to_i) : nil
    method, path = line.split
    @requests << [method, path, headers, body]
    case path
    when "/v1/bundle"
      if headers["if-none-match"] == '"abc"'
        sock.write("HTTP/1.1 304 Not Modified\r\nETag: \"abc\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
      else
        b = '{"revision":2,"checksum":"abc","bundle":{"schema":1,"revision":2,"flags":{"f":{"enabled":true,"default":"on","off":"off","rules":[]}},"segments":{}}}'
        sock.write("HTTP/1.1 200 OK\r\nETag: \"abc\"\r\nX-NanoFlags-Signed: false\r\nContent-Type: application/json\r\nContent-Length: #{b.bytesize}\r\nConnection: close\r\n\r\n#{b}")
      end
    when "/v1/stream"
      sock.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n: hi\r\n\r\n")
      sock.write("event: revision\r\ndata: {\"revision\":3,\r\ndata: \"checksum\":\"x\"}\r\n\r\n")
      sleep 2
    when "/redirect"
      sock.write("HTTP/1.1 302 Found\r\nLocation: /v1/bundle\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    else
      sock.write("HTTP/1.1 202 Accepted\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
    end
  rescue IOError, Errno::EPIPE, Errno::ECONNRESET
    nil
  ensure
    sock.close
  end

  def test_requests_etag_redirects_and_posts
    http = NanoFlags::HTTP::NetHttp.new
    res = http.call("GET", "#{@base}/v1/bundle", { "Authorization" => "Bearer k" }, nil, 5)
    assert_equal [200, '"abc"'], [res.status, res.header("ETag")]
    assert_includes res.body, '"flags"'
    assert_equal 304, http.call("GET", "#{@base}/v1/bundle", { "If-None-Match" => '"abc"' }, nil, 5).status
    assert_equal 302, http.call("GET", "#{@base}/redirect", {}, nil, 5).status # never followed
    assert_equal 202, http.call("POST", "#{@base}/v1/events", { "Content-Type" => "application/json" }, '{"x":1}', 5).status
    posted = []
    posted << @requests.pop until @requests.empty?
    assert_equal ["POST", "/v1/events", '{"x":1}'], posted.last.values_at(0, 1, 3)
  end

  def test_event_stream_and_closing_it
    http = NanoFlags::HTTP::NetHttp.new
    got = []
    status = http.stream("#{@base}/v1/stream", {}, open_timeout: 5, read_timeout: 5) do |event, data|
      got << [event, data]
      :stop
    end
    assert_equal 200, status
    assert_equal [["revision", "{\"revision\":3,\n\"checksum\":\"x\"}"]], got
  end

  def test_client_end_to_end
    c = NanoFlags::Client.new("nf_srv_http", base_url: @base, verify: false, events: false, poll_interval: 0)
    assert c.wait_until_ready(5)
    assert_equal ["on", 2], [c.string_variation("f", "x"), c.revision]
    c.close
  end
end
