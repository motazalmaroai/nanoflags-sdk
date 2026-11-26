import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** Frameworks `nanoflags init` writes code for. */
export const FRAMEWORKS = ["next-app", "next-pages", "vite-react", "vite", "react", "node"] as const;
export type Framework = (typeof FRAMEWORKS)[number];
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const FRAMEWORK_LABEL: Record<Framework, string> = {
  "next-app": "Next.js (App Router)",
  "next-pages": "Next.js (Pages Router)",
  "vite-react": "React + Vite",
  vite: "Vite",
  react: "React (Create React App)",
  node: "Node.js",
};

/** Browser frameworks get a client key (`nf_pub_…`, only client-exposed flags); everything else a server key. */
export function keyKindFor(f: Framework): "client" | "server" {
  return f === "vite" || f === "vite-react" || f === "react" ? "client" : "server";
}

export interface Detection {
  framework: Framework;
  /** Set when the project uses a framework init has no template for; `framework` is then the closest fallback. */
  unsupported: string | null;
  packageManager: PackageManager;
  typescript: boolean;
  /** `"type": "module"` in package.json. */
  esm: boolean;
  /** The app keeps its code under src/. */
  srcDir: boolean;
  /** The `service` name the SDK reports (package name, else the directory name). */
  service: string;
  /** @nanoflags/sdk is already a dependency. */
  hasSdk: boolean;
  /** Express, Fastify, Koa or Hono, when detected (informational). */
  server: string | null;
}

interface PackageJson {
  name?: unknown;
  type?: unknown;
  packageManager?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Other frameworks we recognise but have no template for yet (the docs cover them by hand). */
const UNSUPPORTED: Array<[string, string]> = [
  ["@remix-run/react", "Remix"],
  ["@react-router/dev", "React Router (framework mode)"],
  ["astro", "Astro"],
  ["@sveltejs/kit", "SvelteKit"],
  ["nuxt", "Nuxt"],
  ["@angular/core", "Angular"],
  ["expo", "Expo / React Native"],
  ["react-native", "React Native"],
];

export function readPackageJson(dir: string): PackageJson | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

export function detectPackageManager(dir: string, pkg: PackageJson | null): PackageManager {
  const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  return "npm";
}

/** The install command for the SDK, as argv. */
export function installCommand(pm: PackageManager): [string, string[]] {
  return pm === "npm" ? ["npm", ["install", "@nanoflags/sdk"]] : [pm, ["add", "@nanoflags/sdk"]];
}

/** Lower-case, URL-safe service label of at most 60 characters. */
export function serviceName(raw: string): string {
  const s = raw.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "my-app";
}

/**
 * Reads package.json, lockfiles and the directory layout. Throws when `dir` has no package.json: init writes into a
 * JavaScript project and needs to know which one.
 */
export function detect(dir: string): Detection {
  const pkg = readPackageJson(dir);
  if (pkg === null) throw new Error(`No package.json in ${dir}. Run \`init\` in your application's directory (or create one with \`npm init -y\`).`);
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
  const srcDir = isDir(join(dir, "src"));
  const typescript = has("typescript") || existsSync(join(dir, "tsconfig.json"));
  let framework: Framework;
  if (has("next")) {
    const app = isDir(join(dir, "app")) || isDir(join(dir, "src", "app"));
    const pages = isDir(join(dir, "pages")) || isDir(join(dir, "src", "pages"));
    framework = !app && pages ? "next-pages" : "next-app";
  } else if (has("vite")) framework = has("react") ? "vite-react" : "vite";
  else if (has("react-scripts")) framework = "react";
  else framework = "node";
  const unsupported = framework === "node" || framework === "vite" ? (UNSUPPORTED.find(([dep]) => has(dep))?.[1] ?? null) : null;
  const server = ["express", "fastify", "koa", "hono"].find(has) ?? null;
  return {
    framework,
    unsupported,
    packageManager: detectPackageManager(dir, pkg),
    typescript,
    esm: pkg.type === "module",
    srcDir,
    service: serviceName(typeof pkg.name === "string" && pkg.name ? pkg.name : basename(dir)),
    hasSdk: has("@nanoflags/sdk"),
    server,
  };
}
