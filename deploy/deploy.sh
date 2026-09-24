#!/usr/bin/env bash
# ============================================================
# 食堂核销系统 · 一键部署（全新服务器 / 日常更新通用）
#
# 用法：
#   bash deploy.sh            # 完整流程：前端构建 → 初始化 → 证书 → 起服务 → 冒烟
#   bash deploy.sh --skip-fe  # 跳过前端构建（前端没改时加速）
#   bash deploy.sh --skip-ssl # 跳过证书检查（已签发/仅内网调试）
#
# 前置（全新服务器一次性）：
#   1. 装 docker + compose 插件
#   2. cp .env.example .env 并填真实值
#   3. DNS 已把域名解析到本机
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

SKIP_FE=0; SKIP_SSL=0
for arg in "$@"; do
  case "$arg" in
    --skip-fe)  SKIP_FE=1 ;;
    --skip-ssl) SKIP_SSL=1 ;;
  esac
done

DOMAIN="${DOMAIN:-tuancan.gengle.xyz}"

step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f .env ] || die "缺 .env：先 cp .env.example .env 填好真实值"
# shellcheck disable=SC1091
set -a; source .env; set +a
[ "${JWT_SECRET:0:9}" != "change-me" ] || die ".env 里的密钥还是模板占位值，先填真实值"

step "1/6 前端构建"
if [ "$SKIP_FE" = 1 ] && [ -d ../admin-web/dist ]; then
  echo "跳过（--skip-fe，沿用现有 dist）"
else
  ( cd ../admin-web && npm ci --silent && npm run build )
  [ -f ../admin-web/dist/index.html ] || die "前端构建后没有 dist/index.html"
fi

step "2/6 MySQL 初始化脚本准备（仅首次）"
if [ -f mysql/init/.done ]; then
  echo "已初始化过，跳过（删 mysql/init/.done 可强制重建初始化脚本，不影响已有数据卷）"
else
  mkdir -p mysql/init
  # 01：业务账号授权（密码从 .env 注入，SQL 不落明文到仓库）
  cat > mysql/init/01-create-user.sql <<SQL
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL
  # 02/03：建表 + 种子（与 backend/sql 严格同源）
  cp ../backend/sql/init.sql mysql/init/02-schema.sql
  cp ../backend/sql/seed.sql mysql/init/03-seed.sql
  touch mysql/init/.done
  echo "已生成 mysql/init/（建账号 → 建表 → 种子，仅空数据卷时执行）"
fi

step "3/6 HTTPS 证书"
if [ "$SKIP_SSL" = 1 ]; then
  echo "跳过（--skip-ssl）"
elif [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  echo "证书已存在：/etc/letsencrypt/live/${DOMAIN}"
else
  command -v certbot >/dev/null || die "未装 certbot：apt install -y certbot（webroot 模式需 80 端口可访问）"
  # 先临时起一个纯 80 的 nginx 供 ACME 验证（compose 起来后由 web 容器接管）
  mkdir -p certbot
  docker run --rm -d --name canteen-certbot-bootstrap -p 80:80 \
    -v "$(pwd)/certbot:/var/www/certbot:ro" nginx:alpine \
    nginx -t -c /dev/stdin <<NGINX || true
events {}
http { server { listen 80; location /.well-known/acme-challenge/ { root /var/www/certbot; } } }
NGINX
  sleep 1
  certbot certonly --webroot -w ./certbot -d "${DOMAIN}" \
    --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring \
    || { docker rm -f canteen-certbot-bootstrap 2>/dev/null || true; die "证书签发失败：检查 DNS 是否解析到本机、80 端口是否可访问"; }
  docker rm -f canteen-certbot-bootstrap 2>/dev/null || true
  echo "证书签发成功；续期 crontab 建议：0 3 * * 1 certbot renew --webroot -w $(pwd)/certbot && docker exec canteen-web nginx -s reload"
fi

step "4/6 启动编排"
docker compose up -d --build

step "5/6 等待健康"
for i in $(seq 1 30); do
  ST=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null | tr '\n' ' ')
  echo "  [$i] $ST"
  echo "$ST" | grep -q "api healthy" && break
  [ "$i" = 30 ] && { docker compose logs --tail 30 api; die "api 30 次探测未健康"; }
  sleep 4
done

step "6/6 冒烟"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_HOST_PORT:-3100}/" || true)
[ "$CODE" != "000" ] || die "后端端口无响应"
echo "api 冒烟：HTTP ${CODE} ✓"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/" --max-time 10 || true)
echo "web 冒烟：HTTP ${CODE}（200/301 即正常）"

printf '\n\033[1;32m✔ 部署完成：https://%s\033[0m\n' "${DOMAIN}"
