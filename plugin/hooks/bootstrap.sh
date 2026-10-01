#!/bin/sh
# zcode-go 插件引导（Linux/macOS）：在祖先链中定位官方 Electron 二进制，
# 以 ELECTRON_RUN_AS_NODE=1 执行插件 CJS（用户机无需 node/python）。
# 非 Linux/macOS 环境以退出码 3 交回 hooks.json 的 || 链（Windows → PowerShell）。
set -u

HOOK_CJS="$(dirname "$0")/zcode-go.cjs"

exe=""
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
elif command -v ps >/dev/null 2>&1; then
  pid=$$
  depth=0
  while [ "${pid:-0}" -gt 1 ] && [ "$depth" -lt 64 ]; do
    e=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    case "$e" in
      *[Zz][Cc]ode*)
        case "$e" in *zcode-go*|*zcode_go*) ;; *) exe="$e"; break ;; esac
        ;;
    esac
    next=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$next" ] || break
    pid=$next
    depth=$((depth + 1))
  done
fi

if [ -z "$exe" ] || [ ! -x "$exe" ]; then
  echo "zcode-go bootstrap: official binary not found in ancestors" >&2
  exit 3
fi

ELECTRON_RUN_AS_NODE=1 exec "$exe" "$HOOK_CJS" hook
