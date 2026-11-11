/** OpenFeature provider for the web SDK (`@openfeature/web-sdk`). */
import { OpenFeatureEventEmitter, ProviderEvents, type EvaluationContext, type JsonValue, type Provider, type ResolutionDetails } from "@openfeature/web-sdk";
import { bridge, resolve, type NanoFlagsProviderOptions } from "./index.js";

export type { NanoFlagsProviderOptions } from "./index.js";

export class NanoFlagsWebProvider implements Provider {
  readonly metadata = { name: "nanoflags" } as const;
  readonly runsOn = "client" as const;
  readonly events = new OpenFeatureEventEmitter();
  private stop: (() => void) | null = null;

  constructor(private readonly options: NanoFlagsProviderOptions) {}

  async initialize(): Promise<void> {
    const { client } = this.options;
    await client.ready();
    this.stop ??= bridge(client, (e) => {
      if (e.type === "ready") this.events.emit(ProviderEvents.Ready);
      else if (e.type === "stale") this.events.emit(ProviderEvents.Stale, { message: e.message });
      else if (e.type === "error") this.events.emit(ProviderEvents.Error, { message: e.message });
      else this.events.emit(ProviderEvents.ConfigurationChanged, { message: e.message, metadata: { revision: e.revision } });
    });
    // No configuration: the SDK reports ERROR. The bridge emits READY as soon as a bundle arrives.
    if (client.status === "not-ready") throw new Error("NanoFlags could not load a configuration. Evaluations return their default values until one arrives.");
    // The SDK emits READY when this method resolves; a stale bundle is reported right after.
    if (client.status === "stale") setTimeout(() => client.status === "stale" && this.events.emit(ProviderEvents.Stale, { message: "The configuration in use is not known to be current." }), 0);
  }

  async onClose(): Promise<void> {
    this.stop?.();
    this.stop = null;
    if (this.options.closeClient) this.options.client.close();
  }

  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext): ResolutionDetails<boolean> {
    return resolve(this.options, flagKey, defaultValue, context, "boolean");
  }

  resolveStringEvaluation(flagKey: string, defaultValue: string, context: EvaluationContext): ResolutionDetails<string> {
    return resolve(this.options, flagKey, defaultValue, context, "string");
  }

  resolveNumberEvaluation(flagKey: string, defaultValue: number, context: EvaluationContext): ResolutionDetails<number> {
    return resolve(this.options, flagKey, defaultValue, context, "number");
  }

  resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T, context: EvaluationContext): ResolutionDetails<T> {
    return resolve(this.options, flagKey, defaultValue, context, "object");
  }
}
