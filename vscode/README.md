# NanoFlags for VS Code

See your NanoFlags feature flags where they are used in code.

- **Hover** a flag key to see its name, type, description and, for every environment, what is published and what is
  waiting in the draft, with a link to the flag in the dashboard.
- **Open in NanoFlags** CodeLens above flag references.
- **Problems** for flag keys that do not exist in the project (with a "did you mean" suggestion) and for archived flags
  that are still read in code.
- **Completion** of flag keys inside SDK getter calls.
- **Flags explorer** in the activity bar: flags per environment with their live status, archived flags apart; copy a
  key or open it in the dashboard from the context menu.
- **Copy Flag Key**, **Refresh Flags**, **Select Project** commands.

> Screenshot placeholder: hover over `flags.boolean("new-checkout")` showing the environment table.
>
> Screenshot placeholder: the Flags explorer with Development and Production expanded.
>
> Screenshot placeholder: a warning on an unknown flag key with the "did you mean" suggestion.

## Sign in

1. In the NanoFlags dashboard, open **Settings → API tokens** and create a token with the **`flags:read`** scope.
   A token scoped to one project is enough and selects that project automatically.
2. Run **NanoFlags: Sign In** from the Command Palette (or the button in the NanoFlags view) and paste the token
   (`nf_api_…`).

The token is kept in VS Code's secret storage (the operating system keychain), never in settings or files.
**NanoFlags: Sign Out** removes it. The extension only reads: it never changes flags.

## Where flag keys are detected

String literals passed as the key to a NanoFlags SDK getter (or an OpenFeature getter):

| Language | Examples |
| --- | --- |
| JavaScript / TypeScript | `flags.boolean("key", false)`, `flags.string(…)`, `flags.number(…)`, `flags.json(…)`, `useFlag("key", …)`, `client.getBooleanValue("key", …)` |
| Python | `flags.bool_variation("key", False, ctx)`, `string_variation`, `number_variation`, `json_variation`, `get_boolean_value` |
| Go | `client.BoolVariation("key", ctx, false)`, `StringVariation`, `Float64Variation`, `JSONVariation`, `client.BooleanValue(ctx, "key", …)` |
| Java / Kotlin | `flags.boolVariation("key", …)`, `stringVariation`, `intVariation`, `doubleVariation`, `jsonVariation`, `rememberFlag("key", …)` |
| C# | `flags.BoolVariation("key", …)`, `client.GetBooleanValueAsync("key", …)` |
| PHP | `$flags->boolVariation('key', …)` |
| Ruby | `FLAGS.bool_variation("key", …)` |
| Swift | `flags.boolVariation(key: "key", default: false)` |
| Dart / Flutter | `flags.boolVariation('key', …)`, `FlagBuilder(flagKey: 'key', …)` |

The `…Detail` / `…Details` variants are recognised too. Keys built from variables or concatenation are not, and comments
are ignored. Generic names such as `x.boolean("…")` only count when the receiver's name mentions flags (`flags`,
`nanoflags`, …), so other libraries' calls are never reported as unknown flags.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `nanoflags.project` | | Project key for this workspace. Empty: the token's project or the one picked with **Select Project**. |
| `nanoflags.cacheMinutes` | `5` | Data older than this is refreshed in the background. |
| `nanoflags.diagnostics.unknownFlags` | `warning` | `error`, `warning`, `information`, `hint` or `off`. |
| `nanoflags.diagnostics.archivedFlags` | `warning` | Same values. |
| `nanoflags.codeLens.enabled` | `true` | Show the **Open in NanoFlags** CodeLens. |
| `nanoflags.baseUrl` | | NanoFlags edge URL (default `https://edge.nanoflags.io`). |
| `nanoflags.dashboardUrl` | `https://app.nanoflags.io` | Used by **Open in NanoFlags**. The dashboard opens the flag in its currently selected project. |

## API use

The extension calls the NanoFlags Management API with `Authorization: Bearer <token>`: `GET /token`, `GET /projects`,
`GET /projects/{project}/environments`, `GET /projects/{project}/flags?archived=all`, and per environment
`GET …/environments/{environment}/draft` and `GET …/revisions/{published revision}`. Loads are cached and shared;
**Refresh Flags** reloads at once.

## Development

```sh
npm ci
npm test            # vitest, with a mocked API and an in-memory vscode stand-in
npm run typecheck
npm run build       # dist/extension.js (esbuild)
npm run package     # vscode-nanoflags.vsix
```

Press F5 with this folder open in VS Code to start an Extension Development Host (add a launch configuration of type
`extensionHost`). Publishing: see [PUBLISHING.md](PUBLISHING.md).

## License

Apache-2.0
