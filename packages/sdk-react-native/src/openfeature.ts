/**
 * `@nanoflags/react-native/openfeature` — OpenFeature provider for React Native (static-context paradigm, i.e.
 * `@openfeature/web-sdk` and `@openfeature/react-sdk`, both of which run in React Native).
 *
 * It is `@nanoflags/openfeature-provider`'s web provider (same mapping of reasons, variants and errors) on the React
 * Native client. Additionally, OpenFeature's global context is the client's context: `OpenFeature.setContext(...)`
 * calls `client.identify(...)`, so NanoFlags hooks and OpenFeature hooks see the same user.
 */
import type { EvaluationContext } from "@openfeature/web-sdk";
import { NanoFlagsWebProvider } from "@nanoflags/openfeature-provider/web";
import { toNanoFlagsContext } from "@nanoflags/openfeature-provider";
import type { ReactNativeClient } from "./client.js";

export { toNanoFlagsContext };

export interface ReactNativeProviderOptions {
  client: ReactNativeClient;
  /** Close the client when the provider is shut down. Default false: the client is yours. */
  closeClient?: boolean;
  /** Default true: OpenFeature's context (initial and every `setContext`) becomes the client's context via `identify()`. */
  syncContext?: boolean;
}

export class NanoFlagsReactNativeProvider extends NanoFlagsWebProvider {
  private readonly rnClient: ReactNativeClient;
  private readonly syncContext: boolean;

  constructor(options: ReactNativeProviderOptions) {
    super({ client: options.client, ...(options.closeClient !== undefined ? { closeClient: options.closeClient } : {}) });
    this.rnClient = options.client;
    this.syncContext = options.syncContext ?? true;
  }

  override async initialize(context?: EvaluationContext): Promise<void> {
    if (this.syncContext && context) this.rnClient.identify(toNanoFlagsContext(context));
    return super.initialize();
  }

  /** Called by the OpenFeature SDK after `OpenFeature.setContext()`. Local and synchronous: nothing is fetched. */
  onContextChange(_oldContext: EvaluationContext, newContext: EvaluationContext): void {
    if (this.syncContext) this.rnClient.identify(toNanoFlagsContext(newContext));
  }
}
