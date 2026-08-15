# dsh-acp-paseo

把 DeepSeek Harness（dsh）编码代理通过 ACP（Agent Client Protocol）接入 Paseo 的集成 bundle。用户把 dsh 添加为 Paseo provider 后，模型目录、凭据、模式与斜杠命令全部从 dsh 侧自动获得，Paseo 端零配置。

## Language

**Bridge**:
运行在 dsh 进程内的 cordis 插件，把 dsh 的 agent/会话/命令能力翻译成 ACP JSON-RPC（stdio）。本项目唯一"说话"的组件。
_Avoid_: adapter, server（除非指整个 ACP 服务端进程）

**Launcher**:
Paseo spawn 的稳定入口脚本（`bin/dsh-acp-paseo-launch.mjs`）：解析 dsh 位置、自愈 profile、保证 stdout 协议纯净，然后 exec `dsh --profile dsh-acp-paseo`。
_Avoid_: wrapper, shim

**Provider Entry**:
写入 Paseo `config.json` 的 `agents.providers.dsh` 条目（`extends: "acp"`）。不声明 `models`/`env`，让 Paseo 走 ACP 自动发现。
_Avoid_: provider config（歧义：也可能指 dsh 侧的 llm provider）

**Profile**:
dsh 的组合单元。本项目使用专属 profile `dsh-acp-paseo`（bundles = dsh-base + 本 bundle），由 Launcher 自愈创建。
_Avoid_: 不要与 Paseo 的 provider 概念混用

**Mode**:
会话级协作姿态，只有两个：`execute`（默认，正常编码）与 `plan`（只读规划，对应 dsh plan mode 布尔开关）。通过 ACP `session/set_mode` 切换。
_Avoid_: build（Opencode 的叫法）；不要把 sandbox 策略或 approval 策略称为 mode

**Goal**:
dsh 的长任务目标领域服务，只能经由 `/goal` 斜杠命令使用。**Goal 不是 Mode**——它需要一段 objective 文本，而模式切换携带不了文本。
_Avoid_: goal mode

**Catalog**:
`session/new` 响应里返回给 Paseo 的模型目录（`models.availableModels` + `currentModelId`），运行时读自 dsh 的 `ctx.llm`。未固定 provider 时聚合所有已注册路由，并把 ACP model ID 编码为 `provider/model`；显式配置 provider 时只读取该路由。
_Avoid_: model list

**Thought Level**:
思考强度选择器（off/high/max），作为 ACP configOption（category `thought_level`）暴露，落到 dsh 的 `reasoningEffort`。
_Avoid_: thinking mode

**Command Passthrough**:
桥对 prompt 的拦截规则：恰好一个 text block 且以 `/` 开头时，交给 dsh 命令注册表（`ctx.commands.execute`）执行，不进模型；其余一律普通消息。
_Avoid_: slash interception

**Self-heal**:
Launcher 每次启动时检查 profile 清单，缺 bundle 层则自动 `dsh plugin add` 修复的幂等行为。
_Avoid_: auto-install（易与 npm 安装混淆）

**Inflight Slot**:
桥内每会话至多一个的在途 prompt 关联结构（message id → turn 号 → turn 结束原因），用于把 dsh 的异步回合结算为 ACP prompt 响应。

**Quiesce**:
连接关闭时的收尾协议：取消全部 agent、结算在途 prompt、drain 子代理、dispose 会话句柄。
