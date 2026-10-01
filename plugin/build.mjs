#!/usr/bin/env node
/**
 * 构建插件：plugin/src/zcode-go.ts → plugin/hooks/zcode-go.cjs（esbuild 单文件 bundle）。
 * 运行时由官方 Electron（ELECTRON_RUN_AS_NODE=1）执行，产物零依赖。
 */
import { build } from "esbuild";
import { renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(repoRoot, "plugin", "src", "zcode-go.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(repoRoot, "plugin", "hooks", "zcode-go.bundle.cjs"),
  minify: false,
  legalComments: "none",
  logLevel: "warning",
});
renameSync(
  join(repoRoot, "plugin", "hooks", "zcode-go.bundle.cjs"),
  join(repoRoot, "plugin", "hooks", "zcode-go.cjs"),
);
console.log("[plugin-build] plugin/hooks/zcode-go.cjs 就绪");
