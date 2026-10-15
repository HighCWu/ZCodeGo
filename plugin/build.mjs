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
  // esbuild 会剥掉源码头部的 oxlint-disable 注释（该注释是仓库对单文件收口
  // 产物的豁免约定，见 e6936da7），必须用 banner 注回产物，否则全量 lint 误报。
  banner: {
    js: "/* oxlint-disable eslint(max-lines) -- 编译产物：单文件收口是有意为之（同源码约定），拆散会破坏内聚。 */",
  },
});
renameSync(
  join(repoRoot, "plugin", "hooks", "zcode-go.bundle.cjs"),
  join(repoRoot, "plugin", "hooks", "zcode-go.cjs"),
);
console.log("[plugin-build] plugin/hooks/zcode-go.cjs 就绪");
