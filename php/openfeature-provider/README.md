# nanoflags/openfeature-provider (PHP)

[OpenFeature](https://openfeature.dev) provider for [NanoFlags](https://nanoflags.io), backed by the native PHP SDK
([`nanoflags/nanoflags`](../nanoflags/README.md)): flags are evaluated locally, with the same results as every other
NanoFlags SDK.

## Install

```sh
composer require nanoflags/openfeature-provider
```

Requires PHP 8.1+ and `open-feature/sdk` 2.x.

## Usage

```php
use NanoFlags\Client;
use NanoFlags\OpenFeature\NanoFlagsProvider;
use OpenFeature\OpenFeatureAPI;
use OpenFeature\implementation\flags\Attributes;
use OpenFeature\implementation\flags\EvaluationContext;

$api = OpenFeatureAPI::getInstance();
$api->setProvider(new NanoFlagsProvider(new Client(getenv('NANOFLAGS_SDK_KEY'), service: 'checkout-api')));

$client = $api->getClient();
$enabled = $client->getBooleanValue('new-checkout', false, new EvaluationContext($userId, new Attributes(['plan' => 'beta'])));
$details = $client->getStringDetails('accent', 'blue', new EvaluationContext($userId));
```

Configure the `Client` exactly as without OpenFeature (cache, verification, telemetry, `refresh: false` with the sync
daemon, …); see the SDK README.

For test sessions (`x-nanoflags-session`, needs a `nanoflags/nanoflags` release with `Client::session()`), pass the
request's evaluator: `new NanoFlagsProvider($flags, fn () => $flags->sessionFromGlobals())` (or the evaluator the
PSR-15 `NanoFlags\SessionMiddleware` put on the request). Outside a session it behaves exactly like the client.

## Mapping

| NanoFlags | OpenFeature |
| --- | --- |
| targeting key | context attribute `key` (the rollout identity; wins over an attribute named `key`) |
| `off` (flag disabled) | reason `DISABLED` |
| `default` (no rule matched) | reason `DEFAULT` |
| fixed rule | reason `TARGETING_MATCH`, variant = rule id |
| percentage rollout | reason `SPLIT`, variant = rule id |
| unknown flag | error `FLAG_NOT_FOUND` (or `PROVIDER_NOT_READY` while no configuration is loaded) |
| value of another type | error `TYPE_MISMATCH`; the integer accessor needs a whole number, the float accessor accepts any number |
| evaluation error | error `GENERAL` |

Flag metadata carries the evaluated `revision`. The object accessor returns JSON objects and arrays as PHP arrays.
The PHP OpenFeature SDK has no provider events; status and errors are on the `Client` (`status()`, `lastError()`,
`onError()`).

## Development

```sh
composer config repositories.nanoflags '{"type": "path", "url": "../nanoflags", "options": {"versions": {"nanoflags/nanoflags": "0.2.0"}}}'
composer install
vendor/bin/phpunit
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The NanoFlags name and logo are not covered by
the license.
