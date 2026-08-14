# Profile 宿主，而非自包含 bin

桥以 cordis bundle 形式装入 dsh 的专属 profile（`dsh --profile dsh-acp-paseo`），由 Launcher 自愈，而不是自己带一个 `dsh-app-boot` 启动的独立 bin。理由：目标用户本机已有 dsh 安装，凭据（`DEEPSEEK_API_KEY`）与 settings 由 dsh 侧管理；复用 dsh-base 的完整产品组合（sandbox/approval/持久化/命令插件）避免我们重复拥有这些组合决策。代价是依赖用户的 dsh CLI 并承担上游快照漂移风险（peer range 放宽 + README 支持矩阵缓解）。曾考虑自包含 bin：组合确定、不依赖 dsh CLI，但需自己挑选 sandbox/approval 策略并整包依赖 @deepseek-ai/* 全家桶，rc 期维护成本更高。
