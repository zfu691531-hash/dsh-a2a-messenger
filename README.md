# DSH A2A Messenger

跨设备 Agent 通信与协作的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件。

它的目标是“不自建后端也能开箱通信”，而不是假装互联网通信完全没有第三方：

- GitHub 信箱借用私有仓库做异步存储；
- 文件目录信箱借用 Syncthing、OneDrive、NAS 或移动介质同步；
- WebRTC 业务数据尽量机器直连，但默认 `stun` 策略会联系公共 STUN；
- `strict` 策略不联系 STUN/TURN，但跨 NAT 成功率更低；
- `relay` 策略只在用户自己配置 TURN 后启用，项目不内置默认中转。

所有路线都明确显示，不会把直连或密文发送失败静默降级为 GitHub 明文。

## 能力

- GitHub 或共享目录异步信箱，支持离线送达；
- X25519 + HKDF-SHA256 + AES-256-GCM 端到端密封信封，Ed25519 签名认证；
- 人与设备分离的联系人：`name@device`、TOFU、人工核验、撤销；
- GitHub/目录信箱自动传递加密的签名 A2A2 SDP，`/a2a-call` 免复制连接码；
- WebRTC `strict | stun | relay` 三种 ICE 策略及 `/a2a-doctor` 候选诊断；
- 多传输同时运行、显式 route、禁止自动 fallback；
- 直连消息 `sent → quarantined → accepted/rejected` 回执；
- 所有普通入站消息先进入本地隔离箱，只有用户批准后才对模型可见。

## 快速开始：GitHub 密封信箱 + 自动直连

前提：DSH、Node.js >= 22、一个仅通信成员可访问的 GitHub 私有仓库。

```sh
dsh plugin --profile web add github:zfu691531-hash/dsh-a2a-messenger
```

```yaml
- id: a2a-messenger
  config:
    agentName: 'alice'
    deviceName: 'work-laptop'
    transport: 'github'
    githubRepo: 'myteam/a2a-inbox'
    mailboxEncryption: 'sealed'
    mailboxTtlHours: 168
    directIcePolicy: 'stun'
    # githubToken 可省略：依次尝试 GITHUB_TOKEN、GH_TOKEN、gh auth token
```

双方各运行 `/a2a-pair`，通过已有可信渠道交换 `A2AC1-...` 配对卡：

```text
/a2a-pair-accept <对方的 A2AC1 卡>
/a2a-verify bob@home-pc <对方指纹末 12 位>
/a2a-call bob@home-pc
```

配对卡经过签名，但首次收到的身份仍是 TOFU；应通过当面、语音或另一个已认证渠道比对完整指纹。旧版 `trustedPeers` 继续有效，可逐步迁移，不会旋转原 Ed25519 身份。

## 共享目录信箱

适用于 Syncthing、OneDrive、Dropbox、NAS 共享目录或 U 盘。写入采用临时文件后原子重命名；建议始终使用 `sealed`。

```yaml
- id: a2a-messenger
  config:
    agentName: 'alice'
    deviceName: 'desktop'
    transport: 'filesystem'
    filesystemDir: 'D:\Shared\dsh-mailbox'
    mailboxEncryption: 'sealed'
```

同步服务仍能看到文件名、时间、大小等元数据，但看不到密封后的正文。

## 多传输与路由

配置 GitHub 为主传输时，再设置 `filesystemDir` 会同时启动两条路线：

```yaml
transport: 'github'
githubRepo: 'myteam/a2a-inbox'
filesystemDir: 'D:\Shared\dsh-mailbox'
mailboxRoute: 'github'
mailboxEncryption: 'sealed'
```

`a2a_send` 可传 `route: github` 或 `route: filesystem`。未指定时只走 `mailboxRoute`；所选路线失败就明确报错，不会换成安全性更低的路线。

## 直连策略

| 策略 | 外部服务 | 典型候选 | 特性 |
|---|---|---|---|
| `strict` | 无 STUN/TURN | host | 同网、已有公网地址或端口映射；最少第三方，成功率最低 |
| `stun`（默认） | 配置的 STUN | host、srflx | 业务数据仍点对点；STUN 可看到源 IP 和请求时间 |
| `relay` | 用户配置的 TURN | relay | 最容易穿过严格 NAT；业务流量经过 TURN |

TURN 示例：

```yaml
directIcePolicy: 'relay'
turnServers: ['turns:turn.example.com:5349']
turnUsername: 'alice'
turnCredential: '从密钥管理注入，不要提交仓库'
```

手工 `/a2a-connect` + `/a2a-join` 仍然保留，适用于没有密封信箱或希望经线下渠道携带 SDP 的场景。连接码包含网络候选，签名只能防篡改，不能隐藏它；自动信令会把连接码放进端到端密封信封。

## 命令与工具

模型工具：

| 工具 | 作用 |
|---|---|
| `a2a_send` | 通过异步信箱发送，可指定 route |
| `a2a_direct_send` | 通过已连接的 WebRTC 会话发送 |
| `a2a_peers` | 查看队友、频道和直连状态 |
| `a2a_inbox_status` | 只查看隔离箱元数据，不泄露正文给模型 |

用户命令：

| 命令 | 作用 |
|---|---|
| `/a2a-pair` | 生成本设备签名配对卡 |
| `/a2a-pair-accept <卡>` | 保存联系人为 TOFU |
| `/a2a-verify <name@device> <指纹后缀>` | 核验联系人 |
| `/a2a-contacts` | 查看人、设备、指纹和信任状态 |
| `/a2a-untrust <name@device>` | 撤销设备 |
| `/a2a-call <name@device> [route]` | 通过密封信箱自动建立直连 |
| `/a2a-doctor` | 诊断 ICE 策略、候选、协议和第三方接触 |
| `/a2a-receipts` | 查看直连投递状态 |
| `/a2a-status` | 查看身份、路由、安全模式和连接状态 |
| `/a2a-inbox` | 人工预览隔离消息 |
| `/a2a-accept <id\|all>` | 放行并注入模型上下文 |
| `/a2a-reject <id\|all>` | 拒绝消息 |
| `/a2a-connect`、`/a2a-join` | 手工连接码流程 |
| `/a2a-disconnect` | 关闭直连 |

## 安全边界

- 密封模式拒绝可读明文，不做静默降级；可读模式用于兼容旧部署。
- 密封信封使用静态设备 X25519 身份，没有双棘轮的前向保密；设备私钥泄露时应立即撤销并重新配对。
- GitHub、同步服务、STUN/TURN 和网络观察者仍可观察各自路径上的元数据。
- 联系人撤销是本地决定，不是全球证书吊销服务；其他设备也需分别撤销。
- 远端文本永远是外部输入。即使来源已认证，也必须经过隔离箱人工放行。
- 自动信令只消费已配对设备发来的、签名有效、未重放且 10 分钟内有效的密封 A2A2 连接码；普通密封消息默认保留 168 小时。

更详细的网络验证矩阵见 [docs/CONNECTIVITY.md](docs/CONNECTIVITY.md)，信任模型见 [docs/DIRECT-TRUST.md](docs/DIRECT-TRUST.md)。

## 开发与验证

```sh
npm ci
npm test
```

自动化覆盖身份迁移、配对与撤销、密封信封篡改、密文目录信箱、禁止路由降级、GitHub 首次并发建信箱竞态、自动加密信令、真实 WebRTC 回环和投递回执。真实跨地区、运营商 NAT 与防火墙组合仍需按验证矩阵在两台物理设备上执行。

## License

MIT. See [LICENSE](LICENSE).
