# ChatGPT Connector Workflow

Connector 管理属于 Control Plane，不得注册成 MCP tool。每次连接或 LRM/E2E 前：

1. 运行 `npm run diagnose:chatgpt-connector -- --config <config>`，读取 JSON。`ok=false` 时先修复本地服务、Remote MCP 或 OAuth，不操作 ChatGPT；`oauth.reauthorization_required=true` 时不要信任旧全局 OAuth state，按后续 exact connector 探针结果重新授权或重建。
2. 使用 ChatGPT Browser Use 打开 `pages.plugins`，只按完整、区分大小写的 `connector.name` 检查当前 workspace 的 connector；不得模糊匹配或操作其他 connector。
3. 即使 `action=none`，也要确认该 exact connector 实际存在且可用。若缺失，按 `create` 重建；若 OAuth 失效，重新授权并继续第 7 步。本地 `verified` 不能替代 ChatGPT 实际检查。
4. `create` 必须先检查 exact connector：
   - 不存在：打开 `pages.create_connector`，按下列字段创建。
   - 已存在：先用它调用 `workspace_info`。成功时直接执行第 8 步以 adopt，不重复创建；探针失败、旧 endpoint 或 OAuth 失效时，删除该 exact connector 后再重建。

   创建字段：
   - Name：`connector.name`
   - Description：`Securely connect ChatGPT to the current Local Review MCP workspace for review.`
   - Server URL：`connector.mcp_url`
   - Authentication：OAuth
5. `update`：在插件页删除 exact `connector.name`，再按第 4 步用同名和新 URL 重建。不要对旧 URL 点 Reconnect 或 Refresh。
6. 完成 Connect / Authorize。LRM 使用 single-owner auto-approval，不输入 pairing code。
7. 在 ChatGPT 对话中选择 exact connector，调用 `workspace_info`；必须确认 `workspace_id` 和 workspace name 都等于 diagnostic 输出，并读取返回的 `request_id`。
8. 只有第 7 步成功后，运行：

   `npm run confirm:chatgpt-connector -- --config <config> --request-id <workspace_info.request_id>`

9. 再运行 diagnostic；只有 `ok=true`、`status=verified`、`action=none` 才继续原任务或 E2E。

普通 timeout、页面仍在加载时继续检查，不立即转人工。仅在 ChatGPT login、2FA、CAPTCHA，或自动化无法处理的明确授权/确认页暂停：

```text
【需要人工操作】

请只执行：<一个最小动作>

完成后回复：已完成
```

用户完成后从当前 connector 步骤继续，不重新开始。
