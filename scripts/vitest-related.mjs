#!/usr/bin/env node
// Runs `vitest related` scoped to whichever workspace package(s) own the
// staged files, so the pre-commit hook only re-tests what could be affected
// instead of every package's whole suite.
import { spawnSync } from "node:child_process";
import { relative } from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) process.exit(0);

const packageDirs = ["apps/server", "apps/web", "packages/shared"];

const byPackage = new Map();
for (const file of files) {
  const pkg = packageDirs.find((dir) => file.startsWith(`${dir}/`));
  if (!pkg) continue;
  const list = byPackage.get(pkg) ?? [];
  list.push(relative(pkg, file));
  byPackage.set(pkg, list);
}

for (const [pkg, relativeFiles] of byPackage) {
  const result = spawnSync(
    "pnpm",
    ["--filter", `./${pkg}`, "exec", "vitest", "related", "--run", ...relativeFiles],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
