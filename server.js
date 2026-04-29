import http from "node:http";
import https from "node:https";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5178);
const HISTORY_ROOT = path.resolve(
  process.env.AI_HISTORY_ROOT ||
    process.env.CLAUDE_HISTORY_ROOT ||
    path.join(process.env.HOME || "", ".claude", "projects"),
);
const TITLES_FILE = path.join(__dirname, "titles.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const TITLE_MODEL = process.env.CLAUDE_HISTORY_TITLE_MODEL || "deepseek-v4-flash";
const TITLE_API_KEY =
  process.env.CLAUDE_HISTORY_DEEPSEEK_API_KEY ||
  process.env.CODEX_HISTORY_DEEPSEEK_API_KEY ||
  process.env.codex_history_deepseek_api_key ||
  process.env["codex-history_deepseek_api_key"] ||
  "";

let titleCache = {};
let cachedFiles = null;
let titleGenerationStarted = false;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function main() {
  titleCache = await readTitleCache();
  await refreshFiles();

  const server = http.createServer(handleRequest);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Claude history viewer: http://127.0.0.1:${PORT}`);
    console.log(`Reading sessions from: ${HISTORY_ROOT}`);
    startTitleGeneration();
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/tree") return sendJson(res, await getTree());
    if (url.pathname === "/api/session") return sendJson(res, await getSession(url));
    if (url.pathname === "/api/search") return sendJson(res, await search(url));
    if (url.pathname === "/api/title") return sendJson(res, await saveManualTitle(req, url));
    if (url.pathname === "/api/refresh") {
      await refreshFiles();
      return sendJson(res, await getTree());
    }
    return serveStatic(url.pathname, res);
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, { error: error.message || "Internal server error" }, status);
  }
}

async function refreshFiles() {
  cachedFiles = await scanHistoryFiles();
  return cachedFiles;
}

async function getFiles() {
  if (!cachedFiles) return refreshFiles();
  return cachedFiles;
}

async function getTree() {
  return {
    root: HISTORY_ROOT,
    files: await getFiles(),
  };
}

async function getSession(url) {
  const relPath = url.searchParams.get("path");
  const filePath = safeResolveHistoryPath(relPath);
  const stat = await fs.stat(filePath);
  const text = await fs.readFile(filePath, "utf8");
  const parsed = parseClaudeJsonl(text);
  const info = await fileInfo(filePath, relPath, stat, parsed);
  return {
    ...info,
    rawLineCount: text.split(/\r?\n/).filter(Boolean).length,
    meta: parsed.meta,
    messages: parsed.messages,
  };
}

async function search(url) {
  const query = (url.searchParams.get("q") || "").trim();
  const files = await getFiles();
  if (!query) {
    return { root: HISTORY_ROOT, query, totalMatches: 0, files };
  }

  const needle = query.toLocaleLowerCase();
  let totalMatches = 0;
  const matches = [];
  for (const file of files) {
    const filePath = safeResolveHistoryPath(file.path);
    let text = "";
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const count = countOccurrences(text.toLocaleLowerCase(), needle);
    if (count > 0) {
      totalMatches += count;
      matches.push({ ...file, matchCount: count });
    }
  }
  return { root: HISTORY_ROOT, query, totalMatches, files: matches };
}

async function saveManualTitle(req, url) {
  if (req.method !== "POST") throw httpError(405, "Method not allowed");
  const relPath = url.searchParams.get("path");
  const filePath = safeResolveHistoryPath(relPath);
  const body = await readJsonBody(req);
  const title = sanitizeManualTitle(body.title || "");
  if (!title) throw httpError(400, "Title is required");

  const text = await fs.readFile(filePath, "utf8");
  const parsed = parseClaudeJsonl(text);
  const name = path.basename(relPath);
  const existing = titleCache[name] || {};
  titleCache[name] = {
    ...existing,
    title,
    path: relPath,
    firstQuestion: existing.firstQuestion || findFirstUserQuestion(parsed.messages),
    model: "manual",
    manual: true,
    updatedAt: new Date().toISOString(),
  };
  await writeTitleCache();
  cachedFiles = null;
  return { path: relPath, name, title };
}

async function scanHistoryFiles() {
  const files = [];
  await walk(HISTORY_ROOT, files);
  files.sort((a, b) => {
    const aTime = Date.parse(a.startedAt || a.modifiedAt || "") || 0;
    const bTime = Date.parse(b.startedAt || b.modifiedAt || "") || 0;
    return bTime - aTime || a.path.localeCompare(b.path);
  });
  return files;
}

async function walk(dir, out) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (dir === HISTORY_ROOT) throw error;
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "memory") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, out);
    } else if (entry.isFile() && shouldIncludeHistoryFile(entry.name)) {
      const relPath = toPosix(path.relative(HISTORY_ROOT, fullPath));
      const stat = await fs.stat(fullPath);
      const parsed = await parseFileLight(fullPath);
      out.push(await fileInfo(fullPath, relPath, stat, parsed));
    }
  }
}

function shouldIncludeHistoryFile(name) {
  if (name === "sessions-index.json") return false;
  if (/\.meta\.json$/i.test(name)) return false;
  return /\.(jsonl|json|md|txt)$/i.test(name);
}

async function parseFileLight(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return parseClaudeJsonl(text);
  } catch (error) {
    return {
      messages: [{
        id: "parse-error-1",
        role: "system",
        kind: "parse_error",
        timestamp: null,
        text: error.message,
      }],
      meta: {},
    };
  }
}

async function fileInfo(filePath, relPath, stat, parsed) {
  const name = path.basename(relPath);
  const cached = titleCache[name];
  const firstQuestion = findFirstUserQuestion(parsed.messages);
  const startedAt = findStartedAt(parsed.messages, stat);
  return {
    path: relPath,
    name,
    title: cached?.title || fallbackTitle(firstQuestion, name),
    treeSegments: treeSegmentsFor(relPath),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    startedAt,
    messageCount: parsed.messages.filter((m) => !m.hidden).length,
    workingDirectory: parsed.meta.cwd || "",
    project: projectNameFromPath(relPath),
  };
}

function parseClaudeJsonl(text) {
  const messages = [];
  const meta = {};
  const lines = text.split(/\r?\n/).filter(Boolean);

  lines.forEach((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      messages.push({
        id: `parse-error-${index + 1}`,
        role: "system",
        kind: "parse_error",
        timestamp: null,
        text: `第 ${index + 1} 行解析失败：${error.message}`,
      });
      return;
    }

    if (record.cwd && !meta.cwd) meta.cwd = record.cwd;
    if (record.sessionId && !meta.sessionId) meta.sessionId = record.sessionId;
    if (record.version && !meta.version) meta.version = record.version;

    const base = {
      id: record.uuid || record.message?.id || `${record.type || "line"}-${index + 1}`,
      timestamp: record.timestamp || null,
    };

    if (record.type === "user") {
      const normalized = normalizeContent(record.message?.content);
      if (normalized.toolResults.length) {
        normalized.toolResults.forEach((tool, toolIndex) => {
          messages.push({
            ...base,
            id: `${base.id}-tool-result-${toolIndex}`,
            role: "tool",
            kind: "function_output",
            name: tool.toolUseId || "tool_result",
            text: tool.text,
          });
        });
      }
      if (normalized.text.trim()) {
        messages.push({ ...base, role: "user", kind: "message", text: normalized.text });
      }
      return;
    }

    if (record.type === "assistant") {
      const content = Array.isArray(record.message?.content) ? record.message.content : [];
      const textParts = [];
      content.forEach((part, partIndex) => {
        if (part?.type === "text" && part.text) textParts.push(part.text);
        if (part?.type === "thinking" && part.thinking) {
          messages.push({
            ...base,
            id: `${base.id}-thinking-${partIndex}`,
            role: "assistant",
            kind: "message",
            text: part.thinking,
            hidden: true,
          });
        }
        if (part?.type === "tool_use") {
          messages.push({
            ...base,
            id: part.id || `${base.id}-tool-${partIndex}`,
            role: "tool",
            kind: "function_call",
            name: part.name || "tool",
            text: formatToolInput(part.input),
          });
        }
      });
      if (typeof record.message?.content === "string") textParts.push(record.message.content);
      if (textParts.join("\n\n").trim()) {
        messages.push({ ...base, role: "assistant", kind: "message", text: textParts.join("\n\n") });
      }
      return;
    }

    const textValue = summarizeSystemRecord(record);
    messages.push({
      ...base,
      role: "system",
      kind: record.type === "summary" ? "message" : "message",
      name: record.type || "system",
      text: textValue,
      hidden: true,
    });
  });

  return { messages, meta };
}

function normalizeContent(content) {
  if (typeof content === "string") return { text: content, toolResults: [] };
  if (!Array.isArray(content)) return { text: "", toolResults: [] };
  const text = [];
  const toolResults = [];
  content.forEach((part) => {
    if (part?.type === "text" && part.text) text.push(part.text);
    if (part?.type === "tool_result") {
      toolResults.push({
        toolUseId: part.tool_use_id || part.toolUseId || "",
        text: typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "", null, 2),
      });
    }
  });
  return { text: text.join("\n\n"), toolResults };
}

function formatToolInput(input) {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

function summarizeSystemRecord(record) {
  if (record.type === "permission-mode") return `权限模式：${record.permissionMode || ""}`;
  if (record.type === "file-history-snapshot") return "文件历史快照";
  if (record.type === "summary") return record.summary || JSON.stringify(record, null, 2);
  if (record.type === "attachment") return record.displayPath || record.filePath || "附件";
  return JSON.stringify(record, null, 2);
}

function safeResolveHistoryPath(relPath) {
  if (!relPath || path.isAbsolute(relPath)) throw httpError(400, "Missing or invalid path");
  const resolved = path.resolve(HISTORY_ROOT, relPath);
  const relative = path.relative(HISTORY_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(403, "Path is outside history root");
  }
  return resolved;
}

function treeSegmentsFor(relPath) {
  const parts = relPath.split("/");
  if (/^\d{4}$/.test(parts[0]) && /^\d{2}$/.test(parts[1] || "") && /^\d{2}$/.test(parts[2] || "")) {
    return [`${parts[0]} 年`, `${parts[1]} 月`, `${parts[2]} 日`];
  }
  return parts.slice(0, -1).map(humanProjectName);
}

function projectNameFromPath(relPath) {
  const first = relPath.split("/")[0] || "";
  if (/^\d{4}$/.test(first)) return "";
  return humanProjectName(first);
}

function humanProjectName(segment) {
  if (!segment) return "根目录";
  if (segment.startsWith("-")) {
    const parts = segment.slice(1).split("-").filter(Boolean);
    if (parts.length >= 3) return `/${parts.join("/")}`;
  }
  return segment;
}

function fallbackTitle(firstQuestion, name) {
  if (firstQuestion) return trimTitle(firstQuestion);
  return name.replace(/\.(jsonl|json|md|txt)$/i, "");
}

function trimTitle(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 18) return cleaned;
  return `${cleaned.slice(0, 18)}...`;
}

function findFirstUserQuestion(messages) {
  const msg = messages.find((item) => item.role === "user" && item.kind === "message" && item.text?.trim());
  return msg?.text?.trim() || "";
}

function findStartedAt(messages, stat) {
  const msg = messages.find((item) => item.timestamp);
  return msg?.timestamp || stat.birthtime?.toISOString?.() || stat.mtime.toISOString();
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count += 1;
    pos += needle.length;
  }
  return count;
}

async function readTitleCache() {
  try {
    return JSON.parse(await fs.readFile(TITLES_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeTitleCache() {
  await fs.writeFile(TITLES_FILE, `${JSON.stringify(titleCache, null, 2)}\n`);
}

function startTitleGeneration() {
  if (titleGenerationStarted) return;
  titleGenerationStarted = true;
  generateMissingTitles().catch((error) => {
    console.error("Title generation failed:", error.message);
  });
}

async function generateMissingTitles() {
  const files = await getFiles();
  const pending = await findPendingTitleFiles(files);
  console.log(`DeepSeek title generation: ${pending.length} sessions pending`);
  if (!TITLE_API_KEY) {
    console.log("DeepSeek title generation skipped: no API key configured");
    return;
  }

  for (const item of pending) {
    try {
      const title = await generateChineseTitle(item.firstQuestion);
      titleCache[item.file.name] = {
        title,
        path: item.file.path,
        firstQuestion: item.firstQuestion,
        model: TITLE_MODEL,
        updatedAt: new Date().toISOString(),
      };
      await writeTitleCache();
      console.log(`Title cached: ${item.file.name} -> ${title}`);
      cachedFiles = null;
    } catch (error) {
      console.error(`Generate title failed for ${item.file.path}:`, error.message);
    }
  }
}

async function findPendingTitleFiles(files) {
  const pending = [];
  for (const file of files) {
    if (titleCache[file.name]?.title) continue;
    const session = await getSession(new URL(`http://local/api/session?path=${encodeURIComponent(file.path)}`));
    const firstQuestion = findFirstUserQuestion(session.messages);
    if (firstQuestion) pending.push({ file, firstQuestion });
  }
  return pending;
}

function generateChineseTitle(firstQuestion) {
  const body = JSON.stringify({
    model: TITLE_MODEL,
    messages: [
      {
        role: "system",
        content: "你只输出一个简洁易懂的中文标题，用来概括一段 AI 对话的主题。不要解释，不要加引号，尽量不超过12个汉字。",
      },
      { role: "user", content: firstQuestion.slice(0, 2000) },
    ],
    thinking: { type: "disabled" },
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TITLE_API_KEY}`,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`DeepSeek HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const title = sanitizeTitle(parsed.choices?.[0]?.message?.content || "");
            if (!title) reject(new Error("Empty title"));
            else resolve(title);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("DeepSeek request timed out")));
    req.write(body);
    req.end();
  });
}

function sanitizeTitle(title) {
  return title.replace(/^["'“”‘’\s]+|["'“”‘’\s。！？!?,，、：:；;]+$/g, "").slice(0, 24);
}

function sanitizeManualTitle(title) {
  return String(title).replace(/\s+/g, " ").trim().slice(0, 80);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 32 * 1024) {
        reject(httpError(413, "Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(httpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(urlPath, res) {
  const pathname = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const relative = path.relative(PUBLIC_DIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return sendJson(res, { error: "Forbidden" }, 403);
  }
  try {
    const data = await fs.readFile(resolved);
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(resolved)] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, { error: "Not found" }, 404);
  }
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
