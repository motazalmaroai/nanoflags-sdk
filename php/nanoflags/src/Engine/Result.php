<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/**
 * The outcome of {@see Engine::evaluate()}, mirroring the TypeScript engine's `Evaluation` object. Values are engine
 * values ({@see Js}); the client converts them to plain PHP data.
 */
final class Result
{
    /** @param list<TraceStep> $trace */
    public function __construct(
        public readonly string $flagKey,
        /** The served value; {@see Undefined} when the configuration served nothing (a malformed flag). */
        public readonly mixed $value,
        /** "rule_match", "default", "off", "flag_not_found" or "error". */
        public readonly string $reason,
        /** The bundle's `revision` (0.0 without a bundle). */
        public readonly mixed $revision = 0.0,
        /** Zero-based index of the matching rule. */
        public readonly ?int $ruleIndex = null,
        /** The matching rule's `id` ({@see Undefined} when there is none). */
        public readonly mixed $ruleId = null,
        public readonly ?bool $inRollout = null,
        public readonly ?float $bucket = null,
        public readonly array $trace = [],
        /** The evaluation error message (reason "error" only). */
        public readonly ?string $error = null,
    ) {
    }
}
