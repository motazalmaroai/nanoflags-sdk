# frozen_string_literal: true

require "openssl"
require "json"
require "digest"

# An in-process edge for the client tests: /v1/bundle (ETag, 304, signatures exactly as the hosted edge makes them),
# /v1/keys, /v1/events, /v1/session, the /v1/stream event stream and (with +live = true+) the /v1/live socket, signing
# with a throwaway Ed25519 key. Plugs in as the client's +http:+ transport.
class FakeEdge
  ENV_ID = "11111111-2222-3333-4444-555555555555"
  BASE = "https://flags.test"

  attr_accessor :signed, :tamper, :stale, :down, :status_override, :env_id, :kid, :live, :live_accept
  attr_reader :jwk, :requests, :events, :text, :revision, :checksum, :stream_opens, :sessions, :ws_connects, :sockets

  def initialize
    @key = OpenSSL::PKey.generate_key("ED25519")
    @jwk = { "kty" => "OKP", "crv" => "Ed25519", "x" => b64url(@key.public_to_der[-32..]), "kid" => "t1" } # x: the raw key ends the SPKI DER
    @kid = "t1"
    @env_id = ENV_ID
    @signed = true
    @requests = []
    @events = []
    @streams = []
    @stream_opens = 0
    @sessions = {}
    @ws_connects = 0
    @sockets = []
    @live_accept = true
    @lock = Mutex.new
    set_bundle(self.class.bundle(1))
  end

  def self.bundle(revision, flags = nil, **extra)
    flags ||= {
      "new-checkout" => { "type" => "boolean", "enabled" => true, "default" => false, "off" => false, "rules" => [
        { "id" => "beta", "match" => "all", "conditions" => [{ "attribute" => "plan", "op" => "eq", "value" => "beta" }], "serve" => { "type" => "fixed", "value" => true } },
        { "id" => "half", "match" => "all", "conditions" => [], "serve" => { "type" => "rollout", "percentage" => 50, "value" => true, "otherwise" => false } }
      ] },
      "accent" => { "type" => "string", "enabled" => true, "default" => "blue", "off" => "grey", "rules" => [] },
      "limit" => { "type" => "number", "enabled" => true, "default" => 10, "off" => 0, "rules" => [] },
      "ratio" => { "type" => "number", "enabled" => true, "default" => 0.5, "off" => 0, "rules" => [] },
      "layout" => { "type" => "json", "enabled" => true, "default" => { "cols" => 3 }, "off" => nil, "rules" => [] },
      "disabled" => { "type" => "string", "enabled" => false, "default" => "on", "off" => "off", "rules" => [] },
      "region" => { "type" => "string", "enabled" => true, "default" => "world", "off" => "off", "rules" => [
        { "id" => "eu", "match" => "any", "conditions" => [{ "attribute" => "country", "op" => "in", "value" => %w[DE FR] }, { "attribute" => "email", "op" => "ends_with", "value" => ".eu" }], "serve" => { "type" => "fixed", "value" => "eu" } }
      ] }
    }
    { "schema" => 1, "engine" => 1, "project" => "p", "environment" => "test", "revision" => revision, "flags" => flags, "segments" => {} }.merge(extra.transform_keys(&:to_s))
  end

  def b64url(bytes) = [bytes].pack("m0").tr("+/", "-_").delete("=")

  def sign(text, revision, checksum, key = @key, env = @env_id)
    canonical = "nanoflags-bundle-v1\n#{env}\n#{revision}\n#{checksum}\n#{Digest::SHA256.hexdigest(text)}"
    b64url(key.sign(nil, canonical))
  end

  def set_bundle(bundle)
    @lock.synchronize do
      # Pretty-printed: the text differs from JSON.stringify of the parsed bundle, so verification must hash the raw span.
      @text = JSON.pretty_generate(bundle)
      @revision = bundle["revision"]
      @checksum = Digest::MD5.hexdigest(@text)
      @signature = sign(@text, @revision, @checksum)
    end
  end

  # Publishes a new revision and announces it on every open event stream.
  def publish(bundle)
    set_bundle(bundle)
    @lock.synchronize { @streams.each { |q| q << ["revision", JSON.generate({ "revision" => @revision, "checksum" => @checksum })] } }
  end

  # Publishes a new revision and pushes it to every open live socket.
  def push(bundle, tamper: false, committed_at: nil, sign_key: nil)
    set_bundle(bundle)
    msg = message("rev", tamper: tamper, committed_at: committed_at, sign_key: sign_key)
    @lock.synchronize { @sockets.each { |ws| ws.deliver(msg) } }
  end

  def message(type, tamper: false, committed_at: nil, sign_key: nil)
    @lock.synchronize do
      text = @text
      sig = sign_key ? sign(text, @revision, @checksum, sign_key) : @signature
      text = text.sub('"blue"', '"red"') if tamper
      JSON.generate({ "t" => type, "revision" => @revision, "checksum" => @checksum, "signature" => sig, "kid" => @kid,
                      "environmentId" => @env_id, "bundle" => text, "committedAt" => committed_at })
    end
  end

  def close_sockets(code, reason = "")
    @lock.synchronize { @sockets.dup }.each { |ws| ws.close_from_server(code, reason) }
  end

  def revoke!
    @lock.synchronize { @streams.each { |q| q << ["revoked", "{}"] } }
  end

  def count(path) = @requests.count { |r| r[:path] == path }

  Resp = NanoFlags::HTTP::Response

  def call(method, url, headers, body, _timeout)
    path = URI(url).path
    @requests << { method: method, path: path, headers: headers }
    raise Errno::ECONNREFUSED, "connection refused" if @down
    return Resp.new(200, {}, JSON.generate({ "keys" => [@jwk.merge("alg" => "EdDSA")] })) if path == "/v1/keys"
    return Resp.new(@status_override, {}, '{"error":{"code":"x","message":"x"}}') if @status_override

    if path == "/v1/session"
      s = @sessions[headers["X-NanoFlags-Session"]]
      return Resp.new(404, {}, '{"error":{"code":"session_not_found","message":"x"}}') if s.nil?
      return Resp.new(s, {}, '{"error":{"code":"x","message":"x"}}') if s.is_a?(Integer)

      return Resp.new(200, {}, JSON.generate(s))
    end

    if path == "/v1/events" && method == "POST"
      @events << JSON.parse(body)
      return Resp.new(202, {}, '{"accepted":0}')
    end
    return Resp.new(404, {}, "") unless path == "/v1/bundle"

    @lock.synchronize do
      etag = %("#{@checksum}-server")
      h = { "etag" => etag, "x-nanoflags-environment-id" => @env_id, "x-nanoflags-signed" => @signed ? "true" : "false" }
      if @signed
        h["x-nanoflags-signature"] = @signature
        h["x-nanoflags-key-id"] = @kid
      end
      h["x-nanoflags-stale"] = "true" if @stale
      return Resp.new(304, h, "") if headers["If-None-Match"] == etag

      text = @tamper ? @text.sub('"blue"', '"red"') : @text
      Resp.new(200, h, %({"revision":#{@revision},"checksum":"#{@checksum}","bundle":#{text}}))
    end
  end

  def stream(url, headers, open_timeout:, read_timeout:, on_open: nil)
    @requests << { method: "GET", path: URI(url).path, headers: headers }
    raise Errno::ECONNREFUSED, "connection refused" if @down
    return @status_override if @status_override

    q = Queue.new
    @lock.synchronize do
      @streams << q
      @stream_opens += 1
    end
    on_open&.call(-> { q << :close })
    yield "hello", "{}"
    loop do
      item = pop(q, read_timeout) # Queue#pop(timeout:) needs Ruby 3.2
      break if item.nil? || item == :close

      break if yield(*item) == :stop
    end
    200
  ensure
    @lock.synchronize { @streams.delete(q) } if q
  end

  # The live socket (the transport's optional +websocket+ method).
  def websocket(url, headers, protocols:, open_timeout:)
    @requests << { method: "GET", path: URI(url).path, headers: headers, protocols: protocols }
    raise NanoFlags::WebSocket::HandshakeError.new("no live socket here", 404) unless @live
    raise Errno::ECONNREFUSED, "connection refused" if @down
    raise NanoFlags::WebSocket::HandshakeError.new("refused", @status_override) if @status_override

    @lock.synchronize { @ws_connects += 1 }
    raise NanoFlags::WebSocket::HandshakeError.new("refused", 503) unless @live_accept && headers["Authorization"]

    ws = Socket.new(self)
    @lock.synchronize { @sockets << ws }
    ws.deliver(message("hello"))
    ws
  end

  def forget(ws) = @lock.synchronize { @sockets.delete(ws) }

  # One fake live connection: the interface of NanoFlags::WebSocket::Connection.
  class Socket
    attr_reader :sent

    def initialize(edge)
      @edge = edge
      @queue = Queue.new
      @sent = []
      @closed = false
    end

    def deliver(text) = @queue << text
    def close_from_server(code, reason) = @queue << [:close, code, reason]
    def closed? = @closed

    def send_text(text)
      raise NanoFlags::WebSocket::Closed if @closed

      @sent << text
      @queue << "pong" if text == "ping"
    end

    def recv(timeout)
      raise NanoFlags::WebSocket::Closed if @closed

      item = FakeEdge.pop(@queue, timeout)
      return nil if item.nil?
      return item unless item.is_a?(Array)

      @closed = true
      @edge.forget(self)
      raise NanoFlags::WebSocket::Closed.new(item[1], item[2])
    end

    def close(_code = 1000, _reason = "")
      @closed = true
      @edge.forget(self)
      @queue << [:close, nil, nil]
    end
  end

  def self.pop(queue, timeout)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    loop do
      return queue.pop(true)
    rescue ThreadError
      return nil if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.005
    end
  end

  private

  def pop(queue, timeout)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    loop do
      return queue.pop(true)
    rescue ThreadError
      return nil if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.005
    end
  end
end
