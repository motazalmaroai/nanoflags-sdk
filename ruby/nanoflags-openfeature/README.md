# nanoflags-openfeature (Ruby)

[OpenFeature](https://openfeature.dev) provider for [NanoFlags](https://nanoflags.io), backed by the native Ruby SDK
([`nanoflags`](../nanoflags/README.md)): flags are evaluated locally, with the same results as every other NanoFlags
SDK.

## Install

```ruby
# Gemfile
gem "nanoflags-openfeature"
```

Requires Ruby 3.1+ and `openfeature-sdk` 0.4 or newer (0.6+ needs Ruby 3.4).

## Usage

```ruby
require "nanoflags/openfeature"

nanoflags = NanoFlags::Client.new(ENV.fetch("NANOFLAGS_SDK_KEY"), service: "checkout-api")
OpenFeature::SDK.configure do |config|
  config.set_provider_and_wait(NanoFlags::OpenFeature::Provider.new(nanoflags, ready_timeout: 10))
end

client = OpenFeature::SDK.build_client
ctx = OpenFeature::SDK::EvaluationContext.new(targeting_key: current_user.id.to_s, plan: current_user.plan)
client.fetch_boolean_value(flag_key: "new-checkout", default_value: false, evaluation_context: ctx)
client.fetch_string_details(flag_key: "accent", default_value: "blue", evaluation_context: ctx)
```

`init` waits up to `ready_timeout` seconds for the first configuration and fails (provider error state) when none
could be loaded; the client keeps trying in the background. `close_client: true` closes the NanoFlags client on
`shutdown`.

### Test sessions

Pass `evaluator:` to evaluate through the request's test session (`x-nanoflags-session`, resolved by
`NanoFlags::SessionMiddleware` or `NanoFlags.with_session`; needs a `nanoflags` release with test sessions, see its
CHANGELOG):

```ruby
provider = NanoFlags::OpenFeature::Provider.new(nanoflags, evaluator: -> { NanoFlags.flags_for(nanoflags) })
```

Outside a session the evaluator behaves exactly like the client.

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

Flag metadata carries the evaluated `revision` (openfeature-sdk 0.5+). With SDK versions that support provider
events, a new revision emits `PROVIDER_CONFIGURATION_CHANGED`, and status changes emit `PROVIDER_READY` /
`PROVIDER_STALE` (`PROVIDER_ERROR` while nothing is loaded).

## Development

```sh
bundle install        # uses ../nanoflags from this repository
bundle exec rake
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The NanoFlags name and logo are not covered by
the license.
