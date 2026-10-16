# AGENTS.md

## LRM Boundary

LRM Core 负责：

* Workspace / Git 只读访问；仅 `workspace_edit_file` 允许显式授权工作区内受控单文件精确替换
* Task / Execution / Review Context
* Review / Loop 状态与控制逻辑

架构边界：

```text
MCP
= Read-only Data Plane + explicitly authorized workspace_edit_file

Browser / Extension / Dispatcher / Codex execution
= Control Plane
```

Control Plane 能力不得向 MCP Data Plane 渗透。`workspace_edit_file` 是唯一文件写入例外，手动注册 Workspace 即授权受控编辑；每次必须明确 workspace_id 和原始字节哈希，并由服务端通过 Registry 精确匹配；读/Review 继续只读，Codex Control Plane 与 shell/exec/git commit/push 边界保持不变。

---

## Permission Boundary

职责固定：

```text
ChatGPT → Planning / Review
Codex   → Edit / Test / Git
LRM MCP → Read-only Data Plane + explicitly authorized workspace_edit_file
```

除非明确要求，MCP 不增加：

* `write_file`
* `exec` / `shell`
* `git commit`
* `git push`

## Language

所有面向用户的思维链、回复、计划、进度更新、说明和最终总结都必须使用简体中文撰写。
在适当的情况下，代码、标识符、命令、文件路径、API 名称、错误消息和技术术语应保留其原始形式。
