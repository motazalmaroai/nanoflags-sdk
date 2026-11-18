# frozen_string_literal: true

$LOAD_PATH.unshift File.expand_path("../lib", __dir__)
$LOAD_PATH.unshift File.expand_path("../../nanoflags/lib", __dir__)
require "nanoflags/openfeature"
require "minitest/autorun"
require "json"

class TestProvider < Minitest::Test
  OF = OpenFeature::SDK

  BUNDLE = {
    "schema" => 1, "engine" => 1, "project" => "p", "environment" => "t", "revision" => 3, "segments" => {},
    "flags" => {
      "new-checkout" => { "type" => "boolean", "enabled" => true, "default" => false, "off" => false, "rules" => [
        { "id" => "beta", "match" => "all", "conditions" => [{ "attribute" => "plan", "op" => "eq", "value" => "beta" }], "serve" => { "type" => "fixed", "value" => true } },
        { "id" => "half", "match" => "all", "conditions" => [], "serve" => { "type" => "rollout", "percentage" => 50, "value" => true, "otherwise" => false } }
      ] },
      "accent" => { "type" => "string", "enabled" => true, "default" => "blue", "off" => "grey", "rules" => [] },
      "limit" => { "type" => "number", "enabled" => true, "default" => 10, "off" => 0, "rules" => [] },
      "ratio" => { "type" => "number", "enabled" => true, "default" => 0.5, "off" => 0, "rules" => [] },
      "layout" => { "type" => "json", "enabled" => true, "default" => { "cols" => 3 }, "off" => nil, "rules" => [] },
      "disabled" => { "type" => "string", "enabled" => false, "default" => "on", "off" => "off", "rules" => [] }
    }
  }.freeze

  # A transport that serves BUNDLE (unsigned; verification is off for this self-hosted edge).
  class Edge
    attr_accessor :down, :revision

    def initialize
      @revision = 3
    end

    def call(_method, _url, _headers, _body, _timeout)
      raise Errno::ECONNREFUSED if down

      b = BUNDLE.merge("revision" => revision)
      NanoFlags::HTTP::Response.new(200, { "etag" => %("x#{revision}") }, %({"revision":#{revision},"checksum":"x#{revision}","bundle":#{JSON.generate(b)}}))
    end

    def stream(*, **) = 200
  end

  def nanoflags(edge = Edge.new)
    NanoFlags::Client.new("nf_srv_test", base_url: "https://flags.test", http: edge, verify: false, events: false, streaming: false)
  end

  def test_context_mapping
    ctx = OF::EvaluationContext.new(targeting_key: "user-1", key: "ignored", plan: "beta", n: 3, tags: %w[a b])
    assert_equal({ "key" => "user-1", "plan" => "beta", "n" => 3, "tags" => %w[a b] }, NanoFlags::OpenFeature.to_nanoflags_context(ctx))
    assert_equal({}, NanoFlags::OpenFeature.to_nanoflags_context(nil))
  end

  def test_resolution_through_the_openfeature_client
    edge = Edge.new
    provider = NanoFlags::OpenFeature::Provider.new(nanoflags(edge), close_client: true)
    changed = Queue.new
    handler = ->(e) { changed << e }
    OF.add_handler(OF::ProviderEvent::PROVIDER_CONFIGURATION_CHANGED, handler) if OF.respond_to?(:add_handler)
    OF.configure { |c| c.set_provider_and_wait(provider) }
    of = OF.build_client
    assert_equal "NanoFlags", provider.metadata.name

    d = of.fetch_boolean_details(flag_key: "new-checkout", default_value: false, evaluation_context: OF::EvaluationContext.new(targeting_key: "u1", plan: "beta"))
    assert_equal [true, "TARGETING_MATCH", "beta"], [d.value, d.reason, d.variant]
    d = of.fetch_boolean_details(flag_key: "new-checkout", default_value: false, evaluation_context: OF::EvaluationContext.new(targeting_key: "u1"))
    assert_equal %w[SPLIT half], [d.reason, d.variant]
    assert_equal "DEFAULT", of.fetch_string_details(flag_key: "accent", default_value: "x").reason
    assert_equal "DISABLED", of.fetch_string_details(flag_key: "disabled", default_value: "x").reason
    assert_equal 10, of.fetch_integer_value(flag_key: "limit", default_value: 0)
    assert_equal 10.0, of.fetch_float_value(flag_key: "limit", default_value: 0.0)
    assert_equal 0.5, of.fetch_float_value(flag_key: "ratio", default_value: 0.0)
    assert_equal({ "cols" => 3 }, of.fetch_object_value(flag_key: "layout", default_value: {}))

    d = of.fetch_integer_details(flag_key: "ratio", default_value: 1)
    assert_equal [1, "TYPE_MISMATCH"], [d.value, d.error_code]
    d = of.fetch_boolean_details(flag_key: "accent", default_value: true)
    assert_equal [true, "TYPE_MISMATCH"], [d.value, d.error_code]
    d = of.fetch_string_details(flag_key: "missing", default_value: "fb")
    assert_equal %w[fb FLAG_NOT_FOUND], [d.value, d.error_code]
    assert_equal({ "revision" => 3 }, d.flag_metadata) if d.respond_to?(:flag_metadata)

    if OF.respond_to?(:add_handler)
      edge.revision = 4
      provider.client.refresh
      deadline = Time.now + 5
      messages = []
      until messages.any? { |m| m.include?("Revision 4") } || Time.now > deadline
        changed.empty? ? sleep(0.01) : messages << changed.pop[:message].to_s
      end
      assert(messages.any? { |m| m.include?("Revision 4") }, messages.inspect)
    end
  ensure
    OF.configure { |c| c.set_provider(OF::Provider::NoOpProvider.new) } rescue nil # rubocop:disable Style/RescueModifier
  end

  # Serves a test session on /v1/session as well.
  class SessionEdge < Edge
    def call(method, url, headers, body, timeout)
      return super unless URI(url).path == "/v1/session"
      return NanoFlags::HTTP::Response.new(404, {}, "{}") unless headers["X-NanoFlags-Session"] == "nf_ts_of"

      pinned = BUNDLE.merge("revision" => 8, "flags" => BUNDLE["flags"].merge("accent" => BUNDLE["flags"]["accent"].merge("default" => "session")))
      NanoFlags::HTTP::Response.new(200, {}, JSON.generate({ "id" => "s1", "context" => { "plan" => "beta" }, "expires_at" => "2999-01-01T00:00:00Z", "bundle" => pinned }))
    end
  end

  def test_test_sessions_through_the_evaluator_option
    client = nanoflags(SessionEdge.new)
    provider = NanoFlags::OpenFeature::Provider.new(client, close_client: true, evaluator: -> { NanoFlags.flags_for(client) })
    provider.init
    assert_equal "blue", provider.fetch_string_value(flag_key: "accent", default_value: "x").value
    NanoFlags.with_session("nf_ts_of") do
      assert_equal "session", provider.fetch_string_value(flag_key: "accent", default_value: "x").value
      d = provider.fetch_boolean_value(flag_key: "new-checkout", default_value: false, evaluation_context: OF::EvaluationContext.new(targeting_key: "u1"))
      assert_equal [true, "TARGETING_MATCH"], [d.value, d.reason] # the session context (plan: beta) applies
    end
    provider.shutdown
  end

  def test_provider_not_ready
    edge = Edge.new
    edge.down = true
    provider = NanoFlags::OpenFeature::Provider.new(nanoflags(edge), ready_timeout: 2, close_client: true)
    assert_raises(RuntimeError) { provider.init }
    d = provider.fetch_string_value(flag_key: "accent", default_value: "fb")
    assert_equal ["fb", "PROVIDER_NOT_READY"], [d.value, d.error_code]
    provider.shutdown
  end
end
