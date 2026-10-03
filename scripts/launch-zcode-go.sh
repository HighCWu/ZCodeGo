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
# app 目录与 ensure-official-electron.mjs 同构：mac 在 .app bundle 内，其余扁平
case "$(uname -s)" in
  Darwin) APP_DIR="$ELECTRON_ROOT/ZCode Go.app/Contents/Resources/app" ;;
  *)      APP_DIR="$ELECTRON_ROOT/resources/app" ;;
esac

# 打包态 renderer（out/renderer/index.html）是必需产物：isPackaged=true 时主进程
# 从文件加载 renderer，忽略 ELECTRON_RENDERER_URL。
# 产物新鲜度：repo mtime 比 app 侧新超过 5s 才判重建（cpSync preserveTimestamps
# 存在亚秒精度损失，-nt 严格比较会在 CI 上误触发全量重建，耗时数分钟）
build_needed=0
[ ! -f "$REPO_ROOT/packages/desktop/out/main/index.js" ] && build_needed=1
[ ! -f "$REPO_ROOT/packages/desktop/out/renderer/index.html" ] && build_needed=1
[ ! -f "$APP_DIR/out/main/index.js" ] && build_needed=1
if [ "$build_needed" = 0 ]; then
  stale=$(node -e "
    const s = require('node:fs').statSync;
    const repo = s(process.argv[1]).mtimeMs;
    const app = s(process.argv[2]).mtimeMs;
    process.stdout.write(repo - app > 5000 ? '1' : '0');
  " "$REPO_ROOT/packages/desktop/out/main/index.js" "$APP_DIR/out/main/index.js" 2>>"$STATE_DIR/desktop-launch.log") || stale=0
  [ "$stale" = "1" ] && build_needed=1
fi
echo "[zcode-go] build_needed=$build_needed" >>"$STATE_DIR/desktop-launch.log" 2>&1
if [ "$build_needed" = 1 ]; then
  echo "[zcode-go] 构建桌面产物（tsup + vite build，preview 身份）…" >>"$STATE_DIR/desktop-launch.log" 2>&1
  (cd "$REPO_ROOT/packages/desktop" \
    && ZCODE_PREVIEW_IDENTITY=1 npx tsup >>"$STATE_DIR/desktop-launch.log" 2>&1 \
    && ZCODE_PREVIEW_IDENTITY=1 npx vite build >>"$STATE_DIR/desktop-launch.log" 2>&1)
fi
# ensure 需要官方二进制：优先 env，其次插件发现写入的 official.json
# （CI 与真实用户都是 official.json 路径；本机默认 /opt/ZCode/zcode 仅是兜底）
if [ -z "${ZCODE_OFFICIAL_BIN:-}" ] && [ -f "$STATE_DIR/official.json" ]; then
  ZCODE_OFFICIAL_BIN="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).bin||'')}catch{}" "$STATE_DIR/official.json")"
  export ZCODE_OFFICIAL_BIN
fi
node "$REPO_ROOT/scripts/ensure-official-electron.mjs" >>"$STATE_DIR/desktop-launch.log" 2>&1

# 根修复：本脚本多经插件 hook 拉起，而 hook 从官方进程树继承 ELECTRON_RUN_AS_NODE=1
# （官方 runtime 即官方 Electron 的 run-as-node 形态）。不清掉它，下面的官方 Electron
# 会被当纯 Node 启动，死于 "bad option: --no-sandbox"（见 desktop-launch.log 尾部）。
unset ELECTRON_RUN_AS_NODE

cd "$APP_DIR"
# Windows（Git bash）下可执行文件必须带 .exe 后缀；
# mac 克隆 bundle 内二进制保留官方原名（CFBundleExecutable 必须一致），
# 取 MacOS 目录下首个条目
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ZCODE_EXE="$ELECTRON_ROOT/zcode.exe" ;;
  Darwin)
    set -- "$ELECTRON_ROOT/ZCode Go.app/Contents/MacOS/"*
    ZCODE_EXE="${1:-}"
    [ -x "$ZCODE_EXE" ] || { echo "[zcode-go] 克隆 bundle 缺少可执行文件" >>"$STATE_DIR/desktop-launch.log" 2>&1; exit 1; }
    ;;
  *)                    ZCODE_EXE="$ELECTRON_ROOT/zcode" ;;
esac
# CI 虚拟机 GPU helper 可能不稳，显式开关降级软件渲染（真实用户默认走 GPU）
GPU_FLAGS=""
[ -n "${ZCODE_GO_DISABLE_GPU:-}" ] && GPU_FLAGS="--disable-gpu"
exec "$ZCODE_EXE" --no-sandbox $GPU_FLAGS >>"$STATE_DIR/desktop-launch.log" 2>&1
