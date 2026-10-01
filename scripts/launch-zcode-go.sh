#!/usr/bin/env bash
# zcode-go 桌面启动器（接管模式）。
#
# 复用官方 Electron，不发行第二份 Electron：
#   1. ensure-official-electron.mjs 幂等装配 ~/.zcode-go/electron/
#      （官方二进制：硬链接→reflink→复制阶梯；Chromium 资产符号链接；
#        resources/app = 本仓库桌面构建产物）
#   2. 以 ZCODE_GO_TAKEOVER=1 启动；应用身份 "ZCode Go" 与官方单实例锁隔离
#   3. 底层原生运行时由 zcodeAgentProcessManager 读取 ~/.zcode-go/official.json
#      重定向到官方安装（本脚本不做任何 runtime 环境拼装）
#
# renderer dev 形态依赖 vite（5174）；未运行时自动后台拉起。
# 未来打包分发：resources/app 换为随包内置产物 + 内置 renderer，其余不变。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/.zcode-go"
mkdir -p "$STATE_DIR"

export ZCODE_GO_TAKEOVER=1
# 单实例身份隔离：官方（"ZCode"）与本应用（"ZCode Go"）可同时常驻。
export ZCODE_DESKTOP_APPLICATION_NAME="ZCode Go"

if [ ! -f "$STATE_DIR/official.json" ]; then
  echo "[zcode-go] warn: $STATE_DIR/official.json 缺失——请先在官方会话内执行 /zcode-go（插件负责探测写入），否则底层运行时回落本仓库链条" >>"$STATE_DIR/desktop-launch.log" 2>&1
fi

ELECTRON_ROOT="$STATE_DIR/electron"
APP_DIR="$ELECTRON_ROOT/resources/app"

# 打包态 renderer（out/renderer/index.html）是必需产物：isPackaged=true 时主进程
# 从文件加载 renderer，忽略 ELECTRON_RENDERER_URL。
build_needed=0
[ ! -f "$REPO_ROOT/packages/desktop/out/main/index.js" ] && build_needed=1
[ ! -f "$REPO_ROOT/packages/desktop/out/renderer/index.html" ] && build_needed=1
[ "$REPO_ROOT/packages/desktop/out/main/index.js" -nt "$APP_DIR/out/main/index.js" ] 2>/dev/null && build_needed=1
[ "$REPO_ROOT/packages/desktop/out/renderer/index.html" -nt "$APP_DIR/out/renderer/index.html" ] 2>/dev/null && build_needed=1
[ ! -f "$APP_DIR/out/main/index.js" ] && build_needed=1
if [ "$build_needed" = 1 ]; then
  echo "[zcode-go] 构建桌面产物（tsup + vite build，preview 身份）…" >>"$STATE_DIR/desktop-launch.log" 2>&1
  (cd "$REPO_ROOT/packages/desktop" \
    && ZCODE_PREVIEW_IDENTITY=1 npx tsup >>"$STATE_DIR/desktop-launch.log" 2>&1 \
    && ZCODE_PREVIEW_IDENTITY=1 npx vite build >>"$STATE_DIR/desktop-launch.log" 2>&1)
fi
node "$REPO_ROOT/scripts/ensure-official-electron.mjs" >>"$STATE_DIR/desktop-launch.log" 2>&1

cd "$APP_DIR"
exec "$ELECTRON_ROOT/zcode" --no-sandbox >>"$STATE_DIR/desktop-launch.log" 2>&1
