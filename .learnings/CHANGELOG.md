# Changelog

<!-- SCHEMA: {"ts":"ISO-8601","action":"add|promote|extract|resolve","type":"learning|error|feature","id":"entry ID","summary":"≤100字","target":"晋升目标(可选)"} -->

```jsonl
{"ts":"2026-09-05T21:30:00+08:00","action":"add","type":"error","id":"ERR-20260905-002","summary":"Browser Worker 默认 Profile 目录受 sandbox 权限限制；提升目录访问后测试通过"}
{"ts":"2026-09-05T21:30:00+08:00","action":"add","type":"learning","id":"LRN-20260905-001","summary":"Navigator 用 mock Page 验证导航，但保留 Profile Manager 生命周期边界"}
{"ts":"2026-09-05T11:24:00+08:00","action":"add","type":"error","id":"ERR-20260905-001","summary":"当前 checkout 的 Git smoke test 受 sandbox 用户与仓库所有者不一致的 safe.directory 检查阻断"}
{"ts":"2026-09-04T18:13:47+08:00","action":"add","type":"error","id":"ERR-20260904-002","summary":"Vitest 不支持 Jest 的 --runInBand；按 package.json 脚本执行 npm test"}
{"ts":"2026-09-04T18:13:47+08:00","action":"add","type":"learning","id":"LRN-20260904-001","summary":"Task Context 独立存储并保持与 Workspace、MCP、C2C Session 解耦"}
{"ts":"2026-09-04T14:18:08+08:00","action":"add","type":"error","id":"ERR-20260904-001","summary":"Launcher 项目 venv 基解释器存在但执行被拒绝；用同一非 bundled 解释器提升权限重试"}
{"ts":"2026-09-01T16:35:00+08:00","action":"add","type":"error","id":"ERR-20260901-001","summary":"PowerShell 参数变量大小写不敏感；区分 configDocument 并避免给 GET 设置空 body"}
{"ts":"2026-09-01T21:40:00+08:00","action":"add","type":"error","id":"ERR-20260901-002","summary":"Windows agent-reach doctor 不支持 --json；Unicode 输出需显式 UTF-8"}
{"ts":"2026-09-01T21:41:00+08:00","action":"add","type":"learning","id":"LRN-20260901-001","summary":"MCP OAuth discovery 需 path-specific metadata 与 401 resource_metadata 指针"}
{"ts":"2026-09-01T22:50:00+08:00","action":"add","type":"learning","id":"LRN-20260901-002","summary":"DCR 可兼容额外 grant 声明，但注册与执行能力仍归一化为 authorization_code + PKCE"}
{"ts":"2026-09-07T18:31:00+08:00","action":"add","type":"error","id":"ERR-20260907-001","summary":"npm 诊断脚本名带冒号，误用不带冒号名称会在执行前返回 Missing script"}
{"ts":"2026-09-07T18:34:00+08:00","action":"add","type":"learning","id":"LRN-20260907-001","summary":"Bridge /hello 不带 protocol 自定义 header，避免 CORS preflight；POST 再发送 protocol header"}
{"ts":"2026-09-07T18:41:00+08:00","action":"add","type":"error","id":"ERR-20260907-002","summary":"Windows PowerShell 下 rg 路径 glob 不展开；改用 rg -g '*.js' 目录过滤"}
{"ts":"2026-09-07T18:45:00+08:00","action":"add","type":"learning","id":"LRN-20260907-002","summary":"真实 ChatGPT Fiber 需沿 bounded return 链读取 turn.messages，conversation.id 位于同级 props；identity 冲突时 fail closed"}
{"ts":"2026-09-07T18:47:00+08:00","action":"add","type":"error","id":"ERR-20260907-003","summary":"computer-use 参考文档路径不存在；读取 skill 资源前应先确认目录结构"}
{"ts":"2026-09-08T09:49:00+08:00","action":"add","type":"learning","id":"LRN-20260908-001","summary":"exact waiter 测试需在目标 evidence 前断言 unrelated evidence 未唤醒，避免最终 lookup 掩盖假阳性"}
```
