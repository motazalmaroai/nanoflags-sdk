# frozen_string_literal: true

require "json"
require "monitor"
require "time"

module NanoFlags
  # The NanoFlags client for Ruby servers (Rails, Puma, Sidekiq, Rack, plain scripts).
  #
  # Flags are evaluated locally and synchronously against an in-memory bundle; a variation call never performs I/O
  # and never raises. The network is used in background threads only: to load the bundle (`/v1/bundle`, with ETag
  # revalidation), to hear about new revisions as soon as they are published (server-sent events, `/v1/stream`,
  # with polling as the safety net), and to send sampled telemetry plus the periodic service report (`/v1/events`).
  #
  # Create one client per process and share it between threads. It is fork-safe: after a fork (Puma and Unicorn
  # workers, Passenger, Resque, Sidekiq Swarm) the child keeps the configuration it inherited and restarts the
  # background threads on its first call (a child that never evaluates a flag never opens a connection). Events
  # queued before the fork are sent by the parent only.
  #
  #   FLAGS = NanoFlags::Client.new(ENV.fetch("NANOFLAGS_SDK_KEY"), service: "checkout-api")
  #   FLAGS.wait_until_ready(5)
  #   FLAGS.bool_variation("new-checkout", false, { key: current_user.id, plan: current_user.plan })
  class Client
    STATUS_NOT_READY = "not-ready"
    STATUS_READY = "ready"
    STATUS_STALE = "stale"

    MAX_QUEUE = 500
    MAX_BATCH = 50
    MAX_EVENT_VALUE_CHARS = 1024
    KEYS_REFETCH = 60.0
    ACCEPT_BOOL = ->(v) { v == true || v == false }
    ACCEPT_STRING = ->(v) { v.is_a?(String) }
    ACCEPT_NUMBER = ->(v) { v.is_a?(Float) && v.finite? }
    ACCEPT_ANY = ->(v) { !v.equal?(Engine::UNDEFINED) }

    REGISTRY = ObjectSpace::WeakMap.new
    REGISTRY_LOCK = Mutex.new
    private_constant :REGISTRY, :REGISTRY_LOCK

    attr_reader :base_url, :service

    # @param sdk_key [String] `nf_srv_…` (server view) or `nf_pub_…` (client-exposed flags only)
    # @param base_url [String] the edge; signatures are verified by default on the hosted edge
    # @param service [String, nil] the name shown in "which revision is each service running"
    # @param poll_interval [Numeric] seconds between polls (0 disables polling)
    # @param streaming [Boolean] hear about new revisions over server-sent events (false: polling only)
    # @param bootstrap [Hash, String, nil] a bundle (Hash or JSON text) to use until the edge answers
    # @param cache_path [String, nil] keep the last good bundle in this file (restored, and verified again, on start)
    # @param store [#get, #set, nil] custom persistence; overrides +cache_path+
    # @param events [Hash, false, nil] telemetry: false disables it; a Hash with :sample_rate (0.1), :flush_interval
    #   (10 s), :report_interval (60 s), :redact (a callable receiving the context Hash)
    # @param verify [Hash, Boolean, nil] signature verification: nil (default) on for the hosted edge; false off;
    #   true on with keys from the edge's /v1/keys; a Hash with :public_keys (JWKs), :require, :fetch_keys
    # @param on_change [#call, nil] called with an {UpdateEvent} whenever a new configuration is adopted
    # @param on_error [#call, nil] called with an {Error} for background failures
    # @param logger [Logger, nil] debug output of the background activity
    # @param start [Boolean] false defers the background work until {#start}
    # @param http [#call, nil] the transport (see {HTTP::NetHttp})
    def initialize(sdk_key, base_url: OFFICIAL_EDGE_URL, service: nil, poll_interval: 30, streaming: true, bootstrap: nil,
                   cache_path: nil, store: nil, events: nil, verify: nil, on_change: nil, on_error: nil, logger: nil,
                   start: true, http: nil, request_timeout: 10, stream_read_timeout: 90, random: nil)
      @sdk_key = sdk_key.to_s
      @base_url = base_url.to_s.sub(%r{/+\z}, "")
      @service = service.to_s.empty? ? "unknown" : service.to_s
      @poll_interval = poll_interval.to_f
      @streaming = streaming
      @request_timeout = request_timeout.to_f
      @stream_read_timeout = stream_read_timeout.to_f
      @http = http || HTTP::NetHttp.new
      @logger = logger
      @random = random || -> { rand }
      @id = format("%08x", Engine.murmur3("#{@base_url}|#{@sdk_key}"))
      @browser_key = @sdk_key.start_with?("nf_pub_")
      @store = store || (cache_path ? Store::File.new(cache_path) : nil)
      @pending_errors = []

      ev = events.is_a?(Hash) ? events.transform_keys(&:to_sym) : {}
      @events_enabled = events != false
      @sample_rate = Float(ev.fetch(:sample_rate, 0.1)).clamp(0.0, 1.0)
      @flush_interval = Float(ev.fetch(:flush_interval, 10.0))
      @report_interval = Float(ev.fetch(:report_interval, 60.0))
      @redact = ev[:redact]

      setup_verifier(verify)
      @fetched_keys = []
      @keys_fetched_at = nil

      @listeners = { change: [], error: [], status: [] }
      @listeners[:change] << on_change if on_change
      @listeners[:error] << on_error if on_error

      @bundle = nil
      @etag = nil
      @checksum = nil
      @sig = nil
      @raw = nil
      @status = STATUS_NOT_READY
      @last_error = nil
      @pinned_env = nil
      @failures = 0
      @closed = false
      @started = false
      @ready = false
      @stream_open = false
      @queue = []
      @last_report = monotonic
      @attrs = {}
      @attrs_for = nil
      init_concurrency

      if @sdk_key.strip.empty?
        @pending_errors << Error.new("An SDK key is required.", :config)
      end
      @pending_errors << Error.new("The base URL must be an http(s) URL, got #{base_url.inspect}.", :config) unless @base_url.match?(%r{\Ahttps?://}i)
      adopt_bootstrap(bootstrap) unless bootstrap.nil?
      REGISTRY_LOCK.synchronize { REGISTRY[self] = true }
      Client.install_exit_hook
      self.start if start
    end

    # ------------------------------------------------------------------ lifecycle

    # Starts the background threads (done by the constructor unless +start: false+).
    def start
      check_fork
      @mutex.synchronize do
        return self if @started || @closed

        @started = true
      end
      pending = @pending_errors
      @pending_errors = []
      pending.each { |e| emit_error(e) }
      if pending.any? { |e| e.code == :config && e.message.start_with?("An SDK key", "The base URL") }
        mark_ready
        return self
      end
      spawn("nanoflags-poll") { main_loop }
      self
    end

    # Stops the background threads after a best-effort final telemetry flush (at most 2 seconds). Evaluations keep
    # working on the last configuration. Idempotent.
    def close
      return if @closed

      flush(timeout: 2) if @started && Process.pid == @pid
      @mutex.synchronize do
        @closed = true
        @cv.broadcast
        @sleep_cv.broadcast
      end
      close_stream
      mark_ready
      @threads.each { |t| t.join(2) unless t == Thread.current }
      nil
    end

    def closed? = @closed

    # Blocks until the first load attempt has finished (or a configuration was adopted); returns whether a
    # configuration is in use. +timeout+ in seconds (nil: no limit).
    def wait_until_ready(timeout = nil)
      check_fork
      deadline = timeout && (monotonic + timeout)
      @mutex.synchronize do
        until @ready
          left = deadline && (deadline - monotonic)
          break if left && left <= 0

          @ready_cv.wait(left)
        end
      end
      !@bundle.nil?
    end

    # "not-ready", "ready" (known to be current) or "stale" (in use, not known to be current).
    def status = @status

    # The revision in use, or nil.
    def revision = @bundle && @bundle["revision"].to_i

    # True when a configuration is in use (ready or stale).
    def initialized? = !@bundle.nil?

    # :stream while the event stream is connected, otherwise :poll.
    def transport = @stream_open ? :stream : :poll

    # The last background error, if any.
    def last_error = @last_error

    # The bundle in use as JSON text (the signed bytes when it was signed), or nil.
    def bundle_json = @raw || (@bundle && Engine::Js.stringify(@bundle))

    # Registers a listener: +:change+ ({UpdateEvent}), +:error+ ({Error}) or +:status+ (a status string). Returns a
    # lambda that removes it. Listeners run on a background thread; exceptions they raise are swallowed.
    def on(event, callable = nil, &block)
      fn = callable || block
      list = @listeners.fetch(event.to_sym) { raise ArgumentError, "unknown event #{event.inspect}" }
      list << fn
      -> { list.delete(fn) }
    end

    def on_change(callable = nil, &block) = on(:change, callable, &block)
    def on_error(callable = nil, &block) = on(:error, callable, &block)

    # Revalidates now (blocking) and returns whether a configuration is in use. Errors are reported, never raised.
    def refresh
      check_fork
      sync
      initialized?
    end

    # ------------------------------------------------------------------ evaluation

    # The boolean value of +key+ for +context+; +default+ when the flag is unknown, not a boolean, or nothing is loaded.
    def bool_variation(key, default, context = nil) = run(key, default, context, ACCEPT_BOOL).value
    def string_variation(key, default, context = nil) = run(key, default, context, ACCEPT_STRING).value
    # A number flag; whole numbers are returned as Integer.
    def number_variation(key, default, context = nil) = run(key, default, context, ACCEPT_NUMBER).value
    # A JSON flag as plain Ruby data (Hash with String keys, Array, …); any served value is accepted.
    def json_variation(key, default, context = nil) = run(key, default, context, ACCEPT_ANY).value

    def bool_variation_detail(key, default, context = nil) = run(key, default, context, ACCEPT_BOOL)
    def string_variation_detail(key, default, context = nil) = run(key, default, context, ACCEPT_STRING)
    def number_variation_detail(key, default, context = nil) = run(key, default, context, ACCEPT_NUMBER)
    def json_variation_detail(key, default, context = nil) = run(key, default, context, ACCEPT_ANY)

    # The full engine result ({EvaluationDetail}) without any type check.
    def evaluate(key, default, context = nil) = run(key, default, context, nil)

    # Every flag of the configuration in use evaluated for +context+ ({} when nothing is loaded). Not sampled into
    # telemetry.
    def all_flags(context = nil)
      all_flags_detail(context).transform_values(&:value)
    end

    def all_flags_detail(context = nil)
      b = @bundle
      return {} if b.nil?

      ctx = to_context(context)
      out = {}
      b["flags"].each_key do |k|
        r = Engine.evaluate(b, k, ctx, nil)
        out[k] = EvaluationDetail.from_result(r, nil) unless r.reason == "flag_not_found"
      end
      out
    rescue StandardError
      {}
    end

    # ------------------------------------------------------------------ fork safety

    # @api private
    def self.install_exit_hook
      REGISTRY_LOCK.synchronize do
        return if @exit_hook

        @exit_hook = true
        at_exit { each_client { |c| c.close unless c.closed? } }
      end
    end

    # @api private
    def self.each_client(&block)
      clients = REGISTRY_LOCK.synchronize { REGISTRY.keys }
      clients.each(&block)
    end

    # Restarts the background threads of every client in a forked child now (for example from Puma's
    # +on_worker_boot+). Optional: a client notices the fork on its first call in the child and restarts then.
    def self.after_fork
      each_client { |c| c.send(:check_fork) }
    end

    private

    def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    def init_concurrency
      @pid = Process.pid
      @mutex = Monitor.new
      @cv = @mutex.new_cond # wakes the poll loop (sync requested, close)
      @sleep_cv = @mutex.new_cond # wakes the other loops (close)
      @ready_cv = @mutex.new_cond
      @sync_mutex = Mutex.new
      @keys_mutex = Mutex.new
      @queue_mutex = Mutex.new
      @threads = []
      @sync_requested = false
      @stream_closer = nil
      @stream_thread = nil
      @stream_active = false
      @stream_gen = 0
    end

    # A fork keeps the configuration but not the threads: restart them in the child, and drop the parent's queued
    # events (the parent sends those).
    def check_fork
      return if Process.pid == @pid

      FORK_LOCK.synchronize do
        return if Process.pid == @pid

        was_started = @started
        init_concurrency
        @queue = []
        @stream_open = false
        @started = false
        @last_report = monotonic
        start if was_started && !@closed
      end
    end

    FORK_LOCK = Mutex.new

    def spawn(name, &block)
      t = Thread.new do
        Thread.current.name = name
        Thread.current.report_on_exception = false
        block.call
      rescue StandardError => e
        log { "#{name} stopped: #{e.class}: #{e.message}" }
      end
      @threads << t
      t
    end

    def log
      @logger&.debug("nanoflags") { yield }
    end

    def mark_ready
      @mutex.synchronize do
        @ready = true
        @ready_cv.broadcast
      end
    end

    def fire(event, arg)
      @listeners[event].dup.each do |fn|
        fn.call(arg)
      rescue StandardError => e
        log { "#{event} listener raised #{e.class}: #{e.message}" }
      end
    end

    def emit_error(e)
      @last_error = e
      log { "#{e.code}: #{e.message}" }
      fire(:error, e)
    end

    def set_status(status)
      changed = @mutex.synchronize do
        old = @status
        @status = status
        old != status
      end
      fire(:status, status) if changed
    end

    def setup_verifier(verify)
      official = @base_url == OFFICIAL_EDGE_URL
      official_keys = -> { Signature.import_keys(OFFICIAL_SIGNING_KEYS) }
      @verifier =
        case verify
        when false then nil
        when nil then official ? { base: official_keys.(), require: true, refetch: true } : nil
        when true then official ? { base: official_keys.(), require: true, refetch: true } : { base: [], require: true, refetch: true }
        when Hash
          v = verify.transform_keys(&:to_sym)
          req = v.key?(:require) ? v[:require] : official
          keys = v[:public_keys]
          if keys.is_a?(Array) && !keys.empty?
            unless keys.all? { |k| Signature.public_ed25519_jwk?(k.is_a?(Hash) ? k.transform_keys(&:to_s) : k) }
              @pending_errors << Error.new("`verify[:public_keys]` must contain public Ed25519 JWKs only. Other entries (including private keys) were ignored.", :config)
            end
            { base: Signature.import_keys(keys), require: req, refetch: v.fetch(:fetch_keys, false) }
          elsif v[:fetch_keys] || !official
            { base: [], require: req, refetch: true }
          else
            { base: official_keys.(), require: req, refetch: true }
          end
        else raise ArgumentError, "verify must be nil, true, false or a Hash"
        end
    end

    def adopt_bootstrap(bootstrap)
      b = bootstrap.is_a?(String) ? Engine::Json.parse(bootstrap) : Engine::Js.from_ruby(bootstrap)
      if !Engine.bundle?(b)
        @pending_errors << Error.new("The bootstrap bundle is invalid and was ignored.", :invalid_bundle)
      elsif !Engine.supports_engine?(b.fetch("engine", Engine::UNDEFINED))
        @pending_errors << engine_error(b)
      else
        adopt(b, etag: nil, checksum: nil, sig: nil, raw: nil, status: STATUS_READY, source: :bootstrap, transport: :poll)
      end
    rescue Engine::InvalidJsonError
      @pending_errors << Error.new("The bootstrap bundle is invalid and was ignored.", :invalid_bundle)
    end

    def engine_error(b)
      Error.new("Bundle r#{Engine::Js.to_str(b.fetch("revision", Engine::UNDEFINED))} needs evaluation engine #{Engine::Js.stringify(b.fetch("engine", Engine::UNDEFINED)) || "undefined"}; " \
                "this SDK supports up to #{Engine::VERSION}. Upgrade the nanoflags gem. The configuration in use is unchanged.", :engine)
    end

    def adopt(bundle, etag:, checksum:, sig:, raw:, status:, source:, transport:)
      event = nil
      @mutex.synchronize do
        prev = @bundle
        prev_rev = prev && prev["revision"].to_i
        is_new = prev.nil? || prev_rev != bundle["revision"].to_i || @checksum != checksum
        @bundle = bundle # one assignment: every evaluation sees one consistent revision
        @etag = etag
        @checksum = checksum
        @sig = sig
        @raw = raw
        event = UpdateEvent.new(revision: bundle["revision"].to_i, previous_revision: prev_rev, checksum: checksum, source: source, transport: transport) if is_new
      end
      set_status(status)
      mark_ready
      fire(:change, event) if event
    end

    # ------------------------------------------------------------------ evaluation internals

    def to_context(context)
      return {} if context.nil?

      v = Engine::Js.from_ruby(context)
      v.is_a?(Hash) ? v : {}
    end

    def run(key, default, context, accepts)
      check_fork
      b = @bundle
      ctx = to_context(context)
      fallback = Engine::Js.from_ruby(default)
      r = Engine.evaluate(b, key.to_s, ctx, fallback)
      if accepts && r.reason != "flag_not_found" && r.reason != "error" && !accepts.(r.value)
        error = "Flag \"#{key}\" has a #{Engine::Js.type_name(r.value)} value, which does not match the requested type."
        r = Engine::Result.new(key.to_s, fallback, "error", r.revision, nil, Engine::UNDEFINED, nil, nil,
                               r.trace + [Engine::TraceStep.new("result", "Returned the fallback", error)], error)
      end
      record(r, context, ctx, b)
      EvaluationDetail.from_result(r, default)
    rescue StandardError => e
      EvaluationDetail.new(flag_key: key.to_s, value: default, reason: "error", revision: 0, error: e.message)
    end

    # ------------------------------------------------------------------ background loop

    def main_loop
      restore
      sync
      mark_ready # even without a bundle: callers must not hang; they check `status`
      return if @closed

      spawn("nanoflags-events") { events_loop } if @events_enabled && @flush_interval.positive?
      start_stream if @streaming
      loop do
        @mutex.synchronize do
          return if @closed

          unless @sync_requested
            if @poll_interval.positive?
              @cv.wait(next_delay)
            else
              @cv.wait
            end
          end
          return if @closed

          @sync_requested = false
        end
        sync
      end
    end

    def request_sync
      @mutex.synchronize do
        @sync_requested = true
        @cv.broadcast
      end
    end

    def next_delay
      jitter = 0.8 + (0.4 * @random.call)
      base = @failures.positive? ? [@poll_interval, 2.0**[@failures - 1, 10].min].min : @poll_interval
      [0.25, base * jitter].max
    end

    def headers(extra = nil)
      h = { "Authorization" => "Bearer #{@sdk_key}", "User-Agent" => "nanoflags-ruby/#{VERSION}" }
      extra ? h.merge(extra) : h
    end

    def request(method, path, extra_headers = nil, body = nil, timeout = @request_timeout)
      @http.call(method, "#{@base_url}#{path}", headers(extra_headers), body, timeout)
    end

    def sync
      @sync_mutex.synchronize { sync_once unless @closed }
    end

    def sync_once
      transport = @stream_triggered ? :stream : :poll
      @stream_triggered = false
      begin
        res = begin
          request("GET", "/v1/bundle", @etag ? { "If-None-Match" => @etag } : nil)
        rescue StandardError => e
          raise Error.new("Could not reach the NanoFlags edge: #{e.message}", :network)
        end
        return if @closed

        served_stale = res.header("X-NanoFlags-Stale") == "true"
        if res.status == 304 && @bundle
          @failures = 0
          set_status(served_stale ? STATUS_STALE : STATUS_READY)
          return
        end
        raise Error.new("The SDK key was rejected (unknown or revoked).", :unauthorized, res.status) if [401, 403].include?(res.status)
        raise Error.new("Bundle request failed with HTTP #{res.status}.", :http, res.status) unless res.ok?

        body = begin
          Engine::Json.parse(res.body)
        rescue Engine::InvalidJsonError
          nil
        end
        raise Error.new("The edge returned an invalid bundle.", :invalid_bundle) unless body.is_a?(Hash) && Engine.bundle?(body["bundle"])

        bundle = body["bundle"]
        sig, raw = check_signature(res, body, bundle)
        return if @closed
        raise engine_error(bundle) unless Engine.supports_engine?(bundle.fetch("engine", Engine::UNDEFINED))

        @failures = 0
        cur = @bundle
        # The edge is serving its last-known-good copy: never go backwards because of it.
        if served_stale && cur && cur["revision"] >= bundle["revision"]
          set_status(STATUS_STALE)
          return
        end
        checksum = body["checksum"].is_a?(String) ? body["checksum"] : nil
        @pinned_env = sig.environment_id if sig
        adopt(bundle, etag: res.header("ETag"), checksum: checksum, sig: sig, raw: raw,
                      status: served_stale ? STATUS_STALE : STATUS_READY, source: :network, transport: transport)
        persist
      rescue Error => e
        return if @closed

        if e.code == :engine
          emit_error(e)
          return
        end
        @failures += 1
        if e.code == :signature
          emit_error(e) # same bundle, same status; polling retries with backoff
          return
        end
        set_status(STATUS_STALE) if @bundle
        emit_error(e)
      end
    end

    # Verifies a /v1/bundle response (when verification is on); returns [signature info or nil, bundle text to keep].
    def check_signature(res, body, bundle)
      raw = Signature.raw_member(res.body, "bundle")
      return [nil, raw] unless @verifier

      rev = bundle["revision"].to_i
      reject = ->(why) { Error.new("Bundle r#{rev} was rejected: #{why} The configuration in use is unchanged.", :signature) }
      unless res.header("X-NanoFlags-Signed") == "true"
        raise reject.("it is not signed (the edge is still distributing it) and unsigned bundles are refused; fetching again shortly.") if @verifier[:require]

        return [nil, raw]
      end
      signature = res.header("X-NanoFlags-Signature")
      env_id = res.header("X-NanoFlags-Environment-Id")
      kid = res.header("X-NanoFlags-Key-Id")
      checksum = body["checksum"]
      raise reject.("the signature headers are incomplete.") if signature.to_s.empty? || env_id.to_s.empty? || !checksum.is_a?(String)
      raise reject.("the signed revision does not match the bundle.") if body["revision"].is_a?(Float) && body["revision"].to_i != rev
      raise reject.("it was signed for a different environment.") if @pinned_env && @pinned_env != env_id

      info = Signature::Info.new(signature, kid.to_s.empty? ? nil : kid, env_id, rev, checksum)
      keys = begin
        load_keys(info.kid)
      rescue StandardError => e
        raise reject.("the signing keys could not be loaded (#{e.message}).")
      end
      # The edge embeds the stored bundle text byte-for-byte; re-serialisation is the fallback.
      return [info, raw] if raw && Signature.verify(keys, info, raw)

      again = Engine::Js.stringify(bundle)
      return [info, again] if again && again != raw && Signature.verify(keys, info, again)

      raise reject.("its signature does not verify.")
    end

    # The pinned or embedded keys plus those of /v1/keys; an unknown key id reloads /v1/keys (at most once a minute).
    def load_keys(kid)
      v = @verifier
      return [] unless v
      return v[:base] unless v[:refetch]

      @keys_mutex.synchronize do
        known = v[:base] + @fetched_keys
        return known if !known.empty? && (kid.nil? || known.any? { |k| k.kid == kid })
        return known if @keys_fetched_at && monotonic - @keys_fetched_at < KEYS_REFETCH

        begin
          # Public endpoint: the SDK key is deliberately not sent.
          res = @http.call("GET", "#{@base_url}/v1/keys", { "User-Agent" => "nanoflags-ruby/#{VERSION}" }, nil, @request_timeout)
          raise Error.new("Signing keys request failed with HTTP #{res.status}.", :signature, res.status) unless res.status == 200

          parsed = JSON.parse(res.body)
          keys = Signature.import_keys(parsed.is_a?(Hash) && parsed["keys"].is_a?(Array) ? parsed["keys"] : [])
          raise Error.new("The edge returned no usable signing keys.", :signature) if keys.empty?

          @fetched_keys = keys
        rescue StandardError
          raise if v[:base].empty?
        ensure
          @keys_fetched_at = monotonic
        end
        v[:base] + @fetched_keys
      end
    end

    # ------------------------------------------------------------------ persistence

    def persist
      return unless @store

      payload = @mutex.synchronize do
        p = { "v" => 1, "id" => @id, "etag" => @etag, "checksum" => @checksum, "savedAt" => Time.now.utc.iso8601(3), "bundle" => Engine::Js.stringify(@bundle) }
        if @sig
          p["sig"] = @sig.to_h
          p["raw"] = @raw if @raw
        end
        p
      end
      # "bundle" is JSON text inside the document, so the persisted bytes survive any re-encoding by the store.
      @store.set(JSON.generate(payload))
    rescue StandardError => e
      emit_error(Error.new("Could not persist the bundle: #{e.message}", :store))
    end

    def restore
      return unless @store

      text = @store.get
      return if text.nil? || text.empty? || @closed

      p = JSON.parse(text)
      return unless p.is_a?(Hash) && p["v"] == 1 && p["id"] == @id && p["bundle"].is_a?(String)

      restored = Engine::Json.parse(p["bundle"])
      return unless Engine.bundle?(restored)
      return emit_error(engine_error(restored)) unless Engine.supports_engine?(restored.fetch("engine", Engine::UNDEFINED))
      return if @bundle && @bundle["revision"] >= restored["revision"]

      sig = nil
      raw = nil
      if @verifier
        # The store is outside the trust boundary: a signed copy must verify again; with `require` an unsigned copy
        # is not used at all.
        s = Signature::Info.from_h(p["sig"])
        if s && s.revision == restored["revision"].to_i
          raw = p["raw"].is_a?(String) ? p["raw"] : p["bundle"]
          ok = begin
            Signature.verify(load_keys(s.kid), s, raw) && (parsed = Engine::Json.parse(raw)) && Engine.bundle?(parsed) && parsed["revision"].to_i == s.revision
          rescue StandardError
            false
          end
          return emit_error(Error.new("The persisted bundle failed signature verification and was ignored.", :signature)) unless ok

          restored = parsed
          sig = s
          @pinned_env ||= s.environment_id
        elsif @verifier[:require]
          return
        end
      end
      # Usable but not known to be current: stale until the edge confirms it.
      adopt(restored, etag: p["etag"], checksum: p["checksum"], sig: sig, raw: raw, status: STATUS_STALE, source: :store, transport: :poll)
    rescue StandardError => e
      emit_error(Error.new("Could not read the persisted bundle: #{e.message}", :store))
    end

    # ------------------------------------------------------------------ event stream (SSE)

    def start_stream
      gen = @mutex.synchronize do
        return if @closed || !@streaming || @stream_active

        @stream_active = true
        @stream_gen += 1
      end
      @stream_thread = spawn("nanoflags-stream") { stream_loop(gen) }
    end

    def close_stream
      closer, thread = @mutex.synchronize do
        @stream_gen += 1
        @stream_active = false
        [@stream_closer, @stream_thread]
      end
      begin
        closer&.call
      rescue StandardError
        nil
      end
      # A read blocked inside OpenSSL does not always notice the socket closing under it: the thread only reads.
      thread.kill if thread && thread != Thread.current && !thread.join(0.2)
      nil
    end

    def stream_loop(gen)
      attempt = 0
      current = -> { !@closed && gen == @stream_gen && Process.pid == @pid }
      while current.()
        started = monotonic
        stop = false
        begin
          status = @http.stream("#{@base_url}/v1/stream", headers("Accept" => "text/event-stream"),
                                open_timeout: @request_timeout, read_timeout: @stream_read_timeout,
                                on_open: ->(closer) { @stream_closer = closer }) do |event, data|
            next :stop unless current.()

            @stream_open = true
            case event
            when "revision" then on_revision(data)
            when "revoked"
              stop = true
              request_sync
              next :stop
            end
            nil
          end
          stop = true if [401, 403].include?(status) # polling keeps reporting the error
        rescue StandardError => e
          log { "stream failed: #{e.class}: #{e.message}" }
        ensure
          @stream_open = false
          @stream_closer = nil
        end
        return unless current.()

        if stop
          @mutex.synchronize { @stream_active = false if gen == @stream_gen }
          return
        end
        attempt = monotonic - started > 30 ? 0 : attempt + 1
        wait = [30.0, 2.0**[attempt, 5].min].min * (0.5 + @random.call)
        @mutex.synchronize { @sleep_cv.wait(wait) unless @closed }
      end
    end

    def on_revision(data)
      m = JSON.parse(data)
      return unless m.is_a?(Hash)

      b = @bundle
      return unless b.nil? || m["revision"] != b["revision"].to_i || m["checksum"] != @checksum || @status != STATUS_READY

      @stream_triggered = true
      request_sync
    rescue JSON::ParserError
      nil
    end

    # ------------------------------------------------------------------ telemetry

    def attrs_used_by(bundle, flag_key)
      return [] if bundle.nil?

      unless @attrs_for.equal?(bundle)
        @attrs = {}
        @attrs_for = bundle
      end
      @attrs[flag_key] ||= Engine.attributes_used_by(bundle, flag_key)
    end

    def record(r, user_context, ctx, bundle)
      return if !@events_enabled || @closed || @sample_rate <= 0 || @random.call >= @sample_rate

      context =
        if @redact
          c = Engine::Js.from_ruby(@redact.call(user_context.is_a?(Hash) ? user_context.dup : Engine::Js.to_ruby(ctx)))
          c.is_a?(Hash) ? c : {}
        else
          # No attribute values: only the names the flag's rules use that are present, with the value's type.
          attrs_used_by(bundle, r.flag_key).each_with_object({}) do |name, h|
            v = ctx.fetch(name, Engine::UNDEFINED)
            h[name] = Engine::Js.type_name(v) unless v.equal?(Engine::UNDEFINED)
          end
        end
      rev = Engine::Js.to_number(r.revision)
      ev = { "flagKey" => truncate(r.flag_key, 63), "value" => event_value(r.value), "reason" => r.reason }
      ev["ruleIndex"] = r.rule_index.to_f unless r.rule_index.nil?
      ev["revision"] = rev.finite? ? rev.to_i.to_f : 0.0
      ev["context"] = context
      ev["at"] = Time.now.utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")
      ev["sampleRate"] = @sample_rate
      text = Engine::Js.stringify(ev)
      @queue_mutex.synchronize { @queue << text if @queue.length < MAX_QUEUE } # bounded: drop instead of growing
    rescue StandardError
      nil # telemetry must never affect evaluation
    end

    def event_value(v)
      return truncate(v, MAX_EVENT_VALUE_CHARS) if v.is_a?(String)

      text = Engine::Js.stringify(v)
      return nil if text.nil? || ((v.is_a?(Array) || v.is_a?(Hash)) && Engine::Js.utf16_length(text) > MAX_EVENT_VALUE_CHARS)

      v
    end

    def truncate(s, n)
      return s if s.bytesize <= n || Engine::Js.utf16_length(s) <= n

      Engine::Js.units_to_string(Engine::Js.to_units(s).first(n))
    end

    public

    # Sends queued telemetry and the service report now (blocking, best effort, never raises).
    def flush(timeout: @request_timeout)
      return unless @events_enabled

      batch = @queue_mutex.synchronize { @queue.shift(MAX_BATCH) }
      @last_report = monotonic
      rev = revision || 0
      body = %({"service":#{Engine::Js.quote(truncate(@service, 60))},"sdk":"ruby/#{VERSION}","revision":#{[rev, 0].max},"events":[#{batch.join(",")}]})
      request("POST", "/v1/events", { "Content-Type" => "application/json" }, body, timeout)
      nil
    rescue StandardError
      nil # dropped on failure, by design: telemetry is never retried
    end

    def inspect
      "#<NanoFlags::Client base_url=#{@base_url.inspect} status=#{@status.inspect} revision=#{revision.inspect} transport=#{transport.inspect}>"
    end

    private

    def events_loop
      loop do
        @mutex.synchronize do
          return if @closed

          @sleep_cv.wait(@flush_interval)
          return if @closed
        end
        empty = @queue_mutex.synchronize { @queue.empty? }
        # Nothing queued: the service report alone goes out once per report interval.
        next if empty && monotonic - @last_report < @report_interval

        flush
      end
    end
  end
end
