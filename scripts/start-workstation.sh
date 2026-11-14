#!/usr/bin/env bash
# Starts the local workstation service and opens the workbench.
# Usage: ./scripts/start-workstation.sh [--dev] [--port 4318]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

mode="production"
port="4318"
while [ $# -gt 0 ]; do
  case "$1" in
    --dev) mode="development"; shift ;;
    --port)
      case "${2:-}" in
        ''|*[!0-9]*) echo "--port 必须是 1 到 65535 之间的整数。" >&2; exit 2 ;;
      esac
      if [ "$2" -lt 1 ] || [ "$2" -gt 65535 ]; then echo "--port 必须是 1 到 65535 之间的整数。" >&2; exit 2; fi
      port="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [ ! -d node_modules ]; then
  echo "首次运行：正在安装依赖…" >&2
  npm install
fi

if [ "$mode" = "production" ] && [ ! -f dist/server/adapters/http/server.js ]; then
  echo "正在构建…" >&2
  npm run build
fi

port_file="$root/.workstation/port"
mkdir -p "$(dirname "$port_file")"

if [ "$mode" = "development" ]; then
  if [ "$port" != "4318" ]; then
    echo "开发模式忽略 --port，使用 API 端口 4318。" >&2
    port="4318"
  fi
  echo "开发模式：前端 5173，API 4318" >&2
  npm run dev &
  launcher_pid=$!
else
  node dist/server/adapters/http/server.js --port "$port" &
  launcher_pid=$!
fi

cleanup() { kill "$launcher_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if curl --silent --fail --max-time 1 "http://127.0.0.1:$port/api/health" > /dev/null 2>&1; then break; fi
  sleep 0.5
done

url="http://127.0.0.1:$port/"
echo "$url" > "$port_file"
echo "工作站已启动：$url" >&2

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) start "" "$url" > /dev/null 2>&1 || true ;;
  Darwin) open "$url" > /dev/null 2>&1 || true ;;
  *) xdg-open "$url" > /dev/null 2>&1 || true ;;
esac

wait "$launcher_pid"
