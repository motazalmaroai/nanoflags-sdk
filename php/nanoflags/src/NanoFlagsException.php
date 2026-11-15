<?php

declare(strict_types=1);

namespace NanoFlags;

/**
 * An error of the client. It is reported through `onError` listeners and {@see Client::lastError()}; an accessor
 * never throws it. A failed update never changes the configuration in use.
 *
 * Codes: "network", "unauthorized", "http", "invalid_bundle", "store", "config", "signature", "engine".
 */
final class NanoFlagsException extends \RuntimeException
{
    public const NETWORK = 'network';
    public const UNAUTHORIZED = 'unauthorized';
    public const HTTP = 'http';
    public const INVALID_BUNDLE = 'invalid_bundle';
    public const STORE = 'store';
    public const CONFIG = 'config';
    public const SIGNATURE = 'signature';
    public const ENGINE = 'engine';

    public function __construct(
        string $message,
        /** One of the class constants. */
        public readonly string $errorCode,
        /** Set for "unauthorized" and "http" errors. */
        public readonly ?int $httpStatus = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }
}
