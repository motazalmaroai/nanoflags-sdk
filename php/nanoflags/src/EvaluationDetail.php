<?php

declare(strict_types=1);

namespace NanoFlags;

use NanoFlags\Engine\Js;
use NanoFlags\Engine\Result;
use NanoFlags\Engine\TraceStep;
use NanoFlags\Engine\Undefined;

/** The full result of an evaluation: value, reason, matched rule, rollout bucket and a human-readable trace. */
final class EvaluationDetail implements \JsonSerializable
{
    /** @param list<TraceStep> $trace */
    public function __construct(
        public readonly string $flagKey,
        /** The value (plain PHP data); the application default for reasons "flag_not_found" and "error". */
        public readonly mixed $value,
        /** One of the {@see Reason} constants. */
        public readonly string $reason,
        /** The revision of the configuration that was evaluated (0 when none is loaded). */
        public readonly int $revision,
        /** Zero-based index of the matching rule. */
        public readonly ?int $ruleIndex,
        /** The matching rule's id. */
        public readonly ?string $ruleId,
        /** For percentage rollouts: whether the context fell inside the allocation. */
        public readonly ?bool $inRollout,
        /** For percentage rollouts: the context's bucket, 0–99.99. */
        public readonly ?float $bucket,
        public readonly array $trace,
        /** Explains reason "error" (evaluation error or type mismatch). */
        public readonly ?string $error,
        private readonly mixed $raw = null,
    ) {
    }

    /** @internal */
    public static function fromResult(Result $r, mixed $default): self
    {
        $useDefault = $r->reason === Reason::FLAG_NOT_FOUND || $r->reason === Reason::ERROR;
        $rev = Js::toNumber($r->revision);
        $ruleId = null;
        if ($r->ruleIndex !== null && !($r->ruleId instanceof Undefined)) {
            $ruleId = is_string($r->ruleId) ? $r->ruleId : Js::stringify($r->ruleId);
        }
        return new self(
            $r->flagKey,
            $useDefault ? $default : Js::toPhp($r->value),
            $r->reason,
            is_finite($rev) ? (int) $rev : 0,
            $r->ruleIndex,
            $ruleId,
            $r->inRollout,
            $r->bucket,
            $r->trace,
            $r->error,
            $useDefault ? Js::fromPhp($default) : $r->value,
        );
    }

    /** The served value as JSON text (object keys in configuration order), or null when nothing was served. */
    public function json(): ?string
    {
        return Js::stringify($this->raw);
    }

    /** The type of the served value: "boolean", "string", "number", "array", "object", "null" or "undefined". */
    public function typeName(): string
    {
        return Js::typeName($this->raw);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'flagKey' => $this->flagKey,
            'value' => $this->value,
            'reason' => $this->reason,
            'revision' => $this->revision,
            'ruleIndex' => $this->ruleIndex,
            'ruleId' => $this->ruleId,
            'inRollout' => $this->inRollout,
            'bucket' => $this->bucket,
            'trace' => array_map(static fn (TraceStep $t) => $t->toArray(), $this->trace),
            'error' => $this->error,
        ];
    }

    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
