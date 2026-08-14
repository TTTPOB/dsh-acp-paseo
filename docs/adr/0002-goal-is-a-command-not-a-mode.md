# Goal 是命令，不是模式

Paseo 的模式选择器只暴露 `execute` 与 `plan` 两个模式；dsh 的 goal 不进入模式集合，保持为 `/goal` 斜杠命令。ACP 的 `session/set_mode` 只携带 modeId，而启动一个 goal 必须提供 objective 文本——做成模式要么激活时没有目标（无意义），要么需要在切模式时弹输入（协议不支持）。dsh 里 plan mode 恰好是布尔协作状态，与 ACP 模式语义吻合；goal 是事件溯源的会话内领域服务，命令是其唯一正规入口。未来若 ACP 支持携带参数的模式切换，可重新评估。
