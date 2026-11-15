# frozen_string_literal: true

require_relative "test_helper"

# Opt-in check against the hosted edge (read-only): NANOFLAGS_LIVE=1 rake test
# Uses NANOFLAGS_SDK_KEY, or the PUBLIC demo browser key (client view of the public demo environment; not a secret).
class TestLive < Minitest::Test
  def test_hosted_edge_serves_a_verified_bundle_and_streams
    skip "set NANOFLAGS_LIVE=1" unless ENV["NANOFLAGS_LIVE"] == "1"
    key = ENV.fetch("NANOFLAGS_SDK_KEY", "nf_pub_4ced72c484c4f388a900aeeaf81e130c110c11730d555dd8")
    c = NanoFlags::Client.new(key, service: "ruby-sdk-ci", events: false)
    assert c.wait_until_ready(15), c.last_error&.message
    assert_equal "ready", c.status
    assert_nil c.last_error
    assert_operator c.revision, :>, 0
    assert_kind_of Hash, c.all_flags({ key: "ci" })
    assert wait_for(15) { c.transport == :stream }
  ensure
    c&.close
  end
end
