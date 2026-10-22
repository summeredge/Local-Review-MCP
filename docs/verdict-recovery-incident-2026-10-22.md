# Verdict 页面恢复及确认期限故障调查

## 事故证据

本次直接读取本机 `%LOCALAPPDATA%/LocalReviewMCP`，确认失败记录属于 MiniJMP Workspace `1e490ba5641d`，不是 LRM 仓库 Workspace。无需重装 Connector；原 Goal 保持 `human_required`，未重放。

- Goal：`goal-f8e1e832-0c9f-4d52-aeba-f5666cb3641d`
- Task：`task-6ebe9bdd-10fe-436e-98c3-d7c46994bc07`
- Execution：`goal-execution-3a47ab1d07aa6eb2b35ffad8cd60ff01`
- Review：`auto-review-3e9845e22dc0ed917e1929c9c5dee3ce`
- Result：`result-072864d4-971e-4b52-b734-e439b772aba0`
- correlation key：`c81d79a4-3841-4bf4-a897-87f6edce37aa`
- correlation SHA-256：`4ed3a5536dff063aad5b15a1ed90ba1527dc4ffba3a8755202e342e324ade3c5`

该哈希与 15:04:18、15:05:16 等浏览器诊断和 Bridge 转发记录精确一致，补齐了原报告尚未完成的事故关联。Bridge 已收到且转发凭据，不是未找到工具或 HTTP 连接未建立。旧日志没有保留 HTTP 响应体，不能将下面的代码重现结果称为当时抓到的 HTTP 包。

以下时间均为北京时间：

| 事件 | 时间或身份 |
| --- | --- |
| Review 投递成功 | 15:00:13.596，document `06C503C88F20ACA7AD26AE6199D096C9`，epoch 10 |
| Result 首次创建 | 15:02:13.825 |
| Verdict MCP 接收 | 15:03:59.534 |
| 凭据到达 Bridge | 15:04:18.619，document 哈希 `c5e7b58127ebc38291d39c047482c55a575e6196b2a3675e61356f64f94f0eec`，epoch 2 |
| Extension Completion 完成 | 15:04:25.373，document `B964D3C4F2F443C515724B433C364963`，epoch 2 |
| Loop 转人工 | 15:04:25.408 |

Completion document 的 SHA-256 与凭据 document 哈希完全一致；用户消息锚点都是 `e306c42b-f356-4b72-8c16-0ef6e6ab2aaa`。

## 已复现的两个缺陷

1. Verdict 仅认投递页面的 document / epoch，而 Completion 已支持在新页面恢复采集。合法恢复凭据被 `VERDICT_EVIDENCE_IDENTITY_INVALID` 拒绝；现有 Bridge 将此类服务错误映射为 HTTP 409。新增测试在修复前以此错误失败。
2. `ReviewResultService` 将先前 TIMEOUT 更新成 COMPLETED 时保留首次 `created_at`；确认期限却使用此时间。此例推导出的旧期限为 15:04:13.825，早于实际 Completion 11.548 秒，因此进入 verdict 阶段后立即超时。新测试先创建 TIMEOUT、180 秒后采集成功，修复前立即进入 `human_required`。

首条凭据到达时 Completion 尚未完成，故不能直接声称首条 HTTP 响应为过期错误。证据支持页面身份拒绝和随后确认期限过早耗尽的组合故障；历史 HTTP 码未被原始日志保存。

## 修复及边界

- 保留原投递身份校验；恢复页面必须持有完整绑定一致、已完成且 document / epoch 相同的 Extension Completion 回执。只 claim lease 不足以授权。
- Review Result 增加服务端写入的可选 `completed_at`；首次成功采集时固定，后续幂等读取和重启不延长期限。原 `created_at`、Result ID 和旧记录语义保留。
- 仍使用有限的 120 秒确认窗口；仍校验实际工具调用 ID、用户锚点、correlation key、裁决摘要、活动 Loop、Workspace 和 Execution。未添加文本回退或新调度器。
- 复用原有 Extension 持久 outbox 和重试。恢复回执未就绪时保持拒绝，随后同一凭据可以重试；永久身份冲突仍拒绝。
- Bridge 在现有脱敏 transport trace 中记录 `http_status` 和 `error_code`，不记录异常消息、凭据正文或认证信息。已覆盖 HTTP 409 / 503 后重试和无私密异常文本泄漏。

## 原记录保全

修复前读取的 SHA-256：

- Verdict JSON：`f1fddd558a01e6aaba63bedddbfeba6e40cf6bd242efec281880d4bfb8a86d93`
- Result JSON：`a93198dff735cf1eebe62b71b5e9b525a071b56ce5af45dbbfbfac7d464746bb`

## 验证

核心测试覆盖页面恢复（运行中及重启后）、仅租约拒绝、错误 Workspace / Task / Delivery / 用户锚点拒绝、重复凭据不重复 Actuation、先 TIMEOUT 后 COMPLETED 的完整确认窗口、旧记录期限兼容及 Bridge 409 / 503 重试。

相关回归共 211 项已通过（8 个测试文件，复用相同生产代码状态的结果；最后补充的两项边界测试单独通过）。首次并行运行中 AutoIteration 两项旧用例超过默认 5 秒并发生清理竞争；仅重跑这两项，单 Worker 下分别约 651/549 毫秒通过，未放宽测试超时或断言。`npm run typecheck`、`npm run build` 已通过。新增边界测试验证成功 Completion 后 119,999 毫秒接受、120,000 毫秒拒绝，工具提交和独立证据使用同一期限。

部署通过现有生产启动脚本完成，MCP 返回 HTTP 200。第一次启动引用了旧启动器自动清理的临时配置，随后通过 `ConfigManager.runtime_config()` 重新生成配置并成功启动；未修改用户认证配置或 Connector。

真实网页验收准备：

- 首次 interactive 测试 Goal `goal-1e030610-9d46-4130-9932-66e3d7fd242a` 因隔离目录未列入 Desktop 项目而在 project_resolution 失败，未进入 Review。
- 随后曾尝试 batch Goal `goal-c5a18dee-11f7-4a91-83e6-9ced6c899cd5`。用户要求仅用 Desktop 后已停止其进程及子进程，持久状态为 failed；两个 recovery-probe 文件均未生成。此尝试不计为验收。
- 用户已将隔离目录加入 Desktop，项目名 E2E，项目 ID `d2cb7da8-8a6b-4703-8c48-d552bec92206`；之后仅使用 interactive 通道。

真实 Desktop E2E 最终通过：

| 标识 | 值 |
| --- | --- |
| Goal | `goal-aafd33e8-ed8c-4343-823f-23e32fa71fd4`，completed |
| Task | `task-ce93d5e7-2742-461c-8a19-340cef7aa8e9` |
| Desktop Thread | `01a162b1-40b2-7671-9287-bb8b13216695`，两轮使用同一 Thread |
| 第一轮 Execution | `goal-execution-2e7d4e75029ca16199c6a37e133241e4`，passed，11 项测试通过 |
| 第一轮 Review | `auto-review-bd666439926f165baa99558c2f5d0df3`，ITERATE，confirmed_at=16:21:26.679 |
| 第二轮 Execution | `auto-execution-6574d8449401f96c8ec1df5c0e669e3a`，passed，11 项测试通过 |
| 第二轮 Review | `auto-review-a09853f7b7699fc2269591728fb524e1`，APPROVE，confirmed_at=16:22:52.030 |
| 最终结果 | iteration=2，completed；该 Task 恰好两条 Actuation，无第三次派发 |

第一轮 Review 投递后主动重载真实浏览器页面。投递 document 为 `6AAF2E154B829CF3DCDDA22E6F274F14` / epoch 3；实际 Fiber 凭据和 Completion 来自 `60A361DF39A5823B4B8548E4494FACC7` / epoch 2。新日志记录了 16:21:15–16:21:26 的 HTTP 409 / `VERDICT_EVIDENCE_IDENTITY_INVALID`：当时只有采集租约，不能放行。Completion 回执于 16:21:26.669 持久化，原有重试随后于 16:21:26.679 确认同一裁决并自动派发第二轮，证明没有为恢复页面取消身份保护。

原计划在第一轮待确认阶段重启，但执行前检查发现已推进到第二轮 Execution，故没有中断执行。实际重启发生于第二轮 `review_completion` 阶段：终止本次 Runtime PID 37824，现有 Supervisor 自动恢复为 PID 5108；日志显示 16:22:21.515 restart triggered、16:22:25.518 restart succeeded。恢复后先观察到真实 Extension evidence、尚无 MCP submission，随后原网页调用完成并匹配该 evidence，写入 APPROVE 的 `confirmed_at`，再等待 Completion 后完成 Goal。

验收结束，本机和公网 MCP 均返回 HTTP 200；原事故的 Verdict / Result SHA-256 与上文完全一致，原 Goal 仍为 human_required。

### 验证范围与限制

- 真实验证：页面重载产生新身份、HTTP 409 安全拒绝到成功重试、真实 ITERATE 自动第二轮、Review 期间 Runtime 重启及 Supervisor 恢复、evidence 先于工具提交、APPROVE 完成、防重复派发。
- 测试验证：HTTP 503 后恢复、Worker outbox 重启与 ACK 丢失、页面 A→B→A 导航、错误身份永久拒绝、先 TIMEOUT 后成功采集、确认期限精确边界及旧记录兼容。未将这些全部称为真实网页故障注入。
- ChatGPT 网页两轮正文显示“无法加载此回复”，现有 Completion 采集器将该文字保存为正文。独立工具中的完整 ITERATE / APPROVE、实际源码读取结果和可信 `confirmed_at` 均已核对，结构化闭环不依赖这段正文；网页显示/占位文字采集问题未在本次范围内修复，不能宣称正文呈现正常。
- 未运行无关全量测试，未提交或推送；长期稳定性需要后续业务使用观察，不把单次 E2E 通过等同长期稳定性验收。

## 复杂度审查

按 no-stop-gpt Audit 检查实际 diff：保留新增完成时间字段，因为首次记录时间不能表达成功采集时间；保留恢复回执分支，因为事故证明投递和采集可合法发生在不同页面。复用现有 Completion 服务和 outbox，无新依赖、缓存、调度器或持久队列。新诊断字段服务于本次缺失的 HTTP 错误证据。
