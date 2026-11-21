# frozen_string_literal: true

require_relative "lib/nanoflags/openfeature/version"

Gem::Specification.new do |spec|
  spec.name = "nanoflags-openfeature"
  spec.version = NanoFlags::OpenFeature::VERSION
  spec.authors = ["Alibtekarat Althkiya Company for Trading & Marketing (Intinovate)"]
  spec.email = ["support@nanoflags.io"]
  spec.summary = "OpenFeature provider for NanoFlags (Ruby)."
  spec.description = "An OpenFeature provider backed by the nanoflags gem: local, deterministic flag evaluation " \
                     "through the OpenFeature Ruby SDK, with configuration-change and staleness events."
  spec.homepage = "https://nanoflags.io"
  spec.license = "Apache-2.0"
  spec.required_ruby_version = ">= 3.1"

  spec.metadata = {
    "homepage_uri" => "https://nanoflags.io",
    "documentation_uri" => "https://nanoflags.io/docs",
    "source_code_uri" => "https://github.com/motazalmaroai/nanoflags-sdk/tree/main/ruby/nanoflags-openfeature",
    "changelog_uri" => "https://github.com/motazalmaroai/nanoflags-sdk/blob/main/ruby/nanoflags-openfeature/CHANGELOG.md",
    "bug_tracker_uri" => "https://github.com/motazalmaroai/nanoflags-sdk/issues",
    "rubygems_mfa_required" => "true"
  }

  spec.files = Dir["lib/**/*.rb"] + %w[README.md CHANGELOG.md LICENSE NOTICE]
  spec.require_paths = ["lib"]

  spec.add_dependency "nanoflags", "~> 0.3"
  spec.add_dependency "openfeature-sdk", ">= 0.4", "< 1.0"
end
