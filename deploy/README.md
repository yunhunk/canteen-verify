# 食堂核销系统 · Docker Compose 部署手册

一条命令拉起全部四个服务：**MySQL 8 + Redis 7 + 后端 API + 前端 nginx（HTTPS）**。
所有配置集中在 `deploy/.env`，换环境只改这一个文件。

## 目录结构

```
deploy/
├── docker-compose.yml   # 服务编排（结构固化，敏感值全走 .env）
├── .env.example         # 全量配置模板（复制为 .env 填真实值）
├── nginx/default.conf   # 前端反代配置（80→301→443 + ACME 验证路径）
├── mysql/init/          # 首次启动自动建账号/建表/种子（deploy.sh 生成）
├── certbot/             # 证书 HTTP-01 验证目录（certbot webroot）
├── deploy.sh            # 一键部署：构建→初始化→证书→起服务→冒烟
└── README.md
```

## 全新服务器（首次）

```bash
# 0. 前置：Docker + Compose 插件、git、certbot
apt update && apt install -y docker.io docker-compose-plugin certbot

# 1. 配置
cd deploy && cp .env.example .env && vim .env     # 填全部真实值

# 2. 一键部署
bash deploy.sh
```

`deploy.sh` 会依次：构建前端 → 生成 MySQL 初始化脚本（建账号/表/种子，仅空数据卷执行）
→ 签发 Let's Encrypt 证书（webroot，不停服）→ `docker compose up -d --build` → 等健康 → 冒烟。

## 日常更新（改了代码后）

```bash
bash deploy.sh            # 全量（前后端都重建）
bash deploy.sh --skip-fe  # 只改了后端
```

## 配置项总览（.env）

| 变量 | 说明 | 默认/示例 |
|---|---|---|
| `MYSQL_ROOT_PASSWORD` | MySQL root 密码 | 建库时生效 |
| `DB_USER` / `DB_PASSWORD` | 业务账号（api 连库） | 首次启动自动创建授权 |
| `DB_NAME` | 库名 | `canteen_verify` |
| `DB_SYNC` | 实体自动同步 | **生产必须 0**，改实体须跑迁移 SQL |
| `MYSQL_HOST_PORT` 等 | 宿主侧端口（只绑 127.0.0.1） | 3307 / 6380 / 3100 |
| `JWT_SECRET` | 登录态签名密钥 | `openssl rand -hex 32` |
| `JWT_EXPIRES_IN` | 登录有效期 | 7d |
| `QRCODE_TTL` | 核销码有效期（秒） | 300 |
| `WX_APPID` / `WECHAT_APPSECRET` | 微信小程序凭证 | 后台重置后须同步 |
| `ALLOW_LEGACY_DEVICE_TOKEN` | 老设备明文密钥通道 | 0 |
| `TZ` | 时区 | Asia/Shanghai |
| `DOMAIN` | 签证书用的域名 | `tuancan.gengle.xyz` |

## 安全边界（编排内置）

- **MySQL / Redis / API 端口全部只绑 `127.0.0.1`**，公网只能走 80/443 的 nginx
- API 容器以非 root 用户运行；镜像多阶段构建，不带 devDependencies
- 证书目录 `/etc/letsencrypt` 只读挂载；数据落 named volume（`mysql-data` / `redis-data`）

## 证书续期（每 60 天自动到期）

```bash
# crontab -e
0 3 * * 1 certbot renew --webroot -w /path/to/deploy/certbot && docker exec canteen-web nginx -s reload
```

## 常用运维

```bash
docker compose ps                      # 各服务健康状态
docker compose logs -f api             # 后端日志
docker compose restart api             # 只重启后端
docker compose exec mysql mysql -uroot -p canteen_verify   # 进数据库
docker compose down                    # 停止（数据保留）
docker compose down -v                 # ⚠️ 删数据卷（数据库清空）
```

## 与旧部署（pm2 + 手工容器）的关系

编排与本仓库即为唯一部署真相；旧机器上 `pm2 delete canteen-api`、
`docker rm -f canteen-web canteen-mysql canteen-redis` 后按本手册重建即可。
数据迁移：旧库 `mysqldump` → 新卷 `mysql < dump.sql`。
