<?php

declare(strict_types=1);

namespace NanoFlags\OpenFeature;

use NanoFlags\Client;
use NanoFlags\EvaluationDetail;
use NanoFlags\Reason as NanoFlagsReason;
use OpenFeature\implementation\provider\AbstractProvider;
use OpenFeature\implementation\provider\ResolutionDetailsBuilder;
use OpenFeature\implementation\provider\ResolutionError;
use OpenFeature\interfaces\flags\EvaluationContext;
use OpenFeature\interfaces\provider\ErrorCode;
use OpenFeature\interfaces\provider\Reason;
use OpenFeature\interfaces\provider\ResolutionDetails;

/**
 * OpenFeature provider backed by a {@see Client}. Evaluations are local (the native engine), mapped like
 * `@nanoflags/openfeature-provider`: `targetingKey` becomes the bucketing identity `key`; `off` → DISABLED,
 * `default` → DEFAULT, a fixed rule → TARGETING_MATCH, a rollout rule → SPLIT (variant = rule id). Flag metadata
 * carries the revision.
 *
 *     $api = OpenFeature\OpenFeatureAPI::getInstance();
 *     $api->setProvider(new NanoFlagsProvider(new NanoFlags\Client(getenv('NANOFLAGS_SDK_KEY'), service: 'web')));
 *     $enabled = $api->getClient()->getBooleanValue('new-checkout', false, new EvaluationContext($userId));
 */
class NanoFlagsProvider extends AbstractProvider
{
    protected static string $NAME = 'NanoFlags';

    /** @var (\Closure(): object)|null */
    private ?\Closure $evaluator;

    /**
     * @param Client $client the NanoFlags client
     * @param (\Closure(): object)|null $evaluator returns the object to evaluate with per call (anything with the
     *        client's `evaluate()` and `revision()` methods); default: $client
     */
    public function __construct(public readonly Client $client, ?\Closure $evaluator = null)
    {
        $this->evaluator = $evaluator;
    }

    public function resolveBooleanValue(string $flagKey, bool $defaultValue, ?EvaluationContext $context = null): ResolutionDetails
    {
        return $this->resolve($flagKey, $defaultValue, $context, 'boolean');
    }

    public function resolveStringValue(string $flagKey, string $defaultValue, ?EvaluationContext $context = null): ResolutionDetails
    {
        return $this->resolve($flagKey, $defaultValue, $context, 'string');
    }

    public function resolveIntegerValue(string $flagKey, int $defaultValue, ?EvaluationContext $context = null): ResolutionDetails
    {
        return $this->resolve($flagKey, $defaultValue, $context, 'integer');
    }

    public function resolveFloatValue(string $flagKey, float $defaultValue, ?EvaluationContext $context = null): ResolutionDetails
    {
        return $this->resolve($flagKey, $defaultValue, $context, 'float');
    }

    /** @param mixed[] $defaultValue */
    public function resolveObjectValue(string $flagKey, array $defaultValue, ?EvaluationContext $context = null): ResolutionDetails
    {
        return $this->resolve($flagKey, $defaultValue, $context, 'object');
    }

    /**
     * OpenFeature context → NanoFlags context. The targeting key becomes `key` and wins over an attribute `key`.
     *
     * @return array<string, mixed>
     */
    public static function toNanoFlagsContext(?EvaluationContext $context): array
    {
        if ($context === null) {
            return [];
        }
        $out = [];
        foreach ($context->getAttributes()->toArray() as $name => $value) {
            if ($name === 'targetingKey') {
                continue;
            }
            $out[(string) $name] = $value;
        }
        $tk = $context->getTargetingKey();
        if (is_string($tk) && $tk !== '') {
            $out['key'] = $tk;
        }
        return $out;
    }

    private function resolve(string $flagKey, mixed $defaultValue, ?EvaluationContext $context, string $kind): ResolutionDetails
    {
        $target = $this->evaluator !== null ? ($this->evaluator)() : $this->client;
        try {
            /** @var EvaluationDetail $e */
            $e = $target->evaluate($flagKey, null, self::toNanoFlagsContext($context));
        } catch (\Throwable $err) {
            return self::failure($defaultValue, ErrorCode::GENERAL(), $err->getMessage(), []);
        }
        $meta = ['revision' => $e->revision];
        if ($e->reason === NanoFlagsReason::FLAG_NOT_FOUND) {
            if ($target->revision() === null) {
                return self::failure($defaultValue, ErrorCode::PROVIDER_NOT_READY(), 'NanoFlags has no configuration loaded yet.', $meta);
            }
            return self::failure($defaultValue, ErrorCode::FLAG_NOT_FOUND(), sprintf('Flag "%s" is not in the loaded configuration (r%d).', $flagKey, $e->revision), $meta);
        }
        if ($e->reason === NanoFlagsReason::ERROR) {
            return self::failure($defaultValue, ErrorCode::GENERAL(), $e->error ?? 'Evaluation failed.', $meta);
        }
        $value = $e->value;
        $ok = match ($kind) {
            'boolean' => is_bool($value),
            'string' => is_string($value),
            'integer' => is_int($value) || (is_float($value) && is_finite($value) && floor($value) === $value),
            'float' => is_int($value) || (is_float($value) && is_finite($value)),
            default => is_array($value),
        };
        if (!$ok) {
            return self::failure($defaultValue, ErrorCode::TYPE_MISMATCH(), sprintf('Flag "%s" has a %s value; a %s was requested.', $flagKey, $e->typeName(), $kind), $meta);
        }
        if ($kind === 'integer') {
            $value = (int) $value;
        } elseif ($kind === 'float') {
            $value = (float) $value;
        }
        $reason = match ($e->reason) {
            NanoFlagsReason::OFF => Reason::DISABLED,
            NanoFlagsReason::DEFAULT => Reason::DEFAULT,
            default => $e->inRollout === null ? Reason::TARGETING_MATCH : Reason::SPLIT,
        };
        $b = (new ResolutionDetailsBuilder())->withValue($value)->withReason($reason);
        if ($e->ruleId !== null) {
            $b = $b->withVariant($e->ruleId);
        }
        if (method_exists($b, 'withMetadata')) {
            $b = $b->withMetadata($meta);
        }
        return $b->build();
    }

    /** @param array<string, mixed> $meta */
    private static function failure(mixed $defaultValue, ErrorCode $code, string $message, array $meta): ResolutionDetails
    {
        $b = (new ResolutionDetailsBuilder())->withValue($defaultValue)->withReason(Reason::ERROR)->withError(new ResolutionError($code, $message));
        if ($meta !== [] && method_exists($b, 'withMetadata')) {
            $b = $b->withMetadata($meta);
        }
        return $b->build();
    }
}
