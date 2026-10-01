# Local Review MCP｜ChatGPT 网页端与本地 Codex 协作

Local Review MCP 将 ChatGPT 网页端、本地项目和本地 Codex 任务执行连接起来。ChatGPT 可以在授权范围内查看本机文件和已有改动；当你明确提出目标与验收条件后，也可以把任务交给本地 Codex 执行，并在完成后回到网页对话中检查结果。

## 项目解决什么问题

ChatGPT 网页端的对话和本地项目彼此分开，通常看不到电脑上的源文件和改动。Codex 虽然能在本地项目中执行任务，但网页对话里的需求、约束和 Review 结论需要经过明确交接。手动复制文件、反复解释背景、再把执行结果贴回网页，会增加遗漏和误解。

Local Review MCP 让这两部分围绕同一个授权项目协作：

- ChatGPT 网页端查看本地项目内容、相关文件和已有改动，完成理解、规划和 Review。
- 你在网页对话中明确提交任务目标、要求和验收条件后，本地 Codex 执行相应工作。
- 执行状态和产生的改动可以回到 Review 流程中，由 ChatGPT 检查结果；需要时继续下一轮。

它适合在提交改动前做代码 Review、调查项目中的具体问题、从网页对话委派本地编码任务，以及复查 Codex 完成的改动。重点是把网页端的计划与本地执行、结果复查连成一条可跟进的流程。

## 首次配置与快速开始

下面按 Windows 主机、Cloudflare 命名隧道和 ChatGPT 网页连接说明。首次配置通常由管理员完成；普通使用者完成后只需在 ChatGPT 中选择连接并发起 Review。

### 开始前准备

- 一台能够访问目标项目文件夹的 Windows 电脑。
- 已安装 Node.js 和 npm。
- 已安装 cloudflared，并已准备可用的 Cloudflare 命名隧道、隧道凭据和稳定的 HTTPS 公网域名。公网域名需已转发到本机服务（默认 http://127.0.0.1:12080）。Local Review MCP 会启动已有隧道，不会替你创建隧道或域名。
- ChatGPT 账号或工作区允许添加自定义连接。开发者模式是否可用可能受账号和工作区策略限制；可参考[OpenAI 官方连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

### 1. 安装依赖并创建配置文件

在 PowerShell 中进入 Local Review MCP 仓库根目录，然后执行：

~~~powershell
npm install
Copy-Item .\config.production.example.json .\config.production.json
notepad .\config.production.json
~~~

只需安装一次依赖。若 config.production.json 已经存在，不要再次复制覆盖；直接用文本编辑器打开现有文件。

### 2. 填写本地项目与连接信息

配置文件至少需要填写目标项目、访问令牌和公网连接信息。单项目配置可以参考下面的结构：

~~~json
{
  "port": 12080,
  "workspace": {
    "id": "sample-project",
    "name": "示例项目",
    "path": "C:\\Projects\\sample-project"
  },
  "workspaces": [
    {
      "id": "sample-project",
      "name": "示例项目",
      "path": "C:\\Projects\\sample-project"
    }
  ],
  "auth": {
    "token": ""
  },
  "remote": {
    "enabled": true,
    "provider": "cloudflare",
    "tunnelName": "替换为现有隧道名称或 UUID",
    "endpoint": "https://review.example.com/mcp"
  },
  "supervisor": {
    "enabled": true,
    "healthIntervalSeconds": 30,
    "maxRestartAttempts": 3
  }
}
~~~

请按下面说明替换示例值：

| 配置项 | 填写内容 |
| --- | --- |
| workspace.id | 项目的唯一短标识，例如 sample-project；同一项目后续保持不变。 |
| workspace.name | ChatGPT 中便于识别的项目名称。 |
| workspace.path | 本机现有项目文件夹的绝对路径。JSON 中 Windows 路径的反斜杠要写成双反斜杠。 |
| workspaces | 可访问项目清单。单项目时保留与 workspace 相同的条目；多个项目时在此添加其他项目。 |
| auth.token | 建议留空，在启动窗口中设置访问令牌，避免把令牌写入配置文件。 |
| remote.enabled | 通过 ChatGPT 网页连接时设为 true。 |
| remote.provider | 保持 cloudflare。 |
| remote.tunnelName | 已创建且可用的 Cloudflare 命名隧道名称或 UUID。 |
| remote.endpoint | 该隧道对应的稳定 HTTPS 地址，末尾保留 /mcp。 |
| supervisor | 首次使用可保留示例中的值。 |

如果配置了多个项目，workspaces 中每一项都要有不同的 id、显示名称和本机路径；顶层 workspace 应与清单中的一个项目相对应。项目路径必须已存在，并且运行服务的 Windows 用户能够访问。

### 3. 设置访问令牌并启动

使用密码管理器生成一个长随机令牌（建议至少 32 个字符），在同一个 PowerShell 窗口中替换下方示例值，然后启动服务：

~~~powershell
$env:LOCAL_REVIEW_MCP_TOKEN = "替换为自己生成的长随机令牌"
.\scripts\start-production.ps1 -Config ".\config.production.json"
~~~

令牌不要提交到 Git、粘贴到公开聊天或分享给无关人员。这个令牌用于本机服务的访问保护；ChatGPT 连接时仍需在连接页面选择 OAuth 并完成授权，两者用途不同。

启动脚本会先检查配置和运行条件，再构建并启动服务。成功后保持该 PowerShell 窗口运行；关闭窗口会停止当前服务。若提示端口 12080 已被占用，可先关闭占用该端口的旧服务，或修改配置中的 port；修改端口时也要同步调整隧道指向的本机端口。

### 4. 在 ChatGPT 中添加连接

1. 在 ChatGPT 设置中开启开发者模式（若账号或工作区提供此选项）。
2. 打开 ChatGPT 的插件或连接管理页面，选择添加自定义连接。
3. 填写连接名称，例如 Local Review MCP；服务器地址使用配置中的 remote.endpoint，确保包含 /mcp。
4. 认证方式选择 OAuth，保存并完成连接授权。
5. 新建一段对话，从工具菜单中选择 Local Review MCP。

界面名称可能随 ChatGPT 账号、工作区和版本变化。若找不到添加自定义连接的入口，请联系工作区管理员确认相关权限。

### 5. 启用网页端 Codex 任务（只做 Review 可跳过）

ChatGPT 连接完成后即可读取项目并做 Review。若要从网页对话提交任务给本地 Codex，还需加载仓库自带的浏览器扩展：

1. 在 Chrome 或 Edge 打开扩展管理页面，开启浏览器扩展的开发者模式，选择“加载已解压的扩展程序”。
2. 选择本仓库中的 extension 文件夹。该扩展可直接加载，无需额外构建。
3. 扩展加载或重新加载后，刷新 ChatGPT 页面。
4. 保持 Local Review MCP 服务运行，并在一条已经打开的具体 ChatGPT 对话中选择 Local Review MCP，再提交任务。

不要从 ChatGPT 首页或空白的新聊天页面提交 Codex 任务；任务需要关联到当前具体对话。只做文件读取和 Review 时不需要加载此扩展。

### 6. 确认连接正确

连接后，先让 ChatGPT 确认可用项目名称，并核对是否与配置中的 workspace.name 一致。若项目不符或没有可用项目，先检查项目路径和项目清单，再开始 Review。

确认成功后，可以直接提出请求，例如：

> 请对当前项目做一次 Review，检查尚未提交的改动，重点关注功能错误、安全问题和数据丢失风险。只报告有代码依据的问题，并说明位置、影响和建议。

### 常见问题

- **项目路径找不到**：确认 path 是本机真实存在的项目文件夹，并按 JSON 格式写双反斜杠。
- **启动时提示缺少令牌**：确认在启动脚本前，已在同一个 PowerShell 窗口设置 LOCAL_REVIEW_MCP_TOKEN，且令牌中没有空格。
- **远程连接无法启动**：确认 cloudflared 已安装、隧道名称正确、隧道凭据可用，remote.endpoint 使用可访问的 HTTPS 公网域名并以 /mcp 结尾。
- **ChatGPT 无法连接**：核对 ChatGPT 中填写的地址与 remote.endpoint 完全一致，检查公网隧道正在运行，并确认已完成 OAuth 授权。
- **任务显示已接收但尚未执行**：确认 Local Review MCP 服务仍在运行、浏览器扩展已加载，并在刷新后的具体 ChatGPT 对话中提交任务。“已接收”不代表执行已经完成。
- **多个项目显示错误**：核对顶层 workspace 是否与 workspaces 清单中的目标项目一致。

## 在 ChatGPT 网页端完成协作

### 只做本地项目 Review

1. 在 ChatGPT 对话中选择 Local Review MCP，并确认目标项目名称正确。
2. 说明 Review 范围：例如当前尚未提交的改动、指定文件、目录或某个问题。
3. 说明关注点：例如功能正确性、安全、错误处理、边界情况或数据完整性。
4. 要求结论附上具体位置、代码依据、触发条件、实际影响和建议。
5. 针对结论继续追问；项目有新改动后，再检查最新内容。

### 需要本地 Codex 执行任务时（先完成首次配置第 5 步）

1. 在已选择 Local Review MCP 的 ChatGPT 对话中，写清要实现的目标、修改范围、不能改变的行为和验收条件。
2. 明确要求 ChatGPT 将任务提交给本地 Codex 执行。重要背景应写进目标和要求，不要假设 Codex 会自动获得网页对话中的全部背景。
3. 等待本地 Codex 完成任务和必要检查，再让 ChatGPT 查看执行结果及最新改动。
4. 如果结果未达到验收条件，指出差距并提交下一轮目标；符合要求后再由你决定是否接受。

## 可直接使用的提问示例

### 检查当前改动

> 请对当前项目做一次 Review，检查尚未提交的改动，重点关注功能错误、安全问题、边界情况和可能造成的数据丢失。只报告有实际代码依据且值得处理的问题，按严重程度排序。每条说明具体位置、触发条件、影响、判断依据和建议。如果没有发现明确问题，请直接说明；不要把单纯的风格偏好列为缺陷。

### 检查指定文件及其影响

> 请查看【文件路径】中的改动，并检查它对相关功能的影响。重点关注【关心的问题】。如果结论需要参考其他文件，请一并查看必要的相关内容，并说明判断依据。请把已确认的问题与仍需验证的猜测分开。

### 调查一个具体疑问

> 我担心【描述现象或疑问】。请从【入口、文件或功能】开始查看项目中的相关实现，判断这种情况是否可能发生。请给出涉及的位置、成立条件、实际影响和依据；如果现有内容不足以确认，请指出缺少什么信息。

### 把任务交给本地 Codex

> 请把以下任务交给当前项目的本地 Codex 执行：实现【目标】。修改范围是【文件或功能范围】，必须保留【现有行为或兼容要求】，验收条件是【可检查的结果】。完成后检查改动，并把执行结果和仍未解决的问题带回当前对话供我复查。

### 修改完成后复查

> 请检查【本次修改范围】的最新改动，确认是否满足以下要求：【列出验收条件】。重点指出未满足的条件、可能引入的回归和仍需人工确认的风险。不要重复已经解决的问题。

## 两端分工与执行边界

- ChatGPT 网页端负责理解需求、查看本地项目、制定计划和 Review 结果。
- 本地 Codex 负责按明确提交的目标执行代码修改及必要检查。
- Local Review MCP 提供授权项目内容，并关联任务、执行状态和 Review 上下文。

网页端提交的是有明确目标、范围和验收条件的任务，由本地 Codex 执行；Local Review MCP 的项目读取和 Review 能力保持只读。执行结果出现“已接收”时，只表示请求已进入处理流程，不代表修改和检查已经完成。请等待结果返回后再复查。
