import { build, context } from "esbuild";

const production = process.argv.includes("--production");
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  await (await context(options)).watch();
} else {
  await build(options);
}
