# P5.1.3 codex_app Project/Thread Context Contract Investigation

调查日期：2026-09-19

结论先行：当前外部 LRM 调用得到的 -32602 不是 list_projects({}) 或
create_thread.target 的参数错误。当前安装的 codex-app-tools 在 MCP
tools/call handler 入口先要求 executor thread metadata；LRM 当前
Client.callTool 没有发送 _meta，也没有通过 launcher 参数提供
--interaction-client-id，所以请求在 server.mjs 中止，尚未进入
Desktop project registry、target schema 或 thread creation handler。

本调查严格只读。本轮 tools/call = 0，没有调用 list_projects、
create_thread、send_message_to_thread、fork_thread、handoff_thread
或其他 MCP tool，也没有修改现有 P5.0/P5.1/P5.1.2 代码。只新增本报告。

## 1. 已验证基线

来源：P5.0/P5.1/P5.1.2 已有诊断结果与本地源码。

| 项目 | 事实 |
| --- | --- |
| Desktop | 26.915.4065.0 |
| Codex | 0.155.0-alpha.9.2 |
| plugin | codex-app-tools 0.1.4 |
| LRM transport | stdio MCP |
| Desktop transport | Windows named pipe |
| initialize | PASS |
| tools/list | PASS；44 tools |
| 外部 list_projects | 之前一次真实调用返回 -32602；本轮不重跑 |
| P5.1 create_thread | 之前曾返回 -32602 |
| P5.1.2 | 因 list_projects fail-closed，未再次调用 create_thread |

此前独立的 Desktop app-side 只读项目发现已把当前 workspace 映射为：

    projectKind: local
    hostId: local
    path: 当前 workspace
    projectId: sha256:cc5e7db612b9cb7e825400f26295e1b7ad47e285f361a82bed181d6533ea3bb9

这里仅保存 project ID 的 hash；LRM 自己的 workspace identity 是另一个
命名空间，不能直接当作 Desktop projectId。

## 2. 当前安装 bundle 与注册链

实际安装 bundle 的相对位置：

    resources/plugins/openai-bundled/plugins/codex-app-tools/
      .codex-plugin/plugin.json
      .mcp.json
      scripts/launch_codex_app_tools_mcp.cmd
      scripts/launch_codex_app_tools_mcp
      server.mjs

plugin.json 的版本是 0.1.4。mcp.json 的关键契约是：

    codex_app:
      command: cmd.exe
      cwd: .
      args:
        - /d
        - /s
        - /c
        - call
        - ./scripts/launch_codex_app_tools_mcp.cmd
        - ./server.mjs
      transport: stdio
      native_pipe_env: CODEX_APP_TOOLS_PIPE_PATH
      effectful_approval:
        create_thread: prompt
        send_message_to_thread: prompt
        fork_thread: prompt
        handoff_thread: prompt

当前 launcher 只选择 Node runtime 并执行 server.mjs；没有注入
--interaction-client-id。mcp.json 的 approval 配置是 Desktop MCP
client 的配置，不会替 standalone LRM spawn 自动生成当前 Desktop
thread metadata。

### 2.1 server.mjs 的 MCP handler

文件：resources/plugins/openai-bundled/plugins/codex-app-tools/server.mjs

bundle 中保留了 source comment ../bundled-plugins/codex-app-tools/src/server.ts。
关键函数/位置约为 server.mjs:24771-24910：

1. tools/list handler 调用 listTools()，向 native pipe 转发：

       {
         "method": "tools/list",
         "params": { "threadStartKind": "all" }
       }

   当前 LRM launch 没有 interactionClientId，所以是 all。

2. tools/call handler 先读 request.params._meta，按以下顺序寻找
   threadId：

       --interaction-client-id
       openai/threadId
       openai/thread_id
       codexThreadId
       codex_thread_id
       threadId
       thread_id
       x-codex-turn-metadata.thread_id
       nested metadata.thread.id

3. 找不到 threadId 时，直接执行：

       McpError(ErrorCode.InvalidParams,
                "Codex app tools require thread metadata from the executor.")

   这发生在 getHostClient().request("tools/call", ...) 之前。

4. 找到 metadata 后，才向 native pipe 发送：

       {
         "method": "tools/call",
         "params": {
           "arguments": {},
           "callId": "...",
           "namespace": "codex_app",
           "threadId": "...",
           "tool": "list_projects | create_thread",
           "turnId": "..."
         }
       }

   callId/turnId 缺省时由 server 生成；threadId 没有默认值。

5. native pipe 返回的 JSON-RPC error 会被包装为
   new McpError(response.error.code, response.error.message)。正常
   dynamic-tool result 则只映射为 content + isError；当前 server
   没有为 tool result 添加 structuredContent。

### 2.2 Desktop native pipe dispatcher

文件：resources/app.asar:.vite/build/main-LM8MUIFp.js

bundle 中的 $ce/tle 是 native pipe server。其 Qce schema 要求
native tools/call 具有非空 callId、namespace、threadId、tool、turnId
和 object arguments。native dispatcher 随后调用：

    getWindowContext().callDynamicAppTool(...)

tle 还有一个独立的 malformed-native-request 分支，会返回：

    -32602 "Invalid app tool request"

这不是当前 LRM 观察到的首个阻塞点，因为当前 server.mjs 在缺少
thread metadata 时根本不会写 native pipe。

## 3. list_projects 调查结果

### 3.1 MCP schema 与 {} 合法性

文件：resources/app.asar:webview/assets/app-initial-6c4523b43a11.js

当前 Desktop runtime tool schema 摘要：

    list_projects:
      type: object
      additionalProperties: false
      properties: []
      required: []

因此：

    list_projects({})：按 MCP inputSchema 合法。

本题第一个硬结论为 C：schema 合法，但 handler/native route 另有
executor metadata 约束。-32602 不能解释为缺少 list_projects
工具参数。

### 3.2 Desktop handler 与返回值

当前 bundle 中：

    lHi({ scope, argumentsValue })
      -> jHi.safeParse(argumentsValue)
      -> Doi({ scope })

Doi 生成：

    {
      "schemaVersion": 2,
      "projects": [
        {
          "projectId": "...",
          "projectKind": "local | remote | chatgpt",
          "label": "...",
          "path": "...",
          "hostId": "...",
          "isGitRepository": true
        }
      ]
    }

安全地概括其真实来源：

    Ooi(scope)
      -> Desktop persisted project registry
      -> local/remote project identity
      -> local project hostId = local
      -> git stable-metadata(path) -> isGitRepository
      -> optional ChatGPT project catalog

Doi 没有从 arguments 读取 project ID，也没有要求
currentProject/selectedProject 作为 list_projects 参数。它读取
Desktop renderer 的 project registry 和 host configuration。

### 3.3 最可能的 -32602 层

    confirmed:
      - tools/list succeeds because it does not require executor thread metadata
      - server.mjs tools/call explicitly rejects missing threadId with InvalidParams
      - LRM callAllowedTool currently sends {name, arguments} only
      - current mcp.json launch has no --interaction-client-id
      - native pipe Qce/project registry/renderer lHi are not reached
    high_confidence:
      - prior external list_projects -32602 came from the server.mjs metadata gate

list_projects({}) 的真实 arguments 是合法的；当前请求在
codex-app-tools server.mjs 而不是 Desktop project handler 失败。

## 4. create_thread 调查结果

### 4.1 当前真实 schema

当前 runtime schema 摘要：

    create_thread:
      type: object
      additionalProperties: false
      required:
        - prompt
        - target
      properties:
        - title
        - prompt
        - target
        - model
        - thinking

    targetVariants:
      - type: project
        required: [type, projectId, environment]
      - type: projectless
        required: [type]
      - type: chatgptWorkCloud
        required: [type]

    environmentVariants:
      local:
        required: [type]
        typeEnum: [local]
      worktree:
        required: [type]
        typeEnum: [worktree]
        startingStateVariants:
          - typeEnum: [working-tree]
            required: [type]
          - typeEnum: [branch]
            required: [type, branchName]
            onMissingEnum: [error, create-branch]

projectless 可选 directoryName；chatgptWorkCloud 可选 projectId。
这些字段都受对象 additionalProperties: false 约束。

### 4.2 handler 实际读取的显式/隐式参数

当前 bundle 中：

    cHi({
      argumentsValue,
      sourceHostId,
      sourceThreadId,
      getAvailableModels,
      signal
    })
      -> kHi.safeParse(argumentsValue)
      -> vHi(scope, target)
      -> BOi({
           turnTrigger: "app_tool_create_thread",
           model,
           prompt,
           sourceThreadId,
           target,
           thinking,
           threadSource: "agent_created_thread",
           title
         })

参数归属：

| 字段/状态 | 来源 |
| --- | --- |
| prompt, title, model, thinking | MCP arguments |
| target.type, projectId, environment | MCP arguments |
| sourceThreadId | server/native executor metadata |
| sourceHostId | Desktop native dispatcher 的 local host route |
| project path / projectKind / remote hostId | Desktop project registry |
| isGitRepository | list_projects discovery；create_thread handler 只按 projectId 查 registry |
| current ready app window | renderer/native dispatch state |
| model availability | destination host model catalog |

vHi 的 project resolution 是严格的 registry identity match：

    Ooi(scope).find(project.projectId === target.projectId)

找不到时才会产生类似：

    Unknown projectId: ... Call list_projects to find available projects.

这是 downstream result-level error，不是当前缺少 metadata 时的
JSON-RPC -32602。

### 4.3 local 与 worktree

当前 schema 明确支持两者。handler 不会因为存在 worktree variant
就自动改选 worktree；它把请求中的 target.environment 传给
内部 thread creation。Desktop tool description 建议根据
isGitRepository 选择 worktree，但这是调用指导，不是 schema 的
隐式字段。

因此，P5.1.2 的 environment: { type: "local" } 在 schema 层是
有效的；本调查没有证据表明它是当前 -32602 的原因。

## 5. Caller / context 模型

    External LRM MCP Client
      └─ stdio: initialize / tools/list
           └─ server.mjs
                ├─ tools/list
                │    └─ native pipe: tools/list {threadStartKind:"all"}
                └─ tools/call
                     ├─ read request.params._meta
                     ├─ require executor threadId
                     └─ native pipe: tools/call
                          └─ main.$ce / tle
                               └─ getWindowContext.callDynamicAppTool
                                    └─ ready renderer dynamicAppTools
                                         ├─ canCallTool(hostId, threadId)
                                         └─ dispatchToolCall
                                              └─ Yra(transport:"mcp")
                                                   ├─ lHi -> Doi -> project registry
                                                   └─ cHi -> vHi -> BOi

context 产生点：

    MCP executor metadata:
      threadId / turnId / callId
    Desktop native dispatcher:
      local host route
    renderer:
      ready app window
      thread/conversation existence
      project registry
      thread ownership/execution claim

### 5.1 外部 client 与 Desktop client 的身份差异

当前 bundle 没有发现 initialize.clientInfo 被用于
list_projects/create_thread 的授权或路由。server.mjs 的 tools/call
只使用：

    request.params._meta
    process argv 的 --interaction-client-id
    extra.requestId（仅用于生成默认 turnId）

向 native pipe 转发时也没有 clientId、sourceClientId、ownerClientId
或 MCP clientInfo；只有 threadId、turnId、callId、namespace、tool、
arguments。

因此当前证据支持：

    外部 stdio client 缺的是 executor context，
    不是一个已确认不可伪造/不可传递的 caller authorization token。

但 context 不是当前 MCP inputSchema 的字段，也不会从
initialize.clientInfo 自动产生。外部 LRM 若要继续，需要取得一个
当前有效的 Desktop thread ID，并把它作为 _meta 提供；本任务没有
这样做，也没有验证加 metadata 后的 end-to-end 结果。

## 6. -32602 分层结论

本 bundle 中至少存在两个不同的 -32602 生产点：

| 层 | 触发条件 | 当前是否命中 |
| --- | --- | --- |
| server.mjs MCP handler | tools/call 缺 executor threadId | 是，高置信 |
| Desktop main native pipe Qce/tle | native request 缺字段或字段类型错误 | 否；尚未到达 |

Desktop renderer 的 create_thread 参数解析不是当前已确认的
-32602 点：cHi 对无效 target 返回 success:false 的 dynamic-tool
result，随后由 MCP server 映射成 content + isError。

所以当前 failure chain 是：

    LRM callTool({name, arguments})
      -> server.mjs sees _meta = {}
      -> no threadId
      -> McpError InvalidParams (-32602)
      -> native pipe not written

这也解释了之前 {} 与省略 arguments 得到同一错误：两者都在
同一个 metadata gate 失败，尚未由 list_projects schema 处理。

## 7. 官方源码/Issue 交叉核验

### Official source

官方仓库的
[dynamic_tools_mcp.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/dynamic_tools_mcp.rs#L246-L303)
在 call_tool 中从 MCP request context 读取 threadId 或
x-codex-turn-metadata.thread_id，缺失时返回
McpError::invalid_params("missing task metadata")，随后才构造
DynamicToolCallParams { thread_id, turn_id, call_id, namespace,
tool, arguments }。这与当前 Desktop bundle 的 metadata gate 和
native request shape 一致。

官方仓库当前 codex_tui dynamic-tool 源码中的 create_thread schema
是另一条 namespace/版本路径，不能覆盖本机 codex-app-tools 0.1.4
bundle 已发现的 target schema；本报告以当前安装 bundle 为 schema
权威。

### GitHub issue reports

以下是交叉验证材料，不把 issue body 当作当前机器的源码证据：

- [#37630](https://github.com/openai/codex/issues/37630) 报告
  list_projects 返回的旧/remote-shaped project ID 被 create_thread
  拒绝，而 Desktop v2/local UUID 可以工作。它支持
  “project discovery 与 create validation 必须共享 registry”这一
  downstream 风险，但不是本次 metadata gate 的根因。
- [#36315](https://github.com/openai/codex/issues/36315) 报告合法
  project/worktree 请求得到 opaque invalid arguments。这说明即使
  到达 cHi，target validation 仍可能有独立问题。
- [#37556](https://github.com/openai/codex/issues/37556) 报告后台
  list_projects/create_thread 可能等待到前台消息后才恢复；issue
  自身把 foreground/session context 标为假设，不能作为本机已证实
  的因果，但与 bundle 中 ready-window/context 依赖相容。

## 8. 根因等级与路线判断

    CONFIRMED:
      - list_projects inputSchema allows {}
      - create_thread target schema is project/projectless/chatgptWorkCloud
      - project target requires type + projectId + environment
      - local environment is schema-valid
      - current LRM call path sends no _meta and launch args contain no interaction-client-id
      - server.mjs rejects tools/call before native pipe when thread metadata is absent
      - create_thread resolves projectId against Desktop Ooi(scope) registry

    HIGH-CONFIDENCE:
      - prior external list_projects -32602 is the server.mjs executor-metadata failure
      - the current failure is not an ordinary project/target argument failure
      - initialize.clientInfo is not a substitute for the required tool-call metadata

    POSSIBLE:
      - once a valid threadId is supplied, the same native pipe/renderer route can service
        the external call; no caller-identity rejection was found

    UNKNOWN:
      - whether this machine's current ready Desktop window will accept a supplied valid
        threadId from an external LRM client
      - whether a later create_thread call would hit project-registry/target validation
      - whether Desktop would show approval UI after the metadata gate is passed

最终路线只能选一项：

    B. 可补充的 Desktop context/routing 问题

理由：当前阻塞是一个明确的、协议可表达的 executor context 缺失；
bundle 接受 _meta thread identifiers，native pipe 没有发现独立的
外部-caller authorization barrier。下一步若获授权，应先补齐/验证
有效 Desktop thread metadata，再观察 downstream project/target
结果；不应继续猜 projectId、worktree 或重复 create_thread。

本结论的范围仅限当前 -32602 根因。加 metadata 后是否成功仍是
UNKNOWN，且不属于 P5.1.3。
