# 网页控制端与 Codex 执行端边界

网页 ChatGPT 调用 `submit_goal`，LRM 在精确网页身份证据匹配后启动 Goal，Codex 在指定 Workspace 执行修改和验证。Codex 执行会话不得重新派发业务任务。

## 实际授权依据

- MCP 的 OAuth/static token 验证代表连接授权。当前认证层只提供认证类型，没有可信的网页/Codex 角色区分；不能将 OAuth、User-Agent、自报来源或扩展在线当作网页证明。
- `/identity-evidence` 经现有 Bridge 的扩展配对 Origin 和 Bearer token 验证。扩展从网页的规范调用记录提取 `submit_goal` 的精确 correlation_key、conversation_id、document_id 和 navigation_epoch。
- Pending 解析必须匹配该 correlation_key 的证据后才能调用 GoalSubmission。`authenticated_mcp_invocation` 只供 connector preflight 使用，不绕过身份门禁；没有对应证据不创建 Goal/Execution/Thread，超时后迟到证据也不重新启动。
- 接收请求可以先创建 Pending。现有接口没有足以在 Pending 创建之前可靠区分网页/Codex 的可信预授权，也没有 Desktop `create_thread` 的会话级 MCP 禁用参数。因此本修复不宣称严格来源隔离或工具卸载，提示词也不是服务端授权机制。

## 执行指令

网页端提交任务时，`workspace_id`、`execution_mode`、`model` 等通过结构化控制参数传递；`goal`、`requirements` 和 `acceptance_criteria` 仅填写可执行的代码修改与验收要求。接收入口识别明显的控制端配置行（如目标 Workspace、执行载体、要求绑定执行环境），直接拒绝含此类指令的提交，不创建 Pending；由网页端重新提交干净的业务字段。首次执行和后续迭代直接使用业务任务文本，不附加职责声明，也不按产品或工具名称关键词改写合法任务。

## 本次提交状态

`submit_goal` 的 `accepted=true` 只代表收到请求，不证明会话已创建。使用同一 correlation_key 调用 `get_identity_trace`，读取持久化的 `submission`：

| state | 含义 |
| --- | --- |
| pending_identity | 已接收，等待精确网页身份证据 |
| starting | 身份匹配，正在尝试启动 Goal |
| started | Goal 启动已确认，返回已有 goal_id/task_id/execution_id |
| failed | 本次请求失败，error 描述原因 |
| indeterminate | 本次启动结果不确定，需要核对已有记录 |

`pending_identity_expired` 仅属于其 correlation_key，不说明其他 Codex 会话未启动，不自动重试。不根据标题或任务相似性关联或去重。用返回的 execution_id 及对应 Workspace 查询 `get_execution_status`，读取已有 Session/thread 关系与当前执行状态；没有证据的 ID 不补猜。`started` 是派发结果，后续完成/失败/人工处理以 Goal/Execution/Session 查询为准。

## 真实网页验收（本次代码测试之外）

1. 部署本次版本后，从网页 ChatGPT 正常提交一次小任务，记录 correlation_key；检查身份匹配、Goal 启动和对应 Execution/Session/thread。
2. 查看目标 Codex 收到的完整业务任务（无额外职责前缀）及实际本地执行，确认没有再次派发。
3. 如需验证重复调用门禁，使用受控测试环境和无网页对应证据的新 key；只应产生独立 Pending 并超时，原 Goal/Execution/Session 保持不变。不要在正常 Codex 执行会话中通过再次派发验证。

本次不对 2026-10-18 首次派发缺失的后台 ID 作关联推断。
