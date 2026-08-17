# 竞品格局与历史教训（2026-08）

本文回答两个问题：**为什么"跨人跨设备的 Agent 通信"这个生态位是空的**，以及
**前人的失败给本项目定了哪些设计红线**。调研时点为 2026 年 8 月，结论会过期，
重大变化应更新本文。

## 一、邻近产品都停在哪一步

| 产品/标准 | 覆盖范围 | 与本项目的关系 |
|---|---|---|
| 腾讯 WorkBuddy | **单人多端**：手机遥控自己电脑的 agent，任务/产物三端同步 | 人↔自己的 agent，不做跨人 |
| Claude Code cross-session messaging（2026-08-07, v2.1.224） | **单人多会话**：同一用户的会话互发文本摘要 | 离本项目最近的大厂动作，见下文 |
| Linux Foundation A2A v1.0 | **企业服务器侧**：公网可达的 agent 服务互通（Azure AI Foundry、Bedrock AgentCore 等） | 概念层对齐对象；不适配 NAT 后的个人设备 |
| Knowe 等单机 Agent 团队应用 | **单人单机多 agent**：群聊界面指挥本机 agent 团队 | 上层应用，未来可成为本网络的节点 |

**跨人、跨设备、个人/小团队场景没有产品占位。** 大厂不做的结构性原因：跨人通信
意味着提示词注入、数据边界、责任归属的全套风险，平台型产品背不起这个责任；
独立开源项目可以用"自托管 + 用户自担 + 人工放行"的模式承接。

## 二、Claude cross-session messaging：设计哲学的同行背书

Anthropic 的实现细节与本项目的隔离收件箱高度一致，可视为方向验证：

- 收件方三档控制（accept / hold / refuse），hold 的消息弹审批对话框：
  显示发件人与内容预览、5 分钟过期、最多押 100 条；
- 只传文本摘要，不传会话历史、文件、权限；
- **跨机器只能回复、不能主动发起**——刻意的爆炸半径控制。

参考：[Developers Digest 解析](https://www.developersdigest.tech/blog/claude-code-cross-session-messaging-2026)、
[The Design Is in the Refusals](https://vanja.io/the-design-is-in-the-refusals/)。

对本项目的启示：第 3 步体验打磨时直接借鉴审批卡（预览+过期+押件上限）；
同时它的存在说明窗口在收窄，双机真实验证的优先级最高。

## 三、历史失败案例与设计红线

### FIPA-ACL / KQML（1990s-2000s）：重语义标准之死

上一代 agent 通信标准，语义上比今天的 A2A 更"先进"（言语行为分类、broker 中介
校验），但要求通信双方共享形式化本体——每接入一个新能力就要维护本体条目，注册表
灾难性失步，**语义共识的维护成本超过了它防住的错误的成本**，最终被业界抛弃。
参考：[Tool Calls Lost the Illocutionary Force](https://moltbook.com/post/40c9c5b2-a2c3-48a6-b9ac-67b78b3c8246)。

> **红线 1**：上下文胶囊只做 JSON Schema 级的轻量语法校验，语义留给人和模型判断，
> 绝不引入需要双方持续维护共识的重语义层。

### IBM ACP（2025）：别跟主流标准打对台

与 Google A2A 并行竞争 agent 互通标准，2025 年 8 月并入 A2A。

> **红线 2**：协议概念持续对齐 A2A（Message/Task/Artifact），不另立标准；
> wire 级兼容推迟到确有生态对接需求时再做。

### 多 Agent 系统生产失败数据（MAST，NeurIPS 2025）

1600+ 执行轨迹的失败分类：生产失败率 41-86.7%，其中规格模糊 41.8%、协调失败
36.9%、验证缺口 21.3%；结构化 schema 通信可显著压低协调失败。
参考：[Augment Code 综述](https://www.augmentcode.com/guides/why-multi-agent-llm-systems-fail-and-how-to-fix-them)。

> **红线 3**：第 2 步的胶囊必须是结构化交接契约（目标/决策/假设/被否决方案/
> 悬而未决问题），不用自由散文；接收注入始终经人工放行。

## 四、大厂内部的两种形态与定位修正（2026-08 补充）

大厂内部**确实已有** agent 互通，分两种成型形态：

1. **工单系统即协调层**：Atlassian 把 agent 做成 Jira 一等公民（agent 作为经办人
   出现在看板、可被 @、走 Jira 权限与审计），GitHub Copilot coding agent 可被指派
   Jira issue、自读描述评论、完工开 PR。agent 之间不直接对话，协调通过工作制品
   （ticket）中转，前提是团队有工单纪律。参考：
   [agents in Jira](https://www.atlassian.com/blog/rovo/ai-agents-in-jira)、
   [Copilot for Jira](https://github.blog/changelog/2026-03-05-github-copilot-coding-agent-for-jira-is-now-in-public-preview/)。
2. **自建 agent mesh**：Uber 的 MCP Gateway/Registry + 标准化 A2A Client（STS JWT、
   密码学 actor chain，1500+ agent、每周 6 万次执行）；LinkedIn 复用自家消息基础
   设施做编排层。参考：
   [Uber](https://www.uber.com/us/en/blog/solving-the-agent-identity-crisis/)、
   [LinkedIn](https://www.infoq.com/news/2025/09/linkedin-multi-agent/)。

**由此修正目标用户**：本项目不与企业级身份/权限/审计竞争；服务对象是**没有（也
不想维护）重工单体系的小团队、初创、独立开发者，以及跨组织临时协作**——后者是
所有企业产品都不覆盖的场景（Jira/Copilot 均框在单一组织边界内）。

**由此获得的验证**："协调通过工作制品而非对话"是大厂共同结论；上下文胶囊本质是
一张不依赖 Jira 就能流转的轻量 ticket，等于把该模式搬给无工单纪律的小团队。与
工单生态不冲突：用户可同时装 Atlassian MCP，远期可做"胶囊 ↔ Jira issue"连接器
作为团队长大后的迁移路径。

## 五、一句话定位

单人多端（WorkBuddy）、单人多会话（Claude）、企业服务器侧（A2A）三个邻位都有人，
本项目占的是第四个格子：**跨人跨设备的个人/小团队 Agent 通信层**——用自托管中转、
隔离收件箱和人工放行，把大厂因责任约束不敢做的事做成可用的开源插件。
