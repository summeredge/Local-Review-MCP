# Changelog

<!-- SCHEMA: {"ts":"ISO-8601","action":"add|promote|extract|resolve","type":"learning|error|feature","id":"entry ID","summary":"≤100字","target":"晋升目标(可选)"} -->

```jsonl
{"ts":"2026-09-05T11:24:00+08:00","action":"add","type":"error","id":"ERR-20260905-001","summary":"当前 checkout 的 Git smoke test 受 sandbox 用户与仓库所有者不一致的 safe.directory 检查阻断"}
{"ts":"2026-09-04T18:13:47+08:00","action":"add","type":"error","id":"ERR-20260904-002","summary":"Vitest 不支持 Jest 的 --runInBand；按 package.json 脚本执行 npm test"}
{"ts":"2026-09-04T18:13:47+08:00","action":"add","type":"learning","id":"LRN-20260904-001","summary":"Task Context 独立存储并保持与 Workspace、MCP、C2C Session 解耦"}
{"ts":"2026-09-04T14:18:08+08:00","action":"add","type":"error","id":"ERR-20260904-001","summary":"Launcher 项目 venv 基解释器存在但执行被拒绝；用同一非 bundled 解释器提升权限重试"}
{"ts":"2026-09-01T16:35:00+08:00","action":"add","type":"error","id":"ERR-20260901-001","summary":"PowerShell 参数变量大小写不敏感；区分 configDocument 并避免给 GET 设置空 body"}
{"ts":"2026-09-01T21:40:00+08:00","action":"add","type":"error","id":"ERR-20260901-002","summary":"Windows agent-reach doctor 不支持 --json；Unicode 输出需显式 UTF-8"}
{"ts":"2026-09-01T21:41:00+08:00","action":"add","type":"learning","id":"LRN-20260901-001","summary":"MCP OAuth discovery 需 path-specific metadata 与 401 resource_metadata 指针"}
{"ts":"2026-09-01T22:50:00+08:00","action":"add","type":"learning","id":"LRN-20260901-002","summary":"DCR 可兼容额外 grant 声明，但注册与执行能力仍归一化为 authorization_code + PKCE"}
```
