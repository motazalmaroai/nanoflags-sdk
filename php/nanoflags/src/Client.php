<?php

declare(strict_types=1);

namespace NanoFlags;

use NanoFlags\Engine\Engine;
use NanoFlags\Engine\Js;
use NanoFlags\Engine\JsObject;
use NanoFlags\Engine\Json;
use NanoFlags\Engine\Result;
use NanoFlags\Engine\TraceStep;
use NanoFlags\Engine\Undefined;
use NanoFlags\Http\CurlTransport;
use NanoFlags\Http\Psr18Transport;
use NanoFlags\Http\Response;
use NanoFlags\Http\StreamingTransport;
use NanoFlags\Http\StreamTransport;
use NanoFlags\Http\Transport;
use NanoFlags\Store\ApcuStore;
use NanoFlags\Store\FileStore;
use NanoFlags\Store\Psr16Store;
use NanoFlags\Store\Store;
use NanoFlags\Verify\Signature;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;
use Psr\Log\LoggerInterface;
use Psr\SimpleCache\CacheInterface;

/**
 * The NanoFlags client for PHP.
 *
 * Flags are evaluated locally against a configuration bundle. PHP usually runs one request at a time and keeps
 * nothing between requests, so the client is built around a shared cache ({@see Store}: APCu, a directory, or any
 * PSR-16 cache) instead of background threads:
 *
 * - The first evaluation of a request reads the bundle from the cache. Within `cacheTtl` seconds of its last
 *   revalidation it is used as it is; after that the client sends one conditional request (`If-None-Match`) to the
 *   edge, which answers `304 Not Modified` when nothing changed. Signed bundles are verified, also when read back.
 * - When the edge cannot be reached, the last good bundle keeps serving (status "stale") and the edge is retried
 *   after `retryInterval` seconds, not on every request. Evaluations never throw; without any configuration they
 *   return the application default.
 * - Sampled evaluation events (no attribute values by default) are buffered in the cache and sent at most once per
 *   flush interval, at the end of a request.
 *
 * Test sessions (`x-nanoflags-session`) are resolved on demand with {@see session()}.
 *
 * Create one client per request (or per worker in long-running PHP); construction does no I/O. For a fleet of web
 * workers that should never wait for the edge, run `vendor/bin/nanoflags-sync` (it keeps the shared cache current,
 * optionally over the edge's event stream) and create the web clients with `refresh: false`.
 */
final class Client
{
    public const SDK_VERSION = '0.3.1';
    /** The newest bundle format (`bundle.engine`) this SDK evaluates. Newer bundles are refused. */
    public const SUPPORTED_ENGINE_VERSION = Engine::VERSION;
    /** Header that carries a test-session token between services. */
    public const SESSION_HEADER = 'x-nanoflags-session';
    /** @internal */
    public const ACCEPT_NUMBER = [self::class, 'acceptsNumber'];
    /** @internal */
    public const ACCEPT_ANY = [self::class, 'acceptsAny'];

    private const MAX_QUEUE = 500;
    private const MAX_BATCH = 50;
    private const MAX_EVENT_VALUE_CHARS = 1024;
    private const KEYS_REFETCH = 60.0;
    private const MEMO_SIZE = 16;
    private const MAX_SESSIONS = 1000;
    private const SESSION_MISS_TTL = 15.0;
    private const SESSION_ERROR_TTL = 3.0;
    /** Longest time an active session is kept in the shared cache before it is asked for again. */
    private const SESSION_SHARED_TTL = 3600;

    /** @var array<string, array{JsObject, array<string, true>}> parsed bundles by text hash, with the signatures verified for them */
    private static array $memo = [];

    private readonly string $sdkKey;
    private readonly string $baseUrl;
    private readonly string $service;
    private readonly string $id;
    private readonly bool $browserKey;
    private readonly ?Store $store;
    private readonly Transport $http;
    private readonly ?LoggerInterface $logger;
    /** @var \Closure(): float */
    private readonly \Closure $clock;
    /** @var \Closure(): float */
    private readonly \Closure $random;

    /** @var array{base: list<array{kid: ?string, key: string}>, require: bool, refetch: bool}|null */
    private ?array $verifier = null;
    /** @var list<array{kid: ?string, key: string}> */
    private array $fetchedKeys = [];
    private float $keysFetchedAt = 0.0;
    /** @var array<string, array{keys: list<array{kid: ?string, key: string}>, at: float}> keys loaded from /v1/keys by this PHP process, by base URL (process memory only, never the shared cache) */
    private static array $processKeys = [];
    /**
     * Verification hardening: the newest revision this client has verified (signature checked against the embedded,
     * pinned or freshly fetched keys) and adopted. Anything older is refused, see {@see Client::fetch()}.
     */
    private ?int $newestVerified = null;
    /** The unsigned-answer error of the current load (the edge's own publisher-lag signal): it leaves the status unchanged. */
    private ?NanoFlagsException $unsignedLag = null;

    private bool $eventsEnabled;
    private float $sampleRate = 0.1;
    private float $flushInterval = 10.0;
    private float $reportInterval = 60.0;
    private float $eventsTimeout = 2.0;
    /** @var (callable(array<string, mixed>): array<string, mixed>)|null */
    private $redact = null;

    /** @var list<callable(NanoFlagsException): void> */
    private array $errorListeners = [];
    /** @var list<NanoFlagsException> errors found while configuring, reported on first use */
    private array $pendingErrors = [];

    /** @var array{bundle: JsObject, revision: int, raw: string, etag: ?string, checksum: ?string, sig: ?array, source: string}|null */
    private ?array $snapshot = null;
    /** @var array{bundle: JsObject, revision: int, raw: string, etag: ?string, checksum: ?string, sig: ?array, source: string}|null */
    private ?array $bootstrap = null;
    private string $status = Status::NOT_READY;
    private ?NanoFlagsException $lastError = null;
    private bool $loaded = false;
    private float $checkedAt = 0.0;
    private bool $shutdownRegistered = false;
    /** @var array<string, list<string>> */
    private array $attrs = [];
    private string $attrsFor = '';
    /** @var list<string> event JSON texts */
    private array $queue = [];
    /** @var array<string, array{0: ?array, 1: float}> resolved test sessions of this client: [state, valid until] */
    private array $sessions = [];

    /**
     * @param string $sdkKey `nf_srv_…` (server view) or `nf_pub_…` (client-exposed flags only)
     * @param string $baseUrl the edge; signatures are verified by default on the hosted edge
     * @param string $service the name shown in "which revision is each service running"
     * @param Store|CacheInterface|false|null $cache where the bundle is shared between requests. null: APCu when
     *        enabled, else a private directory under sys_get_temp_dir(). false: no cache (every new client fetches).
     * @param float $cacheTtl seconds a revalidated bundle is used without asking the edge again
     * @param bool $refresh false: never request bundles; read them from the cache only (kept current by
     *        `bin/nanoflags-sync` or another process)
     * @param bool $offline true: no network at all (bootstrap / cache only, no telemetry)
     * @param float $timeout seconds for one bundle request (it can run on the request path; keep it short)
     * @param float $retryInterval seconds before the edge is asked again after a failed request
     * @param array<string, mixed>|string|null $bootstrap a bundle (decoded array or JSON text) used until, or
     *        whenever, nothing better is available
     * @param bool|array{publicKeys?: list<array<string, string>>, require?: bool, fetchKeys?: bool}|null $verify
     *        signature verification: null (default) on for the hosted edge; false off; true on with keys from the
     *        edge's /v1/keys; an array to pin keys or require signatures
     * @param bool|array{sampleRate?: float, flushInterval?: float, reportInterval?: float, timeout?: float, redact?: callable}|null $events
     *        sampled evaluation telemetry; false disables it
     * @param Transport|ClientInterface|null $http a transport, or a PSR-18 client (then pass both factories)
     * @param (callable(NanoFlagsException): void)|null $onError called for every background error
     * @param (\Closure(): float)|null $clock seconds since the epoch (tests)
     * @param (\Closure(): float)|null $random a number in [0, 1) for event sampling (tests)
     */
    public function __construct(
        string $sdkKey,
        string $baseUrl = Keys::OFFICIAL_EDGE_URL,
        string $service = 'unknown',
        Store|CacheInterface|false|null $cache = null,
        private readonly float $cacheTtl = 30.0,
        private readonly bool $refresh = true,
        private readonly bool $offline = false,
        private readonly float $timeout = 3.0,
        private readonly float $retryInterval = 5.0,
        array|string|null $bootstrap = null,
        bool|array|null $verify = null,
        bool|array|null $events = null,
        Transport|ClientInterface|null $http = null,
        ?RequestFactoryInterface $requestFactory = null,
        ?StreamFactoryInterface $streamFactory = null,
        ?LoggerInterface $logger = null,
        ?callable $onError = null,
        ?\Closure $clock = null,
        ?\Closure $random = null,
    ) {
        $this->sdkKey = $sdkKey;
        $this->baseUrl = self::normalizeBaseUrl($baseUrl);
        $this->service = $service !== '' ? $service : 'unknown';
        $this->id = sprintf('%08x', Engine::murmur3($this->baseUrl . '|' . $sdkKey));
        $this->browserKey = str_starts_with($sdkKey, 'nf_pub_');
        $this->logger = $logger;
        $this->clock = $clock ?? static fn (): float => microtime(true);
        $this->random = $random ?? static fn (): float => mt_rand() / (mt_getrandmax() + 1);
        if ($onError !== null) {
            $this->errorListeners[] = $onError;
        }

        if (trim($sdkKey) === '') {
            $this->pendingErrors[] = new NanoFlagsException('An SDK key is required.', NanoFlagsException::CONFIG);
        }
        if (!preg_match('#^https?://#i', $this->baseUrl)) {
            $this->pendingErrors[] = new NanoFlagsException(sprintf('The base URL must be an http(s) URL, got "%s".', $baseUrl), NanoFlagsException::CONFIG);
        }

        // ---- cache
        if ($cache === false) {
            $this->store = null;
        } elseif ($cache instanceof Store) {
            $this->store = $cache;
        } elseif ($cache instanceof CacheInterface) {
            $this->store = new Psr16Store($cache);
        } else {
            $this->store = ApcuStore::available() ? new ApcuStore() : new FileStore(FileStore::defaultDirectory());
        }

        // ---- transport
        if ($http instanceof Transport) {
            $this->http = $http;
        } elseif ($http instanceof ClientInterface) {
            if ($requestFactory === null || $streamFactory === null) {
                $this->pendingErrors[] = new NanoFlagsException('A PSR-18 client needs a PSR-17 request factory and stream factory (requestFactory, streamFactory); the built-in transport is used instead.', NanoFlagsException::CONFIG);
                $this->http = CurlTransport::available() ? new CurlTransport() : new StreamTransport();
            } else {
                $this->http = new Psr18Transport($http, $requestFactory, $streamFactory);
            }
        } else {
            $this->http = CurlTransport::available() ? new CurlTransport() : new StreamTransport();
        }

        // ---- verification
        $official = $this->baseUrl === Keys::OFFICIAL_EDGE_URL;
        if ($verify === null) {
            if ($official) {
                $this->verifier = ['base' => Signature::importKeys(Keys::OFFICIAL_SIGNING_KEYS), 'require' => true, 'refetch' => true];
            }
        } elseif ($verify === true) {
            $this->verifier = $official
                ? ['base' => Signature::importKeys(Keys::OFFICIAL_SIGNING_KEYS), 'require' => true, 'refetch' => true]
                : ['base' => [], 'require' => true, 'refetch' => true];
        } elseif (is_array($verify)) {
            $keys = $verify['publicKeys'] ?? null;
            $require = (bool) ($verify['require'] ?? $official);
            if (is_array($keys) && $keys !== []) {
                foreach ($keys as $k) {
                    if (!Signature::isPublicEd25519($k)) {
                        $this->pendingErrors[] = new NanoFlagsException('`verify.publicKeys` must contain public Ed25519 JWKs only. Other entries (including private keys) were ignored.', NanoFlagsException::CONFIG);
                        break;
                    }
                }
                $this->verifier = ['base' => Signature::importKeys($keys), 'require' => $require, 'refetch' => (bool) ($verify['fetchKeys'] ?? false)];
            } elseif (($verify['fetchKeys'] ?? false) || !$official) {
                $this->verifier = ['base' => [], 'require' => $require, 'refetch' => true];
            } else {
                $this->verifier = ['base' => Signature::importKeys(Keys::OFFICIAL_SIGNING_KEYS), 'require' => $require, 'refetch' => true];
            }
        }
        if ($this->verifier !== null && !Signature::available()) {
            $this->pendingErrors[] = new NanoFlagsException('Signature verification needs ext-sodium (or paragonie/sodium_compat); without it every signed bundle is refused. Install one, or pass verify: false for a self-hosted edge you trust.', NanoFlagsException::CONFIG);
        }

        // ---- telemetry
        $this->eventsEnabled = $events !== false && !$offline;
        if (is_array($events)) {
            $this->sampleRate = (float) ($events['sampleRate'] ?? 0.1);
            $this->flushInterval = (float) ($events['flushInterval'] ?? 10.0);
            $this->reportInterval = (float) ($events['reportInterval'] ?? 60.0);
            $this->eventsTimeout = (float) ($events['timeout'] ?? 2.0);
            $this->redact = isset($events['redact']) && is_callable($events['redact']) ? $events['redact'] : null;
        }
        $this->sampleRate = min(1.0, max(0.0, $this->sampleRate));

        // ---- bootstrap
        if ($bootstrap !== null) {
            try {
                if (is_array($bootstrap)) {
                    // json_decode(..., true) turns empty objects into []: flags and segments are objects.
                    foreach (['flags', 'segments'] as $m) {
                        if (($bootstrap[$m] ?? null) === []) {
                            $bootstrap[$m] = new JsObject([]);
                        }
                    }
                }
                $doc = is_string($bootstrap) ? Json::parse($bootstrap) : Js::fromPhp($bootstrap);
            } catch (\Throwable) {
                $doc = null;
            }
            if (!Engine::isBundle($doc)) {
                $this->pendingErrors[] = new NanoFlagsException('The bootstrap bundle is invalid and was ignored.', NanoFlagsException::INVALID_BUNDLE);
            } elseif (!Engine::supportsEngine($doc->get('engine'))) {
                $this->pendingErrors[] = $this->engineError($doc);
            } else {
                $raw = (string) Js::stringify($doc);
                $this->bootstrap = ['bundle' => $doc, 'revision' => self::revisionOf($doc), 'raw' => $raw, 'etag' => null, 'checksum' => null, 'sig' => null, 'source' => 'bootstrap'];
            }
        }
    }

    /**
     * `https://EDGE.nanoflags.io:443/`, a trailing dot or trailing slashes are the official edge; anything else (another
     * host, scheme or port, a path, user info, a query) is left as given (minus trailing slashes).
     */
    private static function normalizeBaseUrl(string $raw): string
    {
        $trimmed = rtrim($raw, '/');
        if (preg_match('~^https://([A-Za-z0-9.-]+)(?::443)?$~iD', $trimmed, $m) === 1 && strtolower(rtrim($m[1], '.')) === (string) parse_url(Keys::OFFICIAL_EDGE_URL, PHP_URL_HOST)) {
            return Keys::OFFICIAL_EDGE_URL;
        }
        return $trimmed;
    }

    public function __destruct()
    {
        $this->shutdown();
    }

    /* ================================================================== evaluation */

    /** The boolean value of $key for $context; $default when the flag is unknown, not a boolean, or nothing is loaded. */
    public function boolVariation(string $key, bool $default, array|JsObject|\stdClass|null $context = null): bool
    {
        return $this->detail($key, $default, $context, static fn ($v) => is_bool($v))->value;
    }

    public function stringVariation(string $key, string $default, array|JsObject|\stdClass|null $context = null): string
    {
        return $this->detail($key, $default, $context, static fn ($v) => is_string($v))->value;
    }

    /** A number flag; whole numbers are returned as int. */
    public function numberVariation(string $key, int|float $default, array|JsObject|\stdClass|null $context = null): int|float
    {
        return $this->detail($key, $default, $context, self::ACCEPT_NUMBER)->value;
    }

    /** A JSON flag as plain PHP data (objects as associative arrays); any served value is accepted. */
    public function jsonVariation(string $key, mixed $default, array|JsObject|\stdClass|null $context = null): mixed
    {
        return $this->detail($key, $default, $context, self::ACCEPT_ANY)->value;
    }

    public function boolVariationDetail(string $key, bool $default, array|JsObject|\stdClass|null $context = null): EvaluationDetail
    {
        return $this->detail($key, $default, $context, static fn ($v) => is_bool($v));
    }

    public function stringVariationDetail(string $key, string $default, array|JsObject|\stdClass|null $context = null): EvaluationDetail
    {
        return $this->detail($key, $default, $context, static fn ($v) => is_string($v));
    }

    public function numberVariationDetail(string $key, int|float $default, array|JsObject|\stdClass|null $context = null): EvaluationDetail
    {
        return $this->detail($key, $default, $context, self::ACCEPT_NUMBER);
    }

    public function jsonVariationDetail(string $key, mixed $default, array|JsObject|\stdClass|null $context = null): EvaluationDetail
    {
        return $this->detail($key, $default, $context, self::ACCEPT_ANY);
    }

    /** The full engine result without any type check. */
    public function evaluate(string $key, mixed $default, array|JsObject|\stdClass|null $context = null): EvaluationDetail
    {
        return $this->detail($key, $default, $context, null);
    }

    /**
     * Every flag of the configuration in use, evaluated for $context: flag key => value (null for a flag that serves
     * nothing). Empty without a configuration. Records no telemetry.
     *
     * @return array<string, mixed>
     */
    public function allFlags(array|JsObject|\stdClass|null $context = null): array
    {
        $out = [];
        foreach ($this->allFlagsDetail($context) as $k => $d) {
            $out[$k] = $d->value;
        }
        return $out;
    }

    /** @return array<string, EvaluationDetail> */
    public function allFlagsDetail(array|JsObject|\stdClass|null $context = null): array
    {
        $out = [];
        try {
            $this->ensure();
            $s = $this->snapshot;
            if ($s === null) {
                return [];
            }
            $ctx = self::toContext($context);
            $flags = $s['bundle']->get('flags');
            foreach ($flags as $k => $_) {
                $r = Engine::evaluate($s['bundle'], $k, $ctx, null);
                if ($r->reason === Reason::FLAG_NOT_FOUND) {
                    continue; // keys whose entry is not a flag at all
                }
                $out[$k] = EvaluationDetail::fromResult($r, null);
            }
        } catch (\Throwable) {
            // accessors never throw
        }
        return $out;
    }

    /**
     * @param (callable(mixed): bool)|null $accepts
     * @param array{id: string, bundle: JsObject, context: JsObject}|null $scope an active test session
     */
    private function detail(string $key, mixed $default, array|JsObject|\stdClass|null $context, ?callable $accepts, ?array $scope = null): EvaluationDetail
    {
        try {
            $this->ensure();
            if ($scope !== null) {
                $bundle = $scope['bundle'];
                $members = $scope['context']->members();
                foreach (self::toContext($context)->members() as $k => $v) {
                    $members[$k] = $v; // the request's context wins
                }
                $ctx = new JsObject($members);
            } else {
                $bundle = $this->snapshot['bundle'] ?? null;
                $ctx = self::toContext($context);
            }
            $fallback = Js::fromPhp($default);
            $r = Engine::evaluate($bundle, $key, $ctx, $fallback);
            if ($accepts !== null && $r->reason !== Reason::FLAG_NOT_FOUND && $r->reason !== Reason::ERROR && !$accepts($r->value)) {
                $error = sprintf('Flag "%s" has a %s value, which does not match the requested type.', $key, Js::typeName($r->value));
                $r = new Result($key, $fallback, Reason::ERROR, $r->revision, null, Undefined::value(), null, null, [...$r->trace, new TraceStep('result', 'Returned the fallback', $error)], $error);
            }
            $this->record($r, $scope === null ? $context : null, $ctx, $bundle, $scope['id'] ?? null);
            return EvaluationDetail::fromResult($r, $default);
        } catch (\Throwable $e) {
            return new EvaluationDetail($key, $default, Reason::ERROR, 0, null, null, null, null, [], $e->getMessage());
        }
    }

    /** @internal */
    public static function acceptsNumber(mixed $v): bool
    {
        return is_float($v) && is_finite($v);
    }

    /** @internal */
    public static function acceptsAny(mixed $v): bool
    {
        return !($v instanceof Undefined);
    }

    private static function toContext(array|JsObject|\stdClass|null $context): JsObject
    {
        if ($context === null || $context === []) {
            return new JsObject([]);
        }
        $v = Js::fromPhp($context);
        return $v instanceof JsObject ? $v : new JsObject([]);
    }

    /* ================================================================== state */

    /** "not-ready", "ready" or "stale" (see {@see Status}). Loads the configuration if this has not happened yet. */
    public function status(): string
    {
        $this->safeEnsure();
        return $this->status;
    }

    /** The revision in use, or null when no configuration is loaded. */
    public function revision(): ?int
    {
        $this->safeEnsure();
        return $this->snapshot['revision'] ?? null;
    }

    /** Where the configuration in use came from: "network", "cache", "bootstrap", or null. */
    public function source(): ?string
    {
        $this->safeEnsure();
        return $this->snapshot['source'] ?? null;
    }

    /** True when a configuration is in use (ready or stale). */
    public function isReady(): bool
    {
        return $this->status() !== Status::NOT_READY;
    }

    /** The last background error, if any (the client never throws it). */
    public function lastError(): ?NanoFlagsException
    {
        return $this->lastError;
    }

    /** The bundle in use as JSON text (the signed bytes when it was signed), or null. */
    public function bundleJson(): ?string
    {
        $this->safeEnsure();
        return $this->snapshot['raw'] ?? null;
    }

    /**
     * Registers a listener for background errors (failed requests, rejected signatures, …). A failed update never
     * changes the configuration in use. Returns a function that removes the listener.
     *
     * @param callable(NanoFlagsException): void $listener
     */
    public function onError(callable $listener): \Closure
    {
        $this->errorListeners[] = $listener;
        return function () use ($listener): void {
            $this->errorListeners = array_values(array_filter($this->errorListeners, static fn ($l) => $l !== $listener));
        };
    }

    /**
     * Revalidates the configuration now (ignoring the cache TTL and the retry interval) and returns whether a
     * current configuration is in use afterwards. Errors are reported, never thrown.
     */
    public function refresh(): bool
    {
        try {
            $this->reportPending();
            $this->sync(true);
        } catch (\Throwable $e) {
            $this->emitError(new NanoFlagsException('Refresh failed: ' . $e->getMessage(), NanoFlagsException::NETWORK, null, $e));
        }
        return $this->status === Status::READY;
    }

    private function safeEnsure(): void
    {
        try {
            $this->ensure();
        } catch (\Throwable) {
            // reported already
        }
    }

    private function now(): float
    {
        return ($this->clock)();
    }

    private function ensure(): void
    {
        if ($this->loaded && $this->now() - $this->checkedAt < $this->cacheTtl) {
            return;
        }
        $this->reportPending();
        $this->registerShutdown();
        $this->sync(false);
    }

    private function reportPending(): void
    {
        $pending = $this->pendingErrors;
        $this->pendingErrors = [];
        foreach ($pending as $e) {
            $this->emitError($e);
        }
    }

    private function registerShutdown(): void
    {
        if ($this->shutdownRegistered || !$this->eventsEnabled) {
            return;
        }
        $this->shutdownRegistered = true;
        $ref = \WeakReference::create($this);
        register_shutdown_function(static function () use ($ref): void {
            $ref->get()?->shutdown();
        });
    }

    private function cacheKey(string $what): string
    {
        return 'nanoflags.' . $what . '.' . $this->id;
    }

    /**
     * What the shared cache holds, and what is trusted from it: one entry per client (base URL + SDK key) with the signed
     * bundle text, its signature and the pinned environment. On every read the bundle is verified again against the
     * embedded keys, the keys the caller pinned, or keys fetched from /v1/keys in this process; the revision of that
     * verified copy is the floor for later answers, also in other requests. The cache never supplies key material
     * (nothing read back from it is used as a signing key), and fields it carries that are not re-derived from the
     * verified bundle (such as a revision number) are not trusted.
     */
    /** @return array<string, mixed>|null */
    private function readEntry(): ?array
    {
        if ($this->store === null) {
            return null;
        }
        try {
            $text = $this->store->get($this->cacheKey('bundle'));
        } catch (\Throwable $e) {
            $this->emitError(new NanoFlagsException('Could not read the cached bundle: ' . $e->getMessage(), NanoFlagsException::STORE, null, $e));
            return null;
        }
        if ($text === null || $text === '') {
            return null;
        }
        $e = json_decode($text, true);
        return is_array($e) && ($e['v'] ?? null) === 1 && ($e['id'] ?? null) === $this->id ? $e : null;
    }

    /** @param array<string, mixed> $entry */
    private function writeEntry(array $entry): void
    {
        if ($this->store === null) {
            return;
        }
        $entry['v'] = 1;
        $entry['id'] = $this->id;
        try {
            $this->store->set($this->cacheKey('bundle'), (string) json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
        } catch (\Throwable $e) {
            $this->emitError(new NanoFlagsException('Could not cache the bundle: ' . $e->getMessage(), NanoFlagsException::STORE, null, $e));
        }
    }

    /**
     * The usable bundle in a cache entry (verified again when verification is on), or null.
     *
     * @param array<string, mixed> $entry
     * @return array{bundle: JsObject, revision: int, raw: string, etag: ?string, checksum: ?string, sig: ?array, source: string}|null
     */
    private function entrySnapshot(array $entry): ?array
    {
        $raw = $entry['raw'] ?? null;
        if (!is_string($raw)) {
            return null;
        }
        $sig = self::sigFrom($entry['sig'] ?? null);
        $bundle = $this->parseBundle($raw, $sig);
        if ($bundle === null) {
            return null;
        }
        if (!Engine::supportsEngine($bundle[0]->get('engine'))) {
            $this->emitError($this->engineError($bundle[0]));
            return null;
        }
        $revision = self::revisionOf($bundle[0]);
        if ($this->verifier !== null) {
            if ($sig !== null && $sig['revision'] === $revision) {
                if (!$bundle[1] && !$this->verifyMemo($raw, $sig)) {
                    $this->emitError(new NanoFlagsException('The cached bundle failed signature verification and was ignored.', NanoFlagsException::SIGNATURE));
                    return null;
                }
            } elseif ($this->verifier['require']) {
                return null;
            } else {
                $sig = null;
            }
        }
        return [
            'bundle' => $bundle[0], 'revision' => $revision, 'raw' => $raw,
            'etag' => is_string($entry['etag'] ?? null) ? $entry['etag'] : null,
            'checksum' => is_string($entry['checksum'] ?? null) ? $entry['checksum'] : null,
            'sig' => $sig, 'source' => 'cache',
        ];
    }

    /**
     * Parses a bundle text (memoised per process by its hash, so long-running workers and repeated clients do not
     * parse or verify the same text twice).
     *
     * @param array{signature: string, kid: ?string, environmentId: string, revision: int, checksum: string}|null $sig
     * @return array{JsObject, bool}|null the bundle and whether $sig was verified for this exact text before
     */
    private function parseBundle(string $raw, ?array $sig): ?array
    {
        $h = hash('sha256', $raw);
        if (isset(self::$memo[$h])) {
            [$bundle, $verified] = self::$memo[$h];
            return [$bundle, $sig !== null && isset($verified[$sig['signature']])];
        }
        try {
            $doc = Json::parse($raw);
        } catch (\Throwable) {
            return null;
        }
        if (!Engine::isBundle($doc)) {
            return null;
        }
        $this->remember($raw, null, $doc);
        return [$doc, false];
    }

    /** @param array{signature: string, kid: ?string, environmentId: string, revision: int, checksum: string} $sig */
    private function verifyMemo(string $raw, array $sig): bool
    {
        try {
            $keys = $this->keysFor($sig['kid']);
        } catch (\Throwable) {
            return false;
        }
        if (!Signature::verify($keys, $sig, $raw)) {
            return false;
        }
        $this->remember($raw, $sig, null);
        return true;
    }

    /** @param array{signature: string}|null $sig a signature that verified for $raw */
    private function remember(string $raw, ?array $sig, ?JsObject $bundle): void
    {
        $h = hash('sha256', $raw);
        if (!isset(self::$memo[$h])) {
            if ($bundle === null) {
                return;
            }
            if (count(self::$memo) >= self::MEMO_SIZE) {
                array_shift(self::$memo);
            }
            self::$memo[$h] = [$bundle, []];
        }
        if ($sig !== null) {
            self::$memo[$h][1][$sig['signature']] = true;
        }
    }

    /** @return array{signature: string, kid: ?string, environmentId: string, revision: int, checksum: string}|null */
    private static function sigFrom(mixed $s): ?array
    {
        if (!is_array($s) || !is_string($s['signature'] ?? null) || !is_string($s['environmentId'] ?? null) || !is_string($s['checksum'] ?? null) || !is_int($s['revision'] ?? null)) {
            return null;
        }
        $kid = $s['kid'] ?? null;
        return ['signature' => $s['signature'], 'kid' => is_string($kid) && $kid !== '' ? $kid : null, 'environmentId' => $s['environmentId'], 'revision' => $s['revision'], 'checksum' => $s['checksum']];
    }

    private static function revisionOf(JsObject $bundle): int
    {
        $r = $bundle->get('revision');
        return is_float($r) && is_finite($r) ? (int) $r : 0;
    }

    /** @param array{bundle: JsObject, revision: int, raw: string, etag: ?string, checksum: ?string, sig: ?array, source: string}|null $snap */
    private function adopt(?array $snap, string $status): void
    {
        if ($snap === null) {
            $snap = $this->bootstrap;
            if ($snap !== null && $status === Status::NOT_READY) {
                $status = $this->offline ? Status::READY : Status::STALE;
            }
        }
        $this->snapshot = $snap;
        $this->status = $snap === null ? Status::NOT_READY : $status;
    }

    /** One load: the cache, then (when it is due) a conditional request to the edge. */
    private function sync(bool $force): void
    {
        $now = $this->now();
        $this->loaded = true;
        $this->checkedAt = $now;
        $entry = $this->readEntry();
        $candidate = $entry !== null ? $this->entrySnapshot($entry) : null;
        if ($candidate === null && $this->snapshot !== null && $this->snapshot['source'] !== 'bootstrap') {
            $candidate = $this->snapshot; // the cache was cleared under us: keep what this process has
        }
        $cachedStatus = ($entry['stale'] ?? false) === true ? Status::STALE : Status::READY;
        if ($candidate !== null && $this->verifier !== null) {
            if ($candidate['source'] === 'cache' && $this->newestVerified !== null && $candidate['revision'] < $this->newestVerified) {
                // The cached copy is older than a revision this client already verified: keep what is in use. The stale
                // cache entry is replaced when the edge confirms the copy in use (or a newer bundle arrives).
                $this->emitError($this->rollbackError($candidate['revision'], $this->newestVerified, 'cached'));
                $keep = $this->snapshot !== null && $this->snapshot['source'] !== 'bootstrap' && $this->snapshot['revision'] >= $this->newestVerified ? $this->snapshot : null;
                $entry = $keep !== null ? ['env' => $keep['sig']['environmentId'] ?? null] : null;
                $candidate = $keep;
                $cachedStatus = Status::STALE;
            }
            if ($candidate !== null && $candidate['sig'] !== null) {
                $this->noteVerified($candidate['revision']); // a cached signed copy was re-verified above: its revision is the floor
            }
        }
        $fetchedAt = is_numeric($entry['fetchedAt'] ?? null) ? (float) $entry['fetchedAt'] : 0.0;
        $fresh = $candidate !== null && $entry !== null && $now - $fetchedAt < $this->cacheTtl;

        if ($this->offline || !$this->refresh) {
            $this->adopt($candidate, $candidate === null ? Status::NOT_READY : ($this->offline || $fresh ? $cachedStatus : Status::STALE));
            return;
        }
        if ($fresh && !$force) {
            $this->adopt($candidate, $cachedStatus);
            return;
        }
        $failedAt = is_numeric($entry['failedAt'] ?? null) ? (float) $entry['failedAt'] : 0.0;
        if (!$force && $failedAt > 0 && $now - $failedAt < $this->retryInterval) {
            // The edge failed moments ago (maybe for another request): serve what we have, retry later.
            $this->adopt($candidate, Status::STALE);
            if ($this->lastError === null && is_string($entry['error'] ?? null)) {
                $this->lastError = new NanoFlagsException($entry['error'], is_string($entry['errorCode'] ?? null) ? $entry['errorCode'] : NanoFlagsException::NETWORK);
            }
            return;
        }
        try {
            $this->fetch($entry ?? [], $candidate, $now);
        } catch (NanoFlagsException $e) {
            $base = $entry ?? [];
            $base['failedAt'] = $now;
            $base['error'] = $e->getMessage();
            $base['errorCode'] = $e->errorCode;
            if ($candidate === null) {
                unset($base['raw'], $base['sig'], $base['etag'], $base['checksum']);
            }
            $this->writeEntry($base);
            // A rejected update leaves the configuration in use, now known not to be current: stale until a bundle verifies
            // or the edge confirms the one in use. Exceptions (status unchanged, error still reported): the edge's own
            // unsigned answer while the publisher signs a new revision, and a bundle for a newer engine.
            $keepStatus = $e === $this->unsignedLag || $e->errorCode === NanoFlagsException::ENGINE;
            $this->adopt($candidate, $keepStatus && $this->snapshot !== null && $this->snapshot['source'] !== 'bootstrap' ? $this->status : Status::STALE);
            $this->emitError($e);
        }
    }

    /**
     * @param array<string, mixed> $entry
     * @param array{bundle: JsObject, revision: int, raw: string, etag: ?string, checksum: ?string, sig: ?array, source: string}|null $candidate
     */
    private function fetch(array $entry, ?array $candidate, float $now): void
    {
        $headers = $this->headers();
        if ($candidate !== null && $candidate['etag'] !== null) {
            $headers['If-None-Match'] = $candidate['etag'];
        }
        try {
            $res = $this->http->send('GET', $this->baseUrl . '/v1/bundle', $headers, null, $this->timeout);
        } catch (\Throwable $e) {
            throw new NanoFlagsException('Could not reach the NanoFlags edge: ' . $e->getMessage(), NanoFlagsException::NETWORK, null, $e);
        }
        $servedStale = $res->header('X-NanoFlags-Stale') === 'true';
        if ($res->status === 304 && $candidate !== null) {
            $entry['fetchedAt'] = $now;
            $entry['stale'] = $servedStale;
            unset($entry['failedAt'], $entry['error'], $entry['errorCode']);
            if (!isset($entry['raw'])) {
                $entry = $this->entryFor($candidate, $now, $servedStale, $entry['env'] ?? null);
            }
            $this->writeEntry($entry);
            $this->adopt($candidate, $servedStale ? Status::STALE : Status::READY);
            return;
        }
        if ($res->status === 401 || $res->status === 403) {
            throw new NanoFlagsException('The SDK key was rejected (unknown or revoked).', NanoFlagsException::UNAUTHORIZED, $res->status);
        }
        if ($res->status < 200 || $res->status > 299) {
            throw new NanoFlagsException(sprintf('Bundle request failed with HTTP %d.', $res->status), NanoFlagsException::HTTP, $res->status);
        }
        try {
            $body = Json::parse($res->body);
        } catch (\Throwable) {
            $body = null;
        }
        $bundle = $body instanceof JsObject ? $body->get('bundle') : null;
        if (!Engine::isBundle($bundle)) {
            throw new NanoFlagsException('The edge returned an invalid bundle.', NanoFlagsException::INVALID_BUNDLE);
        }
        /** @var JsObject $body */
        $pinned = is_string($entry['env'] ?? null) ? $entry['env'] : null;
        [$sig, $raw] = $this->checkSignature($res, $body, $bundle, $pinned);
        $revision = self::revisionOf($bundle);
        if ($this->verifier !== null && !$servedStale && $this->newestVerified !== null && $revision < $this->newestVerified) {
            // Never adopt a revision older than one already verified (signed or not). Revisions only grow per environment.
            throw $this->rollbackError($revision, $this->newestVerified, 'served');
        }
        if (!Engine::supportsEngine($bundle->get('engine'))) {
            throw $this->engineError($bundle);
        }
        // The edge is serving its last-known-good copy: never go backwards because of it.
        if ($servedStale && $candidate !== null && $candidate['revision'] >= $revision) {
            $entry['fetchedAt'] = $now;
            $entry['stale'] = true;
            unset($entry['failedAt'], $entry['error'], $entry['errorCode']);
            $this->writeEntry($entry);
            $this->adopt($candidate, Status::STALE);
            return;
        }
        $checksum = $body->get('checksum');
        $snap = [
            'bundle' => $bundle, 'revision' => $revision, 'raw' => $raw, 'etag' => $res->header('ETag'),
            'checksum' => is_string($checksum) ? $checksum : null, 'sig' => $sig, 'source' => 'network',
        ];
        if ($this->verifier !== null && !$servedStale && $this->store !== null) {
            // Another request may have stored a newer verified revision while this one was under way: it wins, silently.
            $latest = $this->readEntry();
            $newer = $latest !== null ? $this->entrySnapshot($latest) : null;
            if ($newer !== null && $newer['sig'] !== null && $newer['revision'] > $revision) {
                $this->noteVerified($newer['revision']);
                $this->adopt($newer, ($latest['stale'] ?? false) === true ? Status::STALE : Status::READY);
                return;
            }
        }
        $this->remember($raw, $sig, $bundle);
        $this->writeEntry($this->entryFor($snap, $now, $servedStale, $sig['environmentId'] ?? $pinned));
        if ($this->verifier !== null && $sig !== null) {
            $this->noteVerified($revision);
        }
        $this->adopt($snap, $servedStale ? Status::STALE : Status::READY);
    }

    private function noteVerified(int $revision): void
    {
        if ($this->newestVerified === null || $revision > $this->newestVerified) {
            $this->newestVerified = $revision;
        }
    }

    private function rollbackError(int $revision, int $newest, string $what): NanoFlagsException
    {
        return new NanoFlagsException(sprintf(
            'Bundle r%d was rejected: it is older than r%d, which this client already verified for this environment (a %s copy; restoring an old revision in NanoFlags publishes a new, higher one). The configuration in use is unchanged.',
            $revision,
            $newest,
            $what,
        ), NanoFlagsException::ROLLBACK);
    }

    /**
     * @param array{bundle: JsObject, revision: int, raw: string, etag: ?string, checksum: ?string, sig: ?array, source: string} $snap
     * @return array<string, mixed>
     */
    private function entryFor(array $snap, float $now, bool $stale, ?string $env): array
    {
        $e = [
            'sdk' => 'php', 'etag' => $snap['etag'], 'checksum' => $snap['checksum'], 'revision' => $snap['revision'],
            'savedAt' => gmdate('Y-m-d\TH:i:s\Z', (int) $now), 'fetchedAt' => $now, 'stale' => $stale, 'raw' => $snap['raw'],
        ];
        if ($snap['sig'] !== null) {
            $e['sig'] = $snap['sig'];
        }
        if ($env !== null) {
            $e['env'] = $env;
        }
        return $e;
    }

    /**
     * Verifies a /v1/bundle response (when verification is on).
     *
     * @return array{?array{signature: string, kid: ?string, environmentId: string, revision: int, checksum: string}, string} the signature and the bundle text to keep
     */
    private function checkSignature(Response $res, JsObject $body, JsObject $bundle, ?string $pinned): array
    {
        $raw = Signature::rawMember($res->body, 'bundle');
        if ($this->verifier === null) {
            return [null, $raw ?? (string) Js::stringify($bundle)];
        }
        $rev = self::revisionOf($bundle);
        $reject = static fn (string $why) => new NanoFlagsException(sprintf('Bundle r%d was rejected: %s The configuration in use is unchanged.', $rev, $why), NanoFlagsException::SIGNATURE);
        if ($res->header('X-NanoFlags-Signed') !== 'true') {
            if ($this->verifier['require']) {
                $this->unsignedLag = $reject('it is not signed (the edge is still distributing it) and unsigned bundles are refused; fetching again shortly.');
                throw $this->unsignedLag;
            }
            return [null, $raw ?? (string) Js::stringify($bundle)];
        }
        if (!Signature::available()) {
            throw $reject('signature verification needs ext-sodium or paragonie/sodium_compat.');
        }
        $signature = $res->header('X-NanoFlags-Signature');
        $envId = $res->header('X-NanoFlags-Environment-Id');
        $kid = $res->header('X-NanoFlags-Key-Id');
        $checksum = $body->get('checksum');
        if ($signature === null || $signature === '' || $envId === null || $envId === '' || !is_string($checksum)) {
            throw $reject('the signature headers are incomplete.');
        }
        $bodyRev = $body->get('revision');
        if (is_float($bodyRev) && $bodyRev !== (float) $rev) {
            throw $reject('the signed revision does not match the bundle.');
        }
        if ($pinned !== null && $pinned !== $envId) {
            throw $reject('it was signed for a different environment.');
        }
        $info = ['signature' => $signature, 'kid' => $kid !== null && $kid !== '' ? $kid : null, 'environmentId' => $envId, 'revision' => $rev, 'checksum' => $checksum];
        try {
            $keys = $this->keysFor($info['kid']);
        } catch (\Throwable $e) {
            throw $reject(sprintf('the signing keys could not be loaded (%s).', $e->getMessage()));
        }
        // The edge embeds the stored bundle text byte-for-byte; re-serialisation is the fallback.
        if ($raw !== null && Signature::verify($keys, $info, $raw)) {
            return [$info, $raw];
        }
        $again = Js::stringify($bundle);
        if ($again !== null && $again !== $raw && Signature::verify($keys, $info, $again)) {
            return [$info, $again];
        }
        throw $reject('its signature does not verify.');
    }

    /**
     * The keys to verify a signature by $kid with: the pinned or embedded keys plus those of /v1/keys. A key id that
     * none of them has (a rotation) loads /v1/keys once, again at most once a minute (kept in this process only, never in the shared cache).
     *
     * @return list<array{kid: ?string, key: string}>
     */
    private function keysFor(?string $kid): array
    {
        $v = $this->verifier;
        if ($v === null) {
            return [];
        }
        if (!$v['refetch']) {
            return $v['base'];
        }
        $now = $this->now();
        // Keys fetched earlier by this process (memory only). The shared cache is never a source of signing keys: keys come from the
        // embedded set, the keys the caller pinned, or /v1/keys.
        if ($this->keysFetchedAt === 0.0 && isset(self::$processKeys[$this->baseUrl])) {
            $this->fetchedKeys = self::$processKeys[$this->baseUrl]['keys'];
            $this->keysFetchedAt = self::$processKeys[$this->baseUrl]['at'];
        }
        $known = [...$v['base'], ...$this->fetchedKeys];
        if ($known !== []) {
            if ($kid === null) {
                return $known;
            }
            foreach ($known as $k) {
                if ($k['kid'] === $kid) {
                    return $known;
                }
            }
        }
        if ($this->keysFetchedAt > 0 && $now - $this->keysFetchedAt < self::KEYS_REFETCH) {
            return $known;
        }
        try {
            // Public endpoint: the SDK key is deliberately not sent.
            $res = $this->http->send('GET', $this->baseUrl . '/v1/keys', ['User-Agent' => 'nanoflags-php/' . self::SDK_VERSION], null, $this->timeout);
            if ($res->status !== 200) {
                throw new \RuntimeException(sprintf('signing keys request failed with HTTP %d', $res->status));
            }
            $body = json_decode($res->body, true);
            $list = is_array($body) && is_array($body['keys'] ?? null) ? $body['keys'] : [];
            $keys = Signature::importKeys($list);
            if ($keys === []) {
                throw new \RuntimeException('the edge returned no usable signing keys');
            }
        } catch (\Throwable $e) {
            // With the embedded keys a failed reload counts as this minute's reload, so a bad key id cannot make
            // every request ask for keys.
            if ($v['base'] === []) {
                throw $e;
            }
            $this->keysFetchedAt = $now;
            self::$processKeys[$this->baseUrl] = ['keys' => $this->fetchedKeys, 'at' => $now];
            return $known;
        }
        $this->fetchedKeys = $keys;
        $this->keysFetchedAt = $now;
        self::$processKeys[$this->baseUrl] = ['keys' => $keys, 'at' => $now];
        return [...$v['base'], ...$keys];
    }

    private function engineError(JsObject $b): NanoFlagsException
    {
        return new NanoFlagsException(sprintf(
            'Bundle r%s needs evaluation engine %s; this SDK supports up to %d. Upgrade nanoflags/nanoflags. The configuration in use is unchanged.',
            Js::toStr($b->get('revision')),
            Js::stringify($b->get('engine')) ?? 'undefined',
            Engine::VERSION,
        ), NanoFlagsException::ENGINE);
    }

    /** @return array<string, string> */
    private function headers(): array
    {
        return ['Authorization' => 'Bearer ' . $this->sdkKey, 'User-Agent' => 'nanoflags-php/' . self::SDK_VERSION, 'Accept' => 'application/json'];
    }

    private function emitError(NanoFlagsException $e): void
    {
        $this->lastError = $e;
        $this->logger?->warning('nanoflags: ' . $e->getMessage(), ['code' => $e->errorCode]);
        foreach ($this->errorListeners as $l) {
            try {
                $l($e);
            } catch (\Throwable) {
                // a listener must never break the client
            }
        }
    }

    /* ================================================================== test sessions */

    /**
     * Resolves a test session and returns an evaluator scoped to it. Pass the incoming `x-nanoflags-session` header
     * value. Never throws: an unknown, expired, revoked or not permitted session (or a failed lookup) yields an
     * evaluator that behaves exactly like the client.
     *
     * The edge is asked once per token and service (`GET /v1/session`, the token in `X-NanoFlags-Session`, $service —
     * default: the client's service — in `X-NanoFlags-Service`). An active session is kept until it expires: in this
     * client and, under its own key, in the shared cache (the normal bundle entry is never touched). Unknown tokens
     * are remembered for 15 s and failed lookups for 3 s, in this client only, so that arbitrary header values cannot
     * fill the shared cache. `offline: true` resolves nothing.
     */
    public function session(?string $token, ?string $service = null): SessionEvaluator
    {
        $valid = self::isSessionToken($token);
        $state = null;
        if ($valid) {
            try {
                $state = $this->resolveSession((string) $token, $service);
            } catch (\Throwable) {
                $state = null; // never throws
            }
        }
        return new SessionEvaluator(
            $valid ? $token : null,
            $state,
            fn (string $key, mixed $default, mixed $context, ?callable $accepts, ?array $scope): EvaluationDetail => $this->detail($key, $default, $context, $accepts, $scope),
            fn (): float => $this->now(),
            fn (): ?int => $this->revision(),
        );
    }

    /** {@see session()} for the `X-NanoFlags-Session` header of the current request (`$_SERVER`). */
    public function sessionFromGlobals(?string $service = null): SessionEvaluator
    {
        $v = $_SERVER['HTTP_X_NANOFLAGS_SESSION'] ?? null;
        return $this->session(is_string($v) ? trim($v) : null, $service);
    }

    /** A session token is opaque; it only has to be safe to put in a header (1–512 printable ASCII characters). */
    public static function isSessionToken(mixed $v): bool
    {
        return is_string($v) && preg_match('/^[\x21-\x7e]{1,512}$/D', $v) === 1;
    }

    /** @return array{id: string, bundle: JsObject, raw: string, context: JsObject, expiresAt: string, expiresAtTs: float, revision: int}|null */
    private function resolveSession(string $token, ?string $service): ?array
    {
        if ($this->offline || !preg_match('#^https?://#i', $this->baseUrl)) {
            return null;
        }
        // The published configuration is what the evaluator falls back to (and loading registers the telemetry flush).
        $this->safeEnsure();
        $name = $service !== null && $service !== '' ? $service : ($this->service !== 'unknown' ? $this->service : null);
        $memoKey = ($name ?? '') . "\n" . $token;
        $now = $this->now();
        $hit = $this->sessions[$memoKey] ?? null;
        if ($hit !== null && $now < $hit[1]) {
            return $hit[0];
        }
        unset($this->sessions[$memoKey]);

        $hash = hash('sha256', $this->id . "\n" . $memoKey);
        $state = $this->readSharedSession($hash, $now);
        $failed = false;
        if ($state === null) {
            [$state, $failed] = $this->fetchSession($token, $name, $now);
            if ($state !== null) {
                $this->writeSharedSession($hash, $state, $now);
            }
        }
        if (count($this->sessions) >= self::MAX_SESSIONS) {
            $this->sessions = array_filter($this->sessions, static fn ($e) => $now < $e[1]);
            while (count($this->sessions) >= self::MAX_SESSIONS) {
                array_shift($this->sessions); // oldest first
            }
        }
        $this->sessions[$memoKey] = [$state, $state !== null ? $state['expiresAtTs'] : $now + ($failed ? self::SESSION_ERROR_TTL : self::SESSION_MISS_TTL)];
        return $state;
    }

    /**
     * @return array{0: ?array{id: string, bundle: JsObject, raw: string, context: JsObject, expiresAt: string, expiresAtTs: float, revision: int}, 1: bool}
     *         the session (null: no such session) and whether the lookup failed
     */
    private function fetchSession(string $token, ?string $service, float $now): array
    {
        try {
            $headers = $this->headers();
            $headers['X-NanoFlags-Session'] = $token;
            $headers['Cache-Control'] = 'no-store';
            if ($service !== null) {
                $headers['X-NanoFlags-Service'] = $service;
            }
            try {
                $res = $this->http->send('GET', $this->baseUrl . '/v1/session', $headers, null, $this->timeout);
            } catch (\Throwable $e) {
                throw new NanoFlagsException('Could not load the test session: ' . $e->getMessage(), NanoFlagsException::SESSION, null, $e);
            }
            if ($res->status === 404) {
                return [null, false];
            }
            if ($res->status < 200 || $res->status > 299) {
                throw new NanoFlagsException(sprintf('Session request failed with HTTP %d.', $res->status), $res->status === 401 || $res->status === 403 ? NanoFlagsException::UNAUTHORIZED : NanoFlagsException::SESSION, $res->status);
            }
            try {
                $body = Json::parse($res->body);
            } catch (\Throwable) {
                $body = null;
            }
            $bundle = $body instanceof JsObject ? $body->get('bundle') : null;
            $id = $body instanceof JsObject ? $body->get('id') : null;
            $expiresAtTs = $body instanceof JsObject ? self::parseTime($body->get('expires_at')) : null;
            if (!is_string($id) || !Engine::isBundle($bundle) || $expiresAtTs === null) {
                throw new NanoFlagsException('The edge returned an invalid session.', NanoFlagsException::SESSION);
            }
            /** @var JsObject $body */
            /** @var JsObject $bundle */
            if (!Engine::supportsEngine($bundle->get('engine'))) {
                throw $this->engineError($bundle);
            }
            if ($expiresAtTs <= $now) {
                return [null, false];
            }
            $context = $body->get('context');
            return [[
                'id' => $id, 'bundle' => $bundle, 'raw' => Signature::rawMember($res->body, 'bundle') ?? (string) Js::stringify($bundle),
                'context' => $context instanceof JsObject ? $context : new JsObject([]),
                'expiresAt' => self::isoNow($expiresAtTs), 'expiresAtTs' => $expiresAtTs, 'revision' => self::revisionOf($bundle),
            ], false];
        } catch (NanoFlagsException $e) {
            $this->emitError($e);
            return [null, true];
        } catch (\Throwable $e) {
            $this->emitError(new NanoFlagsException('Could not load the test session: ' . $e->getMessage(), NanoFlagsException::SESSION, null, $e));
            return [null, true];
        }
    }

    private static function parseTime(mixed $v): ?float
    {
        if (!is_string($v) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/D', $v)) {
            return null;
        }
        try {
            $t = (float) (new \DateTimeImmutable($v))->format('U.u');
        } catch (\Throwable) {
            return null;
        }
        return is_finite($t) ? $t : null;
    }

    /**
     * An active session from the shared cache. Its key (`nanoflags.session.<hash>.<client>`) is separate from the
     * bundle entry and names a hash of the service and token, never the token itself.
     *
     * @return array{id: string, bundle: JsObject, raw: string, context: JsObject, expiresAt: string, expiresAtTs: float, revision: int}|null
     */
    private function readSharedSession(string $hash, float $now): ?array
    {
        if ($this->store === null) {
            return null;
        }
        try {
            $e = json_decode((string) $this->store->get($this->cacheKey('session.' . substr($hash, 0, 40))), true);
            if (!is_array($e) || ($e['v'] ?? null) !== 1 || ($e['key'] ?? null) !== $hash || !is_string($e['id'] ?? null) || !is_string($e['raw'] ?? null) || !is_string($e['context'] ?? null) || !is_numeric($e['expiresAtTs'] ?? null)) {
                return null;
            }
            $expiresAtTs = (float) $e['expiresAtTs'];
            if ($expiresAtTs <= $now) {
                return null;
            }
            $parsed = $this->parseBundle($e['raw'], null);
            $context = Json::parse($e['context']);
            if ($parsed === null || !Engine::supportsEngine($parsed[0]->get('engine')) || !($context instanceof JsObject)) {
                return null;
            }
        } catch (\Throwable) {
            return null; // fetched again
        }
        return [
            'id' => $e['id'], 'bundle' => $parsed[0], 'raw' => $e['raw'], 'context' => $context,
            'expiresAt' => self::isoNow($expiresAtTs), 'expiresAtTs' => $expiresAtTs, 'revision' => self::revisionOf($parsed[0]),
        ];
    }

    /** @param array{id: string, raw: string, context: JsObject, expiresAtTs: float} $state */
    private function writeSharedSession(string $hash, array $state, float $now): void
    {
        if ($this->store === null) {
            return;
        }
        $ttl = (int) max(1, min(self::SESSION_SHARED_TTL, ceil($state['expiresAtTs'] - $now)));
        $entry = ['v' => 1, 'key' => $hash, 'id' => $state['id'], 'expiresAtTs' => $state['expiresAtTs'], 'context' => (string) Js::stringify($state['context']), 'raw' => $state['raw']];
        try {
            $this->store->set($this->cacheKey('session.' . substr($hash, 0, 40)), (string) json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), $ttl);
        } catch (\Throwable $e) {
            $this->emitError(new NanoFlagsException('Could not cache the test session: ' . $e->getMessage(), NanoFlagsException::STORE, null, $e));
        }
    }

    /* ================================================================== daemon / relay */

    /**
     * Keeps the shared cache current: revalidates now and then every $pollInterval seconds, and, with $stream,
     * listens to the edge's event stream (`/v1/stream`) in between so that a new revision is fetched within a
     * second or two. Runs until $duration seconds have passed (forever when null). This is what
     * `bin/nanoflags-sync` runs; web workers sharing the cache can then use `refresh: false`.
     *
     * @param (callable(Client): void)|null $onSync called after every revalidation
     */
    public function run(float $pollInterval = 30.0, bool $stream = true, ?float $duration = null, ?callable $onSync = null): void
    {
        $until = $duration === null ? INF : $this->now() + $duration;
        $streamOk = $stream && $this->http instanceof StreamingTransport;
        $attempt = 0;
        while ($this->now() < $until) {
            $this->refresh();
            $this->flush();
            if ($onSync !== null) {
                $onSync($this);
            }
            $remaining = $until - $this->now();
            if ($remaining <= 0) {
                return;
            }
            $window = min($pollInterval * (0.8 + 0.4 * ($this->random)()), $remaining);
            if (!$streamOk) {
                usleep((int) ($window * 1e6));
                continue;
            }
            $started = $this->now();
            $changed = false;
            $headers = $this->headers();
            $headers['Accept'] = 'text/event-stream';
            /** @var StreamingTransport $t */
            $t = $this->http;
            try {
                $code = $t->stream($this->baseUrl . '/v1/stream', $headers, function (string $event, string $data) use (&$changed, &$streamOk): bool {
                    if ($event === 'revoked') {
                        $streamOk = false;
                        $changed = true;
                        return false;
                    }
                    if ($event !== 'revision') {
                        return true;
                    }
                    $m = json_decode($data, true);
                    $s = $this->snapshot;
                    if (!is_array($m) || $s === null || ($m['revision'] ?? null) !== $s['revision'] || ($m['checksum'] ?? null) !== $s['checksum'] || $this->status !== Status::READY) {
                        $changed = true;
                        return false;
                    }
                    return true;
                }, min(10.0, $window), $window);
            } catch (\Throwable) {
                $code = 0;
            }
            if ($code === 401 || $code === 403) {
                $streamOk = false; // polling keeps reporting the error
            }
            if ($changed) {
                $attempt = 0;
                continue;
            }
            $elapsed = $this->now() - $started;
            if ($elapsed < $window) {
                // The stream ended early (or could not open): back off, then poll again.
                $attempt = $elapsed > 30 ? 0 : $attempt + 1;
                usleep((int) (min($window - $elapsed, min(30.0, 2 ** min($attempt, 5)) * (0.5 + ($this->random)())) * 1e6));
            }
        }
    }

    /* ================================================================== telemetry */

    /** @param array<mixed>|JsObject|\stdClass|null $userContext */
    private function record(Result $r, array|JsObject|\stdClass|null $userContext, JsObject $ctx, ?JsObject $bundle, ?string $sessionId = null): void
    {
        if (!$this->eventsEnabled || $this->sampleRate <= 0 || ($this->random)() >= $this->sampleRate || count($this->queue) >= self::MAX_QUEUE) {
            return;
        }
        try {
            if ($this->redact !== null) {
                $c = Js::fromPhp(($this->redact)(is_array($userContext) ? $userContext : (array) Js::toPhp($ctx)));
                $context = $c instanceof JsObject ? $c : new JsObject([]);
            } else {
                $context = $this->defaultRedact($bundle, $r->flagKey, $ctx);
            }
            $rev = Js::toNumber($r->revision);
            $ev = [
                'flagKey' => self::truncate($r->flagKey, 63),
                'value' => self::eventValue($r->value),
                'reason' => $r->reason,
            ];
            if ($r->ruleIndex !== null) {
                $ev['ruleIndex'] = (float) $r->ruleIndex;
            }
            $ev['revision'] = is_finite($rev) ? (float) (int) $rev : 0.0;
            $ev['context'] = $context;
            $ev['at'] = self::isoNow($this->now());
            if ($sessionId !== null) {
                $ev['sessionId'] = $sessionId;
            }
            $ev['sampleRate'] = $this->sampleRate;
            $this->queue[] = (string) Js::stringify(new JsObject($ev));
        } catch (\Throwable) {
            // telemetry must never affect evaluation
        }
    }

    /** Only the names of the attributes the flag's rules use that are present, mapped to the value's type. */
    private function defaultRedact(?JsObject $bundle, string $flagKey, JsObject $ctx): JsObject
    {
        if ($bundle === null) {
            return new JsObject([]);
        }
        $tag = spl_object_hash($bundle);
        if ($this->attrsFor !== $tag) {
            $this->attrs = [];
            $this->attrsFor = $tag;
        }
        $names = $this->attrs[$flagKey] ??= Engine::attributesUsedBy($bundle, $flagKey);
        $out = [];
        foreach ($names as $n) {
            $v = $ctx->get($n);
            if (!($v instanceof Undefined)) {
                $out[$n] = Js::typeName($v);
            }
        }
        return new JsObject($out);
    }

    private static function eventValue(mixed $v): mixed
    {
        if (is_string($v)) {
            return self::truncate($v, self::MAX_EVENT_VALUE_CHARS);
        }
        $text = Js::stringify($v);
        if ($text === null || ((is_array($v) || $v instanceof JsObject) && Js::utf16Len($text) > self::MAX_EVENT_VALUE_CHARS)) {
            return null;
        }
        return $v;
    }

    /** The first $n UTF-16 code units of $s (String.prototype.slice). */
    private static function truncate(string $s, int $n): string
    {
        if (strlen($s) <= $n || Js::utf16Len($s) <= $n) {
            return $s;
        }
        $units = array_slice(Js::toUnits($s), 0, $n);
        $out = '';
        $count = count($units);
        for ($i = 0; $i < $count; $i++) {
            $u = $units[$i];
            if ($u >= 0xD800 && $u <= 0xDBFF && $i + 1 < $count && $units[$i + 1] >= 0xDC00 && $units[$i + 1] <= 0xDFFF) {
                $out .= Js::encodeUnit(0x10000 + (($u - 0xD800) << 10) + ($units[$i + 1] - 0xDC00));
                $i++;
                continue;
            }
            $out .= Js::encodeUnit($u);
        }
        return $out;
    }

    private static function isoNow(float $t): string
    {
        $sec = (int) floor($t);
        return gmdate('Y-m-d\TH:i:s', $sec) . sprintf('.%03dZ', (int) (($t - $sec) * 1000));
    }

    /**
     * End-of-request telemetry: queued events join the shared buffer, and when the flush interval has passed (or a
     * service report is due) one batch is sent. Registered as a shutdown function; also runs on destruction.
     */
    public function shutdown(): void
    {
        if (!$this->eventsEnabled || !$this->loaded) {
            return;
        }
        try {
            $this->flushDue(false);
        } catch (\Throwable) {
            // dropped by design: telemetry is never retried
        }
    }

    /** Sends every queued event (and the service report) now. Best effort; never throws. */
    public function flush(): void
    {
        if (!$this->eventsEnabled) {
            return;
        }
        try {
            $this->flushDue(true);
        } catch (\Throwable) {
            // dropped by design
        }
    }

    private function flushDue(bool $all): void
    {
        $local = $this->queue;
        $this->queue = [];
        $now = $this->now();
        if ($this->store === null) {
            if ($local === [] && !$all) {
                return;
            }
            foreach (array_chunk($local === [] ? [[]] : $local, self::MAX_BATCH) as $i => $batch) {
                if ($i >= ($all ? 10 : 1)) {
                    break;
                }
                $this->sendEvents(array_values(array_filter($batch, 'is_string')));
            }
            return;
        }
        $key = $this->cacheKey('events');
        $buf = json_decode((string) $this->store->get($key), true);
        $last = is_array($buf) && is_numeric($buf['lastFlushAt'] ?? null) ? (float) $buf['lastFlushAt'] : 0.0;
        $queued = is_array($buf) && is_array($buf['queue'] ?? null) ? array_values(array_filter($buf['queue'], 'is_string')) : [];
        $merged = array_slice([...$queued, ...$local], 0, self::MAX_QUEUE);
        $due = $all || ($now - $last >= $this->flushInterval && ($merged !== [] || $now - $last >= $this->reportInterval));
        if (!$due) {
            if ($local !== []) {
                $this->store->set($key, (string) json_encode(['lastFlushAt' => $last, 'queue' => $merged]));
            }
            return;
        }
        $batches = array_chunk($merged, self::MAX_BATCH);
        $send = $all ? $batches : array_slice($batches, 0, 1);
        $rest = $all ? [] : array_merge(...array_slice($batches, 1) ?: [[]]);
        // Claim the slot before sending, so concurrent requests do not send the same batch.
        $this->store->set($key, (string) json_encode(['lastFlushAt' => $now, 'queue' => $rest]));
        if ($send === []) {
            $send = [[]];
        }
        foreach ($send as $batch) {
            $this->sendEvents($batch);
        }
    }

    /** @param list<string> $batch event JSON texts */
    private function sendEvents(array $batch): void
    {
        $rev = $this->snapshot['revision'] ?? 0;
        $body = '{"service":' . Js::quote(self::truncate($this->service, 60)) . ',"sdk":"php/' . self::SDK_VERSION . '","revision":' . max(0, $rev) . ',"events":[' . implode(',', $batch) . ']}';
        $headers = $this->headers();
        $headers['Content-Type'] = 'application/json';
        try {
            $this->http->send('POST', $this->baseUrl . '/v1/events', $headers, $body, $this->eventsTimeout);
        } catch (\Throwable) {
            // dropped on failure, by design: telemetry is never retried
        }
    }

    public function __debugInfo(): array
    {
        return ['baseUrl' => $this->baseUrl, 'service' => $this->service, 'status' => $this->status, 'revision' => $this->snapshot['revision'] ?? null, 'source' => $this->snapshot['source'] ?? null];
    }
}
