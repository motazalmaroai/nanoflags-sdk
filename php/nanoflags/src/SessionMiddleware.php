<?php

declare(strict_types=1);

namespace NanoFlags;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * PSR-15 middleware (Slim, Mezzio, Laminas, Spiral, any PSR-15 pipeline). Reads `x-nanoflags-session`, resolves the
 * test session once, and passes the request's evaluator on as the request attribute `nanoflags.flags`: scoped to the
 * session while it is active, the plain client behaviour otherwise.
 *
 *     $app->add(new \NanoFlags\SessionMiddleware($flags));
 *     $f = $request->getAttribute(\NanoFlags\SessionMiddleware::ATTRIBUTE);
 *     $f->boolVariation('checkout-v2', false, ['key' => $userId]);
 *     $http->request('GET', $pricingUrl, ['headers' => $f->headers()]); // the next service joins the session
 *
 * Needs psr/http-server-middleware, which every PSR-15 framework already installs; it is not a dependency of
 * nanoflags/nanoflags. Without PSR-15 use {@see Client::session()} or {@see Client::sessionFromGlobals()}.
 */
final class SessionMiddleware implements MiddlewareInterface
{
    public const ATTRIBUTE = 'nanoflags.flags';

    public function __construct(private readonly Client $client, private readonly ?string $service = null)
    {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $token = trim($request->getHeaderLine(Client::SESSION_HEADER));
        $flags = $this->client->session($token !== '' ? $token : null, $this->service);
        return $handler->handle($request->withAttribute(self::ATTRIBUTE, $flags));
    }
}
