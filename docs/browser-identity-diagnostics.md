# Browser identity evidence: persistent diagnostics

## 0.1.5：选择前结构摘要

扩展直接加载仓库 `extension` 下的文件，没有独立打包产物。安装目录一致不能
证明已注入页面的脚本与磁盘一致。新版 `fiber_scanned` 分别携带 `fiber_revision`、
`content_revision`、`background_revision` 和 worker 读取的 manifest `extension_version`。
本次版本均应为 `0.1.5`；缺失或 `unknown` 表示无法确认该层版本。版本标签用于
识别发布版本与混合加载，不是运行脚本的字节校验或身份证据。

保留 `snapshot_selection_reason`，新增以下只读摘要：

| 字段 | 含义 |
| --- | --- |
| `snapshot_path` | 当前路径：timeline / legacy / unknown |
| `candidate_turn_count` | DOM 分组后的候选逻辑 turn 数 |
| `searched_turn_count` | 选择器工具搜索阶段实际检查的 turn 数；不含单独的 anchor 探测 |
| `most_recent` | 当前 timeline 节点显式的布尔状态；legacy 或无法判断时为 unknown |
| `anchor_state` | stable / unstable / absent / unknown |
| `structured_tool_count` | 已知结构容器中可读取的 MCP item 或 legacy assistant tool request 数 |
| `recognized_submit_count` | 名称被现有解析器识别的 submit_goal 数；不保证参数或身份有效 |
| `excluded_tool_count` | 未被工具搜索访问的候选快照中结构化调用数 |
| `selection_reason` | 选择结果的细分原因，见下文 |

摘要最多观察最后 100 个候选 turn，共用 1000 个 section/item 的预算，不遍历任意
Fiber 对象字段。计数按读取的快照计算，不按调用 ID 去重。快照不可读、候选被截断
或预算耗尽时，全局工具计数为 `unknown`，不会据此宣称工具不存在。

`tool_absent` 表示完整观测范围内没有结构化调用；`tool_out_of_scope` 表示可读
submit_goal 候选位于未搜索快照，或全部可读工具调用都在范围外；它不宣称这些
调用属于当前 Goal。`tool_unsupported` 表示存在结构化调用但没有被选中，包括
其他工具名称、未支持的结构和更深层 reasoning group。`invalid_submit_arguments`
表示原选择器选中了 submit_goal 快照，但最新调用未提供有效 key。
`selected` 表示选中带有效 key 的工具快照，仍需原有 canonical identity、路由与
权限门禁才能发送 Evidence。边界、不可读、历史视口和异常继续单独标识。

这些摘要不参与选择和身份认证，不输出正文、完整参数、凭据或原始 Fiber。
`selection_reason` 等摘要变化沿现有限流立即记录；稳定状态仍最多每 30 秒一条。
`diagnostic.observed_at` 保留 Fiber 实际完成观测的时间，外层 `timestamp` 为日志
接收时间；旧脚本未提供有效观测时间时沿用 worker 时间，须结合版本字段判断。

下一次真实 E2E 前先加载新版后端 Schema，再重新加载扩展并刷新 ChatGPT 页面。
不刷新页面可能保留旧 Fiber/Content，单独重新加载扩展不足以确认版本一致。
检查 `fiber_scanned` 的四个版本字段和细分原因；再按 document/epoch/scan 与
`route_checked`、`worker_send_attempted`、Bridge/Connector 事件对照。无 key 的
摘要只能用于诊断上下文，不能用于绑定 Pending，也不改变 120 秒 TTL。

## Current conclusion (2026-09-17)

The successful hash `b6ecc5921bd445b4e5f3994b3da05b5300a811dbaf90987ee32bbc18d7d22919`
has Bridge reception at 05:01:20Z, pending acceptance at 05:01:22Z, resolution success,
and Goal start at 05:01:24Z. The failed hash
`bafc5a0a7e1df7fd3d3b19bbb0fc26995cfca34b02bed57339548235cc508ca1`
has only submit/pending/expiry events (05:10:39Z to 05:12:39Z), no transport events.
The first historical divergence inside the extension cannot be reconstructed from these logs.
Even `extension_evidence_created` was recorded at the Bridge, after authentication, not locally
at creation. Its absence does not distinguish no send from pre-handler transport/auth failure.
The same-model `WEB:` -> `serverId$()` fix remains unchanged. No second root cause is claimed.

## One normal retest, no DevTools

1. Restart the launcher to load the rebuilt backend, reload the extension, **refresh the ChatGPT page**
   (reloading the extension alone does not replace scripts already injected into the page).
2. Make one normal `submit_goal` call with a fresh correlation key; retain its key and UTC time.
3. Read `C:\Users\shaoy\AppData\Local\LocalReviewMCP\control-plane\evidence-transport-trace.jsonl`.
   New rows have `event=browser_identity_diagnostic`, with details under `diagnostic`.
   Read `identity-trace.jsonl` and `pending-goal-submissions.json` in the same directory for the outcome.

Filter by SHA-256 of the exact correlation key. Also inspect the surrounding document/epoch/time
observations: before a key can be extracted, `correlation_key_hash` is empty; those rows cannot be
attributed definitively to a Goal. They must never be used to bind a pending Goal.

The read-only `get_evidence_transport_trace` result now includes the same
allowlisted `diagnostic` object for `browser_identity_diagnostic` rows, so the
scan branch can be inspected without reading the local JSONL directly.

Omit `correlation_key` (`{}` or `{ "limit": 200 }`) to read recent browser diagnostics,
including rows without a key. The default is the newest 100 rows; `limit` accepts 1–200.
With a key, exact hash filtering and the default 10,000-row cap remain unchanged.
Uncorrelated observations are troubleshooting context only, never proof of Goal ownership.
`fiber_scanned` is emitted before identity resolution and registration, including timeout,
missing identity and navigation rejection. Current submit_goal evidence can use its own
validated Fiber identity despite unreadable or unrelated history; current Fiber identity conflicts and route
mismatches still reject it. Since extension 0.1.4, Delivery uses the latest active
timeline's validated Fiber identity; the legacy section adapter retains its cross-node gate.

## 2026-10-09 investigation

The open failing conversation exposed three historical submit_goal calls as structured
`mcp-tool-call` entries with `Local MCP Connector__link_<id>/submit_goal`, matching
`invocation.server/tool`, and object arguments containing a direct correlation_key.
These match the existing adapter. This observation does not support the earlier hypothesis
that the page exposes only functions.exec text. No JavaScript-text key parser was added.
During 23:13–23:15Z on October 8 (07:13–07:15 Beijing time on October 9), diagnostics for
the same conversation hash reported a reply and a current turn, but no selected Fiber root
or message snapshot. Those uncorrelated rows narrow the failure to snapshot selection;
they cannot uniquely identify the historical failing branch or prove an end-to-end fix.

Fields: `observed_at` (worker observation time), outer `timestamp` (local receipt),
`document_id_hash` (browser sender document), `conversation_id_hash` (sender route observation only),
`navigation_epoch`, `scan_id` (content scan counter; background stages use 0), `stage`, `flags`,
`assistant_tool_calls_found`, `fiber_evidence_count`. Group content scans by document/epoch/scan_id.
State changes emit immediately, unchanged stage snapshots at most once every 30 seconds,
so missing stages within one scan alone do not prove loss; consult the preceding snapshot too.

`snapshot_selection_reason` distinguishes `selected`, `no_current_turn`,
`historical_viewport`, `snapshot_unreadable`, `user_conflict`, `user_boundary`,
`no_submit_goal`, and `scan_exception`. `fiber_root_detected=false` means no tool
snapshot was selected, not necessarily that the DOM has no React Fiber. In an idle
conversation, `no_submit_goal` is expected; attribute a failure only within the
actual submit_goal window for the matching document and navigation epoch.

## Review completion references

The October 9 typecheck execution passed, but its ReviewResult held only a
`::chatgpt-content-reference` marker, resulting in `VERDICT_BLOCK_MISSING`.
The timeline completion adapter now resolves a whole-body reference only when the
terminal message id, finished source reference, and exactly one rendered
`data-dil-source-message-id` container with the matching copy-reference index agree
inside the already validated user turn. The captured content is rendered plain text;
direct string answers retain their original format. Missing, ambiguous, unfinished,
mixed references or oversized content are not submitted as a completed result.
No DIL code is executed and no verdict validation is bypassed.

After rebuilding, restart the backend, reload the extension, and refresh the ChatGPT
page. If a tool schema changes, use the Connector settings page's Refresh tools action;
browser page reload alone does not update the registered Connector schema.

Extension version 0.1.1 validation (2026-10-09): 248 targeted tests, TypeScript
typecheck and build passed. Offline replay of the original failing Review's exact
reference/DOM structure captured 1,143 characters and parsed APPROVE. A fresh real
submission in the original long conversation started in 289 ms at 09:03 Beijing
time, passed typecheck, stored a 1,260-character Review with a complete verdict and
no reference marker, and reached Goal completed at 09:04:20.919. The original failed
Goal was preserved. This validates the reference-body fix and this submission;
it does not retrospectively establish the original Pending timeout branch.

## Fresh-chat timeout reproduced; extension 0.1.2

At 09:32:20 Beijing time on October 9, a valid new-chat submission created Pending
and expired at 09:34:20 without identity evidence. Its correlated scan reported
`snapshot_selection_reason=selected`, key found, and `conversation_unreadable=true`.
The live Fiber chain retained `local-chatgpt:<UUID v4>` in entry/flat conversationId
fields while higher ancestors already supplied the canonical server conversationId.
The resolver rejected the colon in the provisional id before reaching those ancestors.

Version 0.1.2 treats only that observed local-id format as provisional, never as
identity evidence. It still requires a canonical id on the same Fiber ancestor chain;
local-only chains, malformed ids, inconsistent local ids, canonical conflicts and
route mismatches remain rejected. Offline replay of the actual failing chain produced
zero evidence before the fix and one canonical evidence item after it. The 212 targeted
tests and typecheck passed. A fresh blank-chat retest without reloading after submission
is required to confirm production recovery; reloading a persisted conversation alone
can remove the local-id state and does not exercise this cause.

## Retained previous-conversation DOM; extension 0.1.3

The 0.1.2 fresh-chat retest created Pending at 09:45:26.488 and expired at
09:47:26.504 Beijing time. Its scan selected the current key and readable canonical
identity, but generated no evidence. Live inspection found three timeline nodes:
two retained nodes belonged to the previous conversation, and the last node belonged
to the new conversation. The current-evidence cross-node conflict guard was too broad.

Version 0.1.3 removes that guard and leaves the existing Delivery consistency gate
unchanged. Current submit_goal evidence depends on its selected Fiber's consistent
canonical identity and must still pass the isolated-world exact route check. An
unrelated node's identity does not invalidate this independently proven tool call.
Replay of all three actual DOM/Fiber snapshots yields null Delivery identity but one
current evidence item matching the route. The 212 targeted tests and typecheck passed;
the new-chat production retest passed as recorded below. This correction also updates the earlier
historical-node test to check the actual ownership boundary instead of global agreement.

## Production validation: 0.1.3

On October 9, a fresh blank-chat submission was received at 10:08:20.288 Beijing
time and started at 10:08:20.501 (213 ms). Its correlated scan selected the current
tool, found canonical identity, generated evidence and passed the exact route and
authenticated transport gates. Live inspection confirmed the turn still contained
one provisional local-chatgpt id and canonical ancestors matching the new route.
Typecheck passed with exit code 0; the saved 1,068-character ReviewResult contained
a complete matching APPROVE verdict and no content-reference marker. The parser
accepted it and Goal reached completed at 10:09:46.075.

Goal: `goal-22381936-1315-4b2d-8a3c-4ac6e865cbfe`.
Execution: `goal-execution-5f6f41eca697836878149250522b8f73`.
Review result: `result-9624d33d-1767-42f7-8a41-5efd7479c151`.

The final extension changes passed 212 targeted tests and typecheck. Earlier
reference-body/diagnostic changes passed 248 targeted tests and build; repeated
tests are not counted as additional unique coverage. Real long-chat tests also
reached completed twice. This closes the reproduced fresh-chat identity and Review
body failures, but does not prove that every historical intermittent timeout had
the same cause. No timeout increase, URL-derived identity, verdict bypass or Git
commit/push was introduced. Original failed records remain available for comparison.

## 0.1.4：边界问题修复及本地验证（2026-10-09）

Delivery 与 Completion 的身份解析改为使用最后一个 timeline 节点：该节点必须
具有可读快照并明确标记 `isMostRecentTurn=true`，其完整 Fiber 祖先链中的 canonical
身份必须一致。旧会话的保留节点不会阻断当前活跃会话；当前节点不可读、身份冲突或
页面停在历史视图时，返回空身份，不回退到旧节点。URL 仍只用于 isolated-world
一致性检查，不作为身份证据。没有 timeline 的旧 section 格式继续使用原一致性检查。

引用判断收窄到完整的 `::chatgpt-content-reference{index="N" source_message_id="ID"}`
结构。普通正文提到标记名称不会被当作未解析引用；真正的引用仍要求整个正文是一个
占位符，并保留来源消息、完成状态、唯一 DOM、同一用户 turn 和大小限制。混合正文
中的完整占位符及还原正文中的残留占位符仍被拒绝。

新增回归检查在修改前分别复现两个失败点；修改后 5 个关联测试文件的 213 项测试和
TypeScript typecheck 通过。保存的真实三节点 DOM/Fiber 重放成功发送身份证据，
Delivery 与 Completion 各产生 2 次 claim，全部指向当前会话且 navigation epoch
保持 0，仅注册一次。真实 Review 结构加入标记说明文字后，直接正文和引用还原正文
均采集到完整的 1,181 字符，保留 APPROVE 判定；测试另行通过实际判定解析器验证。

轻量复杂度审查确认复用原快照和 canonical 身份解析器，没有新增持久状态、缓存、
重试、依赖或控制层接口；导航、文档授权及 Review 精确关联边界保留。
上述证据属于自动测试与离线重放；0.1.4 的真实提交验证记录见下节。
部署这次纯扩展修复时，重新加载扩展，确认版本为 0.1.4，再刷新 ChatGPT 页面。

## 0.1.4：两轮真实链路验证（2026-10-09）

重新加载扩展并刷新页面后，从页面执行上下文读取的 manifest 版本为 0.1.4，
身份采集器、Completion 采集器与 DOM 接口均已加载。两轮均由用户在 ChatGPT
页面发起真实 `submit_goal`，各使用一个全新 key、只提交一次且不自动重试。

| 场景 | correlation_key | Goal | ReviewResult | 结果 |
| --- | --- | --- | --- | --- |
| 刷新后的新会话 | `a30b81da-271c-486d-ba73-b52f29d6187c` | `goal-fc403910-b687-43cd-b5ba-609e72909e6c` | `result-4d6dc922-a334-4988-aff9-e7fd36b460a9` | 10:58:17 北京时间 completed；APPROVE；正文 1,137 字符 |
| 不刷新页面，保留旧会话 DOM 后切换新会话 | `6e7bbdc3-17c9-4760-9f40-73504aa74b82` | `goal-01fbb281-1afc-4cdb-b284-0234d7ed9f13` | `result-7d130800-43b4-4d8e-a51d-93997d9a2dea` | 11:04:19 北京时间 completed；APPROVE；正文 1,296 字符 |

原始 Execution JSONL 中，两轮各只有一个已完成的 `npm run typecheck` 命令，
实际退出码均为 0。Review 判定被实际控制器接受，两轮 Goal 均完成。
两份保存的 ReviewResult 均包含普通正文
“本次验证覆盖 ::chatgpt-content-reference 正文标记采集。”，未残留结构化占位符。
实时 Fiber 显示最终助手正文实际上使用结构化引用，因而这两轮覆盖了真实引用还原路径。

第二轮提交时，同一文档同时存在 2 个旧会话节点和 1 个新会话节点，分别解析到
`6ac857b3-de38-83ea-8e7f-a862e1e9d5a8` 与
`6ac85926-62fc-83ea-8b17-1a96b998fc18`。旧节点中仍有
`isMostRecentTurn=true`。当前会话的身份、路由及授权检查成功；Review Delivery
已 delivered，Completion lease 与回执关联当前会话，navigation epoch 均为 5。
完成后仍保留旧会话的 2 个节点及新会话的 2 个节点；原页面执行上下文和文档 ID
保持一致，因此成功不依赖整页刷新恢复。

结论：本次两处边界修复通过了真实场景验证。该结果不证明所有历史间歇超时均已消除。

## 0.1.4：主动恢复测试（2026-10-09）

新增执行的 8 个恢复相关测试文件共 125 项全部通过，覆盖服务恢复、执行结束证据、
过期 lease、重复 ACK、通知失败及终态稳定性；此前已通过的浏览器恢复测试结果继续保留。

真实会话切换测试使用 key `4de3ed9c-6681-41ec-b582-a45729cd8fd1`，Goal 为
`goal-714d098a-6a07-4abf-99d5-6a2cf56ad818`。执行仍为 running 时，将原标签页
`2122779247` 从目标会话 `6ac86169-5394-83e9-9c4e-3000fc929e60` 切换到另一会话，
随后确认浏览器中没有目标会话标签页。Review 排队后，扩展自动创建目标标签页
`2122779268`，无需人工重新打开或刷新。Delivery 收据关联目标会话及恢复后的新文档，
最终 ReviewResult 为 `result-b02e681a-7cef-48ca-b456-80a06aad915c`，APPROVE 被接受，
Goal 于北京时间 11:40:42 completed。

保存记录及原始 Execution JSONL 断言确认：同一 key 只提交一次，仅创建一个 Execution，
`npm run typecheck` 只运行一次且退出码为 0，仅一个实际 Delivery 和一个最终 ReviewResult。
关闭目标标签页验证记录如下；真实服务重启尚待人工操作。

关闭测试在同一会话中出现两条人工指令，分别使用 key
`0018dcb0-826d-4108-8ab6-436e725310f4` 和
`c3412c34-6710-44ad-8094-8e16e1859b44`，不属于同一 key 的自动重复提交。
第二份任务启动且 Execution 仍为 running 时，关闭唯一目标标签页 `2122779272`。
扩展自动创建新的目标标签页 `2122779276`，两份任务的 Review 均被采集并接受。

| key | Goal | 最终 ReviewResult | 北京时间完成 |
| --- | --- | --- | --- |
| `0018dcb0-826d-4108-8ab6-436e725310f4` | `goal-5c6df1da-b868-4361-ab4a-6f543f00f2f2` | `result-304adb57-9d38-40d7-8217-b2f81e2ca115` | 11:47:47 |
| `c3412c34-6710-44ad-8094-8e16e1859b44` | `goal-6595298a-424f-434d-9bd0-bb7c3454841f` | `result-e97c6819-74b3-404b-9338-3e6a135592af` | 11:48:28 |

两个 Goal 均 completed / APPROVE。逐 key 的保存记录和原始命令事件断言均为：
一次提交、一个 Execution、一次 typecheck（退出码 0）、一条成功投递消息及一份最终结果。
恢复期间有一次 `send control unavailable` 的失败投递记录，随后在现有恢复机制下成功，
没有产生重复的已确认发送。最终结果通过并不代表整个恢复过程没有瞬时失败。

服务重启前已确认没有 running Goal，保存上述三个恢复测试的结果和次数基线。
此时 MCP / Bridge 监听 12080 / 12081，进程 PID 为 38140；后续需核对实际进程重启、
旧终态与次数稳定，以及重启后的新任务链路。基线保存在仓库外测试附件中。

用户完成服务重启、扩展重新加载和页面刷新后，实际监听进程变为 PID 31488，
启动时间为北京时间 12:31:23，MCP / Bridge 仍监听 12080 / 12081。
对照重启前基线，三个恢复测试的 completed 状态、Execution ID、完成时间和最终
ReviewResult 均未改变，每个 key 仍只有一个 Execution、一条成功投递和一份最终结果，
当前没有 running Goal。页面身份及 Completion 采集器已加载，Connector 的只读
诊断调用成功，扩展文档注册及新诊断回传正常。重启后的新任务完整链路尚待最后一次提交。

### 重启后的新提交失败：状态文件原子替换 EPERM

最后一次真实提交 key 为 `f4968c2b-974d-4f87-8e10-76b0f76432ae`。
北京时间 12:38:15 的证据匹配成功，随后记录 `goal_start_failed`。
失败点是 `ActuationAuthorizationStore.persist()` 对 `controlled-actuations.json`
执行的原子 rename，系统返回 EPERM；不是浏览器身份缺失或请求等待超时。

Goal `goal-9a616740-009a-4459-97b2-874a6f32bfe7` 已保存并停在 human_required，
pending submission 为 indeterminate。授权记录存在，但启动预留记录不存在，
对应 `goal-execution-2a952ff77dd1c7cc253084d2b2fa8d0f` 没有 Execution 文件或日志，
没有启动 Codex。原失败记录保留，未重提、未修改状态，也未手动恢复任务。

在仓库外隔离目录调用实际编译后的 `ActuationAuthorizationStore.persist()`，
由 PowerShell 的读取句柄以 `FileShare.ReadWrite` 打开目标文件，不允许删除共享，
稳定复现相同 EPERM。失败时旧文件保留、临时文件清理；释放句柄后同一方法保存成功。
这验证了文件占用故障机制，不能据此认定现场的具体占用进程；现场未采集句柄跟踪。

Execution、Session 及 Event 持久化已有 Windows 瞬时错误的有界等待策略，
ControlledActuation 的原子替换目前直接失败，缺少相应处理。后续修复应仅处理文件保存，
保留原子替换、持久化先于启动及失败保护；不得以自动重新提交 Goal 代替。
修复前结论：旧任务重启稳定性通过，重启后的新任务启动未通过。该失败记录保持原样。

### EPERM 修复与验证（2026-10-09）

`ActuationAuthorizationStore.persist()` 现在只对 Windows rename 的 EPERM / EACCES /
EBUSY 进行有界再次尝试，沿用 EventStore 的 10、20、40、80、160 毫秒等待序列，
最多尝试 6 次，累计等待预算 310 毫秒（不含 I/O 及调度耗时）。临时文件只写一次，
重试发布同一份快照；原子替换成功后不再进入该重试。其他错误与其他平台立即返回错误，
持续占用超过次数仍保留原错误并清理临时文件。内存状态更新、授权消费和执行启动仍等待
持久化完成；没有增加 Goal / Execution 的自动重试或启动恢复。

新增 7 项回归检查在修复前复现短暂失败，修复后与 ControlledActuation、GoalOrchestration、
GoalPreflight 相关的 51 项测试全部通过，TypeScript typecheck 和 build 通过。
使用真实 PowerShell `FileShare.ReadWrite` 读取句柄及编译后的公共 Store API 验证：
占用 80 毫秒期间旧文件保持不变、预留未提前完成，释放后成功生成一个预留，重复请求返回
existing；持续占用时仍 EPERM，授权保持 authorized、无启动预留、旧文件保持不变、临时文件清理。
真实文件锁验证脚本及数据均位于仓库外附件目录，没有操作生产状态文件。

轻量复杂度审查确认本次仅增加文件发布边界的等待，没有新增配置、依赖、持久状态、
抽象层或执行重试；仍遵守持久化先于启动。现场具体占用进程未被追溯证明。
原失败 key 的 indeterminate 及 Goal 的 human_required 状态、时间和 Execution ID 未改变。
已构建修复；当时的旧服务进程 PID 31488 需重启加载，真实验收结果见下节。
扩展代码未变，扩展版本继续为 0.1.4。

### EPERM 修复后的真实启动验收通过（2026-10-09）

用户重启服务后，监听进程为 PID 15428，启动时间为北京时间 12:51:07。
编译文件于 12:51:06 更新，并包含新的 rename 有界处理，进程启动晚于构建。
最后一次真实提交 key 为 `358a7690-7e05-45fc-8d62-1b3fe0c5d733`，
Goal `goal-a331ffcc-4cb0-44e4-9a3f-50a4bac83420` 成功启动，Execution 为
`goal-execution-3a856ca87168cb5b7452c7b4f2c14184`。

原始 Execution JSONL 确认只运行一次 `npm run typecheck`，实际退出码为 0。
Review 已成功投递、采集，保存 1,383 字符正文；
`result-4e3f2c39-b55d-412d-806c-939149dd751f` 的 APPROVE 判定经实际解析器及控制器接受，
Goal 于北京时间 12:53:50 completed。状态断言确认一个提交、一个 Execution、一次命令、
一条成功投递及一份最终 ReviewResult。浏览器可见结果与保存记录一致。

原失败 key 仍为 indeterminate，原 Goal 仍 human_required，原时间及 Execution ID 不变，
没有产生对应的执行目录，没有重新启动。现场占用进程仍未被证明；真实故障机制与修复行为
由前述隔离文件锁实验验证，本次真实提交证明部署后启动及 Review 链路正常。

另有两次从当前 Codex 发起的 Connector 只读 get_execution_status 查询报外部代理 HTTP
请求发送失败（ChatGPT backend-api/ps/mcp）。未据此修改本地服务或重提 Goal；本次验收
使用本地原始执行事件、持久化状态、判定解析器及浏览器可见 Review 核对。
该独立网络读取问题不纳入本次 EPERM 修复通过的结论。

| Last observation / fields | Meaning |
| --- | --- |
| `scan_started`, route present=false | Not on an exact supported conversation route |
| `scan_busy`, scan_in_flight=true repeatedly | Previous scan is still awaiting registration/Fiber/worker; preceding stage narrows the await |
| `document_registered`, register_document_ok=false | Document registration failed after Fiber scanning; no evidence is sent |
| `fiber_scanned`, fiber_reply_received=false | MAIN-world reply timed out or postMessage failed |
| `fiber_scanned`, evidence_generated=false | Fiber replied but no validated identity evidence was produced |
| fiber_root_detected=false / messages_found=false | Current turn root / message collection unavailable |
| assistant_tool_calls_found=0 | No recognized assistant tool request in selected current turn |
| submit_goal_found=false / correlation_key_found=false | No recognized valid submit_goal candidate / no strict direct key in this turn |
| correlation_key_found=true but current_key_found=false | Earlier candidate exists in this turn but current/latest tool does not yield a key; no historical fallback |
| current_key_found=true, conversation_id_found=false | Direct key found, trusted Fiber identity absent; inspect conflict/unreadable flags |
| navigation_epoch_unchanged=false | Navigation or URL changed while scanning; evidence fenced |
| `route_checked`, fiber_route_match=false | Route and trusted Fiber conversation disagree; evidence fenced |
| `deduplicated` | This exact epoch/conversation/key was previously acknowledged |
| `worker_send_attempted` without `background_received` | Runtime messaging boundary or diagnostic delivery loss; do not infer Fiber loss |
| `background_received`, sender_source_valid=false | Browser sender document/tab identity unavailable |
| `document_authorized`, document_authorized=false | Background document/epoch ownership gate rejected evidence |
| `bridge_send_attempted` | Background entered postEvidence (includes credential discovery before HTTP); not proof of HTTP reception |
| `bridge_send_finished`, bridge_reply_ok=false | Existing Bridge delivery returned failure (discovery/auth/network/HTTP); compare normal transport traces |
| `worker_send_finished`, worker_reply_ok=false | Content received a negative/no worker reply; preceding background stages narrow cause |
| Normal `bridge_evidence_received` | Evidence reached the authenticated Bridge identity handler; continue with identity trace |

## Safety and limits

Only allowlisted booleans, bounded counters, timestamps and SHA-256 hashes are stored.
No prompts, tool payloads, cookies, bearer tokens or full Fiber props enter diagnostics.
The endpoint uses existing origin/protocol/token checks and strict schema validation. It cannot
resolve identity, refresh presence, or change Goal Preflight. Diagnostics do not pair or discover
Bridge endpoints: they use existing credentials independently of business delivery.

Worker observations first enter `chrome.storage.local.identityDiagnosticOutbox` (newest 1000 rows).
Failed diagnostic HTTP delivery retains them; a later sample retries, including after worker restart.
After Bridge connectivity/credentials recover they appear in the same local JSONL automatically.
Loss of an ACK can duplicate rows; compare stage/document/epoch/scan/time, not row count.
An outage longer than the ring capacity can evict older rows. The JSONL uses existing append-only
trace retention; this patch adds no rotation or new logging subsystem.

If the content runtime channel is completely dead, or storage fails / the worker terminates before
its asynchronous observation is persisted, that boundary cannot report through itself. Absence of
all telemetry is an instrumentation/channel gap, not evidence that Fiber found no root. The next
test requires a working heartbeat to distinguish individual upstream branches. A normal test that
succeeds also cannot prove the intermittent fault is resolved.
