# 架构

dsh-acp-paseo 把 DeepSeek Harness（dsh）编码代理通过 ACP（Agent Client Protocol，stdio JSON-RPC）接入 Paseo。用户在 Paseo 端把 dsh 添加为自定义 provider（`extends: "acp"`）后，模型目录、凭据、模式、思考强度与斜杠命令全部从 dsh 侧自动发现，Paseo 零配置。

## 分层

```
Paseo daemon ──每 agent spawn──▶ bin/dsh-acp-paseo-launch.mjs
                                  │ 解析 dsh、自愈 profile、stdout 纯净、信号转发
                                  ▼
                              dsh --profile dsh-acp-paseo
                                  │ bundles: @deepseek-ai/dsh-base + dsh-acp-paseo
                                  │ （patch 层注入桥插件，见 cordis.patch.yml）
                                  ▼
                              dsh-acp-paseo 桥（cordis 插件）
                                  │ ACP JSON-RPC over stdio
                                  ▼
                              Paseo ACP 客户端（@agentclientprotocol/sdk 0.17.1）
```

- **Launcher**（`bin/dsh-acp-paseo-launch.mjs`）：Paseo spawn 的稳定入口。诊断全部走 stderr（`[dsh-acp-paseo-launch]` 前缀），stdout 保持协议纯净；`--version` 探针由自身应答；dsh 解析序 `DSH_ACP_PASEO_DSH` → PATH（win32 PATHEXT 感知）→ `$DSH_HOME/source/current/bin/dsh`；每次启动自愈专属 profile（缺 bundle 层即 `dsh plugin --profile dsh-acp-paseo add <spec>`，幂等）；默认 `DSH_PERMISSION_MODE=workspace-write`。
- **Profile**（`dsh-acp-paseo`）：dsh-base 提供完整产品组合（agent-loop / llm / session / sandbox / approval / 命令注册表 / plan-mode / goal / compact / 持久化……），本 bundle 的 patch 层只做两件事：插入桥插件行、覆盖 persona。
- **Provider Entry**（Paseo `config.json` → `agents.providers.dsh`）：`{extends: "acp", command: [launcher], params: {supportsMcpServers: false}, enabled: true}`，**不声明 `models`/`env`** —— Paseo 走 ACP 自动发现（`session/new` 响应里的 `models`/`modes`/`configOptions`），凭据由 dsh 侧自解析（env → `$DSH_HOME/.credentials.yaml` → 项目 `.env` → `$DSH_HOME/.env`）。
- **桥**（`packages/dsh-acp-paseo/src/index.ts`）：唯一"说话"的组件，见下。

## 桥的 ACP 面

| ACP 方法 | 实现 | 落点 |
|---|---|---|
| `initialize` | 固定能力（仅文本 prompt，无 fs/terminal/MCP 能力） | — |
| `session/new` | 创建 agent 并返回三套状态：`models`（显式 provider 或 dsh 当前默认路由的目录 + 当前模型）、`modes`（execute/plan）、`configOptions`（thought_level） | `ctx.llm.listModels` / `ctx.agentDefaultModel` / `ctx.llm.resolveModelInfo` |
| `session/prompt` | 单 text block 以 `/` 开头 → Command Passthrough；否则普通消息 | `ctx.commands.execute` / `createUserMessage` + `followup` |
| `session/cancel` | 中止在途命令与工具、结算 prompt | `agent.cancel({kind:'user'})` |
| `session/set_mode` | execute/plan → dsh plan mode 布尔开关 | `ctx.planMode.set` |
| `session/set_model`（unstable） | 校验目录内 → 改会话的 `ModelSelectionRef.current` | `installModelSelection(agent.ctx, ref)` |
| `session/set_config_option` | thought_level → `selection.reasoningEffort` | 同上 |
| `requestPermission`（agent→client） | allow-once / reject-once 一次选项 | `approval/request` 瀑布 |

## 流式映射（dsh 会话事件 → ACP session/update）

| dsh 事件 | ACP 更新 | 说明 |
|---|---|---|
| `assistant/chunk` `text-delta` | `agent_message_chunk` | 增量文本 |
| `assistant/chunk` `reasoning-delta` | `agent_thought_chunk` | 增量思维链（Opencode 同款） |
| `assistant/message` | 仅 image 占位符 | 文本/思考已在 delta 流中；未收到 delta 的步骤（退化场景）回退推送完整文本 |
| `tool/call` | `tool_call`（`in_progress`） | title=命令/路径/prompt 摘要，kind 见下表，rawInput=解析后的 arguments |
| `tool/result` | `tool_call_update`（`completed`/`failed`） | content=结果文本（截断 8000 字符），rawOutput=output/error |
| `plan/mode` | `current_mode_update` | 会话内 `/plan`、`exit_plan_mode` 触发的自主切换 |
| `commands/change` | `available_commands_update` | 命令注册表变更即时重推 |
| `turn/end`（error） | prompt 响应 reject | 回合失败 → RPC internalError |

工具 kind 映射：`bash`/`pwsh`→execute；`read`/`read_image`→read；`write`/`edit`/`str_replace_editor`→edit；`glob`/`grep`→search；`web_search`/`web_fetch`→fetch；`subagent`/`subagent_fork`/`todo_write`→think；其余→other。

取消/断连时对在途工具补发 `failed` 更新（否则 Paseo 里工具永远显示运行中）。

## 命令广播时序

`available_commands_update` 必须在 `session/new` **响应之后**发送：Paseo 的 `ACPAgentSession.sessionUpdate` 会丢弃任何 sessionId 尚未匹配的通知（它在响应里才学到 sessionId），且其消息泵与请求响应并发处理。又因 generic ACP client 的 `waitForInitialCommands` 硬编码为 false，Paseo 在会话创建后立即查询一次命令、不做等待。因此桥在响应后按 `0/250/1000ms` 阶梯重播三次：客户端缓存只要一次通知落地即被填充，之后任何 `list_commands` 查询都命中。首次查询（响应后即刻）仍存在竞态窗口，但 Paseo 的 60s stale 刷新或面板重开必然命中；直接输入 `/compact` 文本始终可用（Command Passthrough 不依赖列表）。根治需 Paseo 上游让 generic ACP 支持 `waitForInitialCommands`（Cursor/Kiro 专属 client 已开启）。

## 会话模型与关键决策

- **Fresh-only**：每连接一至多个全新会话，不支持 load/resume（ADR-0003）。
- **Goal 不是模式**：模式集合只有 execute/plan；goal 保持 `/goal` 命令（ADR-0002）。
- **总是显式 provider/model**：会话创建时显式传 `{provider, model}`，子代理经 `resolveChildAgentOptions` 继承——这是 subagent 正常工作的前提（ADR-0004）。
- **Inflight Slot**：每会话至多一个在途 prompt，`agent/inbox/claimed` 关联 turn 号，`whenIdle()` 结算。
- **Quiesce**：连接关闭 → 取消全部 agent、结算 prompt、补发工具 failed、drain 子代理、dispose。
- **SDK 版本**：钉 `@agentclientprotocol/sdk@0.17.1`——与已装 Paseo 0.3.1 客户端一致（其 `NewSessionResponse` 含 `models` 字段；0.25.1 反而移除了该字段）。Paseo 升级 SDK 时随动。

## 与官方/参考实现的边界

| 能力 | 官方 dsh-acp | renat3u/dsh-paseo | 本项目 |
|---|---|---|---|
| 模型目录 + 切模型 | ❌ | ❌（模型选择器是摆设） | ✅ session/new + set_model |
| 模式（execute/plan） | ❌ | ❌ | ✅ set_mode + 自主变更广播 |
| 思考强度 | ❌ | ❌ | ✅ thought_level configOption |
| 斜杠命令 | ❌ | ❌ | ✅ 动态列表 + 执行 + 变更广播 |
| 思维链/增量文本流 | ❌（只推提交文本） | ❌ | ✅ assistant/chunk 增量流 |
| 工具调用流 | ❌ | ❌ | ✅ tool_call 生命周期 |
| 子代理 | 支持（quiesce drain） | 同左 | ✅（含显式模型选项修复） |

## 已知限制

- Fresh-only 会话；image/audio/embedded 块与 MCP 服务器显式拒绝。
- 工具 kind 映射是名字表驱动的（`src/tools.ts`），新工具默认 `other`。
- 富权限选项（once/always）、`usage_update`、plan 更新未实现。
- Windows 尽力支持（PATHEXT、`.cmd` shell spawn 加固），以实测为准。
