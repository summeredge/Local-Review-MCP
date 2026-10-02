# submit_goal 完成后 Review Delivery 修复

## 运行证据与根因

检查时间：2026-10-02，所有下述时间均为北京时间。读取的是当前生产持久化状态，未改写历史 Goal 或投递记录。

| 记录 | 第一次 | 第二次 |
| --- | --- | --- |
| Goal | `goal-46df1f1f-193a-4ff9-a006-1d7c89757d09` | `goal-a57c6229-7968-4100-9e04-53a9c628cab4` |
| Execution | `goal-execution-7a202b5a4b2daa0eba35dfee031fb8d1` | `goal-execution-41c84ac332862e3db5c420767cdc0981` |
| Execution 结果 | passed，17:05:13 | passed，17:52:59 |
| Review Delivery | `auto-delivery-aeab42bc7161ee3f139ccc9f1b81e66a` | `auto-delivery-d97a1e76c4536e5169ea0c06a4567217` |
| 投递尝试 | 10 次 | 10 次 |
| 最终结果 | human_required，17:24:44 | human_required，18:12:30 |
| 错误 | TARGET_CONVERSATION_EXTENSION_NOT_READY | TARGET_CONVERSATION_EXTENSION_NOT_READY |

两次 Review Request、Routing、Review Delivery 已建立，目标都为同一 canonical conversation。
Identity trace 有 evidence_match_success 和 goal_started；不是 submit_goal 失败，也不是 Desktop Execution 未完成。
第二次先前长时间 running 对应投递等待和重试；本次读取时已耗尽预算并进入 human_required。

已确认的根因是身份链路断开：Fiber 通过 conversation 模型及 serverId$() 解析 canonical identity，
但 content 的 pollDelivery/pollCompletion 重新解析 location.href，background 的 document 授权、claim、
submit-started 和 ACK 又重新解析 sender.url。SPA 中这些 URL 来源并不保证同步，Fiber 解析成功
不会更新 Delivery 身份。生产 trace 同一 scan 中出现 content 的 route_conversation_present=true，
background conversation_id_hash 为空，以及 Fiber evidence 存在但 fiber_route_match=false，直接证明
身份来源存在不一致。URL 缺少 ID 时，旧 pollDelivery 直接返回；worker URL 缺少 ID/不同步时，
即使 content 发出 claim，也被 wrong_conversation 拒绝。没有有效 claim，Web submit 和 ACK 都不会发生。

恢复机制的代码也存在可复现断点：

1. recoverConversations 仅按 URL/pendingUrl 找 tab，除了 discarded 外直接复用，未探测 content 是否存在、
   是否完成 document 注册、是否具备正确 Fiber 模型。旧 content 或未注册 document 可永久阻塞该 tab。
2. recoveryTabs 只有内存状态，worker 重启后的 auth/404 回调可能没有目标映射。HTTP 回调原先甚至在 load
   前读取空映射，因此不能把明确失败传回 backend。
3. backend recoveryTargets 只包含 queued；浏览器/worker 在领取后、提交前中断并超过 lease 时，
   command 仍为 leased，无法通过 target discovery 找回。
4. recovery 查询、后台异常被静默吞掉，无法区分无目标与 recovery endpoint/worker 失败。

已核对生产 Runtime 构建和启动时间、Bridge wiring，以及 Edge 默认 profile 的扩展安装路径和授权：
扩展指向本仓库 extension，已有 alarms/storage/tabs/webRequest 权限。没有权限缺失的证据。
历史记录没有每次 recovery alarm/HTTP discovery 的独立日志，因此无法断言两次历史任务中每一次
worker recovery 是否执行、是否跑着旧内存脚本；不能把这项取证限制写成已确认的版本故障。
已确认的是两次都没有产生成功投递回执，最终以目标 Extension 未就绪结束，上述断点已用生产脚本复现。

## 本轮修改文件

进入任务时已有多处未提交修改；以下是本轮实际编辑的文件，保留其它已有改动。

| 文件 | 本轮修改 |
| --- | --- |
| extension/fiber.js | 从渲染的 conversation 模型独立返回 canonical identity，复用已有解析器；无需当前 tool turn；未知/冲突模型 fail closed |
| extension/content.js | Evidence、Delivery、Completion 共用当前 Fiber identity；claim 与 submit 前重新验证；身份变化提升 epoch；增加 delivery_probe；领取前即锁定并发 polling |
| extension/background.js | 使用 content 验证的 canonical identity，并以当前 tab URL 交叉检查；实际探测 document；无响应目标 reload；持久化恢复目标和 reload 时间；启动/失败回调恢复映射；输出 recovery warning |
| src/control-plane/extension-delivery.ts | discovery 包含过期 leased command，使未提交 lease 可经现有 claim 流程恢复 |
| tests/extension-conversation-recovery.test.ts | 真实 Fiber/content/background 脚本和真实 HTTP Bridge 的恢复闭环回归，22 个场景 |
| tests/extension-identity.test.ts | 无当前 submit_goal 的 canonical identity、WEB server ID、未知/冲突模型；更新身份契约断言 |
| tests/extension-delivery.test.ts | polling harness 使用 canonical Fiber reply |
| docs/reliable-extension-delivery.md | 更新身份、恢复和重启语义 |
| docs/review-delivery-submit-goal-fix.md | 本报告 |

未新增 MCP 写文件、shell 或 Git 控制能力；修改仍位于 Control Plane。

## 修复后的状态流

```text
Execution passed
  → Review Request（持久化）
  → Routing（原 Goal 的 canonical conversation）
  → Review Delivery pending/delivering（稳定 logical delivery ID）
  → Broker 持久化 Extension command queued
  → readiness：同一 conversation 的已验证 claim，不能用全局 Extension presence 替代
  → MV3 启动 / claim 流量 / recovery alarm
      → 优先处理过期 submitting 和 durable ACK outbox
      → authenticated recovery-targets（queued 或过期 leased）
      → 探测 live content document 与 Fiber canonical identity
      → 复用正确 document / reload 无响应目标 / create 缺失目标
  → 恢复页面加载 MAIN Fiber helper 与 isolated content
  → register_document（Chrome documentId + navigation epoch）
  → Fiber 校验当前 conversation，具体 URL 存在时必须一致
  → delivery_claim（同一 canonical conversation + client/document/epoch owner）
  → leased（既有持久化 lease）
  → 插入 exact prompt
  → delivery_submit_started（先持久化 submitting）
  → 再次验证 Fiber identity 与 navigation fence
  → Web submit
  → 观察 exact user message 的稳定 message_id
  → sent ACK（先持久化 outbox，再 POST Bridge）
  → Extension command delivered / Review Delivery delivered
  → Review Completion → verdict → Loop/Goal 后续决策
```

导航、未知模型、身份冲突、auth、not-found 都不能领取或发送到其它 conversation。
ACK 丢失但 outbox 已持久化时先重放 ACK；已有 delivered receipt 始终优先于 readiness。
submitting 后结果不明保持 ambiguous，禁止自动再次点击。只有明确 not_sent 才可按既有 retry 规则重新尝试。
过期未提交 lease 复用原 physical delivery ID 和现有 owner fencing；同 logical ID/message 的 dedupe 不变。
未领取 command 超时仍按原规则安全退休，logical Review Delivery 保留，重试预算/耗尽规则不变。

## 验收与验证

| 用户场景 | 自动化验证 |
| --- | --- |
| 原对话保持打开 | 现有 tab 完成 claim → submit → sent ACK，不新建 tab，发送一次 |
| 执行时导航到其它对话 | 原 document 的新 claim 更新 conversation presence；原目标变为无 claimant；创建正确目标 tab，原页面零发送，恢复页一次发送 |
| 其它页面/真实空首页 | 空或其它 canonical 模型不能领取目标；Extension 在线但目标 readiness=false；恢复正确目标后投递 |
| URL 无 ID / sender URL 陈旧 | 用实际 WEB:* + serverId$() Fiber 模型，经 content/worker/真实 Bridge 完整投递；缺少 /c 仍复用有效 document |
| recovery 后 document 闭环 | register_document、delivery_claim、submit_started、send、sent ACK、backend delivered 均有断言 |
| 浏览器/worker/Runtime 重启 | 持久化服务重载、pending tab 去重、过期未提交 lease 恢复、sent ACK 重放、submitting ambiguous 阻止重发 |
| navigation/auth/not-found | 401/403/404、登录跳转、tab create 失败、URL 不变但 Fiber 切换；worker 重启前后均 fail closed |

定向验证通过：Extension/Delivery/Identity/Completion、Broker、Bridge、AutoIteration、Review Request、Routing、
interactive Goal submission 和 static boundary 测试。最终 14 个测试文件通过 214 项，其中恢复测试文件 22 项。
npm run typecheck、npm run build、node --check（三个扩展脚本）和 git diff --check 通过。
没有运行无关的 Python/GUI/浏览器 Worker 全量测试。

自动化会执行真实生产脚本、真实本地 HTTP Bridge 和持久化状态；Chrome API、页面 DOM/提交回执由 harness 提供。
不是已登录 Edge 中的真实 interactive Goal 验收。当前常驻 Runtime 和已打开页面不会自动载入磁盘新代码：
需重启 Runtime、Reload Extension，并刷新已打开的 ChatGPT 页面，以使 MAIN/content/background 同时更新。
之后用新 interactive Goal 验证实际 Web Review 和最终 verdict；本次未复活已经 human_required 的历史 Goal，
也未向真实对话补发历史 Review，以免改变用户任务状态。
