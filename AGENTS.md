# Repository Guidelines

## Project Structure & Module Organization

This repository is a zero-dependency Node.js app for viewing local Claude and Codex history.

- `server.js` contains the HTTP server, routes, history scanning/parsing, file watching, and title cache logic.
- `public/index.html` is the browser entry point.
- `public/app.js` contains frontend interaction and rendering code.
- `public/style.css` contains all page styling.
- `titles.json` stores manually edited or generated session titles and is runtime data.
- `README.md` and `README.en.md` document usage in Chinese and English.

There is no dedicated `src/` or test directory.

## Build, Test, and Development Commands

- `npm start` starts the local server with `node server.js`.
- `PORT=5180 npm start` runs the app on a custom port.
- `AI_HISTORY_SOURCE=codex npm start` starts with Codex sessions selected by default.
- `AI_HISTORY_ROOT=/path/to/history npm start` points the Claude source at a custom history directory.

The server listens on `127.0.0.1`; open `http://127.0.0.1:5178` unless `PORT` is changed. There is no build step.

## Coding Style & Naming Conventions

Use ECMAScript modules and keep compatibility with Node.js 18 or later. Follow the existing style: two-space indentation, semicolons, double quotes, `const`/`let`, and descriptive camelCase names. Keep server-only logic in `server.js` and browser-only logic in `public/app.js`.

Avoid dependencies unless they materially simplify a feature. Prefer Node built-ins for filesystem, path, HTTP, and URL work.

## Testing Guidelines

No automated test framework is configured. For changes, verify manually with `npm start` and the browser UI. Exercise affected API routes, such as `/api/tree`, `/api/session`, `/api/search`, `/api/title`, or `/api/refresh`, when server behavior changes.

If tests are added later, place them in a clearly named directory such as `test/` and add an `npm test` script before relying on them in pull requests.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries, for example `Add English README` or `Add README language links`. Keep commits focused on one change.

Pull requests should include a brief description, the reason for the change, manual verification steps, and screenshots or short recordings for visible UI changes. Mention any environment variables used during testing and note whether `titles.json` changes are intentional runtime data updates.

## Security & Configuration Tips

Do not commit API keys or local history data. Configure title generation with environment variables such as `CLAUDE_HISTORY_DEEPSEEK_API_KEY`. Keep path handling defensive when reading user-selected history files, and preserve the local-only bind address unless remote access is explicitly required.
