/**
 * After `bun run build:web`, generates `public/dist/sw.js` (and workbox runtime chunk)
 * via workbox-build. Precache revisions bump when `package.json` version or any
 * hashed/checked asset changes, avoiding stale caches across deploys.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { generateSW } from "workbox-build";

const root = resolve(import.meta.dirname, "..");

const distDir = resolve(root, "public/dist");
if (existsSync(distDir)) {
  for (const name of readdirSync(distDir)) {
    if (
      name === "sw.js" ||
      name.startsWith("sw.js.") ||
      name.startsWith("workbox-")
    ) {
      unlinkSync(resolve(distDir, name));
    }
  }
}

function revisionFor(relativeToRoot: string): string {
  const buf = readFileSync(resolve(root, relativeToRoot));
  return createHash("sha256").update(buf).digest("hex").slice(0, 20);
}

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string;
};

const additionalManifestEntries: { url: string; revision: string }[] = [
  { url: "/main.css", revision: revisionFor("src/web/main.css") },
  { url: "/manifest.json", revision: revisionFor("src/web/manifest.json") },
];

for (const name of ["fifos.png", "fifos-192.png", "fifos-512.png"] as const) {
  const rel = `public/${name}`;
  if (existsSync(resolve(root, rel))) {
    additionalManifestEntries.push({
      url: `/${name}`,
      revision: revisionFor(rel),
    });
  }
}

const { count, size, warnings } = await generateSW({
  swDest: resolve(root, "public/dist/sw.js"),
  globDirectory: resolve(root, "public/dist"),
  globPatterns: ["**/*.js"],
  globIgnores: [
    "sw.js",
    "sw.js.map",
    "workbox-*.js",
    "workbox-*.js.map",
  ],
  cacheId: `fifos-${pkg.version}`,
  cleanupOutdatedCaches: true,
  skipWaiting: true,
  clientsClaim: true,
  additionalManifestEntries,
});

for (const w of warnings) console.warn(w);
console.log(`Service worker: ${count} precache entries, ${size} bytes total`);
