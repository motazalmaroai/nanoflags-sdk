<?php

declare(strict_types=1);

namespace NanoFlags;

/** The state of the configuration in use. */
final class Status
{
    /** No configuration is loaded: every evaluation returns its fallback. */
    public const NOT_READY = 'not-ready';
    /** The configuration is known to be current (revalidated within the cache TTL). */
    public const READY = 'ready';
    /** A configuration is in use but is not known to be current (edge unreachable, served stale, cache-only, …). */
    public const STALE = 'stale';
}
