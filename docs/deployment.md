# Quill 自部署指南

> 范围：把 server + web 打成一个 Docker 镜像，用 `docker compose up` 单进程托管。
> 对应 `docs/web-server.md` 实施路径第 8 步。

## 前置

- Docker + Docker Compose v2 (`docker compose` 子命令，不是老的 `docker-compose`)
- 一台能访问的服务器（运行 Linux/macOS 都行）
- 一个域名（可选；不接 HTTPS 用 IP+端口也能跑）

## Quick start（一键）

```bash
git clone https://github.com/HanchenZhou/quill.git
cd quill

./scripts/quill-init.sh     # 提示输入密码 → 生成 config.yaml + vault/
docker compose up -d        # 自动 build + 起容器

curl http://localhost:3000/health   # → {"ok":true}
# 浏览器打开 http://localhost:3000
```

`quill-init.sh` 做的事：

1. 创建 `./vault/` 目录
2. 询问密码，**用 build 出来的镜像本身** 跑 bcrypt 哈希（不依赖主机有 bun）
3. 用 `/dev/urandom` 生成 256 bit session secret
4. 写 `./config.yaml`（权限 0600）

config.yaml 已经生成后再跑脚本是安全的——它会跳过、不覆盖。

**想配 AI provider**：跑完 init 之后编辑 `./config.yaml`，把里面注释掉的
`ai.providers` 段取消注释，填上 `api_key`（推荐写成 `${OPENAI_API_KEY}` 然后
通过 `.env` 注入），然后 `docker compose up -d` 重启容器。

## 配置文件详解

`config.yaml` 完整 schema 见 `apps/server/config.example.yaml` + zod 校验源
（`apps/server/src/config.ts`）。**broken config 会让 server 直接拒启**，方便提前
发现问题。

环境变量插值：YAML 里任何 `${VAR_NAME}` 在解析前会从 `process.env` 替换。常用：

```yaml
auth:
  password_hash: "${PASSWORD_HASH}"      # docker compose 的 env_file 注入
  session_secret: "${SESSION_SECRET}"
ai:
  providers:
    - id: openai
      api_key: "${OPENAI_API_KEY}"
```

`docker-compose.yml` 已经把这几个常用变量从主机 env 透传进容器；不想透传敏感
key 时，用 `--env-file` 单独提供：

```bash
echo "OPENAI_API_KEY=sk-xxx" > .env.prod
docker compose --env-file .env.prod up -d
```

## 数据布局

- `./vault/` → 容器 `/data/vault`：所有 markdown 文件。**这是用户数据，
  备份这一个目录就够。**
- `./config.yaml` → 容器 `/data/config.yaml`（只读挂载）

镜像本身**不存任何用户状态**——`docker compose down` 后 `vault/` 和 `config.yaml`
留在主机，重新 build / 升级镜像不丢东西。

## 端口与 HTTPS

默认 compose 文件把 3000 端口**只绑定到 127.0.0.1**（避免没装 HTTPS 就裸暴露）。
公网访问推荐前面接一个反向代理：

### Caddy（最简单，自动 HTTPS）

```caddy
quill.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name quill.example.com;

    ssl_certificate /etc/letsencrypt/live/quill.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/quill.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        # WebSocket upgrade for /api/agent
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

> **WebSocket 注意**：Agent 端点 `/api/agent` 走 WebSocket，反代必须配置 `Upgrade`
> 头转发，否则 AI 功能在生产环境完全用不了。Caddy 默认就支持；nginx 需要上面那
> 两行 `proxy_set_header`。

要直接暴露不接反代（dev only），把 `docker-compose.yml` 里的：

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

改成 `"3000:3000"`。

## 升级

```bash
git pull
docker compose build --pull
docker compose up -d
```

镜像内**没有数据库或缓存层**，重启零成本。Session JWT 用 `session_secret` 签名，
只要这个 secret 不变，老 cookie 升级后仍然有效。

## 故障排查

- `docker compose logs quill` 看启动日志
- 启动日志输出 JSON，第一行带 \`{event: "server-start", ...}\` 说明 config 解析通过
- `curl localhost:3000/health` 是无鉴权的 liveness probe；不通就是没起来
- 容器内 `/data/config.yaml` 必须存在且能读；权限问题最常见——主机上
  `chmod 644 config.yaml`
- Vault 目录权限：容器以 `bun` 用户（uid 通常 1000）运行，主机上
  `./vault/` 至少要让这个 uid 能读写

## 备份策略

需要备份的只有两个东西：

```bash
# 数据
tar czf quill-backup-$(date +%F).tar.gz vault/ config.yaml
```

恢复：解压到新服务器，`docker compose up -d`，完事。

## 性能与资源

- 内存峰值 ~200 MB（Bun runtime + node stdlib + 应用代码）
- CPU：空闲几乎为 0；AI 请求时主要是网络等待（agent 调用上游 LLM API）
- 磁盘：镜像 ~150 MB；运行时只占 vault 大小
- 网络：每次 AI 请求建立 WebSocket，长连接

单用户场景 1 vCPU + 512 MB 内存绰绰有余。
