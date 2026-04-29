# AI History Viewer

[中文](README.md)

A local AI conversation history viewer for browsing Claude and Codex sessions. The project ships as a zero-dependency Node.js server with a static frontend, reading local JSONL/JSON/Markdown/Text history files and rendering them in the browser.

## Features

- Switch between Claude and Codex history sources
- Browse sessions by time, with project-based browsing for Claude history
- Search across session content with highlighted matches
- View regular messages, tool calls, tool outputs, and optional system messages
- Edit session titles manually
- Optionally generate concise Chinese titles with DeepSeek
- Watch history directories for changes and refresh page data automatically

## Requirements

- Node.js 18 or later

## Quick Start

```bash
npm start
```

Then open:

```text
http://127.0.0.1:5178
```

By default, the app reads Claude history from:

```text
~/.claude/projects
```

## Configuration

Use environment variables to customize the server port, default source, and history directories.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `5178` | Local server port |
| `AI_HISTORY_SOURCE` | `claude` | Default history source: `claude` or `codex` |
| `AI_HISTORY_ROOT` | `~/.claude/projects` | Claude history directory, with higher priority than `CLAUDE_HISTORY_ROOT` |
| `CLAUDE_HISTORY_ROOT` | `~/.claude/projects` | Claude history directory |
| `CODEX_SESSION_ROOT` | `~/.codex/sessions` | Codex history directory |
| `AI_HISTORY_TITLE_MODEL` | `deepseek-v4-flash` | DeepSeek model used for automatic title generation |
| `CLAUDE_HISTORY_TITLE_MODEL` | `deepseek-v4-flash` | Compatibility setting for the title model |
| `CLAUDE_HISTORY_DEEPSEEK_API_KEY` | Empty | DeepSeek API key |
| `CODEX_HISTORY_DEEPSEEK_API_KEY` | Empty | Compatibility setting for the DeepSeek API key |

Example:

```bash
AI_HISTORY_SOURCE=codex PORT=5180 npm start
```

Use a custom history directory:

```bash
AI_HISTORY_ROOT=/path/to/claude/projects npm start
```

Enable automatic title generation:

```bash
CLAUDE_HISTORY_DEEPSEEK_API_KEY=your_api_key npm start
```

If no DeepSeek API key is configured, the app still works normally and skips automatic title generation.

## Project Structure

```text
.
├── public/
│   ├── app.js       # Frontend interaction logic
│   ├── index.html   # Page entry
│   └── style.css    # Page styles
├── package.json
└── server.js        # HTTP server, history scanning, parsing, and title cache
```

## Data Notes

- Claude reads `.jsonl`, `.json`, `.md`, and `.txt` files from `~/.claude/projects` by default.
- Codex reads `.jsonl` files from `~/.codex/sessions` by default.
- Manually edited or automatically generated titles are saved to `titles.json` in the project root.
- The server listens on `127.0.0.1` for local access only.
