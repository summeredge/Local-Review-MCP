# Review Verdict 缺失与自动补充

## 2026-10-20 故障证据

- Goal：`goal-e0eee931-30f7-4956-8d15-d9b9b73cf7a4`
- Task：`task-c8d03572-261c-4959-b2bf-4e692a991ab2`
- Execution：`goal-execution-bd11decc331878f0236414de90ff6669`，原始状态为 `passed`。
- Review Result：`result-079dd40b-dc59-43d7-9edf-ccc9c9a37c17`，原始状态为 `COMPLETED`。
- Review Request：`auto-review-f4540eac749663b2c5ea96c7f83f589f`。
- 扩展采集回执：`f82585b6-218f-45b4-b286-4ff4fda2052a`，assistant message 为 `8988b3a4-b88a-4f2d-a99f-4b23319a62a5`。

原始记录位于 `%LOCALAPPDATA%\LocalReviewMCP`。采集回执的 `content` 与 Review Result 的 `content` 逐字一致，均以“最终决定：APPROVE。”结束，没有完整协议块。

核对原对话中同一 message ID 的 DIL 渲染容器及其 `data-chatgpt-copy-reference="0"` 正文，同样没有 Verdict。`extension/fiber.js` 对这种回复将严格绑定的 content reference 解析为该容器的 `innerText`，普通文本则直接采集。此处存在渲染到文本的转换，但没有发现它遗漏公开正文的证据。后续回复声称此前已输出合法 JSON，与实际正文和持久化证据不一致，不能作为通过依据。

故障定位为公开 Review 输出没有履行 Verdict 协议；保存过程没有改变内容，解析器正确拒绝缺失块。未获取模型生成前的内部 token 或历史 DIL 源，因此不声称能够证明内部生成或渲染前从未存在该块。

## 首次 Verdict 协议兼容改进

本次重新读取上述原始 Result 与 Completion Receipt：两者内容逐字一致，长度均为 1162 个字符，均没有 XML 开始或结束标签。内容 SHA256 为 `2c7fe9abe2df4a2b7a53738621d3f0d4748b855d773d47004d7f5433728eff59`。没有取得历史 DIL 源，未重新验证历史浏览器正文；不能把渲染丢失或采集过早认定为这次故障的根因。

代码确认 DIL 分支将严格绑定的渲染容器 `innerText` 作为公开内容，而普通消息直接读取正文。XML 风格边界需经过渲染再转文本，存在表示兼容风险，因此新 Review 及补交请求改用独立行的纯文本边界 `LRM_REVIEW_VERDICT_BEGIN` / `LRM_REVIEW_VERDICT_END`。解析器继续兼容旧 XML 边界，要求全篇唯一、配对、顺序正确且位于末尾，JSON、Schema v1、请求身份及 iteration 规则保持不变。混用或重复两种边界均拒绝。

诊断区分边界完全缺失（`VERDICT_BLOCK_MISSING`）、边界不完整或错配（`VERDICT_BLOCK_INCOMPLETE`），以及完整块内 JSON / Schema / 身份错误。仅凭缺失或不完整的公开文本，无法进一步区分模型未生成和浏览器未完整采集，错误不能作为任一原因的证明。不完整块不再被归入完全缺失或触发缺失补交。

没有确认采集时序故障，因此保持现有终态、消息及会话身份校验，不新增重读、缓存或计时状态。没有新增完整审查正文日志。Review Result 不可覆盖、最多一次缺失补交及状态恢复规则保持不变。

## 处理策略

正常提示要求直接回复审查正文，再输出唯一的末尾 Schema v1 Verdict，避免另建 Page/canvas/视觉产物。

有效 Verdict 直接使用。仅首次 `VERDICT_BLOCK_MISSING` 自动补充一次：

1. 在 Loop 的 `verdict_recovery` 保存原 Result ID 与原始解析错误，原 Result 不覆盖。
2. 使用确定性的独立 Review Request、Routing、Delivery ID，复用现有投递、完成采集、超时恢复和 Verdict 校验。Workspace、Task、Execution、对话及业务迭代次数保持不变。
3. 补充请求携带完整原 Review 文本和原 Result / Request 标识，仅请模型确认 Verdict；证据不足应返回 `HUMAN_REQUIRED`，不能由程序从自然语言 APPROVE 构造结果。
4. 补充 Verdict 必须严格匹配补充请求 ID；原请求 ID 仅作证据关联。原请求和原始结果仍保留，避免破坏一请求一结果及完成记录不可覆盖的约束。
5. 补充完成后按原有 APPROVE / ITERATE / HUMAN_REQUIRED 规则处理；只有合法 ITERATE 才能触发后续业务迭代。补充本身不启动 Execution。仍缺失或协议无效时才进入 `human_required`。

补充流程沿用既有传输预算及消息大小限制，传输失败不推断审核通过。重启使用同一补充请求和持久化断点，不重复投递已完成的消息。已有终止 Goal 保持终止，不自动回填或重启。诊断分别呈现 Execution 状态、Review 内容完成、Verdict 协议错误与 Goal 的 `human_required`。
