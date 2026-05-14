#!/usr/bin/env bun
/**
 * Vendor selected parts of the peer ../pues into ./pues.
 *
 * Which parts to vendor is declared in config/pues.yaml under `parts:`.
 * Edit that file to opt this consumer into more of pues over time.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const SRC_BASE = "../pues/base";
const DST_BASE = "pues/base";

const config = Bun.YAML.parse(await Bun.file("config/pues.yaml").text()) as {
  parts?: string[];
};
const parts = config.parts ?? [];

if (parts.length === 0) {
  console.error("config/pues.yaml has no `parts:` list — nothing to vendor.");
  process.exit(1);
}

if (!existsSync(SRC_BASE)) {
  console.error(`No peer pues found at ${SRC_BASE}`);
  process.exit(1);
}

await rm("pues", { recursive: true, force: true });
await mkdir(DST_BASE, { recursive: true });

for (const part of parts) {
  await cp(`${SRC_BASE}/${part}`, `${DST_BASE}/${part}`, { recursive: true });
}

console.log(`Vendored pues/base: ${parts.join(", ")}`);
