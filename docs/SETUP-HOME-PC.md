# Runbook：在家用 Windows 电脑上部署团队消息中转（供 AI Agent 执行）

> **给执行本文档的 Agent（Codex/Claude/其他）**：你的任务是在这台 Windows 电脑上部署
> TeamMCP 消息中转服务器，并通过 Cloudflare Tunnel 暴露为公网 HTTPS 地址，全程零月租
> 成本。请逐节执行，每节末尾有验收标准，验收不通过就停下排查，不要带病继续。涉及
> 浏览器登录的步骤需要请主人（用户）亲自操作，你负责给出明确指引并等待完成。

## 执行纪律

- 所有命令在 PowerShell 中执行；一次执行一条，检查输出后再继续。
- 生成的密钥（注册密钥、apiKey）**不要**写入任何会提交到 git 的文件，**不要**完整
  回显在总结里（只显示前 8 位）。
- 遇到与本文档预期不符的输出，先向用户报告差异再决定是否继续，不要自行猜测绕过。
- 本机代号下文称 **relay-pc**。

## 阶段 0：环境检查

```powershell
node --version    # 需要 >= 22；没有或过旧则: winget install OpenJS.NodeJS.LTS 后重开终端
git --version     # 没有则: winget install Git.Git 后重开终端
```

**验收**：`node --version` 输出 >= v22。

## 阶段 1：安装并试运行 TeamMCP

```powershell
cd $HOME
git clone https://github.com/cookjohn/teammcp.git
cd teammcp
npm install
```

生成注册密钥（防陌生人注册，记下备用，下文用 `<SECRET>` 指代）：

```powershell
-join ((48..57)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
```

前台试运行：

```powershell
$env:TEAMMCP_PORT = "3100"
$env:TEAMMCP_REGISTER_SECRET = "<SECRET>"
npm start
```

在**另一个** PowerShell 窗口验证：

```powershell
curl.exe http://127.0.0.1:3100/api/health
```

**验收**：health 返回 200（JSON 内容不限）。通过后 Ctrl+C 停掉前台进程，进入下一阶段。

**注意**：TeamMCP 的 README 提到的 Claude Code CLI、Bun、fakechat 插件**都不需要安装**
——我们只用它的 HTTP API 做消息中转，不用它的 Agent 进程管理。若 `npm start` 因缺少
可选依赖报错，报告错误原文再处理。

## 阶段 2：注册为开机自启任务

用任务计划程序让 TeamMCP 开机常驻（需管理员 PowerShell）：

```powershell
$action = New-ScheduledTaskAction -Execute "$(Get-Command node | Select-Object -ExpandProperty Source)" `
  -Argument "server/index.mjs" -WorkingDirectory "$HOME\teammcp"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "TeamMCP-Relay" -Action $action -Trigger $trigger -Settings $settings `
  -User "SYSTEM" -RunLevel Highest
```

环境变量对 SYSTEM 任务不可见，改为系统级设置：

```powershell
[Environment]::SetEnvironmentVariable("TEAMMCP_PORT", "3100", "Machine")
[Environment]::SetEnvironmentVariable("TEAMMCP_REGISTER_SECRET", "<SECRET>", "Machine")
Start-ScheduledTask -TaskName "TeamMCP-Relay"
Start-Sleep 5
curl.exe http://127.0.0.1:3100/api/health
```

> 如果 TeamMCP 的入口文件不是 `server/index.mjs`（以仓库实际 package.json 的 `start`
> 脚本为准），按实际入口调整 `-Argument`。

同时关闭睡眠，保证常驻：

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

**验收**：health 通过；重启电脑后（可与用户约时间验证）health 仍通过。

## 阶段 3：Cloudflare Tunnel 公网暴露

### 3a. 先用临时隧道快速验证（无需域名，5 分钟）

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://127.0.0.1:3100
```

输出中会给一个 `https://随机词.trycloudflare.com` 地址。用手机流量（不连家里 WiFi）
访问 `https://<该地址>/api/health` 验证公网可达。

**验收**：外网能访问 health。此地址是临时的（进程重启就变），只用于验证，验证后 Ctrl+C。

### 3b. 永久隧道（需要域名）

前置条件（需主人亲自完成，请给出指引并等待）：

1. 有一个域名（任意注册商，¥15/年的即可）；
2. 在 [Cloudflare](https://dash.cloudflare.com) 免费套餐添加该域名，并按提示到注册商
   处把 NS 改为 Cloudflare 分配的两个地址（生效可能要几分钟到几小时）。

然后执行（`cloudflared tunnel login` 会打开浏览器，请主人点授权）：

```powershell
cloudflared tunnel login
cloudflared tunnel create teammcp-relay
cloudflared tunnel route dns teammcp-relay relay.<你的域名>
```

创建配置文件 `$HOME\.cloudflared\config.yml`（`<TUNNEL_ID>` 用 `cloudflared tunnel list` 查看）：

```yaml
tunnel: <TUNNEL_ID>
credentials-file: C:\Users\<用户名>\.cloudflared\<TUNNEL_ID>.json

ingress:
  - hostname: relay.<你的域名>
    service: http://127.0.0.1:3100
  - service: http_status:404
```

安装为 Windows 服务并启动（管理员）：

```powershell
cloudflared service install
Start-Service cloudflared
curl.exe https://relay.<你的域名>/api/health
```

**验收**：公网域名 health 通过；`Get-Service cloudflared` 为 Running。

## 阶段 4：端到端消息验证

注册两个测试身份并互发消息（在 relay-pc 上执行即可）：

```powershell
# 注册 test-a 与 test-b（记下各自返回的 apiKey）
curl.exe -X POST https://relay.<你的域名>/api/register -H "content-type: application/json" `
  -d '{\"name\": \"test-a\", \"role\": \"test\", \"secret\": \"<SECRET>\"}'
curl.exe -X POST https://relay.<你的域名>/api/register -H "content-type: application/json" `
  -d '{\"name\": \"test-b\", \"role\": \"test\", \"secret\": \"<SECRET>\"}'

# a 发消息
curl.exe -X POST https://relay.<你的域名>/api/send -H "authorization: Bearer <test-a的apiKey>" `
  -H "content-type: application/json" -d '{\"channel\": \"general\", \"content\": \"hello from runbook\"}'

# b 离线收件箱应能取到
curl.exe https://relay.<你的域名>/api/inbox -H "authorization: Bearer <test-b的apiKey>"
```

**验收**：test-b 的 inbox 返回中包含 `hello from runbook`。

## 阶段 5：交付

1. 为每位真实团队成员注册身份（名字用真名拼音），把各自的 apiKey **单独私发**给本人。
2. 向主人提交总结报告：公网地址、注册密钥存放位置、开机自启与隧道服务状态、
   端到端验证结果、以及"电脑关机期间消息会在中转排队、开机自动补收"的说明。
3. 提醒每位成员在自己电脑的 DSH profile 中配置插件（见仓库根 README 的"安装"一节），
   `serverUrl` 填 `https://relay.<你的域名>`。

## 故障速查

- **公网 health 超时**：先查本地 3100 是否正常 → 再查 `Get-Service cloudflared` →
  再查 Cloudflare 面板中域名 NS 是否已生效。
- **SSE 长连接每隔几分钟断一次**：Cloudflare 免费版对空闲连接有超时，属正常现象，
  插件端会自动重连并补收，无需处理。
- **注册返回 403**：secret 不匹配，核对系统级环境变量是否生效（改完需重启任务）。
- **重启后服务没起来**：`Get-ScheduledTask TeamMCP-Relay` 查看状态，
  `Get-ScheduledTaskInfo TeamMCP-Relay` 看最近一次运行结果码。
