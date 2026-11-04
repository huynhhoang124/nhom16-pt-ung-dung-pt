#!/usr/bin/env bash
# Chỉ đo stack đã cấu hình; tên là nhãn kết quả, không tự đổi Compose/DB.
set -euo pipefail
if [[ $# != 1 || ! $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
  printf 'Dùng: BASE=http://frontend bash scripts/do-so-sanh.sh <ten-cau-hinh>\n' >&2
  exit 2
fi
name=$1
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
results="$root/tai-lieu/ket-qua-do"
mkdir -p "$results"
if [[ -e "$results/$name.json" || -e "$results/$name.log" ]]; then
  printf 'Đã có kết quả %s; chọn tên lượt chạy khác để không ghi đè.\n' "$name" >&2
  exit 2
fi
# Git Bash: Docker Desktop cần đường dẫn Windows, không tự đổi /work và /results.
source_dir="$root/tests/load"
if command -v cygpath >/dev/null 2>&1; then
  source_dir="$(cygpath -m "$source_dir")"
  results="$(cygpath -m "$results")"
fi
args=()
for var in BASE PARKING_IDS DURATION DEMO_USERNAME DEMO_PASSWORD LOOKUP_VUS RESERVE_VUS \
  LOOKUP_P95_MS RESERVE_P95_MS MAX_ERROR_RATE MIN_CHECK_RATE MAX_503_RATE MAX_504_RATE \
  POLL_TIMEOUT_MS POLL_INTERVAL_MS DEBUG_SLOW_MS; do
  if [[ -n ${!var:-} ]]; then args+=(-e "$var=${!var}"); fi
done
MSYS_NO_PATHCONV=1 docker run --rm --network "${K6_NETWORK:-nhom16-parking_default}" \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$source_dir,target=/work,readonly" \
  --mount "type=bind,source=$results,target=/results" \
  -e "CONFIG_NAME=$name" -e "SUMMARY_PATH=/results/$name.json" \
  "${args[@]}" grafana/k6 run /work/k6.js 2>&1 | tee "$root/tai-lieu/ket-qua-do/$name.log"
# pipefail giữ mã lỗi k6 (kể cả threshold fail), log/JSON vẫn còn để đối chiếu.
