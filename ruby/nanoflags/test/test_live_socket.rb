# frozen_string_literal: true

require_relative "test_helper"
require_relative "fake_edge"

# The live socket (/v1/live) through the client, against the in-process edge.
class TestLiveSocket < Minitest::Test
  def setup
    @edge = FakeEdge.new
    @edge.live = true
    @errors = Queue.new
    @seen = []
    @clients = []
  end

  def teardown
    @clients.each(&:close)
  end

  def client(**opts)
    c = NanoFlags::Client.new("nf_srv_test", base_url: FakeEdge::BASE, service: "ruby-tests", http: @edge,
                                             verify: { public_keys: [@edge.jwk], require: true }, events: false,
                                             on_error: ->(e) { @errors << e }, **opts)
    @clients << c
    c
  end

  def errors
    @seen << @errors.pop until @errors.empty?
    @seen
  end

  def flags(accent)
    f = FakeEdge.bundle(1)["flags"]
    f["accent"]["default"] = accent
    f
  end

  def test_hello_push_latency_and_tampered_push
    changes = Queue.new
    c = client(on_change: ->(e) { changes << e })
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :live }
    live = @edge.requests.find { |r| r[:path] == "/v1/live" }
    assert_equal ["Bearer nf_srv_test", ["nanoflags.v1"]], [live[:headers]["Authorization"], live[:protocols]]
    assert_match %r{\Ananoflags-ruby/}, live[:headers]["User-Agent"]
    assert wait_for { @edge.stream_opens.zero? && c.transport == :live } # no event stream while the socket is healthy
    assert_equal "ready", c.status

    commit = (Time.now.to_f * 1000) - 25
    @edge.push(FakeEdge.bundle(2, flags("orange")), committed_at: commit)
    assert wait_for { c.revision == 2 }
    assert_equal "orange", c.string_variation("accent", "x")
    u = nil
    u = changes.pop until u&.revision == 2
    assert_equal [:live, :network, 1], [u.transport, u.source, u.previous_revision]
    assert_operator u.latency_ms, :>=, 25
    # The safety poll sends the ETag of the pushed revision and gets a 304.
    bundle_requests = @edge.count("/v1/bundle")
    assert c.refresh
    assert_equal bundle_requests + 1, @edge.count("/v1/bundle")
    assert_equal %("#{@edge.checksum}-server"), @edge.requests.reverse.find { |r| r[:path] == "/v1/bundle" }[:headers]["If-None-Match"]

    # A tampered push changes nothing, and the verified request path then fetches what the edge really serves.
    @edge.push(FakeEdge.bundle(3), tamper: true)
    assert wait_for { errors.any? { |e| e.code == :signature && e.message.include?("Pushed bundle r3 was rejected") } }
    assert wait_for { c.revision == 3 }
    assert_equal "blue", c.string_variation("accent", "x")
  end

  def test_push_signed_with_a_foreign_key_or_unsigned_is_rejected
    c = client(poll_interval: 0)
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :live }
    @edge.push(FakeEdge.bundle(5), sign_key: OpenSSL::PKey.generate_key("ED25519"))
    assert wait_for { errors.any? { |e| e.message.include?("Pushed bundle r5 was rejected: its signature does not verify.") } }
    assert_includes [1, 5], c.revision # r5 may then arrive through the verified HTTP path
    assert_equal "blue", c.string_variation("accent", "x")
  end

  def test_unverified_client_accepts_pushes_and_never_goes_backwards
    c = client(verify: false, poll_interval: 0)
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :live }
    @edge.push(FakeEdge.bundle(4, flags("teal")))
    assert wait_for { c.revision == 4 }
    @edge.push(FakeEdge.bundle(2, flags("old")))
    sleep 0.1
    assert_equal [4, "teal"], [c.revision, c.string_variation("accent", "x")]
  end

  def test_close_code_4004_keeps_the_bundle_and_stops_reconnecting
    c = client
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :live }
    connects = @edge.ws_connects
    @edge.close_sockets(NanoFlags::CLOSE_ENVIRONMENT_DELETED, "environment deleted")
    assert wait_for { errors.any? { |e| e.code == :environment_deleted } }
    assert_equal ["stale", :poll], [c.status, c.transport]
    sleep 1.5
    assert_equal connects, @edge.ws_connects # no reconnect
    assert_equal 0, @edge.stream_opens # and no event stream
    assert_equal "blue", c.string_variation("accent", "x") # last bundle kept
  end

  def test_reconnects_after_a_drop
    c = client
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :live }
    n = @edge.ws_connects
    @edge.close_sockets(1011, "restart")
    assert wait_for(8) { @edge.ws_connects > n && c.transport == :live }
  end

  def test_falls_back_to_the_event_stream_and_polling
    @edge.live = false # the edge has no live socket (or a proxy refuses the upgrade)
    c = client(poll_interval: 0)
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :stream }
    @edge.publish(FakeEdge.bundle(2, flags("green")))
    assert wait_for { c.string_variation("accent", "x") == "green" }

    @edge.live = true # the socket comes back: the stream is closed again
    assert wait_for(8) { c.transport == :live }
    assert wait_for { @edge.instance_variable_get(:@streams).empty? }
  end

  def test_live_false_uses_only_the_event_stream
    c = client(live: false, poll_interval: 0)
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :stream }
    assert_equal 0, @edge.count("/v1/live")
  end

  def test_rejected_key_drops_the_socket
    c = client
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :live }
    @edge.status_override = 401
    c.refresh
    assert wait_for { c.transport != :live }
    assert_includes errors.map(&:code), :unauthorized
    assert_equal "blue", c.string_variation("accent", "x")
  end

  def test_fork_opens_its_own_socket_and_leaves_the_parents_alone
    skip "fork is not available" unless Process.respond_to?(:fork)
    c = client(poll_interval: 0)
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :live }
    parent_socket = @edge.sockets.first
    reader, writer = IO.pipe
    pid = fork do
      reader.close
      out = [c.transport.to_s, c.string_variation("accent", "x")]
      out << (wait_for { c.transport == :live } ? "live" : "no-live")
      out << @edge.ws_connects
      writer.puts(JSON.generate(out))
      writer.close
      exit!(0)
    end
    writer.close
    result = JSON.parse(reader.read)
    Process.wait(pid)
    assert_equal ["poll", "blue", "live", 2], result # the child starts without the parent's socket, then opens its own
    refute parent_socket.closed?
    assert_equal :live, c.transport
  end
end
