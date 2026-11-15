# frozen_string_literal: true

require_relative "engine/js"
require_relative "engine/json"

module NanoFlags
  # The NanoFlags evaluation engine: a port of the TypeScript engine (`@nanoflags/engine`) that the dashboard, the
  # edge and every SDK share.
  #
  # Pure and deterministic: the same bundle, flag key and context always produce the same result, including the
  # bucket of percentage rollouts (MurmurHash3 x86 32-bit over the NFC-normalised UTF-8 bytes of "seed:identity").
  # Rules are data; no user code ever runs. Configuration is JSON evaluated with JavaScript semantics ({Engine::Js});
  # the cross-language parity fixtures (packages/engine/fixtures/parity.json) pin the behaviour, malformed
  # configurations included.
  module Engine
    # The engine version implemented here (`ENGINE_VERSION` of the TypeScript engine). Newer bundles are refused.
    VERSION = 1

    # One line of the human-readable explanation of an evaluation. +kind+ is "config", "rule", "allocation" or
    # "result"; +matched+ is set for rule and allocation steps.
    TraceStep = Struct.new(:kind, :title, :detail, :matched) do
      def to_h
        h = { "kind" => kind, "title" => title, "detail" => detail }
        h["matched"] = matched unless matched.nil?
        h
      end
    end

    # The outcome of {Engine.evaluate}, mirroring the TypeScript engine's `Evaluation` object. Values are engine
    # values; +value+ is {UNDEFINED} when the configuration served nothing, +rule_id+ is {UNDEFINED} when there is none.
    Result = Struct.new(:flag_key, :value, :reason, :revision, :rule_index, :rule_id, :in_rollout, :bucket, :trace, :error)

    OP_WORDS = {
      "eq" => "=", "neq" => "≠", "in" => "in", "not_in" => "not in", "contains" => "contains",
      "starts_with" => "starts with", "ends_with" => "ends with", "gt" => ">", "gte" => "≥", "lt" => "<", "lte" => "≤",
      "exists" => "exists", "not_exists" => "does not exist", "segment" => "in segment", "not_segment" => "not in segment"
    }.freeze

    M32 = 0xFFFFFFFF

    module_function

    # ---------------------------------------------------------------- hashing

    # `TextEncoder.encode(input.normalize("NFC"))`: lone surrogates and invalid bytes become U+FFFD.
    def hash_input(s)
      return s.b if s.ascii_only?
      return s.unicode_normalize(:nfc).b if s.valid_encoding?

      out = +"".b
      run = +""
      Js.code_points(s).each do |cp, size|
        if cp.between?(0xD800, 0xDFFF) || (cp == 0xFFFD && size == 1)
          out << run.unicode_normalize(:nfc).b << Js::REPLACEMENT.b
          run = +""
          next
        end
        run << Js.encode_unit(cp)
      end
      out << run.unicode_normalize(:nfc).b
    end

    # MurmurHash3 x86 32-bit over the NFC-normalised UTF-8 bytes of +input+ (unsigned). Distribution only.
    def murmur3(input, seed = 0)
      data = hash_input(input)
      c1 = 0xCC9E2D51
      c2 = 0x1B873593
      h = seed & M32
      n = data.bytesize
      blocks = n >> 2
      data.unpack("V#{blocks}").each do |k|
        k = (k * c1) & M32
        k = ((k << 15) | (k >> 17)) & M32
        k = (k * c2) & M32
        h ^= k
        h = ((h << 13) | (h >> 19)) & M32
        h = ((h * 5) + 0xE6546B64) & M32
      end
      tail = data.byteslice(blocks * 4, n & 3).bytes
      k = 0
      k ^= tail[2] << 16 if tail.length >= 3
      k ^= tail[1] << 8 if tail.length >= 2
      if tail.length >= 1
        k ^= tail[0]
        k = (k * c1) & M32
        k = ((k << 15) | (k >> 17)) & M32
        k = (k * c2) & M32
        h ^= k
      end
      h ^= n & M32
      h ^= h >> 16
      h = (h * 0x85EBCA6B) & M32
      h ^= h >> 13
      h = (h * 0xC2B2AE35) & M32
      h ^ (h >> 16)
    end

    # Bucket in [0, 100) with two decimals of resolution, stable for a given seed + identity.
    def bucket_of(seed, identity)
      (murmur3("#{seed}:#{identity}") % 10_000) / 100.0
    end

    # ---------------------------------------------------------------- conditions

    def loose_eq?(a, b)
      return false if a.equal?(UNDEFINED) || b.equal?(UNDEFINED)

      obj = ->(v) { v.nil? || v.is_a?(Array) || v.is_a?(Hash) }
      return Js.stringify(a) == Js.stringify(b) if obj.(a) || obj.(b)
      return a == b if a.is_a?(Float) && b.is_a?(Float)
      return a == b if (a == true || a == false) && (b == true || b == false)
      return a == b if a.is_a?(String) && b.is_a?(String)

      false
    end

    def num(v)
      if v.is_a?(Float)
        v.finite? ? v : nil
      elsif v.is_a?(String) && !Js.trim(v).empty?
        n = Js.string_to_number(v)
        n.finite? ? n : nil
      end
    end

    def lookup(ctx, name)
      ctx.is_a?(Hash) ? ctx.fetch(name, UNDEFINED) : UNDEFINED
    end

    def match_condition(c, ctx, segments, depth)
      op = Js.get(c, "op")
      if op == "segment" || op == "not_segment"
        value = Js.get(c, "value")
        seg = value.is_a?(String) ? Js.own(segments, value) : UNDEFINED
        in_seg = false
        if !seg.equal?(UNDEFINED) && depth < 4
          match = Js.get(seg, "match")
          conds = Js.get(seg, "conditions")
          in_seg = match_all(match, conds, ctx, segments, depth + 1)
        end
        return op == "segment" ? in_seg : (!seg.equal?(UNDEFINED) && !in_seg)
      end
      actual = lookup(ctx, Js.to_str(Js.get(c, "attribute")))
      value = Js.get(c, "value")
      return false unless op.is_a?(String)

      case op
      when "exists" then !Js.nullish?(actual)
      when "not_exists" then Js.nullish?(actual)
      when "eq" then loose_eq?(actual, value)
      when "neq" then !actual.equal?(UNDEFINED) && !loose_eq?(actual, value)
      when "in" then value.is_a?(Array) && value.any? { |v| loose_eq?(actual, v) }
      when "not_in" then !actual.equal?(UNDEFINED) && value.is_a?(Array) && value.none? { |v| loose_eq?(actual, v) }
      when "contains" then actual.is_a?(String) && value.is_a?(String) && Js.includes?(actual, value)
      when "starts_with" then actual.is_a?(String) && value.is_a?(String) && Js.starts_with?(actual, value)
      when "ends_with" then actual.is_a?(String) && value.is_a?(String) && Js.ends_with?(actual, value)
      when "gt", "gte", "lt", "lte"
        a = num(actual)
        b = num(value)
        return false if a.nil? || b.nil?

        case op
        when "gt" then a > b
        when "gte" then a >= b
        when "lt" then a < b
        else a <= b
        end
      else false
      end
    end

    # The engine's matchAll(mode, conditions, …), including its failure modes.
    def match_all(mode, conditions, ctx, segments, depth)
      length = Js.get(conditions, "length")
      return true if length.is_a?(Float) && length.zero?

      some = mode == "any"
      raise JsTypeError, "conditions.#{some ? "some" : "every"} is not a function" unless conditions.is_a?(Array)

      conditions.each do |c|
        ok = match_condition(c, ctx, segments, depth)
        return true if some && ok
        return false if !some && !ok
      end
      !some
    end

    # Human-readable condition, as shown in traces (describeCondition of the TypeScript engine).
    def describe_condition(c)
      value = Js.get(c, "value")
      v = if value.is_a?(Array) then Js.join(value, ", ")
          elsif value.equal?(UNDEFINED) then ""
          else Js.to_str(value)
          end
      op = Js.get(c, "op")
      key = Js.to_str(op)
      word = OP_WORDS[key] || Js::OBJECT_PROTO_STRINGS[key] || "undefined"
      return "#{word} #{v}" if op == "segment" || op == "not_segment"

      attribute = Js.to_str(Js.get(c, "attribute"))
      return "#{attribute} #{word}" if op == "exists" || op == "not_exists"

      "#{attribute} #{word} #{v}"
    end

    # The engine's fmt(v): strings as they are, everything else as JSON ("undefined" when there is none).
    def fmt(v)
      v.is_a?(String) ? v : (Js.stringify(v) || "undefined")
    end

    # ---------------------------------------------------------------- evaluation

    # Evaluates one flag of +bundle+ (a parsed bundle document; nil or {UNDEFINED} for "no configuration loaded") for
    # +ctx+ (a Hash of engine values). Never raises: on any problem it returns +fallback+ with reason
    # "flag_not_found" or "error".
    def evaluate(bundle, flag_key, ctx, fallback)
      nullish = Js.nullish?(bundle)
      revision = 0.0
      unless nullish
        r = begin
          Js.get(bundle, "revision")
        rescue StandardError
          UNDEFINED
        end
        revision = r unless Js.nullish?(r)
      end
      trace = []
      begin
        flag = nullish ? UNDEFINED : Js.own(Js.get(bundle, "flags"), flag_key)
        if !Js.truthy?(bundle) || !Js.truthy?(flag)
          detail = if Js.truthy?(bundle)
                     "Flag is not in this configuration. The application fallback applies."
                   else
                     "No configuration is loaded. The application fallback applies."
                   end
          trace << TraceStep.new("result", "Returned #{fmt(fallback)}", detail)
          return Result.new(flag_key, fallback, "flag_not_found", revision, nil, UNDEFINED, nil, nil, trace, nil)
        end
        trace << TraceStep.new("config", "Configuration loaded", Js.to_number(revision) > 0 ? "r#{Js.to_str(revision)}" : "draft")
        unless Js.truthy?(Js.get(flag, "enabled"))
          off = Js.get(flag, "off")
          trace << TraceStep.new("result", "Returned #{fmt(off)}", "Flag is disabled in this environment.")
          return Result.new(flag_key, off, "off", revision, nil, UNDEFINED, nil, nil, trace, nil)
        end
        rules = Js.get(flag, "rules")
        segments = Js.get(bundle, "segments")
        i = 0
        loop do
          length = Js.get(rules, "length")
          break unless i.to_f < Js.to_number(length)

          rule = Js.get(rules, i.to_s)
          match = Js.get(rule, "match")
          conditions = Js.get(rule, "conditions")
          matched = match_all(match, conditions, ctx, segments, 0)
          label = format("Rule %02d", i + 1)
          summary = "all contexts"
          if Js.truthy?(Js.get(conditions, "length"))
            summary = conditions.map { |c| describe_condition(c) }.join(match == "any" ? " OR " : " AND ")
          end
          trace << TraceStep.new("rule", matched ? "#{label} matched" : "#{label} did not match", summary, matched)
          unless matched
            i += 1
            next
          end
          serve = Js.get(rule, "serve")
          serve_type = Js.get(serve, "type")
          rule_id = Js.get(rule, "id")
          if serve_type == "fixed"
            value = Js.get(serve, "value")
            trace << TraceStep.new("result", "Returned #{fmt(value)}", "#{label} serves a fixed value.")
            return Result.new(flag_key, value, "rule_match", revision, i, rule_id, nil, nil, trace, nil)
          end
          attr_v = Js.get(serve, "bucketBy")
          attr = Js.nullish?(attr_v) ? "key" : Js.to_str(attr_v)
          identity = lookup(ctx, attr)
          otherwise = Js.get(serve, "otherwise")
          if Js.nullish?(identity) || identity == ""
            trace << TraceStep.new("allocation", "Allocation skipped", "Context has no \"#{attr}\" to bucket by; treated as outside the allocation.", false)
            trace << TraceStep.new("result", "Returned #{fmt(otherwise)}", "Remaining eligible users.")
            return Result.new(flag_key, otherwise, "rule_match", revision, i, rule_id, false, nil, trace, nil)
          end
          seed_v = Js.get(serve, "seed")
          seed = Js.nullish?(seed_v) ? flag_key : Js.to_str(seed_v)
          hash = murmur3("#{seed}:#{Js.to_str(identity)}") % 10_000
          bucket = hash / 100.0
          percentage = Js.get(serve, "percentage")
          in_rollout = bucket < Js.to_number(percentage)
          pct = Js.to_str(percentage)
          fixed = format("%d.%02d", hash / 100, hash % 100)
          trace << TraceStep.new("allocation", "Allocation evaluated", "#{pct}% rollout · #{attr} #{in_rollout ? "inside" : "outside"} allocation (bucket #{fixed})", in_rollout)
          value = in_rollout ? Js.get(serve, "value") : otherwise
          trace << TraceStep.new("result", "Returned #{fmt(value)}", in_rollout ? "Inside the #{pct}% allocation." : "Remaining eligible users.")
          return Result.new(flag_key, value, "rule_match", revision, i, rule_id, in_rollout, bucket, trace, nil)
        end
        default = Js.get(flag, "default")
        trace << TraceStep.new("result", "Returned #{fmt(default)}", "No rule matched. The flag default applies.")
        Result.new(flag_key, default, "default", revision, nil, UNDEFINED, nil, nil, trace, nil)
      rescue StandardError, SystemStackError => e
        msg = e.message.to_s.empty? ? e.class.name : e.message
        trace << TraceStep.new("result", "Returned #{fmt(fallback)}", "Evaluation error: #{msg}. The application fallback applies.")
        Result.new(flag_key, fallback, "error", revision, nil, UNDEFINED, nil, nil, trace, msg)
      end
    end

    # ---------------------------------------------------------------- bundles

    # True when this engine can evaluate a bundle whose `engine` member is +e+ ({UNDEFINED} when absent).
    def supports_engine?(e)
      return true if e.equal?(UNDEFINED)

      e.is_a?(Float) && e.finite? && e == e.floor && e >= 1 && e <= VERSION
    end

    # The shape the SDKs accept as a bundle: `schema` 1, a numeric `revision`, object `flags` and `segments`.
    def bundle?(v)
      v.is_a?(Hash) && v["schema"].is_a?(Float) && v["schema"] == 1.0 && v["revision"].is_a?(Float) &&
        v["flags"].is_a?(Hash) && (v["segments"].is_a?(Hash) || v["segments"].is_a?(Array))
    end

    # The browser-key view: only client-exposed flags, and only the segments they reference (directly or through
    # other segments). Mirrors `clientBundle()` of the TypeScript engine.
    def client_bundle(bundle)
      flags = bundle["flags"].is_a?(Hash) ? bundle["flags"] : {}
      pending = []
      refs = lambda do |conditions|
        next unless conditions.is_a?(Array)

        conditions.each do |c|
          op = Js.own(c, "op")
          v = Js.own(c, "value")
          pending << v if (op == "segment" || op == "not_segment") && v.is_a?(String)
        end
      end
      kept = {}
      flags.each do |k, f|
        next unless Js.own(f, "clientExposed") == true

        kept[k] = f
        rules = Js.own(f, "rules")
        rules.each { |r| refs.(Js.own(r, "conditions")) } if rules.is_a?(Array)
      end
      segments = bundle["segments"]
      needed = {}
      until pending.empty?
        k = pending.pop
        next if needed.key?(k) || !segments.is_a?(Hash) || !segments.key?(k)

        needed[k] = true
        refs.(Js.own(segments[k], "conditions"))
      end
      seg_out = segments.is_a?(Hash) ? segments.select { |k, _| needed.key?(k) } : {}
      out = bundle.to_h do |k, v|
        [k, case k
            when "flags" then kept
            when "segments" then seg_out
            else v
            end]
      end
      out["flags"] ||= kept
      out["segments"] ||= seg_out
      out
    end

    # The context attributes that the rules of +flag_key+ reference (through segments up to the engine's nesting
    # limit), plus the bucketing attribute of rollouts. The SDK reports only these attribute names, with the type of
    # the value and never the value, in sampled evaluation events.
    def attributes_used_by(bundle, flag_key)
      names = {}
      segments = Js.own(bundle, "segments")
      visit = lambda do |conds, depth|
        # `for…of` over a non-iterable throws in the TypeScript SDK: nothing is reported.
        return conds.is_a?(String) unless conds.is_a?(Array)

        conds.each do |c|
          op = Js.get(c, "op")
          if op == "segment" || op == "not_segment"
            value = Js.get(c, "value")
            if value.is_a?(String)
              seg = Js.own(segments, value)
              return false if Js.truthy?(seg) && depth < 4 && !visit.(Js.get(seg, "conditions"), depth + 1)
            end
          else
            attr = Js.get(c, "attribute")
            names[Js.to_str(attr)] = true if Js.truthy?(attr)
          end
        end
        true
      end
      rules = Js.get(Js.own(Js.own(bundle, "flags"), flag_key), "rules")
      return [] unless rules.is_a?(Array)

      rules.each do |r|
        return [] unless visit.(Js.get(r, "conditions"), 0)

        serve = Js.get(r, "serve")
        if Js.get(serve, "type") == "rollout"
          by = Js.get(serve, "bucketBy")
          names[Js.nullish?(by) ? "key" : Js.to_str(by)] = true
        end
      end
      names.keys
    rescue StandardError
      []
    end
  end
end
