# Codex App-server Backend 原型

这是一个独立的底层验证模块，不接入 LRM 的 `submit_goal`、Goal、Task、
Execution、MCP 或现有 CLI execution chain。

## 范围

`CodexAppServerClient` 负责：

- 启动 `codex app-server --listen stdio://`；
- 通过 stdio 传输 JSON-RPC 请求和响应；
- 完成 `initialize` / `initialized`；
- 分页读取 `model/list`；
- 调用 `thread/start` 和 `turn/start`；
- 将 app-server notifications 转换为内部事件；
- 捕获 stdout/stderr，并正确关闭子进程。

当前原型只处理：

```text
thread_started
turn_started
agent_message_delta
agent_message_completed
turn_completed
turn_failed
```

未知 provider event 不向调用方暴露。Server-request（approval、user input
等）暂未实现，原型会返回明确的 unsupported RPC error，避免静默放行。

## 使用

先编译 TypeScript，再运行独立 smoke test：

```powershell
npm run build
node scripts/test_codex_app_server.mjs
```

可选环境变量：

```powershell
$env:CODEX_EXECUTABLE = "C:\path\to\codex.exe"
$env:CODEX_APP_SERVER_CWD = "C:\path\to\workspace"
$env:CODEX_APP_SERVER_MODEL = "provider-model-id"
node scripts/test_codex_app_server.mjs
```

未设置 `CODEX_APP_SERVER_MODEL` 时，测试只使用 provider 明确标记的默认
模型；如果没有默认模型，则不硬编码或自动选择列表第一项，而是让 provider
使用自己的默认配置。

## 协议注意事项

当前 Codex app-server 的实际 wire schema 由安装版 Codex 决定。实现阶段可用
下面的命令生成当前版本 schema 进行核对：

```text
codex app-server generate-json-schema --out <temporary-directory>
```

原型使用当前版本的 `clientInfo`、`capabilities`、camelCase provider fields
和 `turn/start` text input shape；这些 provider details 被限制在本模块内。
