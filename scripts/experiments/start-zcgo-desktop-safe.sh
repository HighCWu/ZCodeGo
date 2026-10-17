#!/usr/bin/env bash
# zcode-go 桌面安全启动（试验用）：全套前置检查通过才启动，任一失败拒绝。
#
# 背景：launcher 的构建新鲜度判定只比较「repo 构建产物 vs 组装产物」的 mtime，
# 不感知分支切换——切到 rsi 后旧产物被直接组装启动（无 EXP_MODE 共存保护），
# 旧 closeOfficial 默认值导致官版被杀（2026-10-17 事故）。本脚本把该类前提
# 全部变成显式检查。
set -euo pipefail

REPO_ROOT="${ZCODE_GO_REPO_ROOT:-/home/whc/pnpm_repos/zcode-go}"
STATE_DIR="$HOME/.zcode-go"
EXP_COMMIT="9ae91b97"

fail() { echo "[safe-start] 拒绝启动：$*"; exit 1; }
log() { echo "[safe-start] $*"; }

# 1) 官版必须在跑（没有官版就没有「共存」对象，本脚本场景不适用）
if ! pgrep -x ZCode >/dev/null 2>&1 && ! pgrep -f "^/opt/ZCode/zcode( |$)" >/dev/null 2>&1; then
  fail "官版 zcode 未运行——本脚本用于与官版共存的试验场景"
fi
log "官版 zcode 进程存在（$(pgrep -cx ZCode || pgrep -cf '^/opt/ZCode/zcode') 个进程组）"

# 2) 仓库路径与分支校验：必须是我们项目的 rsi 分支，且含 EXP_MODE 提交
[ -d "$REPO_ROOT/.git" ] || fail "REPO_ROOT 不是 git 仓库：$REPO_ROOT"
branch="$(git -C "$REPO_ROOT" branch --show-current)"
[ "$branch" = "rsi" ] || fail "主克隆不在 rsi 分支（当前：$branch）"
if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$EXP_COMMIT" HEAD 2>/dev/null; then
  fail "HEAD 不含 EXP_MODE 提交 $EXP_COMMIT"
fi
head_line="$(git -C "$REPO_ROOT" log --oneline -1)"
log "仓库校验通过：$REPO_ROOT @ rsi → ${head_line%% *}"

# 3) EXP_MODE 共存开关必须存在
[ -f "$STATE_DIR/EXP_MODE" ] || fail "$STATE_DIR/EXP_MODE 不存在（无共存保障）"
log "EXP_MODE 存在：桌面 enterZCodeGo 将强制共存（不杀官版）"

# 4) 强制重建主克隆桌面产物（不信任任何既有 out/），产物必须含 EXP_MODE 逻辑
cd "$REPO_ROOT/packages/desktop"
log "强制重建桌面产物（tsup + vite build，preview 身份）…"
rm -rf out
ZCODE_PREVIEW_IDENTITY=1 npx tsup >>"$STATE_DIR/desktop-launch.log" 2>&1 || fail "tsup 构建失败（见 $STATE_DIR/desktop-launch.log）"
ZCODE_PREVIEW_IDENTITY=1 npx vite build >>"$STATE_DIR/desktop-launch.log" 2>&1 || fail "vite 构建失败（见 $STATE_DIR/desktop-launch.log）"
grep -q "EXP_MODE" out/main/index.js || fail "构建产物不含 EXP_MODE 共存逻辑——产物与源码不符"
grep -q "ZCODE_GO_EXP_HTTP" out/main/index.js || fail "构建产物不含试验接口挂载"
log "产物校验通过：out/main/index.js 含 EXP_MODE 与试验接口逻辑"

# 5) 组装（ensure 幂等）并验证组装产物同样含 EXP_MODE
ZCODE_OFFICIAL_BIN="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).bin||'')}catch{}" "$STATE_DIR/official.json")"
[ -n "$ZCODE_OFFICIAL_BIN" ] || ZCODE_OFFICIAL_BIN="/opt/ZCode/zcode"
export ZCODE_OFFICIAL_BIN
node "$REPO_ROOT/scripts/ensure-official-electron.mjs" >>"$STATE_DIR/desktop-launch.log" 2>&1 || fail "ensure-official-electron 组装失败"
case "$(uname -s)" in
  Darwin) APP_DIR="$STATE_DIR/electron/ZCode Go.app/Contents/Resources/app" ;;
  *)      APP_DIR="$STATE_DIR/electron/resources/app" ;;
esac
grep -q "EXP_MODE" "$APP_DIR/out/main/index.js" || fail "组装产物不含 EXP_MODE——组装用错产物"
log "组装产物校验通过：$APP_DIR"

# 6) 启动前变量值留痕（证据行，与 launcher 实际 export 对齐）
log "启动变量：ZCODE_GO_TAKEOVER=1（launcher export）"
log "启动变量：ZCODE_DESKTOP_APPLICATION_NAME=ZCode Go（与官版单实例锁隔离）"
log "启动变量：ZCODE_GO_EXP_HTTP=1（EXP_MODE 触发 launcher export）"
log "启动变量：ELECTRON_RUN_AS_NODE 由 launcher unset（当前 shell 值：'${ELECTRON_RUN_AS_NODE:-<空>}'）"
log "启动变量：ZCODE_OFFICIAL_BIN=$ZCODE_OFFICIAL_BIN"

# 7) 启动（launcher 此时 stale 判定为不重建，直接组装校验 + 启动）
log "拉起 launch-zcode-go.sh…"
cd "$REPO_ROOT"
printf '' > "$STATE_DIR/SHOW"
nohup bash scripts/launch-zcode-go.sh >>"$STATE_DIR/desktop-launch.log" 2>&1 &
echo "[safe-start] launcher 已后台启动 pid=$!；观察：$STATE_DIR/desktop-launch.log 与 ~/.zcode/opc/exp/http-port"
