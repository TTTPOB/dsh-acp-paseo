# dsh-acp-paseo

把 DeepSeek Harness（dsh）编码代理通过 ACP（Agent Client Protocol）接入 [Paseo](https://github.com/getpaseo/paseo)。用户把 dsh 添加为 Paseo provider 后，模型目录、凭据、模式、思考强度与斜杠命令**全部从 dsh 侧自动发现，Paseo 端零配置**。

## 特性

- **模型目录自动发现**：Paseo 打开会话即拿到 dsh 的模型目录（`deepseek-official` 路由），无需在 Paseo 配置模型列表；会话内可切模型
- **凭据由 dsh 管理**：`DEEPSEEK_API_KEY` 走 dsh 的凭据链（env → `$DSH_HOME/.credentials.yaml` → `.env`），Paseo 不接触密钥
- **模式选择**：`execute`（默认）/ `plan`（只读规划），对应 dsh 的 plan mode 布尔开关
- **思考强度**：`off` / `high` / `max` 选择器，落到 dsh 的 `reasoningEffort`
- **斜杠命令**：`/compact`、`/goal`、`/plan`、`/permission`、`/feedback` 自动出现在 Paseo 命令菜单，原地执行、不进模型（`/export` 等 web-only 命令被过滤）
- **实时流**：思维链（`agent_thought_chunk`）、增量文本、工具调用全生命周期（bash/文件/搜索/subagent 委托）实时可见
- **子代理可用**：模型前台/后台调用 subagent 正常工作（显式模型选项继承，见 [ADR-0004](docs/adr/0004-explicit-model-options.md)）

## 安装

前置：Node ≥ 22.19；本机已装 dsh CLI（`dsh --version` 可执行，0.1.0-rc.6 及以上）；dsh 侧已配置 `DEEPSEEK_API_KEY`。

```bash
npm install -g dsh-acp-paseo
dsh-acp-paseo-install-provider   # 幂等写入 ~/.paseo/config.json 的 agents.providers.dsh，自动备份
# 重启 Paseo daemon，然后新建 agent 选择 provider "DSH (DeepSeek Harness)"
```

> 与 [renat3u/dsh-paseo](https://github.com/renat3u/dsh-paseo) 互斥：注册脚本会覆盖同名 `dsh` provider 条目。本项目的差异见 [docs/architecture.md](docs/architecture.md)。

## 手动配置（可选）

注册脚本等价于向 `~/.paseo/config.json` 的 `agents.providers.dsh` 写入：

```json
{
  "extends": "acp",
  "label": "DSH (DeepSeek Harness)",
  "command": ["<绝对路径>/dsh-acp-paseo-launch.mjs"],
  "params": { "supportsMcpServers": false },
  "enabled": true
}
```

不声明 `models`/`env`——目录与凭据全部自动发现。

## 工作原理

```
Paseo ──spawn──▶ dsh-acp-paseo-launch.mjs ──▶ dsh --profile dsh-acp-paseo
                                                 └─ 桥插件：ACP over stdio
```

Launcher 每次启动自愈专属 profile（缺 bundle 层自动 `dsh plugin add`），保证 stdout 协议纯净。桥在 `session/new` 响应里携带模型目录/模式/思考选项，把 dsh 的会话事件翻译成 ACP 更新流。详见 [docs/architecture.md](docs/architecture.md)。

## 开发

```bash
pnpm install
pnpm run build && pnpm test
node tools/acp-smoke-client.mjs --cwd <工作目录>   # 端到端冒烟
```

构建只依赖 npm 上发布的 `@deepseek-ai/*`（无 dsh 源码快照）。`DSH_MONOREPO` 为未来 snapshot 构建预留。

## 文档

- [架构与决策](docs/architecture.md)
- [测试指南（含首用户实测清单）](docs/testing.md)
- [术语表](CONTEXT.md)
- [ADRs](docs/adr/)

## License

MIT
