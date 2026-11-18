# frozen_string_literal: true

require_relative "test_helper"
require "socket"
require "digest"

# The RFC 6455 client (NanoFlags::WebSocket) and the client's live socket against a real local server (plain TCP).
class TestWebSocket < Minitest::Test
  GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

  def setup
    @server = TCPServer.new("127.0.0.1", 0)
    @port = @server.addr[1]
    @handshakes = Queue.new
    @server_frames = Queue.new
    @handler = nil
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

  # ---- a minimal server side

  def read_head(sock)
    line = sock.gets.to_s
    headers = {}
    while (h = sock.gets) && h != "\r\n"
      k, v = h.split(":", 2)
      headers[k.downcase] = v.strip
    end
    [line.split[1], headers]
  end

  def serve(sock)
    path, headers = read_head(sock)
    if path == "/v1/bundle"
      b = %({"revision":1,"checksum":"c1","bundle":{"schema":1,"revision":1,"flags":{"f":{"enabled":true,"default":"one","off":"off","rules":[]}},"segments":{}}})
      sock.write("HTTP/1.1 200 OK\r\nETag: \"c1-server\"\r\nContent-Length: #{b.bytesize}\r\nConnection: close\r\n\r\n#{b}")
      return
    end
    unless path.start_with?("/v1/stream")
      @handshakes << [path, headers]
      @handler.call(sock, headers)
      return
    end
    sock.write("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
  rescue IOError, SystemCallError
    nil
  ensure
    sock.close unless sock.closed?
  end

  def accept(sock, headers, protocol: "nanoflags.v1", accept_key: nil)
    key = accept_key || [Digest::SHA1.digest(headers["sec-websocket-key"] + GUID)].pack("m0")
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: #{key}\r\n" \
               "#{protocol ? "Sec-WebSocket-Protocol: #{protocol}\r\n" : ""}\r\n")
  end

  def frame(opcode, payload, fin: true)
    payload = payload.b
    len = payload.bytesize
    head = [(fin ? 0x80 : 0) | opcode].pack("C")
    head << if len < 126 then [len].pack("C")
            elsif len < 65_536 then [126, len].pack("Cn")
            else [127, len].pack("CQ>")
            end
    head + payload
  end

  def read_frame(sock)
    b0, b1 = sock.read(2).unpack("CC")
    len = b1 & 0x7F
    len = sock.read(2).unpack1("n") if len == 126
    len = sock.read(8).unpack1("Q>") if len == 127
    assert_equal 0x80, b1 & 0x80, "client frames must be masked"
    mask = sock.read(4).bytes
    data = sock.read(len).bytes.each_with_index.map { |b, i| b ^ mask[i % 4] }.pack("C*")
    [b0 & 0x0F, data]
  end

  def url(path = "/v1/live") = "ws://127.0.0.1:#{@port}#{path}"

  # ---- the protocol client

  def test_handshake_messages_ping_pong_and_close_code
    @handler = lambda do |sock, headers|
      accept(sock, headers)
      sock.write(frame(0x1, "hel", fin: false) + frame(0x9, "beat") + frame(0x0, "lo")) # a ping between fragments
      @server_frames << read_frame(sock) # the pong
      @server_frames << read_frame(sock) # the client's text "ping"
      sock.write(frame(0x1, "pong"))
      big = "x" * 70_000
      sock.write(frame(0x1, big))
      @server_frames << read_frame(sock) # 70 000 bytes from the client
      sock.write(frame(0x8, [4004].pack("n") + "environment deleted"))
      @server_frames << read_frame(sock) # the close echo
    end
    ws = NanoFlags::WebSocket.connect(url, headers: { "Authorization" => "Bearer nf_srv_x", "User-Agent" => "t" }, protocols: ["nanoflags.v1"], open_timeout: 5)
    path, headers = @handshakes.pop
    assert_equal "/v1/live", path
    assert_equal ["Bearer nf_srv_x", "nanoflags.v1", "13", "websocket"], headers.values_at("authorization", "sec-websocket-protocol", "sec-websocket-version", "upgrade")
    assert_equal "nanoflags.v1", ws.protocol
    assert_equal "hello", ws.recv(5)
    assert_equal [0xA, "beat"], @server_frames.pop
    ws.send_text("ping")
    assert_equal [0x1, "ping"], @server_frames.pop
    assert_equal "pong", ws.recv(5)
    assert_equal 70_000, ws.recv(5).bytesize
    ws.send_text("y" * 70_000)
    assert_equal [0x1, "y" * 70_000], @server_frames.pop
    err = assert_raises(NanoFlags::WebSocket::Closed) { ws.recv(5) }
    assert_equal [4004, "environment deleted"], [err.code, err.reason]
    assert_equal [0x8, [4004].pack("n")], @server_frames.pop
    assert ws.closed?
  end

  def test_refused_and_invalid_upgrades
    @handler = ->(sock, _h) { sock.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n") }
    err = assert_raises(NanoFlags::WebSocket::HandshakeError) { NanoFlags::WebSocket.connect(url, open_timeout: 5) }
    assert_equal 401, err.status

    @handler = ->(sock, h) { accept(sock, h, accept_key: "wrong") }
    assert_raises(NanoFlags::WebSocket::HandshakeError) { NanoFlags::WebSocket.connect(url, protocols: ["nanoflags.v1"], open_timeout: 5) }

    @handler = ->(sock, h) { accept(sock, h, protocol: "other") }
    assert_raises(NanoFlags::WebSocket::HandshakeError) { NanoFlags::WebSocket.connect(url, protocols: ["nanoflags.v1"], open_timeout: 5) }

    @handler = ->(sock, _h) { sleep 2 } # never answers
    assert_raises(NanoFlags::WebSocket::TimeoutError) { NanoFlags::WebSocket.connect(url, open_timeout: 0.3) }
  end

  def test_recv_timeout_and_close_from_another_thread
    @handler = lambda do |sock, headers|
      accept(sock, headers)
      @server_frames << read_frame(sock)
    end
    ws = NanoFlags::WebSocket.connect(url, protocols: ["nanoflags.v1"], open_timeout: 5)
    assert_nil ws.recv(0.1)
    t = Thread.new { ws.recv(10) rescue $! } # rubocop:disable Style/RescueModifier
    sleep 0.1
    ws.close(1000, "bye")
    assert_kind_of NanoFlags::WebSocket::Closed, t.value
    assert_equal [0x8, [1000].pack("n") + "bye"], @server_frames.pop
    ws.close # idempotent
  end

  def test_mask_round_trips
    key = "\x01\x02\x03\x04".b
    %w[a abcd abcdefg].each { |s| assert_equal s, NanoFlags::WebSocket.mask(NanoFlags::WebSocket.mask(s.b, key), key) }
    # RFC 6455 section 5.7: "Hello" masked with 37 fa 21 3d.
    assert_equal ["7f9f4d5158"].pack("H*"), NanoFlags::WebSocket.mask("Hello".b, ["37fa213d"].pack("H*"))
  end

  # ---- the client over a real socket

  def test_client_goes_live_receives_a_push_and_honours_4004
    @handler = lambda do |sock, headers|
      accept(sock, headers)
      bundle = %({"schema":1,"revision":2,"flags":{"f":{"enabled":true,"default":"two","off":"off","rules":[]}},"segments":{}})
      sock.write(frame(0x1, JSON.generate({ "t" => "hello", "revision" => 2, "checksum" => "c2", "bundle" => bundle, "committedAt" => (Time.now.to_f * 1000) - 10 })))
      sleep 0.3
      sock.write(frame(0x8, [4004].pack("n")))
      read_frame(sock)
    end
    errors = Queue.new
    changes = Queue.new
    c = NanoFlags::Client.new("nf_srv_ws", base_url: "http://127.0.0.1:#{@port}", verify: false, events: false, poll_interval: 0,
                                           on_error: ->(e) { errors << e }, on_change: ->(e) { changes << e })
    assert c.wait_until_ready(5)
    assert wait_for { c.string_variation("f", "x") == "two" }
    pushed = wait_for { (e = changes.pop(true) rescue nil) && e.transport == :live ? e : nil } # rubocop:disable Style/RescueModifier
    assert_equal [2, 1], [pushed.revision, pushed.previous_revision]
    assert_operator pushed.latency_ms, :>=, 10
    assert wait_for { (e = errors.pop(true) rescue nil) && e.code == :environment_deleted } # rubocop:disable Style/RescueModifier
    assert_equal ["stale", :poll, "two"], [c.status, c.transport, c.string_variation("f", "x")]
    _, headers = @handshakes.pop
    assert_equal "Bearer nf_srv_ws", headers["authorization"]
    sleep 1.2
    assert_equal 0, @handshakes.size # no reconnect after 4004
    c.close
  end
end
