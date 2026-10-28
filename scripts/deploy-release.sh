#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/srv/bobo"
ENV_FILE="/etc/bobo/bobo.env"
SERVICE="bobo"

if [[ $# -ne 3 ]]; then
  echo "用法: $0 <发布包.zip> <release-manifest.json> <发布包.sha256>" >&2
  exit 2
fi

ARCHIVE="$(readlink -f "$1")"
MANIFEST="$(readlink -f "$2")"
CHECKSUM="$(readlink -f "$3")"

[[ -f "$ARCHIVE" && -f "$MANIFEST" && -f "$CHECKSUM" ]] || {
  echo "发布包、清单或校验文件不存在" >&2
  exit 1
}
[[ -f "$ENV_FILE" ]] || { echo "缺少生产环境文件: $ENV_FILE" >&2; exit 1; }
[[ -d "$ROOT/shared/data" ]] || { echo "缺少生产数据目录" >&2; exit 1; }
[[ -d "$ROOT/shared/uploads" ]] || { echo "缺少生产附件目录" >&2; exit 1; }

cd "$(dirname "$ARCHIVE")"
sha256sum -c "$CHECKSUM"

TAG="$(node -e 'const m=require(process.argv[1]);if(!/^bobo-v\d+\.\d+\.\d+-[a-z0-9][a-z0-9-]*$/.test(m.tag||""))process.exit(1);process.stdout.write(m.tag)' "$MANIFEST")"
COMMIT="$(node -e 'const m=require(process.argv[1]);if(!/^[0-9a-f]{40}$/.test(m.commit||""))process.exit(1);process.stdout.write(m.commit)' "$MANIFEST")"
RELEASE="$ROOT/releases/$TAG"
BACKUP="$ROOT/backups/$(date +%Y%m%d-%H%M%S)-$TAG"
PREVIOUS=""
SWITCHED=0

[[ ! -e "$RELEASE" ]] || { echo "发布版本已存在: $RELEASE" >&2; exit 1; }
mkdir -p "$ROOT/releases" "$ROOT/backups" "$BACKUP"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [[ "${DB_DRIVER:-mysql}" == "mysql" ]]; then
  : "${MYSQL_HOST:?缺少 MYSQL_HOST}"
  : "${MYSQL_DATABASE:?缺少 MYSQL_DATABASE}"
  : "${MYSQL_USER:?缺少 MYSQL_USER}"
  MYSQL_PWD="${MYSQL_PASSWORD:-}" mysqldump \
    --host="$MYSQL_HOST" \
    --port="${MYSQL_PORT:-3306}" \
    --user="$MYSQL_USER" \
    --single-transaction \
    --routines \
    --triggers \
    "$MYSQL_DATABASE" > "$BACKUP/database.sql"
else
  tar -C "$ROOT/shared" -czf "$BACKUP/data.tar.gz" data
fi

find "$ROOT/shared/uploads" -type f -printf '%P\t%s\n' | sort > "$BACKUP/uploads-manifest.tsv"
sha256sum "$ENV_FILE" > "$BACKUP/environment.sha256"
if [[ -L "$ROOT/current" ]]; then
  PREVIOUS="$(readlink -f "$ROOT/current")"
  printf '%s\n' "$PREVIOUS" > "$BACKUP/previous-release.txt"
fi

mkdir "$RELEASE"
unzip -q "$ARCHIVE" -d "$RELEASE"
cp "$MANIFEST" "$RELEASE/release-manifest.json"
mkdir -p "$RELEASE/public"
ln -s "$ROOT/shared/data" "$RELEASE/data"
ln -s "$ROOT/shared/uploads" "$RELEASE/public/uploads"

[[ -f "$RELEASE/package-lock.json" ]] || { echo "发布包缺少 package-lock.json" >&2; exit 1; }
npm --prefix "$RELEASE" ci --omit=dev
node --check "$RELEASE/server.js"

rollback_code() {
  local exit_code=$?
  if [[ $SWITCHED -eq 1 && -n "$PREVIOUS" ]]; then
    ln -sfn "$PREVIOUS" "$ROOT/current"
    systemctl restart bobo
    echo "健康检查失败，已恢复上一代码版本；数据库未自动回滚" >&2
  fi
  exit "$exit_code"
}
trap rollback_code ERR

ln -sfn "$RELEASE" "$ROOT/current"
SWITCHED=1
systemctl restart bobo

HEALTH="$(curl --fail --silent --show-error http://127.0.0.1:3000/api/external/health)"
node -e '
const health=JSON.parse(process.argv[1]);
if(health.releaseVersion!==process.argv[2]||health.gitCommit!==process.argv[3]) process.exit(1);
' "$HEALTH" "$TAG" "$COMMIT"

trap - ERR
echo "BOBO 已切换到 $TAG ($COMMIT)"
echo "备份目录: $BACKUP"
