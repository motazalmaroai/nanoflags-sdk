# frozen_string_literal: true

require "open_feature/sdk"
require "nanoflags"
require_relative "openfeature/version"

module NanoFlags
  # OpenFeature provider for NanoFlags.
  #
  #   require "nanoflags/openfeature"
  #   OpenFeature::SDK.configure do |config|
  #     config.set_provider_and_wait(NanoFlags::OpenFeature::Provider.new(NanoFlags::Client.new(ENV.fetch("NANOFLAGS_SDK_KEY"))))
  #   end
  #   OpenFeature::SDK.build_client.fetch_boolean_value(flag_key: "new-checkout", default_value: false,
  #     evaluation_context: OpenFeature::SDK::EvaluationContext.new(targeting_key: user.id, plan: user.plan))
  #
  # Evaluations are local (the native engine), mapped like `@nanoflags/openfeature-provider`: the targeting key
  # becomes the bucketing identity `key`; `off` → DISABLED, `default` → DEFAULT, a fixed rule → TARGETING_MATCH, a
  # rollout rule → SPLIT (variant = rule id). Flag metadata carries the revision. Client status changes become
  # provider events (with openfeature-sdk versions that support provider events).
  module OpenFeature
    SDK = ::OpenFeature::SDK
    ErrorCode = SDK::Provider::ErrorCode
    Reason = SDK::Provider::Reason
    ResolutionDetails = SDK::Provider::ResolutionDetails

    # OpenFeature context → NanoFlags context. The targeting key becomes `key` and wins over an attribute `key`.
    def self.to_nanoflags_context(context)
      return {} if context.nil?

      out = {}
      context.fields.each do |name, value|
        next if name.to_s == SDK::EvaluationContext::TARGETING_KEY

        out[name.to_s] = value
      end
      tk = context.targeting_key
      out["key"] = tk.to_s unless tk.nil? || tk.to_s.empty?
      out
    end

    class Provider
      include SDK::Provider::EventEmitter if defined?(SDK::Provider::EventEmitter)

      NAME = "NanoFlags"

      attr_reader :metadata, :client

      # @param client [NanoFlags::Client] the NanoFlags client (one per process)
      # @param ready_timeout [Numeric] seconds +init+ waits for the first configuration
      # @param close_client [Boolean] close the client on +shutdown+ (default false: the client is yours)
      # @param evaluator [#call, nil] returns the object to evaluate with per call (default: the client)
      def initialize(client, ready_timeout: 10, close_client: false, evaluator: nil)
        @client = client
        @ready_timeout = ready_timeout
        @close_client = close_client
        @evaluator = evaluator
        @metadata = SDK::Provider::ProviderMetadata.new(name: NAME).freeze
        @offs = []
      end

      def init(_evaluation_context = nil)
        @offs << @client.on(:change) { |e| emit(SDK::ProviderEvent::PROVIDER_CONFIGURATION_CHANGED, message: "Revision #{e.revision} is now in use.", flags_changed: nil) }
        @offs << @client.on(:status) do |s|
          if s == Client::STATUS_READY
            emit(SDK::ProviderEvent::PROVIDER_READY)
          elsif s == Client::STATUS_STALE
            emit(SDK::ProviderEvent::PROVIDER_STALE, message: "The configuration in use is not known to be current.")
          end
        end
        @offs << @client.on(:error) do |e|
          emit(SDK::ProviderEvent::PROVIDER_ERROR, error_code: ErrorCode::GENERAL, message: e.message) unless @client.initialized?
        end
        raise "NanoFlags has no configuration loaded yet." unless @client.wait_until_ready(@ready_timeout)
      end

      def shutdown
        @offs.each(&:call)
        @offs = []
        @client.close if @close_client
      end

      def fetch_boolean_value(flag_key:, default_value:, evaluation_context: nil) = resolve(flag_key, default_value, evaluation_context, :boolean)
      def fetch_string_value(flag_key:, default_value:, evaluation_context: nil) = resolve(flag_key, default_value, evaluation_context, :string)
      def fetch_number_value(flag_key:, default_value:, evaluation_context: nil) = resolve(flag_key, default_value, evaluation_context, :number)
      def fetch_integer_value(flag_key:, default_value:, evaluation_context: nil) = resolve(flag_key, default_value, evaluation_context, :integer)
      def fetch_float_value(flag_key:, default_value:, evaluation_context: nil) = resolve(flag_key, default_value, evaluation_context, :float)
      def fetch_object_value(flag_key:, default_value:, evaluation_context: nil) = resolve(flag_key, default_value, evaluation_context, :object)

      private

      def emit(event, details = {})
        emit_event(event, details) if respond_to?(:emit_event)
      rescue StandardError
        nil
      end

      def resolve(flag_key, default_value, context, kind)
        target = @evaluator ? @evaluator.call : @client
        begin
          e = target.evaluate(flag_key, nil, OpenFeature.to_nanoflags_context(context))
        rescue StandardError => err
          return failure(default_value, ErrorCode::GENERAL, err.message, nil)
        end
        meta = { "revision" => e.revision }
        if e.reason == "flag_not_found"
          return failure(default_value, ErrorCode::PROVIDER_NOT_READY, "NanoFlags has no configuration loaded yet.", meta) if target.revision.nil?

          return failure(default_value, ErrorCode::FLAG_NOT_FOUND, "Flag \"#{flag_key}\" is not in the loaded configuration (r#{e.revision}).", meta)
        end
        return failure(default_value, ErrorCode::GENERAL, e.error || "Evaluation failed.", meta) if e.reason == "error"

        value = e.value
        ok = case kind
             when :boolean then value == true || value == false
             when :string then value.is_a?(String)
             when :number then value.is_a?(Numeric)
             when :integer then value.is_a?(Integer)
             when :float then value.is_a?(Numeric)
             else value.is_a?(Hash) || value.is_a?(Array)
             end
        return failure(default_value, ErrorCode::TYPE_MISMATCH, "Flag \"#{flag_key}\" has a #{e.type_name} value; a #{kind} was requested.", meta) unless ok

        value = value.to_f if kind == :float
        reason = case e.reason
                 when "off" then Reason::DISABLED
                 when "default" then Reason::DEFAULT
                 else e.in_rollout.nil? ? Reason::TARGETING_MATCH : Reason::SPLIT
                 end
        details(value: value, reason: reason, variant: e.rule_id, flag_metadata: meta)
      end

      def failure(default_value, code, message, meta)
        details(value: default_value, reason: Reason::ERROR, error_code: code, error_message: message, flag_metadata: meta)
      end

      # openfeature-sdk < 0.5 has no flag_metadata member.
      def details(**fields)
        ResolutionDetails.new(**fields.slice(*ResolutionDetails.members))
      end
    end
  end
end
