# DSH A2A Messenger

[English](README.md)

DSH A2A Messenger 是一个实验性的、可自托管的跨设备 Agent 通信层。`0.2.0`
提供稳定的 Agent/设备身份、单聊与群聊、加密消息信封、至少一次可靠投递、经用户
明确授权的 Context Capsule，以及受权限控制的协作任务状态机。新增的 Work Package
可以把“任务说明 + 代码/文件目录”直接发送给对方，也能用同样方式返回结果，不依赖
GitHub、GitLab 或其他内容平台。

> **验证状态：**MVP 已在同一台电脑上完成 loopback 与带设备鉴权的 HTTP+SQLite
> 端到端测试；尚未验证公网或两台真实设备之间的通信。该版本不是生产级软件。

## 最核心的协作流程

1. 一个 Agent 提出任务，并发送装有普通文件或源码目录的 Work Package。
2. 接收端检查身份、群成员关系、签名、文件声明与本地策略；文件先留在隔离区。
3. 本地用户批准后，文件才会写入一个全新的独立目录；不会自动合并或执行。
4. 接收端 Agent 完成工作后，可以把结果目录作为 Work Package 原路返回。

分片、重试、加密和离线队列都隐藏在底层。用户面对的始终只是一个 Work Package。

## 职责与边界

Messenger 负责协议封装、可替换传输、投递状态、会话成员关系，以及把授权请求交给
本地策略。它不拥有长期记忆、音频 I/O、传感器解释或协作提示模板。

- 消息不等于工具授权。远程任务必须经过 capability negotiation、接收端本地 policy，
  并在策略要求时取得人工审批。
- 长期记忆的真相源仍是记忆插件。Messenger 只传输用户授权、最小披露的 Context
  Capsule；接收后默认隔离并视为不可信，未经审批不得进入提示、记忆或工具参数。
- 音频插件负责 ASR、TTS 和 WebRTC；本 MVP 只传结构化消息、附件引用和任务事件。
- 手势插件只是本地输入适配器。手势事件必须先转换为 capability intent，再通过正常的
  policy/审批；置信度不是身份，也不是权限。
- `dsh-codex-collab` 继续负责同机 DSH↔Codex 桥。二者只通过版本化
  adapter/capability 契约集成，不依赖对方内部存储。

## 与标准 A2A 的关系

互操作基线为 Linux Foundation A2A wire **1.0**，并按 **2026-05-26 发布的
v1.0.1 规范补丁**核对。项目复用了 Agent Card、Message、Task、Artifact、Parts、
扩展声明和版本协商等 A2A 概念。

当前适配器只提供字段映射，不实现 A2A HTTP/JSON-RPC、gRPC 或 SSE 服务，也未
通过官方 SDK 一致性套件。因此 `0.2.0` 不宣称具备 wire-level A2A conformance。

联系人、稳定设备身份、会话/群聊、成员与密钥 epoch、E2EE、投递游标、审批和
Context Capsule 都是 Messenger 产品扩展，**不是标准 A2A 字段**。详见
[协议](docs/PROTOCOL.md)和[架构决策](docs/adr/)。

## 安全现状

MVP 对消息和 Work Package 正文实施端到端加密，并假设 relay 对正文不可信；relay 仍能看到
投递元数据。密钥和明文不得进入审计日志；防重放与去重状态持久化；成员变更推进密钥
epoch；附件以引用传递并校验哈希和长度；工具执行默认拒绝。

此版本**没有**实现 MLS、Double Ratchet、前向保密、密钥透明度、硬件证明或生产级
密钥管理。E2EE 不能隐藏流量元数据，也不能保护已被攻陷的端点。撤回/删除仅是尽力
而为的处理指令，不能擦除已查看、导出或备份的副本。评估 MVP 前请阅读
[SECURITY.md](SECURITY.md)与[威胁模型](docs/THREAT_MODEL.md)。

## 环境要求

- Node.js 22.13 或更高版本（无需实验性开关即可使用 `node:sqlite`）
- npm
- 可供 MVP 持久化状态使用的本地文件系统

## 安装与卸载

安装依赖并注册开发版 CLI：

```sh
npm run install:local
```

移除全局开发链接：

```sh
npm run uninstall:local
```

CLI 命令名为 `dsh-a2a`。

## 检查、演示与测试

检查运行环境与状态：

```sh
dsh-a2a doctor
```

运行本机 loopback 演示：

```sh
dsh-a2a demo
```

运行“直接发送代码目录并返回结果”的本机 HTTP 演示：

```sh
dsh-a2a work-demo
```

生成每台设备独立的 Relay 凭据并启动自托管 Relay：

```sh
dsh-a2a relay-token --device-id 你的设备UUID
cp examples/relay-credentials.example.json relay-credentials.json
chmod 600 relay-credentials.json
dsh-a2a relay-serve --credentials relay-credentials.json --db relay.db
```

请把生成的 43 字符 token 填入本机凭据文件，替换 `REPLACE_ME`。该真实文件已加入
gitignore，发布门禁也会拒绝它；Relay 数据库只保存哈希，但配置文件本身仍含原始
Bearer 凭据，必须按秘密保存。

这里的凭据只用于进入 Relay，不是 Agent 身份，也不是用户看到的“协作号”。Relay 默认
只监听 `127.0.0.1`。非本机明文 HTTP 必须显式添加 `--allow-insecure-network`，仅限受控
开发环境；真实部署必须在外层配置 TLS。

运行自动化测试和发布门禁：

```sh
npm test
npm run release:check
```

这些 demo 只能证明单机 loopback/HTTP 流程。网络传输已经作为公共模块提供，但本版
尚未提供完整的持久化配对 UI/CLI；真实多设备接入仍需集成方通过公共 API 保存已验证
身份和会话。它不代表已经验证公网 Relay、NAT 穿透或物理设备互操作。

最低支持版本中的 Node 内置 SQLite 仍会输出实验性 API 警告；这也是本 MVP 不适合
生产使用的原因之一。

## MVP 协议保证

- 使用稳定随机的 `agentId` 与 `deviceId`；显示名不具备身份权威性。
- 支持根身份签名的设备凭证、轮换、加入、撤销和联系人核验。
- 单聊与群聊使用成员/密钥 epoch、角色、邀请、移除及哈希链成员提交。
- 签名加密信封支持不可变重试帧、发送者内有序、邮箱游标、过期、重启恢复和持久去重。
- 传输为至少一次；当适配器遵守幂等契约时，同一本地任务不会被重复执行。
- 协作任务状态包括 `proposed`、`accepted`、`running`、`blocked`、
  `completed`、`failed` 和 `cancelled`。
- 审计只记录无正文元数据，并使用 trace/correlation ID 串联状态。
- Work Package 支持源码/文件直接传输、确定性清单、加密分片、发送者绑定、断网与重启
  恢复、本地审批、过期/暂存配额，以及校验后写入全新目录。
- Transport 可替换；当前实现包括 loopback 与带设备鉴权的 HTTP+SQLite Relay。
- Work Package 从暂存到落盘都绑定发送端的准确设备与密钥版本；成功落盘后删除暂存
  分片；HTTP 拉取每次最多 16 个帧，并通过游标继续。
- 落盘中断后，重启只会校验并确认完整结果；未知结果进入 `blocked`，必须显式重试并
  再次通过当前 policy 与原始设备授权，不会静默重复写入。

项目不承诺全局总序。群成员被移除后不能读取新 epoch 的内容，但无法撤销其已获得的
历史明文。

## 项目状态

`0.2.0` 是用于评估协议、直接文件协作和安全边界的 MVP。另见
[ARCHITECTURE.md](ARCHITECTURE.md)、[CONTRIBUTING.md](CONTRIBUTING.md)和
[CHANGELOG.md](CHANGELOG.md)。测试范围与尚未验证的边界记录在
[docs/VALIDATION.md](docs/VALIDATION.md)。安全问题请按负责任披露流程提交，
不要公开发布利用细节。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
