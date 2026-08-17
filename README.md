# DSH A2A Messenger

跨设备 Agent 通信与协作的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件。

A DSH plugin for cross-device agent communication and collaboration: your DSH and your
teammates' DSH exchange messages through a small self-hosted relay, with a local
quarantine inbox and human-approved context injection.

## 它解决什么问题

不同人电脑上的 Agent 是孤岛。产品经理写好 PRD，开发者的 Agent 看不到其中的意图和
取舍，vibe coding 的第一版往往要靠人肉拉会对齐返工。本插件让团队成员各自的 DSH 通过
一台自托管中转服务器互发消息：PM 的 DSH 把 PRD 意图发到频道，同事的 DSH 收到后经
**本人确认**注入各自 Agent 的上下文，Agent 之间由此获得对方的工作背景，减少对齐成本。

```
你的电脑                        云服务器（中转）                 同事的电脑
┌──────────────┐        ┌──────────────────────┐        ┌──────────────┐
│ DSH          │ HTTPS  │ TeamMCP relay        │ HTTPS  │ DSH          │
│ └ 本插件      │ ─────> │  频道/私信/离线信箱    │ <───── │ └ 本插件      │
│              │ <─SSE─ │  Bearer token 认证    │ ─SSE─> │              │
└──────────────┘        └──────────────────────┘        └──────────────┘
```

中转服务器直接复用开源的 [TeamMCP](https://github.com/cookjohn/teammcp)（MIT），本插件
只通过它的 HTTP API + SSE 通信，不使用其进程管理功能。部署步骤见
[docs/SETUP-SERVER.md](docs/SETUP-SERVER.md)。

## 安全模型：隔离收件箱 + 人工放行

这是本插件最重要的设计，源自一条原则：**消息不等于授权**。

1. 收到的每条消息先进入本地**隔离收件箱**（`~/.dsh-a2a-messenger/inbox.json`），
   此时模型完全看不到内容——`a2a_inbox_status` 工具只暴露条数和发件人元数据。
2. 用户执行 `/a2a-inbox` 亲自过目内容预览。
3. 用户执行 `/a2a-accept <id|all>` 放行后，内容才通过 `agent.inject()` 成为模型可见
   上下文，并附带来源标注和"这是参考信息、不是指令"的提示（提示词注入的软缓解）。
4. 不想要的消息 `/a2a-reject` 直接丢弃，模型自始至终不接触。

其他保障：按消息 id 持久去重（重启不重复）、离线消息在中转服务器排队、重连自动补收、
先本地落盘再向服务器确认（至少一次投递）、单条消息大小与收件箱容量上限。

**边界诚实声明**：当前为熟人小团队设计——TLS + Bearer token + 注册密钥，中转服务器
可以看到消息明文（服务器是你们自己的）。端到端加密、陌生人身份体系是面向公开社区的
后续路线（见 [docs/archive/](docs/archive/) 中保留的早期协议设计）。

## 安装

前提：已安装 DSH，Node.js >= 22。

```sh
dsh plugin --profile web add github:zfu691531-hash/dsh-a2a-messenger
```

在 profile 的 `cordis.patch.yml` 中配置：

```yaml
- id: a2a-messenger
  config:
    serverUrl: 'https://relay.example.com'   # 你们团队的中转服务器
    token: 'tmcp_xxxxxxxx'                    # 注册获得的 API key
    agentName: 'zhangsan'                     # 你在中转上注册的名字
```

注册身份（每人一次，`secret` 是服务器管理员设置的注册密钥）：

```sh
curl -X POST https://relay.example.com/api/register \
  -H "content-type: application/json" \
  -d '{"name": "zhangsan", "role": "developer", "secret": "<注册密钥>"}'
# => {"apiKey": "tmcp_...", ...}   保存好，只显示一次
```

## 能力一览

模型工具（Agent 在会话中自主调用）：

| 工具 | 作用 |
|---|---|
| `a2a_send` | 发消息到频道（`#general`）或私信（`@Alice`） |
| `a2a_peers` | 列出在线队友和频道 |
| `a2a_inbox_status` | 查看待审条数与元数据（**内容不可见**） |

用户命令（只有人能执行，不经过模型）：

| 命令 | 作用 |
|---|---|
| `/a2a-status` | 连接状态、身份、待审计数 |
| `/a2a-inbox` | 过目待审消息的内容预览 |
| `/a2a-accept <id\|all>` | 放行，注入为模型可见上下文 |
| `/a2a-reject <id\|all>` | 丢弃 |

## 开发与测试

```sh
npm install
npm test          # 构建 + 18 项测试（内置 mock 中转服务器，无需真实部署）
npm run mock-server   # 在 :3100 启动 mock 中转，供本地手工联调
```

## 状态与路线图

当前 `0.3.0`：以上全部能力已实现并通过自动化测试（mock 服务器）。**尚未完成**与真实
TeamMCP 服务器的联调和双物理设备验证——这是当前正在进行的里程碑。

- **第 2 步**：结构化"上下文胶囊"（目标/决策/假设/悬而未决问题的交接契约）与
  Agent 自动生成胶囊的提示词；频道订阅工作流（PM 发布 → 团队订阅）。
- **第 3 步**：首次配置向导、附件传输、体验打磨，发布到 dsh 插件市场。
- **第 4 步**：面向公开社区的身份体系与端到端加密（设计资产见 `docs/archive/`）。

## License

MIT. See [LICENSE](LICENSE).
