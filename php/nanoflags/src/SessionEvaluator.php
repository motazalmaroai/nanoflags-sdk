<?php

declare(strict_types=1);

namespace NanoFlags;

use NanoFlags\Engine\JsObject;

/**
 * Evaluator bound to one test session ({@see Client::session()}).
 *
 * While {@see isActive()}, flags are evaluated against the session's pinned bundle with the context
 * `session context + your context` (yours wins), and sampled events carry the session id. When the session is unknown,
 * not permitted for this service, or expired, it evaluates exactly like the client, so one code path serves normal
 * traffic and tests. A session changes which snapshot and context an evaluation uses; it grants no data access and
 * must not be used for authorization.
 */
final class SessionEvaluator
{
    /**
     * @internal created by {@see Client::session()}
     * @param array{id: string, bundle: JsObject, raw: string, context: JsObject, expiresAt: string, expiresAtTs: float, revision: int}|null $state
     * @param \Closure(string, mixed, mixed, ?callable, ?array): EvaluationDetail $detail
     * @param \Closure(): float $now
     * @param \Closure(): ?int $clientRevision
     */
    public function __construct(
        private readonly ?string $token,
        private readonly ?array $state,
        private readonly \Closure $detail,
        private readonly \Closure $now,
        private readonly \Closure $clientRevision,
    ) {
    }

    /** True while the session is known and has not expired. Re-evaluated on every call. */
    public function isActive(): bool
    {
        return $this->state !== null && ($this->now)() < $this->state['expiresAtTs'];
    }

    /** Session id, or null when the session could not be resolved. */
    public function id(): ?string
    {
        return $this->state['id'] ?? null;
    }

    /** ISO 8601 expiry time, or null when the session could not be resolved. */
    public function expiresAt(): ?string
    {
        return $this->state['expiresAt'] ?? null;
    }

    /** The revision evaluations currently run against. */
    public function revision(): ?int
    {
        return $this->isActive() ? $this->state['revision'] : ($this->clientRevision)();
    }

    /**
     * Headers to add to downstream calls so the next service joins the same session: `['x-nanoflags-session' =>
     * token]` for a well-formed token (also when this service could not resolve it), else `[]`. Always safe to merge.
     *
     * @return array<string, string>
     */
    public function headers(): array
    {
        return $this->token === null ? [] : [Client::SESSION_HEADER => $this->token];
    }

    public function boolVariation(string $key, bool $default, array|JsObject|\stdClass|null $context = null): bool
    {
        return $this->run($key, $default, $context, static fn ($v) => is_bool($v))->value;
    }

    public function stringVariation(string $key, string $default, array|JsObject|\stdClass|null $context = null): string
    {
        return $this->run($key, $default, $context, static fn ($v) => is_string($v))->value;
    }

    public function numberVariation(string $key, int|float $default, array|JsObject|\stdClass|null $context = null): int|float
    {
        return $this->run($key, $default, $context, Client::ACCEPT_NUMBER)->value;
    }

    public function jsonVariation(string $key, mixed $default, array|JsObject|\stdClass|null $context = null): mixed
    {
        return $this->run($key, $default, $context, Client::ACCEPT_ANY)->value;
    }

    public function boolVariationDetail(string $key, bool $default, array|JsObject|\stdClass|null $context = null): EvaluationDetail
    {
        return $this->run($key, $default, $context, static fn ($v) => is_bool($v));
    }

    public function stringVariationDetail(string $key, string $default, array|JsObject|\stdClass|null $context = null): EvaluationDetail
    {
        return $this->run($key, $default, $context, static fn ($v) => is_string($v));
    }

    public function numberVariationDetail(string $key, int|float $default, array|JsObject|\stdClass|null $context = null): EvaluationDetail
    {
        return $this->run($key, $default, $context, Client::ACCEPT_NUMBER);
    }

    public function jsonVariationDetail(string $key, mixed $default, array|JsObject|\stdClass|null $context = null): EvaluationDetail
    {
        return $this->run($key, $default, $context, Client::ACCEPT_ANY);
    }

    /** The full engine result without any type check. */
    public function evaluate(string $key, mixed $default, array|JsObject|\stdClass|null $context = null): EvaluationDetail
    {
        return $this->run($key, $default, $context, null);
    }

    public function __debugInfo(): array
    {
        return ['active' => $this->isActive(), 'id' => $this->id(), 'expiresAt' => $this->expiresAt(), 'revision' => $this->revision()];
    }

    private function run(string $key, mixed $default, mixed $context, ?callable $accepts): EvaluationDetail
    {
        return ($this->detail)($key, $default, $context, $accepts, $this->isActive() ? $this->state : null);
    }
}
