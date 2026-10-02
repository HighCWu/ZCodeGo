#!/bin/sh
# zcode-go 插件引导（Linux/macOS）：在祖先链中定位官方 Electron 二进制，
# 以 ELECTRON_RUN_AS_NODE=1 执行插件 CJS（用户机无需 node/python）。
# 非 Linux/macOS 环境以退出码 3 交回 hooks.json 的 || 链（Windows → PowerShell）。
set -u

trace="${HOME:-.}/.zcode-go/bootstrap-trace.log"

HOOK_CJS="$(dirname "$0")/zcode-go.cjs"

exe=""
# env 捷径：e2e / 已知官方路径的场景直接采用（CI 必经；真实用户桌面路径走下方祖先链）
exe="${ZCODE_GO_OFFICIAL_BIN:-}"
case "$exe" in
  */*) [ -x "$exe" ] || exe="" ;;
  *) exe="" ;;
esac
if [ -d /proc ]; then
  pid=$$
  while [ "${pid:-0}" -gt 1 ]; do
    e=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
    case "$e" in
      *[Zz][Cc]ode*)
        case "$e" in *zcode-go*|*zcode_go*) ;; *) exe="$e"; break ;; esac
        ;;
    esac
    pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null) || break
    [ -n "${pid:-}" ] || break
  done
elif command -v ps >/dev/null 2>/dev/null; then
  pid=$$
  depth=0
  while [ "${pid:-0}" -gt 1 ] && [ "$depth" -lt 64 ]; do
    e=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    case "$e" in
      */*) ;;                 # 全路径
      *)  # 某些平台 comm 只有程序名——回退 args 首词（完整可执行路径）
        e=$(ps -o args= -p "$pid" 2>/dev/null | awk '{print $1}')
        ;;
    esac
    echo "ps-walk depth=$depth pid=$pid exe=${e:-<empty>}" >> "$trace" 2>/dev/null
    case "$e" in
      *[Zz][Cc]ode*)
        case "$e" in *zcode-go*|*zcode_go*) ;; *) exe="$e"; break ;; esac
        ;;
      *)
        # macOS：Electron 改写进程标题（comm/args 变 "zcode-cli"），ps 拿不到
        # 路径——用 lsof txt 段解析真实可执行文件
        case "$e" in
          zcode-cli|*[Zz][Cc]ode*-cli)
            full=$(lsof -p "$pid" 2>/dev/null | awk '$4=="txt" {print $NF; exit}')
            case "$full" in
              */*[Zz][Cc]ode*)
                case "$full" in *zcode-go*|*zcode_go*) ;; *) exe="$full"; break ;; esac
                ;;
            esac
            ;;
        esac
        ;;
    esac
    next=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$next" ] || break
    pid=$next
    depth=$((depth + 1))
  done
fi

if [ -z "$exe" ] || [ ! -x "$exe" ]; then
  echo "ps-walk result: not-found" >> "${trace:-/dev/null}" 2>/dev/null
  echo "zcode-go bootstrap: official binary not found in ancestors" >&2
  exit 3
fi
echo "ps-walk result: $exe" >> "${trace:-/dev/null}" 2>/dev/null

ELECTRON_RUN_AS_NODE=1 exec "$exe" "$HOOK_CJS" hook
