# ===== 阶段 1：构建 =====
# 用带有 devDependencies 的完整依赖跑 tsc 编译出 dist/
FROM node:20.18-alpine3.20 AS builder
WORKDIR /app

# 先只拷依赖清单，利用 Docker 层缓存：
# package.json 没变时，npm ci 直接命中缓存，改代码重构建只需几秒
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# ===== 阶段 2：运行 =====
# 运行镜像只带生产依赖 + 编译产物，体积小、攻击面小
FROM node:20.18-alpine3.20
WORKDIR /app
ENV NODE_ENV=production

# tini 作为 PID 1：正确转发 SIGTERM，pm2/裸 node 在容器里都不如它可靠
RUN apk add --no-cache tini
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./

# 容器内以非 root 运行
USER node

EXPOSE 3100
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
