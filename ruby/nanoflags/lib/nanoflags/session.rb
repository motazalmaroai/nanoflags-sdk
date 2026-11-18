# frozen_string_literal: true

module NanoFlags
  # Header that carries a test-session token between services.
  SESSION_HEADER = "x-nanoflags-session"
  # The Rack env key of the header.
  SESSION_RACK_HEADER = "HTTP_X_NANOFLAGS_SESSION"

  # Evaluator bound to one test session ({Client#session}). While {#active?}, flags are evaluated against the session's
  # pinned bundle with the context +session.context.merge(context)+, and sampled events carry the session id. When the
  # session is unknown, not permitted for this service, or expired, it evaluates exactly like the client. Sessions
  # change which snapshot and context an evaluation uses; they grant no data access and must not be used for
  # authorization.
  class SessionEvaluator
    def initialize(client, state)
      @client = client
      @state = state
    end

    # True while the session is known and has not expired. Re-evaluated on every call.
    def active? = !@state.nil? && Time.now.to_f < @state.expires_at_ts
    alias active active?

    # Session id, or nil when the session could not be resolved.
    def id = @state&.id

    # ISO 8601 expiry time, or nil when the session could not be resolved.
    def expires_at = @state&.expires_at

    # The revision evaluations currently run against.
    def revision = active? ? @state.bundle["revision"].to_i : @client.revision

    def bool_variation(key, default, context = nil) = run(key, default, context, Client::ACCEPT_BOOL).value
    def string_variation(key, default, context = nil) = run(key, default, context, Client::ACCEPT_STRING).value
    def number_variation(key, default, context = nil) = run(key, default, context, Client::ACCEPT_NUMBER).value
    def json_variation(key, default, context = nil) = run(key, default, context, Client::ACCEPT_ANY).value
    def bool_variation_detail(key, default, context = nil) = run(key, default, context, Client::ACCEPT_BOOL)
    def string_variation_detail(key, default, context = nil) = run(key, default, context, Client::ACCEPT_STRING)
    def number_variation_detail(key, default, context = nil) = run(key, default, context, Client::ACCEPT_NUMBER)
    def json_variation_detail(key, default, context = nil) = run(key, default, context, Client::ACCEPT_ANY)
    def evaluate(key, default, context = nil) = run(key, default, context, nil)

    def inspect = "#<NanoFlags::SessionEvaluator active=#{active?} id=#{id.inspect} revision=#{revision.inspect}>"

    private

    def run(key, default, context, accepts) = @client.__send__(:run, key, default, context, accepts, active? ? @state : nil)
  end

  # Request-scoped test sessions: the session of the request (or job) being handled lives in fiber storage, so it
  # follows the request through the code that handles it (and, on Ruby >= 3.2, into threads and fibers started from
  # it) and is invisible to every other request. Nothing is stored on the client.
  Scope = Struct.new(:token, :evaluators, :lock) # @api private
  private_constant :Scope
  SCOPE_KEY = :__nanoflags_session
  private_constant :SCOPE_KEY

  class << self
    # A session token is opaque; it only has to be safe to put in a header (1–512 printable ASCII characters).
    def session_token?(value) = value.is_a?(String) && value.match?(/\A[\x21-\x7e]{1,512}\z/)

    # Runs the block with +token+ as the current test session (an absent or malformed token: outside any session),
    # restoring the previous one afterwards. For jobs and queues: pass the token along with the job.
    def with_session(token)
      token = token.strip if token.is_a?(String)
      previous = scope
      self.scope = session_token?(token) ? Scope.new(token, {}.compare_by_identity, Mutex.new) : nil
      yield
    ensure
      self.scope = previous
    end

    # The token of the current request's session, or nil.
    def current_session = scope&.token

    # Headers to add to downstream calls so the next service joins the same session: +{ "x-nanoflags-session" =>
    # token }+ inside a session, else +{}+ (always safe to merge).
    def session_headers
      token = current_session
      token ? { SESSION_HEADER => token } : {}
    end

    # The evaluator for the current request: scoped to its test session inside {with_session} (or the Rack
    # middleware), resolved once per request and client; otherwise one that behaves exactly like the client.
    # Never raises.
    def flags_for(client, service: nil)
      s = scope
      return SessionEvaluator.new(client, nil) unless s

      s.lock.synchronize { s.evaluators[client] ||= client.session(s.token, service: service) }
    rescue StandardError
      SessionEvaluator.new(client, nil)
    end

    private

    if Fiber.respond_to?(:[]=) # Ruby >= 3.2: inherited by threads and fibers created inside the block
      def scope = Fiber[SCOPE_KEY]
      def scope=(value)
        Fiber[SCOPE_KEY] = value
      end
    else
      def scope = Thread.current[SCOPE_KEY]
      def scope=(value)
        Thread.current[SCOPE_KEY] = value
      end
    end
  end

  # Rack middleware (Rails, Sinatra, Hanami, Roda, …). Reads +x-nanoflags-session+, resolves the session once, and runs
  # the rest of the request inside it: +env["nanoflags.flags"]+ (and {NanoFlags.flags_for}) is the request's
  # evaluator, session-scoped while the session is active and the plain client behaviour otherwise;
  # {NanoFlags.session_headers} carries the session to downstream calls. Needs no gem besides this one.
  #
  #   # config/application.rb
  #   config.middleware.use NanoFlags::SessionMiddleware, FLAGS
  #   # a controller
  #   request.env["nanoflags.flags"].bool_variation("checkout-v2", false, { key: current_user.id })
  #
  # The session ends when +call+ returns: code that runs while a streaming body is iterated is outside it.
  class SessionMiddleware
    ENV_KEY = "nanoflags.flags"

    def initialize(app, client, service: nil)
      @app = app
      @client = client
      @service = service
    end

    def call(env)
      NanoFlags.with_session(env[SESSION_RACK_HEADER]) do
        env[ENV_KEY] = NanoFlags.flags_for(@client, service: @service)
        @app.call(env)
      end
    end
  end
end
