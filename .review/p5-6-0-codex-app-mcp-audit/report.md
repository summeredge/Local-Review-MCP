# P5.6.0 Codex App MCP Capability Handoff Audit

verdict: **NOT_FEASIBLE**（在现有 Desktop build 与现有 codex_app MCP server 之下）
scope: 只读架构审查；未修改 production code / Desktop / app.asar / MCP server；未新增 MCP tool；无 commit/push
date: 2026-09-21（Asia/Shanghai）
artifacts: .review/p5-6-0-codex-app-mcp-audit/

---

## Executive Summary

结论：

    NOT_FEASIBLE

    codex_app MCP 确实处在 Desktop-owned capability 边界内：它是 Desktop app-server（codex.exe）的
    stdio 子进程，通过 plugin .mcp.json 的 env_vars 白名单显式收到 CODEX_APP_TOOLS_PIPE_PATH。
    但它不能承担 handoff，原因有三，且每一条都是独立阻断点：

    1. 它没有任何 localhost/HTTP 能力。server.mjs 的全部 ESM import 只有 node:crypto、node:net、
       node:process；没有 node:http / node:https / fetch / child_process / createServer / listen /
       动态 import。它唯一的对外通道是连到 Desktop native pipe 的 net.createConnection。
    2. 它没有任何 bootstrap 挂载点。应用层只注册了两个 request handler（tools/list、tools/call），
       没有 oninitialized / startup / setNotificationHandler 应用回调；模块顶层唯一的副作用是
       await server.connect(new StdioServerTransport())。tool 目录本身由 Desktop host 通过 pipe 下发
       （tools/list 是转发请求），server.mjs 只是代理，没有可扩展的注册面。
    3. 它不可被 LRM 触达。它是 app-server 的 stdio 子进程；LRM 既不能 attach 它的 stdin/stdout，
       自己 spawn 一份又必须先拿到 pipe path 才能工作（否则 tools/list 直接失败）——即循环依赖。

    因此本任务要求的“无需修改 ChatGPT Desktop、无需新增 helper、无需 hook 的最小 handoff 路径”
    在 codex_app MCP 上不存在：

    NO_EXISTING_CODEX_APP_MCP_BOOTSTRAP_SEAM

    这也与 P5.4.4 / P5.5 的结论一致：codex_app 不是一个可用的 seam，而是同一循环依赖的另一端。

## Capability Ownership

    Desktop main:
      CODEX_APP_TOOLS_PIPE_PATH owner
      ChatGPT.exe (pid 51064) 启动时创建 native app-tools pipe，把 pipePath 写进自己的 process.env，
      并在 teardown disposer 中删除。
      evidence（app.asar 只读扫描，本轮复核，pipe 字面值已 redact）:
        delete process.env[os];
        let ke = await $ce({ callTool: ..., listTools: ... })
          .catch(e => (warning("Failed to start the Codex app tools native pipe", ...), null));
        ke != null && (process.env[os] = ke.pipePath);
      （os = "CODEX_APP_TOOLS_PIPE_PATH"）

    codex_app MCP:
      inherits capability YES
      Desktop 只有在 CODEX_APP_TOOLS_PIPE_PATH 存在时才启用该 MCP server，并按 plugin .mcp.json 的
      env_vars 白名单把该值显式传给子进程：
        async function fs({ hostConfig, resourcesPath }) {
          if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) return ps("missing-pipe"); ... }
      .mcp.json env_vars = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", ...]

    LRM:
      does not own capability
      Launcher 链路（pythonw -> powershell -> npm -> node cli.js --runtime）从不引用该变量，
      只接受既有 handoff endpoint 送进来的能力（P5.4.4 / P5.4.2 已证）。

## MCP Runtime Analysis

    process:
      node.exe ./server.mjs（cmd.exe -> scripts/launch_codex_app_tools_mcp.cmd 启动）
      实测进程链: ChatGPT.exe(51064) -> codex.exe app-server(50868) -> cmd.exe(55432) -> node.exe(59624)
      server.mjs 来源: C:\Users\shaoy\.codex\.tmp\bundled-marketplaces\openai-bundled\plugins\
                       codex-app-tools\server.mjs（与 Program Files 内 app 包副本 SHA256 完全一致）

    lifetime:
      app-server lifetime，而不是 Desktop app lifetime。
      Desktop log（时间戳为 UTC，本地为 UTC+8）显示 mcp_server_startup_status_updated
      server=codex_app status=starting 只在 thread 启动时出现：
        09:38:58.363Z thread=01a0c2cc  （Desktop 09:38:22Z 启动后约 36s 的首个 thread）
        09:39:00.748Z thread=01a06a52
        11:18:44.693Z thread=01a0c3b0-93ba / 11:18:53.135Z thread=01a0c3b0-b47f
        11:26:01.106Z thread=01a0c3b7 / 11:33:43.987Z thread=01a0c3be
        11:35:52.709Z thread=01a0c3c0 / 11:39:18.854Z thread=01a0c3c3 / 11:42:04.468Z thread=01a0c3c5
        12:53:39.851Z thread=01a0c407 / 14:55:34.095Z thread=01a0c477 / 23:17:44.254Z thread=01a0c407
      同一 server.mjs 进程 59624 创建于本地 22:55:34（= 14:55:34Z，正是 thread=01a0c477 的
      codex_app status=starting），此后在 23:17:44Z（本地次日 07:17:44，thread=01a0c407）仍存活，
      即 app-server 跨 thread 复用同一个 codex_app MCP 子进程；Desktop 关闭时才随之消失。

    startup:
      由 app-server 在 Codex thread 启动时惰性拉起；server.mjs 自身在启动阶段只做一件事：
        var interactionClientId = processArgumentValue(process.argv.slice(2), "--interaction-client-id");
        var server = new Server({ name: "codex-app-tools", ... }, { capabilities: { tools: {} }, ... });
        server.setRequestHandler(ListToolsRequestSchema, ...);
        server.setRequestHandler(CallToolRequestSchema, ...);
        await server.connect(new StdioServerTransport());
      连 native pipe 也是惰性的（getHostClient() 在第一次 tools/list|tools/call 时才读 env 并连接）。

    environment:
      CODEX_APP_TOOLS_PIPE_PATH = YES（经 env_vars 白名单显式注入；插件启用本身也以该值存在为前置）

    与 SessionStart hook 的相对位置:
      codex_app MCP 不比 SessionStart hook 更接近 Desktop lifecycle。两者由同一类事件触发
      （一个 Codex thread/session 的开始）；codex_app MCP 由 app-server 在 thread start 时拉起，
      SessionStart hook 由 Codex 在同一时刻执行。二者都不覆盖“Desktop 已运行但没有任何 Codex session”。
      注意：本节只比较“触发时机是否更接近 Desktop lifecycle”，不表示 SessionStart hook 是一条可用路线；
      该路线的最新状态见下文 “P5.4.3.2 状态更正”。

## MCP Capability Boundary

    codex_app MCP:
      can call localhost: NO
      can execute custom bootstrap logic: NO
      can run automatically on MCP startup: NO
      extension point: NO

    证据（server.mjs，947933 bytes，只读字节扫描 + 行级复核）:

      ESM imports（真实 import 语句）: node:crypto, node:net, node:process
      marker 计数:
        node:http            0      node:https           0
        child_process        0      spawn(               0
        execFile(            0      execSync(            0
        fetch(               0      XMLHttpRequest       0
        createServer         0      .listen(             0
        import(              0      setInterval          0
        setRequestHandler   13（其中 11 个是 SDK 基类，2 个是应用层）
        setNotificationHandler 4（全部是 SDK 基类，应用层 0）
        oninitialized        1（SDK 基类的 this.oninitialized?.()，应用层从未赋值）
        server.connect       1
        process.env          1（仅 process.env["CODEX_APP_TOOLS_PIPE_PATH"]）
        process.argv         1（仅读 --interaction-client-id）

      能力面结论:
        - 唯一对外通道是 net.createConnection(this.pipePath) 连 Desktop named pipe；
          协议是 4 字节长度前缀 + JSON-RPC 帧（encodeFrame/onData）。
        - 应用层只处理 tools/list 与 tools/call，二者都转发给 Desktop host：
          getHostClient().request("tools/list", { threadStartKind: ... })
          getHostClient().request("tools/call", { namespace, tool, threadId, turnId, callId, arguments })
        - 没有 oninitialized / startup / 启动回调；没有动态 import；没有第二入口。
        - plugin 无扩展点：codex-app-tools/plugin.json 只有 name/version/mcpServers/description/
          author/license，没有 hooks 字段，插件目录下也没有 hooks/ 目录。
        - tool 目录由 Desktop host 决定（tools/list 是转发），因此“新增一个会返回 pipe path 的 tool”
          属于 Desktop 侧改动，且需要 LRM 先能调用该 stdio server —— 仍然回到循环依赖。

      命名混淆提醒（避免与 P5.4.x 的 handoff 混淆）:
        codex_app 工具集中存在 handoff_thread / get_handoff_status，它们是 Codex thread 与其 git
        worktree 之间迁移的 Desktop 功能，与 LRM 的 /launcher/desktop-tools-pipe 能力 handoff 无关；
        server.mjs 内 handoff / HANDOFF 字面命中数为 0。

## Bootstrap Seam

    existing bootstrap trigger: NO

    location:
      n/a（server.mjs 顶层唯一副作用是 stdio connect；应用层无任何初始化回调）

    reason:
      方案 A（已有调用点：initialize -> bootstrap）不存在：应用层没有 oninitialized handler，
        SDK 基类的 oninitialized 从未被赋值。
      方案 B（已有工具调用链：tool call -> internal function -> localhost POST）不存在：
        应用层只有 tools/list 与 tools/call 两个转发 handler，且没有任何 HTTP 客户端；
        唯一 socket 目标是 Desktop native pipe，不是 loopback。
      方案 C 成立：

    NO_EXISTING_CODEX_APP_MCP_BOOTSTRAP_SEAM

    补充：即使存在挂载点，server.mjs 是 WindowsApps/Program Files 下的打包插件文件，
    修改它属于“修改 MCP server”，本任务明确禁止；用户 cache 副本与之字节一致，同样属于该插件产物。

## Dependency Analysis

    cycle: YES

    reason:
      LRM
        -> 需要 codex_app MCP
        -> 需要 Desktop pipe（tools/list 与 tools/call 都必须先连上 native pipe）
        -> 需要 handoff
        -> 需要 Desktop

      LRM 侧现状（src/desktop-codex/codex-app-runtime.ts）:
        pipeFor() 只接受 explicit_override 或 current_environment；两者都没有时抛
        CodexAppRuntimeError("pipe_unavailable")，因此 LRM 自 spawn 的 codex_app 副本在拿到 pipe path
        之前无法完成 tools/list。
      Desktop 侧现状：codex_app MCP 是 app-server 的 stdio 子进程，LRM 无句柄可 attach。
      因此正确形态只能是：
        LRM Host -> 已有 connector/MCP access -> codex_app MCP -> Desktop capability -> handoff
      而这条形态要求 codex_app MCP 侧存在可触发、可外呼的 bootstrap —— 本轮证明不存在。

## 和其他方案比较

|方案|结果|原因|
|-|-|-|
|Desktop main bootstrap|NOT_FEASIBLE|Desktop main 持有 capability，但安装版 bundle 里 setDynamicAppToolsPipePath() 是空实现（`setDynamicAppToolsPipePath(e){}`），且 bundle 内对 LRM 的引用为 0（`local-review` / `12080` / `desktop-tools-pipe` / `LocalReviewLauncher` 命中数均为 0）；没有可被外部触发、且会返回该能力的 surface。需要改 Desktop，禁止。|
|codex_app MCP bootstrap|NOT_FEASIBLE|本任务结论。它已在 capability 边界内，但没有 HTTP 能力、没有 startup 回调、没有扩展点，且对 LRM 不可触达（循环依赖）。|
|Desktop-owned bootstrap/bridge component|REQUIRED（形式待定）|唯一同时满足“运行在 Desktop-owned 环境内”且“能到达 LRM loopback endpoint”的能力位置；最小缺失组件是一个只负责把 capability 交给既有 handoff endpoint 的 Desktop 侧 bootstrap。其具体承载形式（extension / plugin / helper / hook / Desktop patch / 新 MCP tool 等）属于下一阶段设计问题，本报告不提前选定。|
|Extension/plugin（作为该组件的形式之一）|NOT_A_SEAM（就 codex_app 路线而言）|codex-app-tools 插件无 hooks 字段、无 hooks 目录，MCP server 也无扩展点；插件系统本身没有“注入 bootstrap 逻辑”的公开接口。此处只否定“用插件扩展 codex_app MCP”这一具体路线，不构成对 bridge 承载形式的选定或排除。|
|Hook|NOT_A_RELIABLE_SEAM（非 codex_app MCP 路线）|SessionStart hook 的机制在 P5.4.2 已 PASS（hook 进程确实运行在持有该能力的 Desktop-owned Codex 环境中），P5.4.3 也已交付 production runner/installer。但 P5.4.3.2 证明：user-scope SessionStart entry 在 `/hooks` 中可见、Trust = Trusted、Enabled = true，真实 Desktop SessionStart 仍不执行该 LRM entry（同批 session 的 plugin SessionStart hook 正常执行）。因此它不是当前可靠的 production automatic bootstrap seam，本轮不把它列为推荐路径；它与 codex_app MCP 无关。|

重点回答：

    codex_app MCP 不可行，因此它不能承担 bootstrap。
    阻断点按独立性排序：
      (a) 无外呼能力：无 http/https/fetch/child_process，只有到 Desktop pipe 的 socket。
      (b) 无挂载点：无 oninitialized/startup 回调，顶层只有 stdio connect；tool 目录由 Desktop 下发，
          server.mjs 是纯代理，没有可扩展注册面。
      (c) 对 LRM 不可达：stdio 子进程不可 attach，自 spawn 又需要先有 pipe path（循环）。
    任一单独存在都足以阻断；三者同时成立，故不存在“无需改 Desktop、无需新增 helper、无需 hook”的路径。

## Recommendation

    REQUIRE_DESKTOP_BRIDGE

    理由：codex_app MCP 已位于 Desktop-owned capability 边界内，但它既不能外呼 loopback、也没有任何
    startup/bootstrap 挂载点，并且对 LRM 不可触达；要在该 server 内实现 handoff 必须修改 MCP server
    （本任务禁止）或修改 Desktop（本任务禁止）。因此“最小缺失组件”仍然是一个运行在 Desktop-owned
    环境内、只负责把 capability 交给既有 loopback handoff endpoint 的 Desktop 侧 bootstrap 组件。

    当前结论只能是：“需要一个 Desktop-owned bootstrap/bridge component。”
    其具体承载形式（extension / plugin / helper / hook / Desktop patch / 新 MCP tool 等）
    属于下一阶段设计问题，本报告不做选定，也不以未验证假设预先给出实现方案。

    不要实现：codex_app MCP 注入、MCP tool 扩展、pipe 扫描/猜测、跨进程环境读取、Launcher 侧 workaround。

## 当前 Live 证据（只读快照）

    进程链:
      ChatGPT.exe 51064 (Desktop main, 17:38:21)
        -> codex.exe 50868 app-server (17:38:24)
             -> cmd.exe 55432 (22:55:34) -> node.exe 59624 ./server.mjs (codex_app MCP)
      Launcher 链（独立，无该变量）:
      pythonw 5372 -> pythonw 42116 -> powershell 52308 -> node 46092 (npm) -> cmd 58360
        -> node 8928 (cli.js) -> node 44916 (LRM Host, 21:44:04)

    LRM Host 侧（GET/POST 127.0.0.1:12080，Bearer 取自 config.production.json，未记录 token）:
      /launcher/desktop-interactive      ready:true, reason:null, pipeSource:"handoff"
      /launcher/desktop-sync             connected:true, activeSource:desktop_ipc, ownerClientId 存在,
                                         currentConversationId 存在, followingThreads 1, fallbackReason:null
      /launcher/desktop-tools-pipe/probe connected:true, pipeSource:"handoff", toolCount:44,
                                         codexAppToolsVersion 0.1.4, 5 个必需 tool 全部存在
      cli diagnose-codex-app-mcp         ok:true, stage:ok, pipeDiscovery:"current_environment", 44 tools

    解读：handoff 链路本身是通的（本次审计会话所在环境持有能力）；问题只在“谁能自动触发它”，
    而 codex_app MCP 不是那个触发者。

## Constraints Check

    hooks used: NO
    pipe scanning: NO
    pipe guessing: NO
    cross-process env read: NO
    Desktop modified: NO
    app.asar modified: NO
    production code changed: NO
    commit/push: NONE

    额外遵守:
      MCP server modified: NO（server.mjs 仅只读扫描；未写入、未替换 cache 副本）
      MCP tool added: NO
      Desktop binary modified: NO
      pipe path 落盘: NO（所有 artifact 中的 pipe 字面值已 redact，无命中）

## Method and Evidence

    本轮只读来源:
      - 安装版 app.asar（字节扫描 + 上下文打印，pipe 值 redact）
      - codex-app-tools 插件文件（.mcp.json / plugin.json / server.mjs / launch script），
        Program Files 与 ~/.codex/.tmp 两份 SHA256 一致
      - Desktop main 日志（LocalCache\Local\Codex\Logs\2026\09\21\...-51064-t0-i1-*.log，只读）
      - 进程表（Win32_Process 快照，只读）
      - LRM 源码（src/desktop-codex/*、src/desktop-sync/codex-app-mcp-diagnostic.ts、src/mcp/http.ts）
      - LRM Host 既有只读 endpoint（desktop-interactive / desktop-sync / tools-pipe probe）

    artifacts:
      scan-codex-app-mcp-capability.mjs       只读 capability 扫描脚本（本轮新增）
      codex-app-mcp-capability-scan.json      上述脚本输出（marker 计数 + ESM import 清单）
      codex-app-mcp-diagnostic.json           cli diagnose-codex-app-mcp 输出（44 tools）
      asar-scan.json / asar-injection-hits.json / asar-plugin-enable-hits.json
      asar-lrm-reference-hits.json            bundle 内对 LRM 的引用（全部为 0）
      asar-handoff-thread-hits.json           handoff_thread 的 Desktop 语义（thread/worktree 迁移）
      asar-12080-hits.json                    "12080" 命中经核对均为无关资源 hash / 字体度量（非 LRM 引用）
      host-state-snapshot.json                LRM Host 只读状态快照

    未做（避免越界）:
      - 未向 codex_app MCP 发送任何未证明的 method
      - 未 attach / 未劫持 app-server 的 stdio
      - 未读取任何其它进程的环境或 PEB（仅本进程布尔值与本轮只读证据）

## Residual Unknowns（声明，不猜测）

    1. 未测量“Desktop 运行但无任何 Codex thread”时 codex_app MCP 是否存在；本轮观察到的实例由
       thread start 拉起，因此该状态下大概率不存在，但没有直接测量，不作为结论。
    2. 未验证 app-server 在多 thread 下是复用同一个 codex_app 子进程还是重启（当前只观测到 1 个存活实例
       跨多个 thread：创建于 14:55:34Z，23:17:44Z 仍在；但未做多实例或重启场景的穷尽观测）；
       该细节不影响“无 bootstrap seam”的结论。
    3. 未来 Desktop build 若给 codex_app MCP 增加 HTTP 能力或 startup 回调，结论可能改变；
       本报告只覆盖已安装版本：Desktop 26.915.4065.0 / codex 0.155.0-alpha.9.2 / codex-app-tools 0.1.4。

---

## 验收回答

    1. codex_app MCP 是否是当前已有 Desktop-owned bridge？
       NO。它确实位于 Desktop-owned capability 边界内（Desktop app-server 的 stdio 子进程，
       显式收到 CODEX_APP_TOOLS_PIPE_PATH），但它不是 bridge：没有 loopback 外呼能力、
       没有 startup/bootstrap 挂载点、对 LRM 不可触达。

    2. 它是否可以自动触发 handoff？
       NO。模块顶层唯一的自动动作是 await server.connect(new StdioServerTransport())，
       应用层无 oninitialized/startup 回调，也没有任何到 127.0.0.1 的调用能力。

    3. 如果不能，缺少什么？
       缺少一个运行在 Desktop-owned 环境内、能把 capability POST 到既有
       /launcher/desktop-tools-pipe 的 bootstrap 组件（Desktop 侧），以及一个受支持、
       在该环境中自动触发它的时机。codex_app MCP 本身无法补上这两点，除非修改 MCP server
       或 Desktop —— 两者都被本任务禁止。

    4. 下一步应该实现什么，而不是继续探索什么？
       实现方向：Desktop 侧最小 bootstrap 组件（REQUIRE_DESKTOP_BRIDGE），只做一件事——
       把 pipe path 交给 LRM 既有 handoff endpoint；这是唯一能满足“无需改 Desktop 就无法自动
       获得能力”这一边界事实的形态。
       停止探索：codex_app MCP 注入、MCP tool 扩展、codex-ipc 扩展、pipe 扫描/猜测、
       Launcher 侧 workaround。P5.4.3 的 SessionStart hook 路线已交付 production runner/installer，
       但按 P5.4.3.2 的最新证据（Trusted + Enabled 却未在真实 Desktop SessionStart 中执行）不是
       当前可靠的 production automatic bootstrap seam，本报告不将其列为推荐生产路径，
       也不建议回到 hook trust 排查（该 blocker 已排除）。

    未实现任何代码；未新增 MCP tool；未修改 Desktop。

---

## P5.4.3.2 状态更正（本报告基线）

    本报告此前把“hook trust”记为待处理的外部动作；该描述已过时，现按 P5.4.3.2 的真实诊断更正：

    user-scope SessionStart hook 状态:
      /hooks 中可见:                YES
      Trust:                        Trusted
      Enabled:                      true
      真实 Desktop SessionStart 执行该 LRM entry:  NO
      同批 Desktop session 的 plugin SessionStart hook 执行:  YES

    因此:
      - 当前 blocker 不是 hook trust；trust 不是待处理动作，本报告不再把它列为遗留项。
      - 该路线不是可靠的 production automatic bootstrap seam。
      - 不建议后续回到 hook trust 排查。
      - 本报告不把 hook 列为当前推荐生产路径。

    该更正不改变 P5.6.0 的任何核心技术结论。
