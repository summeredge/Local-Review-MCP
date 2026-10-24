# ChatGPT Connector Workflow

Connector 管理属于 Control Plane，不得注册成 MCP tool。每次连接或 LRM/E2E 前：

1. 运行 `npm run diagnose:chatgpt-connector -- --config <config>`，读取 JSON。`ok=false` 时先修复本地服务、Remote MCP 或 OAuth，不操作 ChatGPT；`oauth.reauthorization_required=true` 时不要信任旧全局 OAuth state，按后续 exact connector 探针结果重新授权或重建。

   OAuth client 与 token 现在是 LRM 实例级状态：`<storageRoot>/oauth/clients.json`、`tokens.json` 由所有工作区共享，工作区访问权另存于 `oauth/workspace-grants.json`。启动时会把旧 `workspaces/ws-<id>/oauth/` 与旧全局 registry 合并到实例级文件，原 `client_id`、token 哈希、有效期与授权主体保持不变；源文件不删除、不覆盖，写入前保留备份。授权迁移只执行一次，完成后写入 `oauth/instance-migration.json`，因此显式撤销的工作区不会在下次启动时被自动恢复；诊断命令只读取并报告迁移状态，不会写入授权。同一 `client_id` 注册冲突或无法归属的 token 会标记 `reauthorization_required`，其余有效数据仍会保留。

   ChatGPT 连接本身不再绑定活动工作区。新增工作区后，在 Launcher 的“工作区注册表”中选择该工作区并点击“授权 ChatGPT”（或运行 `lrm workspace-access grant <workspace_id>`）；撤销使用“撤销授权”或 `lrm workspace-access revoke <workspace_id>`。授权变更对现有 Token 立即生效，无需重新 OAuth。`workspace_list` 只返回已授权工作区，未指定 `workspace_id` 时仅在默认工作区已授权时使用默认值。

   `ok=false` 时 `connector.reason` 直接标出失败层：`oauth_protected_resource_metadata_missing`、`oauth_protected_resource_metadata_unavailable`、`oauth_protected_resource_metadata_invalid`、`oauth_resource_mismatch`、`oauth_authorization_server_metadata_missing`、`oauth_authorization_server_metadata_unavailable`、`oauth_authorization_server_metadata_invalid`、`oauth_issuer_invalid`、`oauth_authorization_endpoint_missing`、`oauth_token_endpoint_missing`、`oauth_registration_not_supported`、`oauth_authorization_code_not_supported`、`oauth_refresh_token_not_supported`、`oauth_pkce_s256_not_supported`。
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

   若 diagnostic 显示 `action=create`，但 ChatGPT 中已存在并通过第 7 步 `workspace_info` 验证的 connector（例如 `Local MCP Connector`），不要创建第二个 connector：`action=create` 只表示本地 binding 还没有已验证的 endpoint，不代表 ChatGPT 平台侧不存在 connector。此时用 fresh `workspace_info` request_id 显式带上该 connector 的实际名称，把现有 connector 采纳进本地 binding：

   `npm run confirm:chatgpt-connector -- --config <config> --request-id <workspace_info.request_id> --connector-name "Local MCP Connector"`

   `--connector-name` 必须与 ChatGPT 中实际使用的 connector 名称完全一致，并且仍然要在全部门禁（request_id 未消费、`tool_name=workspace_info`、OAuth、workspace 与 MCP resource 匹配、evidence 10 分钟内）通过之后才会被采纳。它只是操作者提供的 adoption metadata，`workspace_info` 证明不了 ChatGPT UI 的显示名称，所以只用它恢复 `unconfigured`/`repair_required` binding：binding 已是 `verified` 且名称不同时 fail closed，不做通用改名，也不改名 ChatGPT 平台侧 connector。

9. 再运行 diagnostic；只有 `ok=true`、`status=verified`、`action=none` 才继续原任务或 E2E。

普通 timeout、页面仍在加载时继续检查，不立即转人工。仅在 ChatGPT login、2FA、CAPTCHA，或自动化无法处理的明确授权/确认页暂停：

```text
【需要人工操作】

请只执行：<一个最小动作>

完成后回复：已完成
```

用户完成后从当前 connector 步骤继续，不重新开始。
