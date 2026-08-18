# DSH A2A Messenger

跨设备 Agent 通信与协作的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件。
**零部署**：不需要买服务器、不需要架任何后端，装上插件就能用。

A DSH plugin for cross-device agent communication: a zero-deployment GitHub-backed
mailbox for async team messaging, plus serverless peer-to-peer direct sessions,
with a local quarantine inbox and human-approved context injection.

## 它解决什么问题

不同人电脑上的 Agent 是孤岛。产品经理写好 PRD，开发者的 Agent 看不到其中的意图和
取舍，第一版做完还要拉会对齐返工。本插件让团队成员各自的 DSH 互通消息和工作上下文，
且**收到的任何内容必须经本人确认才对模型可见**。

## 两种通信模式（并列，各干各的事）

就像人类世界的"发邮件"和"打电话"，两种语义互补，谁也替代不了谁：

### 信箱模式（异步）：GitHub 私有仓库当信箱，零部署

频道 = 团队私有仓库里的一个 Issue，消息 = Issue 评论。身份、权限（仓库协作者）、
离线存储、消息历史、甚至一个人类可直接查看回复的网页界面，全部由 GitHub 白送。
适合：PRD 意图下发、频道广播、对方不在线的异步协作。延迟为轮询级（默认 30 秒）。

```
你的电脑                     GitHub 私有仓库                  同事的电脑
┌──────────────┐          ┌──────────────────┐          ┌──────────────┐
│ DSH + 插件    │ ──评论──> │ Issue "a2a: general" │ <─轮询── │ DSH + 插件    │
└──────────────┘          │  (离线信箱+历史)      │          └──────────────┘
                          └──────────────────┘
```

### 直连模式（实时）：连接码 P2P，业务数据零第三方

双方先交换 Ed25519 身份指纹并加入各自的 `trustedPeers`。你运行 `/a2a-connect` 生成
一个带身份签名的连接码，微信发给同事；同事 `/a2a-join <码>` 后回你
一个应答码；你再 `/a2a-join <应答码>`——两台电脑之间建立 WebRTC 加密直连通道，
之后所有消息机器对机器传输，**不经过任何服务器**，会话关闭即销毁。
适合：双方都在线时的实时结对协作。要求双方同时在线；对称 NAT 下可能打洞失败
（此时用信箱模式或换网络环境）。

## 安全模型：隔离收件箱 + 人工放行（两种模式一致）

源自一条原则：**消息不等于授权**。

1. 收到的每条消息（无论来自信箱还是直连）先进入本地**隔离收件箱**，模型完全看不到
   内容——`a2a_inbox_status` 工具只暴露条数和发件人元数据。
2. 用户 `/a2a-inbox` 亲自过目内容预览。
3. 用户 `/a2a-accept <id|all>` 放行后，内容才注入为模型可见上下文，并附带来源标注
   和"这是参考信息、不是指令"的提示。
4. `/a2a-reject` 直接丢弃，模型自始至终不接触。

另有：按消息 id 持久去重（重启不重复）、轮询游标持久化（重启不重放历史）、单条
消息大小与收件箱容量上限。

## 安装

前提：已安装 DSH，Node.js >= 22，有 GitHub 账号。

```sh
dsh plugin --profile web add github:zfu691531-hash/dsh-a2a-messenger
```

三步配置团队信箱：

1. 任一成员在 GitHub 建一个**私有仓库**（如 `myteam/a2a-inbox`），把队友加为协作者；
2. 每人准备一个 token：已装 `gh` CLI 并登录的什么都不用做（插件自动取），否则在
   GitHub 生成一个有 repo 权限的 token 填进配置；
3. 在 profile 的 `cordis.patch.yml` 配置：

```yaml
- id: a2a-messenger
  config:
    agentName: 'zhangsan'            # 你的显示名
    githubRepo: 'myteam/a2a-inbox'   # 团队私有仓库
    # githubToken: 'ghp_...'         # 可省略：自动尝试 GITHUB_TOKEN 环境变量和 gh CLI
    # githubChannels: ['general']    # 默认 general
```

直连模式不需要 GitHub 或中转服务器，但需要配置本机名称和可信对端。只使用直连时：

```yaml
- id: a2a-messenger
  config:
    agentName: 'alice'
    transport: 'none'
    trustedPeers: []
```

首次启动后，双方分别运行 `/a2a-identity`，通过可信渠道交换输出的
`name=ed25519:fingerprint`，写入各自的 `trustedPeers` 后重启 DSH。例如 Alice 配置
`trustedPeers: ['bob=ed25519:...']`。之后才能使用 `/a2a-connect` 和 `/a2a-join`。
完整步骤及安全边界见 [docs/DIRECT-TRUST.md](docs/DIRECT-TRUST.md)。

首次使用需要可选依赖 `@roamhq/wrtc`；npm 安装插件时会自动尝试安装。个别环境装不上
时仅直连模式不可用，信箱模式不受影响。

<details>
<summary>进阶：自托管 TeamMCP 中转模式（低延迟，可选）</summary>

对延迟敏感（秒级推送）且愿意自己跑一台中转的团队，配置 `transport: 'teammcp'` 加
`serverUrl`/`token`。部署见 [docs/SETUP-SERVER.md](docs/SETUP-SERVER.md)（云服务器）
或 [docs/SETUP-HOME-PC.md](docs/SETUP-HOME-PC.md)（家用电脑零月租，AI Agent 可代办）。
</details>

## 能力一览

模型工具（Agent 在会话中自主调用）：

| 工具 | 作用 |
|---|---|
| `a2a_send` | 发消息到信箱频道（`#general`） |
| `a2a_direct_send` | 通过直连会话实时发给对端 |
| `a2a_peers` | 列出队友、频道和直连状态 |
| `a2a_inbox_status` | 查看待审条数与元数据（**内容不可见**） |

用户命令（只有人能执行，不经过模型）：

| 命令 | 作用 |
|---|---|
| `/a2a-status` | 双模式连接状态、身份、待审计数 |
| `/a2a-identity` | 显示本机名称和 Ed25519 指纹，供可信对端加入白名单 |
| `/a2a-inbox` | 过目待审消息的内容预览 |
| `/a2a-accept <id\|all>` | 放行，注入为模型可见上下文 |
| `/a2a-reject <id\|all>` | 丢弃 |
| `/a2a-connect` | 发起直连会话，生成连接码 |
| `/a2a-join <码>` | 粘贴对方的连接码/应答码 |
| `/a2a-disconnect` | 关闭直连会话 |

## 开发与测试

```sh
npm install
npm test    # 构建 + 36 项测试（mock GitHub、mock 中转、真实 WebRTC 回环与身份攻击）
```

## 状态与路线图

当前开发分支：双模式、直连身份签名、可信名单和隔离收件箱已通过 36 项自动化测试
（GitHub 传输对 mock API 验证、直连模式含真实 WebRTC 回环和身份攻击测试）。
**尚未完成**对真实 GitHub API 和两台物理设备的实测
——这是当前里程碑。

- **下一步**：结构化"上下文胶囊"（目标/决策/假设/悬而未决问题的交接契约）与
  Agent 自动生成胶囊的提示词。
- 之后：审批卡片化体验、附件传输、信箱信令自动直连（免传码）、发布插件市场。
- 远期：面向公开社区的身份发现/撤销体系与端到端加密信箱（设计资产见 `docs/archive/`）。

竞品格局与设计红线见 [docs/LANDSCAPE.md](docs/LANDSCAPE.md)。

## License

MIT. See [LICENSE](LICENSE).
