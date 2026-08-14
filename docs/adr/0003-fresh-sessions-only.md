# Fresh-only 会话

v1 不支持 `session/load`/resume：每个 Paseo agent 窗口对应一个全新 dsh 会话，连接关闭即释放。这与官方 dsh-acp 桥的边界一致。真正的恢复需要在组合里接入持久化回放（dsh-base 已含 jsonl 持久化，缺的是桥侧 loadSession 回放路径），工作量与风险都独立于本项目的核心目标（目录/模式/命令通路）。Paseo 侧行为良好：桥不声明相应能力，Paseo 直接开新会话。会话历史本身仍由 dsh-base 的持久化落盘（`$DSH_HOME/sessions`），后续版本可补 loadSession 而不破坏现有行为。
