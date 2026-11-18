import type { Bundle, BundleFlag, Environment, Flag, ManagementClient, Project } from "./api";

export interface EnvironmentStatus {
  environment: Environment;
  /** The flag as published in the environment's current revision; null when not in it (or nothing published). */
  published: BundleFlag | null;
  /** The flag in the environment's draft; null when not in the draft (e.g. archived). */
  draft: BundleFlag | null;
}

interface EnvBundles {
  published: Bundle | null;
  draft: Bundle | null;
}

export interface StoreOptions {
  /** How long loaded data counts as fresh (default 5 minutes). */
  ttlMs?: number;
  now?: () => number;
}

type Listener = () => void;

/**
 * Cache of one project's flags, environments and per-environment configuration (draft and published bundles).
 * Everything is loaded with a handful of calls: flags (paged), environments, and per environment the draft and the
 * published revision. `ensureFresh` reloads after the TTL; `refresh` reloads now.
 */
export class FlagStore {
  project: Project | undefined;
  environments: Environment[] = [];
  private flagsByKey = new Map<string, Flag>();
  private bundles = new Map<string, EnvBundles>();
  private loadedAt = 0;
  private loading: Promise<void> | undefined;
  private listeners = new Set<Listener>();
  lastError: unknown;

  constructor(
    private readonly client: () => ManagementClient | undefined,
    private readonly o: StoreOptions = {},
  ) {}

  get loaded(): boolean {
    return this.loadedAt > 0;
  }

  get flags(): Flag[] {
    return [...this.flagsByKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  get(key: string): Flag | undefined {
    return this.flagsByKey.get(key);
  }

  onDidChange(l: Listener): { dispose(): void } {
    this.listeners.add(l);
    return { dispose: () => this.listeners.delete(l) };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  clear(): void {
    this.project = undefined;
    this.environments = [];
    this.flagsByKey.clear();
    this.bundles.clear();
    this.loadedAt = 0;
    this.lastError = undefined;
    this.emit();
  }

  isStale(): boolean {
    const now = (this.o.now ?? Date.now)();
    return this.loadedAt === 0 || now - this.loadedAt > (this.o.ttlMs ?? 5 * 60_000);
  }

  /** Loads when nothing is loaded or the data is older than the TTL. Never throws (see lastError). */
  async ensureFresh(projectKey: string): Promise<void> {
    if (this.project && this.project.key !== projectKey && this.project.id !== projectKey) this.loadedAt = 0;
    if (!this.isStale()) return;
    await this.refresh(projectKey);
  }

  /** Reloads everything now. Concurrent calls share one load. Never throws (see lastError). */
  refresh(projectKey: string): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.load(projectKey).finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async load(projectKey: string): Promise<void> {
    const c = this.client();
    if (!c) return;
    try {
      const [projects, environments, flags] = await Promise.all([c.projects(), c.environments(projectKey), c.flags(projectKey)]);
      const project = projects.find((p) => p.key === projectKey || p.id === projectKey);
      const bundles = new Map<string, EnvBundles>();
      await Promise.all(
        environments.map(async (e) => {
          const [draft, published] = await Promise.all([
            c.draft(projectKey, e.key).then((d) => d.bundle, () => null),
            e.publishedRevision > 0 ? c.revision(projectKey, e.key, e.publishedRevision).then((r) => r.bundle, () => null) : Promise.resolve(null),
          ]);
          bundles.set(e.key, { draft, published });
        }),
      );
      this.project = project ?? { id: projectKey, key: projectKey, name: projectKey, defaultEnvironment: environments[0]?.key ?? "" };
      this.environments = [...environments].sort((a, b) => a.sort - b.sort);
      this.flagsByKey = new Map(flags.map((f) => [f.key, f]));
      this.bundles = bundles;
      this.loadedAt = (this.o.now ?? Date.now)();
      this.lastError = undefined;
    } catch (e) {
      this.lastError = e;
    }
    this.emit();
  }

  /** Per-environment status of a flag, in dashboard order. */
  statusOf(key: string): EnvironmentStatus[] {
    return this.environments.map((environment) => {
      const b = this.bundles.get(environment.key);
      return { environment, published: b?.published?.flags?.[key] ?? null, draft: b?.draft?.flags?.[key] ?? null };
    });
  }
}
