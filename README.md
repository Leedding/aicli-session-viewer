# AI History Viewer

[English](README.en.md)

一个本地 AI 历史对话浏览器，用于查看 Claude 和 Codex 的会话记录。项目包含一个零依赖 Node.js 服务和静态前端页面，会从本机历史目录读取 JSONL/JSON/Markdown/Text 会话文件并在浏览器中展示。

## 功能

- 支持 Claude 和 Codex 历史记录切换
- 按时间浏览会话，Claude 历史还支持按项目浏览
- 搜索所有会话内容并高亮匹配文本
- 展示普通消息、工具调用、工具输出和可选系统消息
- 支持手动编辑会话标题
- 可选使用 DeepSeek 为会话自动生成中文标题
- 自动监听历史目录变化，并定时刷新页面数据

## 环境要求

- Node.js 18 或更高版本

## 快速开始

```bash
npm start
```

启动后访问：

```text
http://127.0.0.1:5178
```

默认读取 Claude 历史目录：

```text
~/.claude/projects
```

## 配置

可以通过环境变量调整服务端口、默认数据源和历史目录。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `5178` | 本地服务端口 |
| `AI_HISTORY_SOURCE` | `claude` | 默认历史来源，可选 `claude` 或 `codex` |
| `AI_HISTORY_ROOT` | `~/.claude/projects` | Claude 历史目录，优先级高于 `CLAUDE_HISTORY_ROOT` |
| `CLAUDE_HISTORY_ROOT` | `~/.claude/projects` | Claude 历史目录 |
| `CODEX_SESSION_ROOT` | `~/.codex/sessions` | Codex 历史目录 |
| `AI_HISTORY_TITLE_MODEL` | `deepseek-v4-flash` | 自动标题使用的 DeepSeek 模型 |
| `CLAUDE_HISTORY_TITLE_MODEL` | `deepseek-v4-flash` | 自动标题模型兼容配置 |
| `CLAUDE_HISTORY_DEEPSEEK_API_KEY` | 空 | DeepSeek API Key |
| `CODEX_HISTORY_DEEPSEEK_API_KEY` | 空 | DeepSeek API Key 兼容配置 |

示例：

```bash
AI_HISTORY_SOURCE=codex PORT=5180 npm start
```

指定历史目录：

```bash
AI_HISTORY_ROOT=/path/to/claude/projects npm start
```

启用自动标题：

```bash
CLAUDE_HISTORY_DEEPSEEK_API_KEY=your_api_key npm start
```

未配置 DeepSeek API Key 时，应用仍可正常使用，只会跳过自动标题生成。

## 项目结构

```text
.
├── public/
│   ├── app.js       # 前端交互逻辑
│   ├── index.html   # 页面入口
│   └── style.css    # 页面样式
├── package.json
└── server.js        # HTTP 服务、历史扫描、解析和标题缓存
```

## 数据说明

- Claude 默认读取 `~/.claude/projects` 下的 `.jsonl`、`.json`、`.md`、`.txt` 文件。
- Codex 默认读取 `~/.codex/sessions` 下的 `.jsonl` 文件。
- 手动编辑或自动生成的标题会写入项目根目录的 `titles.json`。
- 服务只监听 `127.0.0.1`，用于本机访问。
