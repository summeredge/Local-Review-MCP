# AGENTS.md

## Reference Projects

本地只读参考：

* C2C: `C:\Users\shaoy\Documents\Codex\codex-with-chatgpt`
* COS: `C:\Users\shaoy\Documents\Codex\chat-on-steroids`

实现新功能前，先检查相关参考实现、调用链和测试。

优先级：

```text
已有成熟实现
> 最小适配
> 重新设计
```

### C2C

优先参考：

* MCP / Schema / structured output
* OAuth / PKCE
* Workspace / Context
* Process / Supervisor
* Execution Record
* Task / Execution / iteration / checkpoint
* ChatGPT Planning / Review 与 Codex Execution 协作

### COS

优先参考：

* Local Control Bridge
* Chrome Extension
* `requestId → conversationId`
* Browser identity / document / navigation epoch
* durable command queue
* claim / lease / authorize / ACK
* restart / lost-ACK / duplicate-send protection
* Dispatcher / Command Broker
* Reliable Browser Delivery

参考仓库只读，禁止修改。不要整体复制无关子系统。

---

## Implementation Path

开发新能力时默认：

1. 先读取 LRM 当前实现、调用链和测试；
2. 按功能域检查 C2C / COS 是否已有成熟实现；
3. 优先复用或最小适配，不无必要重构 LRM Core；
4. 先完成最小可验证实现，再扩展自动化；
5. Browser / Extension / Dispatcher / Codex execution 保持在 Control Plane；
6. 修改后运行相关测试、typecheck、build 和 diagnostics。

---

## LRM Boundary

LRM Core 负责：

* Workspace / Git 只读访问
* Task / Execution / Review Context
* Review / Loop 状态与控制逻辑

架构边界：

```text
MCP
= Read-only Data Plane

Browser / Extension / Dispatcher / Codex execution
= Control Plane
```

Control Plane 能力不得向 MCP Data Plane 渗透。

---

## Permission Boundary

职责固定：

```text
ChatGPT → Planning / Review
Codex   → Edit / Test / Git
LRM MCP → Read-only Data Plane
```

除非明确要求，MCP 不增加：

* `write_file`
* `exec` / `shell`
* `git commit`
* `git push`
