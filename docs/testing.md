# 测试指南

本项目测试分三层：CI 单测、本地 ACP 冒烟、Paseo 手动实测。

## 1. CI：typecheck + 单测 + 构建

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest（codec / catalog / tools 纯函数层）
pnpm run build       # 编译 + 产物检查（无 .ts 残留 import）
```

单测覆盖：turn-end→stop-reason 映射、prompt 扁平化与 Command Passthrough 谓词、目录/模式/思考强度派生、工具 kind/title/结果渲染与截断。

## 2. 本地 ACP 冒烟（端到端，走真实 dsh）

前置：本机已装 dsh CLI（PATH 可解析或设 `DSH_ACP_PASEO_DSH`）；`DEEPSEEK_API_KEY` 已配置（env 或 `$DSH_HOME/.credentials.yaml`）。

```bash
export PATH="<dsh bin 目录>:$PATH"
node tools/acp-smoke-client.mjs --cwd <工作目录>
```

冒烟脚本按 Paseo 的客户端行为走完整链路并断言：

1. `initialize` → 协议版本一致
2. `session/new` → **目录非空 + currentModelId + modes[execute,plan] + thought_level 与 permissions 选项**
3. 命令广播 → 含 compact/plan/goal（`/export` 被过滤）
4. `set_mode plan` → `unstable_setSessionModel` → `set_config_option thought_level=high` → `set_config_option permissions=<另一预设>`（断言生效并还原）逐项生效
5. `/compact` 斜杠命令 → `end_turn`（不进模型）
6. 普通 prompt → 收到**增量文本**与 `agent_thought_chunk`（思维链；模型不思考时 WARN 不 fail）
7. **subagent 回归**：prompt 要求调用 subagent 工具 → 断言 `end_turn` + 答案非空 + 收到 subagent 委托工具的 `tool_call`→终结更新（回归 ADR-0004 的显式模型选项修复）
8. `cancel` 收尾

## 3. Paseo 手动实测清单

```bash
# 注册 provider（幂等，备份 config.json）
dsh-acp-paseo-install-provider
# 重启 Paseo daemon 后：
paseo run --provider dsh "Reply with exactly: PONG"
```

UI 清单：

- [ ] Provider 列表出现 "DSH (DeepSeek Harness)"，无需配置任何 API key / 模型
- [ ] 模型选择器显示 deepseek-v4-flash / deepseek-v4-pro（自动发现），切换后生效
- [ ] 模式选择器有 Execute / Plan；Plan 下模型只读规划，可经 plan 审查退出
- [ ] 思考强度选择器 off/high/max，切换影响后续回复
- [ ] 权限选择器显示 workspace-write / danger-full-access（当前值可能显示为 Custom），切换后生效；若 Paseo 不渲染非官方 category 的 configOption，记录为已知限制
- [ ] 输入 `/permission <preset>` 后 Paseo 权限选择器同步更新
- [ ] 输入 `/` 出现命令自动补全：compact / goal / permission / plan / feedback（**首次打开会话可能暂无列表**——Paseo 首查在广播落定前；稍候重开面板或直接输入 `/compact` 文本均可）
- [ ] `/compact` 执行后输出压缩结果，不产生模型调用
- [ ] `/goal <objective>` 设置长任务目标；goal 只是命令，不是模式
- [ ] 回复期间：**思维链实时滚动**、**工具调用实时可见**（bash 命令、文件读写、subagent 委托），完成后显示结果
- [ ] 模型调用 subagent 不再报 "subagent run failed"
- [ ] 取消（stop）后工具状态闭合为失败、turn 显示取消
- [ ] 授权弹窗 allow-once / reject-once 工作；Auto Accept 开启后自动放行

## 4. Windows 清单（尽力支持）

- [ ] `dsh-acp-paseo-install-provider` 写入 `[node, launcher]` 形式 command
- [ ] launcher 通过 PATHEXT 找到 `dsh.cmd`
- [ ] `--version` 探针、SIGINT/SIGTERM 转发、退出码透传
