# AGENTS.md

## C2C Reference Project

LRM 可参考本机 C2C 项目：
C:\Users\shaoy\Documents\Codex\codex-with-chatgpt


查阅 C2C 时：
- 直接读取本地代码；
- 优先理解已有实现和调用链；
- 适用时复用或最小适配。

## Reference Priority

涉及以下功能时，优先检查 C2C 是否已有实现：

- MCP Tool 注册
- input/output schema
- structuredContent / outputSchema
- Zod Schema
- Response helper
- OAuth / PKCE
- Workspace 管理
- Process / Supervisor
- Execution Output
- Context 管理

原则：

已有成熟实现
>
最小适配
>
重新设计

---

## LRM Boundary

LRM 定位：

Data Plane
+
Review Context

负责：

- Workspace读取；
- Git信息；
- Review上下文。

不引入 C2C 的：

- Workspace ↔ Conversation绑定；
- Session状态机；
- Agent Control Plane；
- Coding Agent执行能力。

---

## Permission Boundary

保持：

ChatGPT:
规划 / Review

Codex:
修改 / 测试 / Git

LRM:
只读数据访问


除非明确要求，不增加：

- write_file
- exec
- shell
- git commit
- git push