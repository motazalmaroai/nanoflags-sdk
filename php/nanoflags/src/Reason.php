<?php

declare(strict_types=1);

namespace NanoFlags;

/** Why an evaluation produced its value (the engine's spelling). */
final class Reason
{
    /** A rule matched (a fixed value, or a percentage rollout). */
    public const RULE_MATCH = 'rule_match';
    /** No rule matched: the flag default. */
    public const DEFAULT = 'default';
    /** The flag is disabled in this environment: its off value. */
    public const OFF = 'off';
    /** No configuration is loaded, or it has no such flag: the application fallback. */
    public const FLAG_NOT_FOUND = 'flag_not_found';
    /** Evaluation error or type mismatch: the application fallback. */
    public const ERROR = 'error';
}
