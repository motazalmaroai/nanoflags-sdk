# frozen_string_literal: true

$LOAD_PATH.unshift File.expand_path("../lib", __dir__)
require "nanoflags"
require "minitest/autorun"

module TestPaths
  ROOT = File.expand_path("../../..", __dir__)

  def self.parity = ENV.fetch("NANOFLAGS_PARITY_FIXTURES", File.join(ROOT, "packages/engine/fixtures/parity.json"))
  def self.extra = ENV.fetch("NANOFLAGS_EXTRA_FIXTURES", File.join(ROOT, "go/internal/testdata/extra.json"))
  def self.signed_demo = File.join(ROOT, "go/internal/testdata/signed-demo-response.json")
end

# Waits up to +timeout+ seconds for the block to become truthy.
def wait_for(timeout = 5)
  deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
  until (v = yield)
    return false if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

    sleep 0.01
  end
  v
end
