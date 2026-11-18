# frozen_string_literal: true

require_relative "test_helper"
require_relative "fake_edge"

# Test sessions (x-nanoflags-session): client.session, request-scoped propagation and the Rack middleware.
class TestSessions < Minitest::Test
  SID = "8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11"

  def setup
    @edge = FakeEdge.new
    @errors = Queue.new
    @clients = []
    pinned = FakeEdge.bundle(9, {
                               "accent" => { "type" => "string", "enabled" => true, "default" => "session", "off" => "x", "rules" => [
                                 { "id" => "r", "match" => "all", "conditions" => [{ "attribute" => "plan", "op" => "eq", "value" => "pro" }], "serve" => { "type" => "fixed", "value" => "session-pro" } }
                               ] }
                             })
    @edge.sessions["nf_ts_abc"] = { "id" => SID, "checksum" => "c", "source" => "draft", "revision" => 9, "context" => { "plan" => "pro" },
                                    "expires_at" => "2999-01-01T00:00:00Z", "bundle" => pinned }
  end

  def teardown
    @clients.each(&:close)
  end

  def client(**opts)
    c = NanoFlags::Client.new("nf_srv_test", base_url: FakeEdge::BASE, service: "ruby-tests", http: @edge, streaming: false,
                                             verify: { public_keys: [@edge.jwk], require: true }, events: false,
                                             on_error: ->(e) { @errors << e }, **opts)
    @clients << c
    c.wait_until_ready(5)
    c
  end

  def codes
    out = []
    out << @errors.pop until @errors.empty?
    out.map(&:code)
  end

  def session_requests = @edge.requests.select { |r| r[:path] == "/v1/session" }

  def test_session_override_context_merge_and_cache
    c = client
    s = c.session("nf_ts_abc")
    assert s.active?
    assert_equal [SID, "2999-01-01T00:00:00.000Z", 9], [s.id, s.expires_at, s.revision]
    assert_equal "session-pro", s.string_variation("accent", "x")
    assert_equal "session", s.string_variation("accent", "x", { "plan" => "free" }) # the request's context wins
    assert_equal "rule_match", s.string_variation_detail("accent", "x").reason
    assert_equal "fb", s.string_variation("new-checkout", "fb") # flags outside the snapshot: application default
    assert_equal "blue", c.string_variation("accent", "x") # the client itself is unaffected
    assert_equal 1, c.revision

    req = session_requests.first
    assert_equal ["nf_ts_abc", "ruby-tests", "Bearer nf_srv_test"], req[:headers].values_at("X-NanoFlags-Session", "X-NanoFlags-Service", "Authorization")
    assert c.session("nf_ts_abc").active?
    assert_equal 1, session_requests.size # cached until the session expires
    c.session("nf_ts_abc", service: "billing")
    assert_equal "billing", session_requests.last[:headers]["X-NanoFlags-Service"] # cached per token and service
    assert_empty codes
  end

  def test_unknown_missing_and_malformed_tokens
    c = client
    none = c.session("nf_ts_unknown")
    refute none.active?
    assert_nil none.id
    assert_nil none.expires_at
    assert_equal 1, none.revision
    assert_equal "blue", none.string_variation("accent", "x") # behaves exactly like the client
    c.session("nf_ts_unknown")
    assert_equal 1, session_requests.size # an unknown token is remembered (15 s)
    refute c.session(nil).active?
    refute c.session("").active?
    refute c.session("has space").active?
    refute c.session("x" * 513).active?
    assert_equal 1, session_requests.size
    assert_empty codes # "no such session" is not an error
  end

  def test_expired_sessions_and_failures
    @edge.sessions["nf_ts_old"] = @edge.sessions["nf_ts_abc"].merge("expires_at" => "2001-01-01T00:00:00Z")
    @edge.sessions["nf_ts_err"] = 500
    @edge.sessions["nf_ts_401"] = 401
    @edge.sessions["nf_ts_bad"] = { "id" => 1 }
    c = client
    refute c.session("nf_ts_old").active?
    assert_empty codes
    refute c.session("nf_ts_err").active?
    refute c.session("nf_ts_bad").active?
    refute c.session("nf_ts_401").active?
    errs = []
    errs << @errors.pop until @errors.empty?
    assert_equal %i[session session unauthorized], errs.map(&:code)
    assert_equal ["Session request failed with HTTP 500.", "The edge returned an invalid session."], errs.first(2).map(&:message)
    assert_equal 401, errs.last.http_status
    @edge.down = true
    refute c.session("nf_ts_new").active?
    assert_equal [:session], codes
    assert_match(/Could not load the test session/, c.last_error.message)
  end

  def test_session_expiring_mid_flight_falls_back_to_the_published_configuration
    @edge.sessions["nf_ts_short"] = @edge.sessions["nf_ts_abc"].merge("expires_at" => (Time.now.utc + 0.3).iso8601(3))
    c = client
    s = c.session("nf_ts_short")
    assert s.active?
    assert_equal "session-pro", s.string_variation("accent", "x")
    sleep 0.4
    refute s.active?
    assert_equal ["blue", 1], [s.string_variation("accent", "x"), s.revision]
  end

  def test_sampled_events_carry_the_session_id
    c = client(events: { sample_rate: 1.0, flush_interval: 3600 })
    c.session("nf_ts_abc").string_variation("accent", "x")
    c.string_variation("accent", "x")
    c.flush
    events = @edge.events.last["events"]
    assert_equal [SID, nil], events.map { |e| e["sessionId"] }
    assert_equal({ "plan" => "string" }, events.first["context"]) # default redaction over the merged context
    assert_equal 9, events.first["revision"]
    assert_equal %w[flagKey value reason ruleIndex revision context at sessionId sampleRate], events.first.keys
  end

  def test_offline_or_closed_clients_resolve_nothing
    c = client
    c.close
    refute c.session("nf_ts_abc").active?
    assert_empty session_requests
  end

  # ---- propagation

  def test_with_session_flags_for_and_headers
    c = client
    assert_equal({}, NanoFlags.session_headers)
    assert_nil NanoFlags.current_session
    refute NanoFlags.flags_for(c).active?
    NanoFlags.with_session(" nf_ts_abc ") do
      assert_equal "nf_ts_abc", NanoFlags.current_session
      assert_equal({ "x-nanoflags-session" => "nf_ts_abc" }, NanoFlags.session_headers)
      f = NanoFlags.flags_for(c)
      assert f.active?
      assert_same f, NanoFlags.flags_for(c) # resolved once per request and client
      assert_equal "session-pro", f.string_variation("accent", "x")
      NanoFlags.with_session(nil) { assert_nil NanoFlags.current_session }
      assert_equal "nf_ts_abc", NanoFlags.current_session
      if Fiber.respond_to?(:[]=)
        assert_equal "nf_ts_abc", Thread.new { NanoFlags.current_session }.value # inherited (Ruby >= 3.2)
      end
    end
    assert_nil NanoFlags.current_session
    assert_nil Thread.new { NanoFlags.with_session("nf_ts_abc") { sleep 0.01 } && NanoFlags.current_session }.value
    assert_raises(RuntimeError) { NanoFlags.with_session("nf_ts_abc") { raise "boom" } }
    assert_nil NanoFlags.current_session # restored after an exception
  end

  def test_concurrent_requests_resolve_a_token_once
    c = client
    threads = Array.new(8) { Thread.new { c.session("nf_ts_abc").active? } }
    assert(threads.map(&:value).all?)
    assert_equal 1, session_requests.size
  end

  def test_rack_middleware
    c = client
    seen = []
    app = lambda do |env|
      f = env["nanoflags.flags"]
      seen << [f.active?, f.string_variation("accent", "x"), NanoFlags.session_headers, NanoFlags.flags_for(c).equal?(f)]
      [200, {}, ["ok"]]
    end
    mw = NanoFlags::SessionMiddleware.new(app, c)
    assert_equal 200, mw.call({ "HTTP_X_NANOFLAGS_SESSION" => "nf_ts_abc" }).first
    mw.call({})
    mw.call({ "HTTP_X_NANOFLAGS_SESSION" => "nf_ts_unknown" })
    assert_equal [true, "session-pro", { "x-nanoflags-session" => "nf_ts_abc" }, true], seen[0]
    assert_equal [false, "blue", {}], seen[1].first(3)
    assert_equal [false, "blue", { "x-nanoflags-session" => "nf_ts_unknown" }], seen[2].first(3) # still propagated
    assert_nil NanoFlags.current_session

    NanoFlags::SessionMiddleware.new(->(_env) { [204, {}, []] }, c, service: "web").call({ "HTTP_X_NANOFLAGS_SESSION" => "nf_ts_x" })
    assert_equal "web", session_requests.last[:headers]["X-NanoFlags-Service"]
  end
end
