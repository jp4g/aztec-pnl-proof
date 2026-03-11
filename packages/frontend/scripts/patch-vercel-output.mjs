/**
 * Patches .vercel/output after `vercel build`.
 *
 * Two issues with Vercel's builder for this project:
 * 1. File tracing doesn't follow symlinks outside the project root, so the
 *    serverless function is missing route.js and its chunks.
 * 2. pino/pino-pretty are marked as serverExternalPackages (they use
 *    worker_threads which webpack can't bundle), so they need to be copied
 *    into the function's node_modules.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const funcDir = resolve(root, ".vercel/output/functions/api/audit/events.func");

// 1. Copy route bundle files
const routeSrc = resolve(root, ".next/server/app/api/audit/events");
const routeDest = resolve(funcDir, ".next/server/app/api/audit/events");

if (!existsSync(routeSrc)) {
  console.error("ERROR: .next build output not found. Run `vercel build` first.");
  process.exit(1);
}

mkdirSync(routeDest, { recursive: true });
for (const file of ["route.js", "route_client-reference-manifest.js"]) {
  cpSync(resolve(routeSrc, file), resolve(routeDest, file));
}

// Copy shared chunks
const chunksDir = resolve(root, ".next/server/chunks");
const destChunks = resolve(funcDir, ".next/server/chunks");
if (existsSync(chunksDir)) {
  mkdirSync(destChunks, { recursive: true });
  for (const file of readdirSync(chunksDir)) {
    if (file.endsWith(".js")) {
      cpSync(resolve(chunksDir, file), resolve(destChunks, file));
    }
  }
}

// Copy webpack runtime
const wpRuntime = resolve(root, ".next/server/webpack-runtime.js");
if (existsSync(wpRuntime)) {
  cpSync(wpRuntime, resolve(funcDir, ".next/server/webpack-runtime.js"));
}

// 2. Copy pino ecosystem into function's node_modules
const pinoSource = resolve(root, "node_modules");
const destNodeModules = resolve(funcDir, "node_modules");

const pinoPackages = [
  // pino core + deps
  "pino", "pino-pretty", "pino-abstract-transport", "pino-std-serializers",
  "atomic-sleep", "fast-redact", "on-exit-leak-free", "process-warning",
  "quick-format-unescaped", "real-require", "safe-stable-stringify",
  "sonic-boom", "thread-stream",
  // pino-pretty deps
  "colorette", "dateformat", "fast-copy", "fast-safe-stringify",
  "help-me", "joycon", "minimist", "pump", "secure-json-parse",
  "strip-json-comments",
];

let copied = 0;
for (const pkg of pinoPackages) {
  const src = resolve(pinoSource, pkg);
  const dest = resolve(destNodeModules, pkg);
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true });
    copied++;
  } else {
    console.warn(`  WARN: ${pkg} not found at ${src}`);
  }
}

console.log(`Patched .vercel/output: route bundle + ${copied} pino packages.`);
