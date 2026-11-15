# frozen_string_literal: true

require_relative "test_helper"
require_relative "fake_edge"
require "tmpdir"

class TestClient < Minitest::Test
  def setup
    @edge = FakeEdge.new
    @errors = Queue.new
    @clients = []
  end

  def teardown
    @clients&.each(&:close)
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
    out = []
    out << @errors.pop until @errors.empty?
    out.map(&:code)
  end

  def test_typed_getters_and_details
    c = client
    assert c.wait_until_ready(5)
    assert_equal "ready", c.status
    assert_equal 1, c.revision
    assert_equal true, c.bool_variation("new-checkout", false, { key: "u1", plan: "beta" })
    assert_equal "blue", c.string_variation("accent", "x")
    assert_equal 10, c.number_variation("limit", 0)
    assert_equal 0.5, c.number_variation("ratio", 0)
    assert_equal({ "cols" => 3 }, c.json_variation("layout", {}))
    assert_equal "off", c.string_variation("disabled", "x")
    assert_equal "eu", c.string_variation("region", "x", { "email" => "a@b.eu" })

    d = c.bool_variation_detail("new-checkout", false, { key: "u1", plan: "beta" })
    assert_equal ["rule_match", 0, "beta"], [d.reason, d.rule_index, d.rule_id]
    assert_equal "Rule 01 matched", d.trace[1].title

    d = c.bool_variation_detail("new-checkout", false, { key: "user-42" })
    assert_equal "half", d.rule_id
    assert_equal d.bucket < 50, d.value
    assert_equal d.in_rollout, d.value

    d = c.bool_variation_detail("accent", true)
    assert_equal [true, "error"], [d.value, d.reason]
    assert_equal 'Flag "accent" has a string value, which does not match the requested type.', d.error
    assert_equal "Returned the fallback", d.trace.last.title
    assert_equal 7, c.number_variation("accent", 7)

    d = c.string_variation_detail("missing", "fb")
    assert_equal %w[fb flag_not_found], [d.value, d.reason]

    expected = { "new-checkout" => true, "accent" => "blue", "limit" => 10, "ratio" => 0.5, "layout" => { "cols" => 3 }, "disabled" => "off", "region" => "world" }
    assert_equal expected, c.all_flags({ key: "u1", plan: "beta" })
    assert_empty codes
    first = @edge.requests.find { |r| r[:path] == "/v1/bundle" }
    assert_equal "Bearer nf_srv_test", first[:headers]["Authorization"]
    assert_match %r{\Ananoflags-ruby/}, first[:headers]["User-Agent"]
  end

  def test_live_updates_over_the_event_stream
    changes = Queue.new
    c = client(poll_interval: 0, on_change: ->(e) { changes << e })
    assert c.wait_until_ready(5)
    first = changes.pop
    assert_equal [1, nil, :network, :poll], [first.revision, first.previous_revision, first.source, first.transport]
    assert wait_for { c.transport == :stream }
    flags = FakeEdge.bundle(2)["flags"]
    flags["accent"]["default"] = "green"
    @edge.publish(FakeEdge.bundle(2, flags))
    assert wait_for { c.string_variation("accent", "x") == "green" }
    second = changes.pop
    assert_equal [2, 1, :stream], [second.revision, second.previous_revision, second.transport]
    assert_equal "ready", c.status
    # Revalidation sends the ETag; an unchanged revision is a 304.
    assert c.refresh
    assert_equal %("#{@edge.checksum}-server"), @edge.requests.reverse.find { |r| r[:path] == "/v1/bundle" }[:headers]["If-None-Match"]
    assert_empty codes
  end

  def test_revoked_stream_triggers_a_check_and_stops
    c = client(poll_interval: 0)
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :stream }
    @edge.status_override = 401
    @edge.revoke!
    assert wait_for { c.transport == :poll }
    assert wait_for { codes.include?(:unauthorized) }
    assert_equal "stale", c.status
    assert_equal "blue", c.string_variation("accent", "x") # the last good bundle keeps serving
  end

  def test_edge_down_keeps_the_last_good_bundle
    c = client(streaming: false)
    assert c.wait_until_ready(5)
    @edge.down = true
    assert c.refresh
    assert_equal "stale", c.status
    assert_equal "blue", c.string_variation("accent", "x")
    assert_equal [:network], codes
    assert_equal :network, c.last_error.code
    @edge.down = false
    c.refresh
    assert_equal "ready", c.status
  end

  def test_nothing_loaded_returns_defaults
    @edge.down = true
    c = client(streaming: false)
    refute c.wait_until_ready(5)
    assert_equal "not-ready", c.status
    assert_nil c.revision
    assert_equal false, c.bool_variation("new-checkout", false)
    assert_equal({}, c.all_flags)
    d = c.evaluate("accent", "fb")
    assert_equal "flag_not_found", d.reason
    assert_equal "No configuration is loaded. The application fallback applies.", d.trace[0].detail
  end

  def test_tampered_unsigned_and_foreign_bundles_are_rejected
    @edge.tamper = true
    c = client(streaming: false)
    refute c.wait_until_ready(5)
    e = @errors.pop
    assert_equal :signature, e.code
    assert_includes e.message, "its signature does not verify"

    @edge.tamper = false
    @edge.signed = false
    c.refresh
    assert_includes @errors.pop.message, "unsigned bundles are refused"

    @edge.signed = true
    c.refresh
    assert_equal 1, c.revision
    @edge.env_id = "ffffffff-2222-3333-4444-555555555555"
    @edge.set_bundle(FakeEdge.bundle(2))
    c.refresh
    assert_equal 1, c.revision
    assert_includes @errors.pop.message, "signed for a different environment"
  end

  def test_unsigned_bundles_without_require_and_without_verification
    @edge.signed = false
    c = client(streaming: false, verify: { public_keys: [@edge.jwk], require: false })
    assert c.wait_until_ready(5)
    c2 = client(streaming: false, verify: false)
    assert c2.wait_until_ready(5)
    assert_empty codes
  end

  def test_keys_are_fetched_when_not_pinned
    c = client(streaming: false, verify: true)
    assert c.wait_until_ready(5)
    assert_equal 1, @edge.count("/v1/keys")
    refute @edge.requests.find { |r| r[:path] == "/v1/keys" }[:headers].key?("Authorization")
  end

  def test_served_stale_never_goes_backwards
    @edge.set_bundle(FakeEdge.bundle(3))
    c = client(streaming: false)
    assert c.wait_until_ready(5)
    @edge.set_bundle(FakeEdge.bundle(2))
    @edge.stale = true
    c.refresh
    assert_equal [3, "stale"], [c.revision, c.status]
  end

  def test_newer_engine_is_refused
    @edge.set_bundle(FakeEdge.bundle(1, nil, engine: 2))
    c = client(streaming: false)
    refute c.wait_until_ready(5)
    e = @errors.pop
    assert_equal :engine, e.code
    assert_includes e.message, "needs evaluation engine 2"
  end

  def test_persisted_bundle_is_restored_and_verified_again
    Dir.mktmpdir do |dir|
      path = File.join(dir, "flags.json")
      c = client(streaming: false, cache_path: path)
      assert c.wait_until_ready(5)
      assert wait_for { File.exist?(path) }
      assert_equal 0o600, File.stat(path).mode & 0o777
      c.close

      @edge.down = true
      restored = Queue.new
      c2 = client(streaming: false, cache_path: path, on_change: ->(e) { restored << e })
      assert c2.wait_until_ready(5)
      assert_equal [1, "stale"], [c2.revision, c2.status]
      assert_equal :store, restored.pop.source
      assert_equal "blue", c2.string_variation("accent", "x")

      doc = JSON.parse(File.read(path))
      doc["raw"] = doc["raw"].sub('"blue"', '"red"')
      File.write(path, JSON.generate(doc))
      c3 = client(streaming: false, cache_path: path)
      refute c3.wait_until_ready(5)
      assert_includes codes, :signature
    end
  end

  def test_bootstrap
    c = client(streaming: false, bootstrap: JSON.generate(FakeEdge.bundle(5)), start: false)
    assert_equal [5, "ready"], [c.revision, c.status]
    assert_equal "blue", c.string_variation("accent", "x")
    assert_empty @edge.requests
    c2 = client(bootstrap: { "nope" => 1 }, start: false)
    c2.start
    assert_includes codes, :invalid_bundle
  end

  def test_events_use_default_redaction
    c = client(streaming: false, events: { sample_rate: 1.0, flush_interval: 0 }, random: -> { 0.0 })
    assert c.wait_until_ready(5)
    c.bool_variation("new-checkout", false, { key: "u1", plan: "beta", email: "secret@example.com" })
    c.string_variation("region", "x", { "country" => "DE", "email" => "secret@example.com", "n" => 3 })
    c.flush
    p = @edge.events.last
    assert_equal ["ruby-tests", "ruby/#{NanoFlags::VERSION}", 1], [p["service"], p["sdk"], p["revision"]]
    assert_equal 2, p["events"].length
    e = p["events"][0]
    assert_equal({ "flagKey" => "new-checkout", "value" => true, "reason" => "rule_match", "ruleIndex" => 0, "revision" => 1 },
                 e.slice("flagKey", "value", "reason", "ruleIndex", "revision"))
    # No attribute values leave the process: only the names the rules use, with the value's type.
    assert_equal({ "plan" => "string", "key" => "string" }, e["context"])
    assert_equal({ "country" => "string", "email" => "string" }, p["events"][1]["context"])
    refute_includes JSON.generate(@edge.events), "secret@example.com"
    assert_equal 1, e["sampleRate"]
    assert_match(/\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\z/, e["at"])
  end

  def test_custom_redact_value_limits_and_sampling
    flags = FakeEdge.bundle(1)["flags"]
    flags["long"] = { "type" => "string", "enabled" => true, "default" => "€" * 2000, "off" => "", "rules" => [] }
    flags["big"] = { "type" => "json", "enabled" => true, "default" => { "x" => "a" * 2000 }, "off" => nil, "rules" => [] }
    @edge.set_bundle(FakeEdge.bundle(1, flags))
    c = client(streaming: false, events: { sample_rate: 1.0, flush_interval: 0, redact: ->(ctx) { { "plan" => ctx[:plan] } } }, random: -> { 0.0 })
    assert c.wait_until_ready(5)
    c.string_variation("long", "", { plan: "beta", email: "x@y.z" })
    c.json_variation("big", nil)
    c.flush
    events = @edge.events.last["events"]
    assert_equal({ "plan" => "beta" }, events[0]["context"])
    assert_equal 1024, events[0]["value"].length
    assert_nil events[1]["value"]

    c2 = client(streaming: false, events: { sample_rate: 0.5, flush_interval: 0 }, random: -> { 0.7 })
    assert c2.wait_until_ready(5)
    c2.bool_variation("new-checkout", false)
    c2.flush
    assert_equal [], @edge.events.last["events"] # the service report alone
  end

  def test_production_signature_vector
    skip "signed-demo-response.json not found" unless File.exist?(TestPaths.signed_demo)
    v = JSON.parse(File.read(TestPaths.signed_demo))
    transport = Object.new
    transport.define_singleton_method(:tamper=) { |x| @tamper = x }
    transport.define_singleton_method(:call) do |*_|
      body = v["body"].dup
      if @tamper
        i = body.rindex("e")
        body[i] = "E"
      end
      NanoFlags::HTTP::Response.new(200, v["headers"], body)
    end
    c = NanoFlags::Client.new("nf_pub_demo", http: transport, events: false, streaming: false)
    @clients << c
    assert c.wait_until_ready(5)
    assert_equal [55, "ready", "blue"], [c.revision, c.status, c.string_variation("demo-accent", "x")]
    assert_nil c.last_error

    transport.tamper = true
    c2 = NanoFlags::Client.new("nf_pub_demo", http: transport, events: false, streaming: false)
    @clients << c2
    refute c2.wait_until_ready(5)
    assert_equal :signature, c2.last_error.code
  end

  def test_config_errors
    c = client(sdk_key: "", verify: { public_keys: [{ "kty" => "OKP", "crv" => "Ed25519", "x" => "abc", "d" => "secret" }] })
    c.wait_until_ready(1)
    assert_equal %i[config config], codes.first(2)
    assert_empty @edge.requests
  end

  def test_fork_restarts_background_work_in_the_child
    skip "fork is not available" unless Process.respond_to?(:fork)
    c = client(poll_interval: 0)
    assert c.wait_until_ready(5)
    assert wait_for { c.transport == :stream }
    reader, writer = IO.pipe
    pid = fork do
      reader.close
      # Inherited configuration works at once; the background threads come back on the first call.
      out = [c.string_variation("accent", "x")]
      out << (wait_for { c.transport == :stream } ? "stream" : "no-stream")
      writer.puts(JSON.generate(out))
      writer.close
      exit!(0)
    end
    writer.close
    result = JSON.parse(reader.read)
    Process.wait(pid)
    assert_equal %w[blue stream], result # the child opened its own stream
    assert_equal "blue", c.string_variation("accent", "x")
  end
end
