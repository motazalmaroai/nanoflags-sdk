# frozen_string_literal: true

module NanoFlags
  # An error of the client. It is reported to +on_error+ listeners and {Client#last_error}; a variation call never
  # raises it. A failed update never changes the configuration in use.
  #
  # Codes (+code+): :network, :unauthorized, :http, :invalid_bundle, :store, :config, :signature, :engine.
  class Error < StandardError
    attr_reader :code, :http_status

    def initialize(message, code, http_status = nil)
      super(message)
      @code = code
      @http_status = http_status
    end

    def inspect = "#<NanoFlags::Error #{code}: #{message}>"
  end

  # A new configuration is in use. +source+ is :network, :store or :bootstrap; +transport+ is :stream (fetched after
  # an event-stream notification) or :poll; +previous_revision+ is nil when nothing was loaded before.
  UpdateEvent = Struct.new(:revision, :previous_revision, :checksum, :source, :transport, keyword_init: true)

  # The full result of an evaluation: value, reason, matched rule, rollout bucket and a human-readable trace.
  #
  # +value+ is plain Ruby data (the application default for reasons "flag_not_found" and "error"); +reason+ is one of
  # "rule_match", "default", "off", "flag_not_found", "error"; +revision+ is the evaluated revision (0 without one);
  # +rule_index+ / +rule_id+ identify the matching rule; +in_rollout+ and +bucket+ (0–99.99) are set for percentage
  # rollouts; +error+ explains reason "error"; +trace+ is a list of {Engine::TraceStep}.
  class EvaluationDetail
    attr_reader :flag_key, :value, :reason, :revision, :rule_index, :rule_id, :in_rollout, :bucket, :trace, :error

    def initialize(flag_key:, value:, reason:, revision:, rule_index: nil, rule_id: nil, in_rollout: nil, bucket: nil, trace: [], error: nil, raw: nil)
      @flag_key = flag_key
      @value = value
      @reason = reason
      @revision = revision
      @rule_index = rule_index
      @rule_id = rule_id
      @in_rollout = in_rollout
      @bucket = bucket
      @trace = trace.freeze
      @error = error
      @raw = raw
      freeze
    end

    # @api private
    def self.from_result(r, default)
      js = Engine::Js
      use_default = r.reason == "flag_not_found" || r.reason == "error"
      rev = js.to_number(r.revision)
      rule_id = nil
      if !r.rule_index.nil? && !r.rule_id.equal?(Engine::UNDEFINED)
        rule_id = r.rule_id.is_a?(String) ? r.rule_id : js.stringify(r.rule_id)
      end
      new(
        flag_key: r.flag_key,
        value: use_default ? default : js.to_ruby(r.value),
        reason: r.reason,
        revision: rev.finite? ? rev.to_i : 0,
        rule_index: r.rule_index,
        rule_id: rule_id,
        in_rollout: r.in_rollout,
        bucket: r.bucket,
        trace: r.trace,
        error: r.error,
        raw: use_default ? js.from_ruby(default) : r.value
      )
    end

    # The served value as JSON text (object keys in configuration order), or nil when nothing was served.
    def json = Engine::Js.stringify(@raw)

    # The type of the served value: "boolean", "string", "number", "array", "object", "null" or "undefined".
    def type_name = Engine::Js.type_name(@raw)

    def to_h
      {
        flag_key: flag_key, value: value, reason: reason, revision: revision, rule_index: rule_index, rule_id: rule_id,
        in_rollout: in_rollout, bucket: bucket, trace: trace.map(&:to_h), error: error
      }
    end

    def inspect = "#<NanoFlags::EvaluationDetail #{flag_key}=#{value.inspect} (#{reason}, r#{revision})>"
  end
end
