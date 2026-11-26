# frozen_string_literal: true

require_relative "test_helper"
require_relative "fake_edge"

# Verification hardening: revision floor, status after a refused update, address spellings, store contents.
class TestVerification < Minitest::Test
  def setup
    @edge = FakeEdge.new
    @errors = Queue.new
    @seen = []
    @clients = []
  end

  def teardown
    @clients.each(&:close)
  end

  def client(**opts)
    c = NanoFlags::Client.new(
      opts.delete(:sdk_key) || "nf_srv_test",
      base_url: FakeEdge::BASE, service: "ruby-tests", http: @edge,
      verify: { public_keys: [@edge.jwk], require: true }, events: false,
      on_error: ->(e) { @errors << e }, **opts
    )
    @clients << c
    c
  end

  def codes
    @seen << @errors.pop until @errors.empty?
    @seen.map(&:code)
  end

  # A client that only syncs when asked to.
  def idle(**opts) = client(streaming: false, poll_interval: 3600, **opts)

  def test_an_older_revision_than_the_one_in_use_is_not_adopted
    @edge.set_bundle(FakeEdge.bundle(3))
    c = idle
    assert c.wait_until_ready(5)
    assert_equal 3, c.revision
    @edge.set_bundle(FakeEdge.bundle(2))
    assert c.refresh
    assert_equal [3, "stale", [:rollback]], [c.revision, c.status, codes]
    @edge.set_bundle(FakeEdge.bundle(4))
    assert c.refresh
    assert_equal [4, "ready"], [c.revision, c.status]
  end

  def test_an_older_stored_copy_is_the_floor_after_a_restart
    store = NanoFlags::Store::Memory.new
    @edge.set_bundle(FakeEdge.bundle(3))
    first = idle(store: store)
    assert first.wait_until_ready(5)
    first.close
    @edge.set_bundle(FakeEdge.bundle(2))
    c = idle(store: store)
    assert c.wait_until_ready(5)
    assert wait_for { codes.include?(:rollback) }
    assert_equal [3, "stale"], [c.revision, c.status]
    # The same older answer is no reason to leave the stored copy either.
    assert JSON.parse(store.get)["bundle"].include?('"revision":3')
  end

  def test_an_older_copy_marked_stale_by_the_edge_keeps_the_current_behaviour
    @edge.set_bundle(FakeEdge.bundle(3))
    c = idle
    assert c.wait_until_ready(5)
    @edge.set_bundle(FakeEdge.bundle(2))
    @edge.stale = true
    assert c.refresh
    assert_equal [3, "stale", []], [c.revision, c.status, codes]
  end

  def test_unverified_revisions_do_not_set_the_floor
    @edge.set_bundle(FakeEdge.bundle(2))
    c = idle(bootstrap: FakeEdge.bundle(10))
    assert wait_for { c.revision == 2 }
    assert_empty codes

    @edge.set_bundle(FakeEdge.bundle(3))
    off = idle(verify: false, sdk_key: "nf_srv_off")
    assert off.wait_until_ready(5)
    @edge.set_bundle(FakeEdge.bundle(2))
    assert off.refresh
    assert_equal [2, []], [off.revision, codes]
  end

  def test_a_refused_update_makes_a_loaded_client_stale_until_a_bundle_verifies
    c = idle
    assert c.wait_until_ready(5)
    assert_equal "ready", c.status
    @edge.set_bundle(FakeEdge.bundle(2))
    @edge.tamper = true
    assert c.refresh
    assert_equal [1, "stale", [:signature]], [c.revision, c.status, codes]
    @edge.tamper = false
    assert c.refresh
    assert_equal [2, "ready"], [c.revision, c.status]
  end

  def test_an_unsigned_answer_while_the_edge_catches_up_and_an_unsupported_engine_leave_the_status
    c = idle
    assert c.wait_until_ready(5)
    @edge.set_bundle(FakeEdge.bundle(2))
    @edge.signed = false
    c.refresh
    assert_equal ["ready", [:signature]], [c.status, codes]
    @edge.signed = true
    @edge.set_bundle(FakeEdge.bundle(3, nil, engine: 99))
    c.refresh
    assert_equal [1, "ready", %i[signature engine]], [c.revision, c.status, codes]
  end

  # ---- live pushes

  def live_client(**opts)
    @edge.live = true
    c = client(**opts)
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :live }
    c
  end

  # A correctly signed push of +older+ while the edge keeps serving +current+.
  def push_older(older, current)
    @edge.set_bundle(older)
    msg = @edge.message("rev")
    @edge.set_bundle(current)
    @edge.sockets.each { |ws| ws.deliver(msg) }
  end

  def test_an_older_push_is_refused_and_the_request_path_confirms_the_current_revision
    c = live_client
    @edge.push(FakeEdge.bundle(5))
    assert wait_for { c.revision == 5 }
    push_older(FakeEdge.bundle(4), FakeEdge.bundle(5))
    assert wait_for { codes.include?(:rollback) }
    assert wait_for { c.status == "ready" }
    assert_equal 5, c.revision
  end

  def test_an_answer_that_trails_a_push_is_dropped_without_an_error
    c = live_client
    @edge.push(FakeEdge.bundle(5))
    assert wait_for { c.revision == 5 }
    @edge.set_bundle(FakeEdge.bundle(4)) # the request path still answers the previous revision for a moment
    assert c.refresh
    assert_equal [5, "ready", []], [c.revision, c.status, codes]
  end

  def test_a_refused_push_is_reported_and_the_request_path_recovers
    c = live_client
    @edge.push(FakeEdge.bundle(2), tamper: true)
    assert wait_for { codes.include?(:signature) }
    assert wait_for { c.revision == 2 } # the verified request path then fetches what the edge serves
  end

  # ---- address spellings

  def test_address_spellings
    official = ["https://edge.nanoflags.io", "https://edge.nanoflags.io///", "https://EDGE.nanoflags.io:443",
                "https://edge.nanoflags.io:443/", "https://edge.nanoflags.io.", "https://edge.nanoflags.io.:443/"]
    other = ["https://edge.example.com", "https://sub.edge.nanoflags.io", "https://edge.nanoflags.io.example.com",
             "http://edge.nanoflags.io", "https://edge.nanoflags.io:8443", "https://edge.nanoflags.io/v1",
             "https://user@edge.nanoflags.io", "https://edge.nanoflags.io@example.com", "https://edge.nanoflags.io?x=1",
             "https://edge.nanoflags.io#x"]
    official.each { |u| assert_equal NanoFlags::OFFICIAL_EDGE_URL, NanoFlags::Client.normalize_base_url(u), u }
    other.each { |u| assert_equal u.sub(%r{/+\z}, ""), NanoFlags::Client.normalize_base_url(u), u }

    # Signed bundles are required by default for the hosted edge, however its address is spelled.
    unsigned = Class.new do
      define_method(:call) do |_m, _u, _h, _b, _t|
        NanoFlags::HTTP::Response.new(200, { "x-nanoflags-signed" => "false" }, JSON.generate({ "revision" => 1, "checksum" => "c", "bundle" => FakeEdge.bundle(1) }))
      end
    end.new
    c = NanoFlags::Client.new("nf_srv_test", base_url: "https://EDGE.nanoflags.io:443/", http: unsigned, streaming: false, events: false, poll_interval: 3600)
    @clients << c
    c.wait_until_ready(5)
    assert_equal "not-ready", c.status
  end

  # ---- the store holds no key material

  def test_keys_are_not_taken_from_the_store
    other_key = OpenSSL::PKey.generate_key("ED25519")
    jwk = { "kty" => "OKP", "crv" => "Ed25519", "x" => @edge.b64url(other_key.public_to_der[-32..]), "kid" => "t1" }
    @edge.set_bundle(FakeEdge.bundle(7))
    text = @edge.text
    checksum = @edge.checksum
    sig = @edge.sign(text, 7, checksum, other_key)
    store = NanoFlags::Store::Memory.new
    id = format("%08x", NanoFlags::Engine.murmur3("#{FakeEdge::BASE}|nf_srv_test"))
    store.set(JSON.generate({ "v" => 1, "id" => id, "etag" => nil, "checksum" => checksum, "bundle" => text, "raw" => text, "keys" => [jwk], "publicKeys" => [jwk],
                              "sig" => { "signature" => sig, "kid" => "t1", "environmentId" => FakeEdge::ENV_ID, "revision" => 7, "checksum" => checksum } }))
    @edge.status_override = 503 # keys are still published, bundles are not
    c = idle(store: store, verify: true)
    c.wait_until_ready(5)
    assert_nil c.revision
    assert wait_for { codes.include?(:signature) }
  end
end
