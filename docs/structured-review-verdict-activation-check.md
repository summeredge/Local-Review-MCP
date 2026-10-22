# 结构化 Verdict 实际接入核查

## 重启后的运行状态与 Codex 宿主复核（2026-10-22）

用户提供的 LRM 启动器截图显示 MCP Runtime 正在运行，Cloudflare 隧道、Browser、Desktop、Desktop IPC、Desktop 身份、Tools Pipe 与 OAuth 均为已连接/正常，当前 Desktop 能力可用。截图是启动器状态证据；本机和公网 MCP 的直接核对也均为 HTTP 200、23 个工具，`workspace_list` 返回工作区清单，包含 `submit_review_verdict`。

Codex 当前会话及新建的 Codex 会话均未能把 `workspace_list` 调用送到 LRM。新会话返回原始错误 `MCP tool codex_apps/local_mcp_connector.workspace_list is not available to the model`；这是模型/宿主工具可用性边界的拒绝，不是 LRM 返回的 MCP 错误。更早的 `backend-api/ps/mcp` `transport send error` 是另一次宿主转发错误，保留为历史现象。现有证据支持 LRM 当前运行正常；重启可能使既有宿主连接中断，但不足以解释新 Codex 会话仍不可调用的原因，也不能据此认定是 LRM 或 Extension 缺陷。ChatGPT 网页 Connector 的真实调用与 Verdict E2E 证据见下文和 [structured-review-verdict.md](structured-review-verdict.md)。

恢复方式：LRM 无需再次重启或修改安全校验。日常 Review 可继续使用已验证的 ChatGPT 网页 Connector。Codex 宿主需在其连接器/工具授权恢复可用后重新开新会话验证；当前尚无证据支持具体的 Codex 内部缓存或授权根因。

## 当前状态（2026-10-22）

此前的真实 Connector 工具发现阻断已通过新建网页 Review 对话解决。`tool_v1` 已设为新 Review Request 的默认协议，并在隔离 Workspace 完成真实 APPROVE、ITERATE 自动启动第二轮并 APPROVE、无效 ID 失败关闭三条网页 E2E。每条成功 Verdict 均核对了持久化 `confirmed_at`、Extension 身份和消息锚点；失败关闭场景无 Verdict 记录、无文本回退、无第二次 Actuation。Desktop continuation 的 executor/target 混淆已修复，重试使用新 Goal，未重放先前失败 Actuation。详细 ID 与结果见 [structured-review-verdict.md](structured-review-verdict.md)。

以下 2026-10-21 诊断是历史状态记录，其中“尚未切换默认值”“当前聊天工具目录不完整”仅描述当时，不代表当前部署状态。

---

## 历史记录：2026-10-21

## 结论：停在真实 Connector 工具目录环节

本次未切换默认协议，未发送隔离 Review，未重新派发 MiniJMP 执行。真实 Connector APPROVE / ITERATE / Extension 身份确认均未验收，不能宣称正式上线。

使用运行配置中的认证凭据（未输出凭据）直接请求 JSON-RPC `tools/list`：

| 环节 | 实测 |
| --- | --- |
| 当前源码与 dist | 均包含 `submit_review_verdict` |
| 实际运行实例 | PID 33904，命令指向本仓库 `dist/src/cli.js --runtime`；构建时间 21:03:53，进程启动时间 21:03:55 |
| 本地 `http://127.0.0.1:12080/mcp` | HTTP 200，23 个工具，含新工具 |
| 公网 `https://review.syqiu.kdns.fr/mcp` | HTTP 200，相同 23 个工具，含新工具 |
| 持久化 Connector binding | 指向上述公网地址；历史 verified 标记不等于新工具已发现 |
| 当前聊天实际工具目录 | 22 个 Local MCP 工具，缺少新工具 |
| 用户报告刷新后 | 当前会话仍无新工具；调用已有 `workspace_list` 返回 ChatGPT `backend-api/ps/mcp` Transport send error |

因此，已排除服务端未注册、当前运行构建过旧和公网清单过滤新工具。当前直接阻断是 ChatGPT Connector 到会话工具目录的发现/暴露及刷新后的转发错误。仅凭服务端信息无法进一步确定 ChatGPT 内部缓存、工具筛选或授权同步中的哪一项导致缺失；不将其推断为已证实的缓存原因。尚未走到 Extension 身份确认阶段。

后续人工操作：在 ChatGPT 设置的应用/连接器中打开 Local MCP Connector，核对 MCP 地址；如有刷新工具入口则刷新，否则断开并重新连接同一地址、完成授权。然后在新聊天中选择该连接器，检查实际工具目录是否含 `submit_review_verdict`。本次用户已报告刷新，但当前聊天仍不可用，应先解决该环节，再按 `structured-review-verdict.md` 做隔离 E2E。不得用直接 HTTP 调用或合成 Fiber 证据代替真实验收。

## 原失败记录

- Goal：`goal-f1fcfd14-2aa1-43ee-83e0-219b1fef215e`
- Task：`task-46c70740-e377-4ce5-ab8a-3d8d2f842350`
- Execution：`goal-execution-2b62255e8f5a291939bfffd6aaf6b367`
- Review Request：`auto-review-a0d67fd8e6c3de760e45a719433a3cfd`
- Review Result：`result-31645be0-5a6a-47e6-b44b-3a424d1bd3bc`

这些记录实际属于 MiniJMP Workspace `1e490ba5641d`；`0ee5a4a43938` 是本次修改的 LRM 仓库 Workspace。未将两者混用。

原 Request 明确持久化 `verdict_protocol: text_v1`。原 Result 状态为 COMPLETED，完整读取本地 JSON 后发现其 content 以 `LRM_REVIEW_VERDICT_BEGIN` 结束，没有 JSON 载荷或 END。正文明确建议 ITERATE，指出 `showoptions=False` 时摘要控件 `pack(before=self.nb)` 引用未 pack 的 Notebook，并指出切换按钮初始文字错误。自然语言意图不构成有效机器裁决。

本地文件读取没有截断，但无法仅凭文件判断网页生成还是 Completion 采集导致尾部缺失；COMPLETED 本身不能证明正文完整。`AutoIterationService.advanceVerdict()` 调用原 Parser 后捕获 `VERDICT_BLOCK_INCOMPLETE`，加上 `INVALID_VERDICT_` 前缀交给 `humanRequired()` 持久化；Goal 通知复用 Loop 原因。终止阶段为 verdict，Execution 为 passed。

`iteration=1`、`max_iterations=3`，故本例不是次数限制。结构化裁决存储目录 `control-plane/review-verdicts` 不存在，没有已接收待确认的结构化 Verdict。

原 Request SHA-256：`e5a7c7a8a9059ee364a0a8f4d72c2f84c01231893a359efe9d2cb97416acd0fc`。

原 Result SHA-256：`a79ced69df815e9ef3df7d28344791e2c66ee7d46fe3e4279592049f888a0cae`。

两者在核查前后保持一致；本次未写入生产持久化记录。

## 默认规则、次数和人工处理

新 Goal 默认 `max_iterations=2`。上限包含首次执行；显式设为 1 时，首次 Review 的 ITERATE 进入 MAX_ITERATIONS_REACHED，不派发第二轮。APPROVE 仍可完成。未修改任何上限或授权约束。

正常创建入口为 AutoIteration 与 ReviewRequestSnapshotService，均委托 ReviewRequestService；其余直接调用是诊断代码。AutoIteration 仅对旧文本补交显式指定 text_v1。当前创建默认值仍是 text_v1；历史缺字段按文本处理，已有 text_v1 不转换。tool_v1 分支不解析正文、不创建二次补交。

终止 Goal 的 advance/recover 不恢复执行，仅可能处理通知。没有可直接恢复该 human_required Goal 的公开入口。人工补充说明不会覆盖旧结论或自动恢复。用户将来授权修复时，应创建新 Goal / Task，明确指定 MiniJMP Workspace，关联上述 Goal / Task / Execution / Request / Result，将范围限定为 showoptions=False 初始化及按钮文字修复与针对性回归，保留原改动，不重复原界面优化任务。本次未启动此任务。

## 本次修改及验证

只补充现有失败摘要：TEXT_VERDICT_INCOMPLETE；确认窗口结束时区分 TOOL_VERDICT_NOT_SUBMITTED、TOOL_VERDICT_IDENTITY_UNCONFIRMED、TOOL_VERDICT_CONFIRMATION_TIMEOUT。保留原 terminal_reason（包括 VERDICT_CONFIRMATION_TIMEOUT 和 MAX_ITERATIONS_REACHED），不新增状态、不降低身份校验。

修改：`src/control-plane/review-verdict-submission.ts`、`src/control-plane/auto-iteration.ts` 及两个对应测试文件，另新增本文。其余原有未提交改动保留。

本次实测：

- `tests/control-plane/review-verdict-submission.test.ts`：29 项通过。
- `tests/control-plane/auto-iteration.test.ts`：57 项通过。
- `tests/control-plane/goal-orchestration.test.ts`：32 项通过。
- `tests/review-request-context.test.ts`：8 项通过。
- `npm run typecheck`、`git diff --check` 通过。

合计 126 项，无跳过。首条测试命令误用了不存在的 `tests/review-request.test.ts`，Vitest 只匹配到另外三个文件；随后单独执行正确的 `tests/review-request-context.test.ts`，上述统计使用实际运行结果。

隔离测试覆盖无正文标记 APPROVE、ITERATE 单次派发及恢复防重复、HUMAN_REQUIRED、身份冲突拒绝、未确认不派发、无二次 Review、max_iterations=1；这些使用测试执行适配器，不等同真实 ChatGPT/Codex E2E。没有运行无关全量测试，没有构建或重启生产服务；本次诊断代码仍待后续部署。轻量复杂度检查仅新增读取已有记录的诊断方法和摘要映射，无新持久化状态、缓存或 fallback。
