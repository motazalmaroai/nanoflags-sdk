# frozen_string_literal: true

require_relative "lib/nanoflags/version"

Gem::Specification.new do |spec|
  spec.name = "nanoflags"
  spec.version = NanoFlags::VERSION
  spec.authors = ["Alibtekarat Althkiya Company for Trading & Marketing (Intinovate)"]
  spec.email = ["support@nanoflags.io"]
  spec.summary = "NanoFlags server SDK for Ruby: local, deterministic feature-flag evaluation with signed live updates."
  spec.description = "Evaluates NanoFlags feature flags locally (the same engine and results as every NanoFlags SDK), " \
                     "keeps the configuration current in background threads (live WebSocket pushes, with the event " \
                     "stream and ETag polling as fallback), verifies bundle signatures, resolves test sessions " \
                     "(Rack middleware), survives forks (Puma, Unicorn, Passenger, Resque) and reports sampled, " \
                     "redacted evaluation telemetry. No runtime dependencies."
  spec.homepage = "https://nanoflags.io"
  spec.license = "Apache-2.0"
  spec.required_ruby_version = ">= 3.1"

  spec.metadata = {
    "homepage_uri" => "https://nanoflags.io",
    "documentation_uri" => "https://nanoflags.io/docs",
    "source_code_uri" => "https://github.com/motazalmaroai/nanoflags-sdk/tree/main/ruby/nanoflags",
    "changelog_uri" => "https://github.com/motazalmaroai/nanoflags-sdk/blob/main/ruby/nanoflags/CHANGELOG.md",
    "bug_tracker_uri" => "https://github.com/motazalmaroai/nanoflags-sdk/issues",
    "rubygems_mfa_required" => "true"
  }

  spec.files = Dir["lib/**/*.rb"] + %w[README.md CHANGELOG.md LICENSE NOTICE]
  spec.require_paths = ["lib"]
end
