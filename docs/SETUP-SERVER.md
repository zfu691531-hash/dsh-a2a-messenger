# 中转服务器部署指南

一台便宜的云服务器 + 开源的 [TeamMCP](https://github.com/cookjohn/teammcp) 就是团队的
消息中转。本插件只使用它的 HTTP API 和 SSE 事件流，**不需要**它的 Claude Code 进程
管理、fakechat 插件和 Bun，也不需要在服务器上登录任何模型账号。

## 选型建议

- 服务器：腾讯云/阿里云轻量应用服务器，**香港节点**（免备案，大陆延迟 30-50ms），
  2 核 2G 足够，Ubuntu 24.04。
- 域名：任意便宜域名，解析 A 记录到服务器 IP。域名指向海外服务器无需备案。

## 部署步骤

### 1. 安装 Node.js 22 与 TeamMCP

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo useradd -r -m -s /bin/bash teammcp
sudo -u teammcp git clone https://github.com/cookjohn/teammcp.git /home/teammcp/teammcp
cd /home/teammcp/teammcp && sudo -u teammcp npm install
```

### 2. systemd 服务（设置注册密钥）

`/etc/systemd/system/teammcp.service`：

```ini
[Unit]
Description=TeamMCP relay
After=network.target

[Service]
User=teammcp
WorkingDirectory=/home/teammcp/teammcp
Environment=TEAMMCP_PORT=3100
Environment=TEAMMCP_REGISTER_SECRET=换成你们团队的注册密钥
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now teammcp
journalctl -u teammcp -f   # 查看日志
```

### 3. Caddy 反向代理（自动 HTTPS）

```sh
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`：

```
relay.example.com {
    reverse_proxy 127.0.0.1:3100 {
        flush_interval -1
    }
}
```

`flush_interval -1` 确保 SSE 事件流不被缓冲。然后 `sudo systemctl reload caddy`。
防火墙放行 80/443，**不要**放行 3100（只走 Caddy）。

### 4. 验证

```sh
curl https://relay.example.com/api/health
# => {"ok":true} 或同类响应

# 每个成员注册一次身份：
curl -X POST https://relay.example.com/api/register \
  -H "content-type: application/json" \
  -d '{"name": "zhangsan", "role": "developer", "secret": "<注册密钥>"}'
# 返回的 apiKey 填入各自 DSH profile 的插件配置
```

两台机器分别用各自的 apiKey 调 `/api/send` 与 `/api/inbox`，能互相收到即部署成功，
之后插件端即可连通。

## 运维备忘

- 数据都在 TeamMCP 的 SQLite 文件里，备份即拷贝该文件；迁移服务器同理。
- 注册密钥泄露只影响"能否注册新身份"，不影响已发消息；定期更换无成本。
- TeamMCP 自带 Web 看板（`https://relay.example.com`），用注册返回的 token 登录，
  可以人工查看频道消息，便于排查问题。
