# 结构化 Review Verdict 实施与验收

本次改动保留原有 APPROVE / ITERATE / HUMAN_REQUIRED、AutoIteration、ControlledActuation 和 Review Completion。`tool_v1` 现为新 Review Request 的默认协议；既有请求继续按持久化协议处理。

**当前启用状态：`tool_v1` 已正式作为新请求默认协议启用。** 真实 ChatGPT 网页 Local MCP Connector 完成 APPROVE、ITERATE 两轮自动执行后 APPROVE，以及无效 Review ID 失败关闭验证；Extension 捕获真实工具调用并通过可信 Bridge 确认，持久化 `confirmed_at`。历史缺失协议或显式 `text_v1` 请求仍使用原文本协议，不转换旧数据。

## 工具契约

新增唯一工具 `submit_review_verdict`，参数为：

```json
{
  "workspace_id": "已注册的 Workspace ID",
  "correlation_key": "00000000-0000-4000-8000-000000000001",
  "verdict": {
    "schema_version": 1,
    "review_request_id": "本次 Review Request ID",
    "decision": "APPROVE",
    "summary": "最终审查结论"
  }
}
```

外层和 `verdict` 都禁止未知字段。`correlation_key` 是 UUID v4，只用于相关性匹配。裁决直接复用 `reviewVerdictSchema`：Summary 不得全为空白；只有 ITERATE 可以且必须提供 `iteration: {goal, requirements, acceptance_criteria}`，两个列表均至少一项且内容非空白。

成功回执为：

```json
{
  "accepted": true,
  "state": "pending_confirmation",
  "review_request_id": "本次 Review Request ID",
  "correlation_key": "00000000-0000-4000-8000-000000000001"
}
```

这是持久接收回执，不证明裁决已生效；重复接收仍返回同一类回执。认证沿用既有 MCP OAuth / SDK authentication proof 校验，不接受模型在参数中自报认证来源。无认证、非 `tool_v1`、非当前活动 Review、身份不符、超时或冲突返回工具错误；不触发 Codex。现有 static-only 调用不能单凭静态令牌跳过 Connector 来源要求。

## 独立的回合证据

Extension 沿用现有 canonical Fiber selector、isolated content document、MV3 worker、配对 Bridge 和持久 outbox。没有建立第二套 Goal 身份状态机。

当前支持 canonical timeline 的 `mcp-tool-call`，也覆盖 reasoning group 中的调用；direct / linked 命名必须与实际 Local MCP Connector 的 server、tool、functionName 一致。`tool_call_id` 只取实际 `item.callId`，Review 用户消息只取当前最后一条 `user-message.messageId`；存在 `serverMessageId` 时必须一致。没有稳定调用 ID 或真实 user anchor 的旧结构安全拒绝。真实网页 E2E 已确认该调用和 Extension 证据路径。

证据包含原有 `request_id`、canonical `conversation_id`、worker 确认的 `document_id` / `navigation_epoch`，以及 `tool_name`、`connector`、`workspace_id`、`review_request_id`、`expected_user_message_id`、`tool_call_id` 和 **实际工具参数中的完整 verdict**。

服务端核对 Registry → 当前 AutoIteration → Review Request → Routing → Review Delivery → Execution 的绑定，要求 Execution passed，并核对已持久化 Extension Delivery 的真实用户消息回执。证据的 document / epoch 必须与该投递回执一致；页面重载后若无法提供相同归属证据，安全进入人工处理，不通过 URL fallback 放宽关联。最后比对 correlation key，以及严格 Schema 规范化后的 MCP 裁决 SHA-256 与独立证据的完整裁决，防止同 key 不同内容被确认。Verdict 证据不进入 `submit_goal` 的 correlation registry。

## 持久化、时序与恢复

每条 Review 的记录保存在 `<storageRoot>/control-plane/review-verdicts/<workspace_id>/<review_request_id>.json`，复用 `serializeRecord` 和 `atomicWriteRecord`。记录包含绑定身份、Review 用户消息、接收时间、按 correlation key 区分的待确认工具提交摘要及认证来源、独立证据和 `confirmed_at`。待确认候选只存裁决 SHA-256，避免复制大量未经证明的载荷；最终完整 Verdict 保存在经过验证的证据内。

- 工具和证据任一可先到，先到的一方也会持久化。未确认调用不能独占 Review：不同 key 的待确认提交可以并存，可信回合证据选择唯一匹配的裁决；每条 Review 最多接收 1000 个候选。同 key 不同内容拒绝，完全相同的重试不改写文件；最终可信裁决确定后拒绝新增或冲突提交。
- 确认截止时间唯一采用持久化 `ReviewResult.created_at + 120 秒`；此前仍由现有 Review Completion 生命周期管理，不另设提前到期时间。重启不重置期限。
- AutoIteration 仍先确认 Review Completion，再进入 verdict 阶段。`tool_v1` 只读取可信记录；未齐全时通过有界事件等待接收确认通知，没有轮询或第二次 Review 投递。
- 工具和证据先完成时，仍等待 Completion。Completion 先完成时，等待工具及证据。超时进入 `human_required`；纯正文 APPROVE 不生效。
- 已确认记录恢复后仍核对当前活动绑定，再复用原有决策和 ControlledActuation。原有稳定 Execution / Actuation ID、防重复派发、最大迭代次数保持原样。
- 停机唤醒等待并保留 verdict 检查点；重启从相同 Completion 时间和记录恢复。原 Review Result 不被结构化提交覆盖。

## 历史兼容和二次补交

`verdict_protocol` 缺失或为 `text_v1` 时使用原 Parser；XML 和 BEGIN / END 纯文本均保留。没有批量更新历史数据，已持久化的 `verdict_recovery` 继续恢复，并显式创建 `text_v1` 补交请求。

**`tool_v1` 分支已完全绕开自动二次 Verdict 补交。** 缺失、证据不符或超时均不会创建另一条 Review，也不会回退到文本裁决。旧协议及显式创建的 `text_v1` 请求保留原有补交行为。

## 修改文件

| 范围 | 文件 |
| --- | --- |
| 工具与应用接线 | `src/mcp/server.ts`、`src/app.ts`、`src/control-plane/bridge.ts` |
| 结构化提交与现有决策 | `src/control-plane/review-verdict-submission.ts`（新增）、`src/control-plane/auto-iteration.ts` |
| 请求协议与证据 Schema | `src/context/review-schema.ts`、`src/context/types.ts`、`src/context/review-request-service.ts`、`src/control-plane/extension-identity.ts` |
| 提示词与投递 | `src/delivery/review-message.ts`、`src/delivery/review-delivery-adapter.ts`、`src/router/browser-router.ts` |
| Extension | `extension/fiber.js`、`extension/content.js`、`extension/background.js` |
| 测试 | `tests/control-plane/review-verdict-submission.test.ts`（新增）、`tests/submit-goal-correlation.test.ts`、`tests/extension-identity.test.ts`、`tests/extension-delivery.test.ts`、`tests/mcp-http.test.ts` |
| 验收说明 | 本文 |

## 验证记录

修改前选定的 6 个相关测试文件共 176 项通过。新增协议测试覆盖三种决策、无正文 Verdict、全部先后顺序、幂等/冲突、错误身份/内容、超时、最大迭代数、重启、停机取消、MCP 与配对应用 Bridge。

相关回归中 `tests/control-plane/bridge.test.ts` 的 `exposes collection-only recovery targets and routes their failure reports` 原用例失败；已用未修改 HEAD 的隔离快照复现同样失败。该用例仅 enqueue 而未启动 `awaitResult`，却预期出现只对活跃采集开放的恢复目标。本次未修改它或 Completion 实现。

最终相关验证覆盖 20 个测试文件，合计 **542 项通过、1 项跳过**，其中复用了未受最后修正影响的已通过结果。最后一次核心回归为 4 个文件、142 项通过、1 项跳过。唯一跳过项即上面已在原始 HEAD `3e55a39` 复现的旧失败用例；运行时使用 `--testNamePattern '^(?!.*exposes collection-only recovery targets)'` 明确排除，未将其计为通过。新增协议测试共 29 项通过。覆盖范围包括 AutoIteration、Pending Goal、MCP HTTP、Bridge、Review Request / Parser / Completion、Fiber correlation、Extension identity / delivery / presence / recovery。

`npm run typecheck`、`npm run build`、三个 Extension JS 文件的 `node --check` 以及 `git diff --check` 均通过。没有运行无关全量测试、没有提交或推送。

2026-10-22 正式启用回归：15 个相关测试文件 **487 项通过**；`npm run typecheck`、`npm run build` 与 `git diff --check` 通过。首次聚焦运行暴露 18 个旧文本协议测试实例未注入 `text_v1` 夹具，显式固定这些历史测试协议后重跑全组通过；生产默认仍为 `tool_v1`。

复杂度审查保留了信任边界 Schema、载荷摘要匹配、持久化串行写入和有界等待；它们分别保护独立的输入、并发及重启窗口。审查后移除了会提前结束确认窗口的独立 TTL，并将未确认候选按 key 隔离，避免一条未经回合证明的提交抢占 Review。未引入新依赖、事件总线、执行器、通用状态机或额外部署配置。

## 真实网页 E2E 验收结果（2026-10-22）

隔离 Workspace：`fe7118e19c17`（测试目录 `lrm-tool-v1-e2e`）。真实 ChatGPT 网页 Review Conversation：`6ad95939-102c-83e8-b88d-9ef59b33c4e7`；使用 Local MCP Connector 和已加载 Extension，网页工具目录包含 `workspace_list` 与 `submit_review_verdict`。

| 场景 | 持久证据与结果 |
| --- | --- |
| APPROVE | Goal `goal-393b803e-aa91-4c50-aa98-dc56f8997d73`、Review `auto-review-ce975a7a17a5745796dadb8d8048c9fa`；一次真实工具调用，Extension 身份及用户消息匹配，`confirmed_at` 已写入，Review Completion 与 AutoIteration 均 completed。 |
| ITERATE → 第二轮 → APPROVE | Goal `goal-688dd3fa-3cbc-4aa2-b299-2471b676ef1a`；第一 Review `auto-review-b71ac04bc59850c9c1ee6e4f4bca82a1` 持久化 ITERATE，第二 Execution `auto-execution-3af40ff6b110a58e5095904913196710` 只派发一次，第二 Review `auto-review-e79ba8887927d7ac62f6b1b18bb06c72` 持久化 APPROVE 并确认，循环在 `iteration=2/max_iterations=2` 完成。 |
| 无效 ID 失败关闭 | Goal `goal-66a2ce3d-1fa4-41a6-b6c7-04fe51a84161`；网页仅提交一次错误 Review ID，服务拒绝；正确 ID 无提交记录、无文本 Verdict 补交、无第二次 Actuation。超过确认期限后 Loop 为 `human_required / VERDICT_CONFIRMATION_TIMEOUT`。 |

首次 ITERATE 运行触发了 Desktop executor/target ID 相同的拒绝，未派发第二轮；该失败记录被保留且没有重放。修复 Desktop continuation 复用持久化 executor identity 后，以全新 Goal 重新真实验证成功。服务恢复后的记录核验显示完成/人工处理的上述 Loop 没有产生额外 Actuation。

`workspace_list` 实际调用成功；记录核验来自 LRM 持久化 Review Request、Verdict、Review Result、Completion、AutoIteration、ControlledActuation、Desktop binding 和 Extension receipt，而非工具回执文本。此前失败的 MiniJMP Goal 未修改或重派。

运行时恢复核验：通过 `ProductionProcessManager` 重启后，本机与公网 `tools/list` 均返回 HTTP 200、23 个工具并含 `submit_review_verdict`；上述四个测试 Task 的 AutoIteration 与 Actuation 持久化快照在重启前后完全一致。用户随后提供的启动器截图也显示 MCP Runtime、隧道、Browser、Desktop、Tools Pipe 和 OAuth 正常。Codex 宿主旧会话曾返回 ChatGPT `backend-api/ps/mcp` `transport send error`；新 Codex 会话则在调用前返回 `MCP tool codex_apps/local_mcp_connector.workspace_list is not available to the model`，没有到达 LRM。两者都不能证明 LRM 服务端拒绝请求，也不能确定重启是唯一原因；Codex 宿主当前仍未能实际调用 Connector。此前真实网页 Connector、Extension 身份确认及 Verdict 自动迭代记录不受影响。
