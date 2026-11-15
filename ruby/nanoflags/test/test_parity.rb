# frozen_string_literal: true

require_relative "test_helper"

# Cross-language parity: the Ruby engine must reproduce every result of the TypeScript engine.
# Fixtures: packages/engine/fixtures/parity.json (shared by every port) and go/internal/testdata/extra.json
# (JavaScript corner cases, with V8's error messages).
class TestParity < Minitest::Test
  E = NanoFlags::Engine
  Js = NanoFlags::Engine::Js

  def self.load(path)
    return nil unless File.exist?(path)

    E::Json.parse(File.binread(path))
  end

  PARITY = load(TestPaths.parity)
  EXTRA = load(TestPaths.extra)

  def parity
    skip "parity fixtures not found at #{TestPaths.parity}" unless PARITY
    PARITY
  end

  def js(v) = Js.stringify(v) || "undefined"

  def canonical_result(r, with_trace, mask)
    s = +%({"reason":#{Js.quote(r.reason)},"revision":#{js(r.revision)})
    s << %(,"value":#{js(r.value)}) unless r.value.equal?(E::UNDEFINED)
    unless r.rule_index.nil?
      s << %(,"ruleIndex":#{r.rule_index})
      s << %(,"ruleId":#{js(r.rule_id)}) unless r.rule_id.equal?(E::UNDEFINED)
    end
    s << %(,"inRollout":#{r.in_rollout}) unless r.in_rollout.nil?
    s << %(,"bucket":#{Js.number_to_string(r.bucket)}) unless r.bucket.nil?
    s << %(,"error":true) if r.reason == "error"
    if with_trace
      steps = r.trace.each_with_index.map do |t, i|
        detail = mask && i == r.trace.length - 1 ? "<error>" : t.detail
        x = +%({"kind":#{Js.quote(t.kind)},"title":#{Js.quote(t.title)},"detail":#{Js.quote(detail)})
        x << %(,"matched":#{t.matched}) unless t.matched.nil?
        x << "}"
      end
      s << %(,"trace":[#{steps.join(",")}])
    end
    s << "}"
  end

  def canonical_expected(e, mask)
    s = +%({"reason":#{js(e["reason"])},"revision":#{js(e["revision"])})
    %w[value ruleIndex ruleId inRollout bucket error].each { |k| s << %(,"#{k}":#{js(e[k])}) if e.key?(k) }
    if e.key?("trace")
      tr = e["trace"]
      steps = tr.each_with_index.map do |t, i|
        detail = mask && i == tr.length - 1 ? "<error>" : t["detail"]
        x = +%({"kind":#{js(t["kind"])},"title":#{js(t["title"])},"detail":#{js(detail)})
        x << %(,"matched":#{js(t["matched"])}) if t.key?("matched")
        x << "}"
      end
      s << %(,"trace":[#{steps.join(",")}])
    end
    s << "}"
  end

  def run_cases(doc, compare_error_messages)
    bundles = doc["bundles"]
    contexts = doc["contexts"]
    failures = []
    failed = 0
    doc["cases"].each_with_index do |c, i|
      bi = c["bundle"].to_i
      bundle = bi >= 0 ? bundles[bi] : nil
      ctx = contexts[c["context"].to_i]
      expected = c["expected"]
      mask = expected.key?("error") && !compare_error_messages
      got = E.evaluate(bundle, c["flag"], ctx.is_a?(Hash) ? ctx : nil, c["fallback"])
      g = canonical_result(got, expected.key?("trace"), mask)
      w = canonical_expected(expected, mask)
      if compare_error_messages && expected.key?("errorMessage") && expected["errorMessage"] != got.error
        g += " err=#{Js.quote(got.error.to_s)}"
        w += " err=#{Js.quote(expected["errorMessage"])}"
      end
      next if g == w

      failed += 1
      failures << "case #{i} #{c["name"]}\n got: #{g}\nwant: #{w}" if failures.length < 20
    end
    [doc["cases"].length, failures, failed]
  end

  def test_fixture_engine_version_matches
    assert_equal E::VERSION.to_f, parity["engineVersion"]
    assert_equal parity["counts"]["cases"], parity["cases"].length.to_f
  end

  def test_evaluation_cases
    n, failures, failed = run_cases(parity, false)
    assert_operator n, :>, 20_000
    assert_equal 0, failed, failures.join("\n")
  end

  def test_extra_cases_with_error_messages
    skip "extra fixtures not found at #{TestPaths.extra}" unless EXTRA
    n, failures, failed = run_cases(EXTRA, true)
    assert_operator n, :>, 3000
    assert_equal 0, failed, failures.join("\n")
  end

  def test_murmur3_vectors
    v = parity["murmur3"]
    assert_operator v.length, :>, 300
    v.each { |c| assert_equal c["hash"].to_i, E.murmur3(c["input"], c["seed"].to_i), Js.quote(c["input"]) }
  end

  def test_bucket_vectors
    parity["buckets"].each { |c| assert_equal c["bucket"], E.bucket_of(c["seed"], c["identity"]) }
  end

  def test_supports_engine
    parity["supportsEngine"].each do |c|
      assert_equal c["expected"], E.supports_engine?(c["bundle"].fetch("engine", E::UNDEFINED)), Js.stringify(c["bundle"])
    end
  end

  def test_client_bundle
    parity["clientBundle"].each { |c| assert_equal Js.stringify(c["expected"]), Js.stringify(E.client_bundle(c["bundle"])) }
  end
end
