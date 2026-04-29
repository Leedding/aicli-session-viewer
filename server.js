import http from "node:http";
import https from "node:https";
import { watch } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5178);
const DEFAULT_SOURCE = normalizeSourceId(process.env.AI_HISTORY_SOURCE || "claude");
const SOURCES = {
  claude: {
    id: "claude",
    label: "Claude",
    root: path.resolve(
      process.env.AI_HISTORY_ROOT ||
        process.env.CLAUDE_HISTORY_ROOT ||
        path.join(process.env.HOME || "", ".claude", "projects"),
    ),
    parser: parseClaudeJsonl,
    supportsProjectView: true,
  },
  codex: {
    id: "codex",
    label: "Codex",
    root: path.resolve(
      process.env.CODEX_SESSION_ROOT ||
        path.join(process.env.HOME || "", ".codex", "sessions"),
    ),
    parser: parseCodexJsonl,
    supportsProjectView: false,
  },
};
const TITLES_FILE = path.join(__dirname, "titles.json");
const CODEX_LEGACY_TITLES_FILE = path.resolve(__dirname, "..", "codex_history_chat", "titles.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const TITLE_MODEL = process.env.AI_HISTORY_TITLE_MODEL || process.env.CLAUDE_HISTORY_TITLE_MODEL || "deepseek-v4-flash";
const TITLE_API_KEY =
  process.env.CLAUDE_HISTORY_DEEPSEEK_API_KEY ||
  process.env.CODEX_HISTORY_DEEPSEEK_API_KEY ||
  process.env.codex_history_deepseek_api_key ||
  process.env["codex-history_deepseek_api_key"] ||
  "";

let titleCache = {};
const cachedFilesBySource = new Map();
let titleGenerationStarted = false;
let titleGenerationRunning = false;
let titleGenerationQueued = false;
let historyRefreshTimer = null;
let historyRefreshRunning = false;
let historyRefreshQueued = false;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function main() {
  titleCache = await readTitleCache();
  await refreshFiles(getDefaultSource());

  const server = http.createServer(handleRequest);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`AI history viewer: http://127.0.0.1:${PORT}`);
    Object.values(SOURCES).forEach((source) => {
      console.log(`Reading ${source.label} sessions from: ${source.root}`);
    });
    startHistoryWatcher();
    startTitleGeneration();
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const source = sourceFromUrl(url);
    if (url.pathname === "/api/tree") return sendJson(res, await getTree(source));
    if (url.pathname === "/api/session") return sendJson(res, await getSession(url, source));
    if (url.pathname === "/api/search") return sendJson(res, await search(url, source));
    if (url.pathname === "/api/title") return sendJson(res, await saveManualTitle(req, url, source));
    if (url.pathname === "/api/refresh") {
      await refreshFiles(source);
      return sendJson(res, await getTree(source));
    }
    return serveStatic(url.pathname, res);
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, { error: error.message || "Internal server error" }, status);
  }
}

function getDefaultSource() {
  return SOURCES[DEFAULT_SOURCE] || SOURCES.claude;
}

function normalizeSourceId(value) {
  return value === "codex" ? "codex" : "claude";
}

function sourceFromUrl(url) {
  return SOURCES[normalizeSourceId(url.searchParams.get("source") || DEFAULT_SOURCE)] || SOURCES.claude;
}

async function refreshFiles(source) {
  const files = await scanHistoryFiles(source);
  cachedFilesBySource.set(source.id, files);
  return files;
}

function startHistoryWatcher() {
  for (const source of Object.values(SOURCES)) {
    try {
      const watcher = watch(source.root, { recursive: true }, (eventType, filename) => {
        if (!shouldHandleHistoryWatchEvent(filename)) return;
        scheduleHistoryRefresh(source, `${eventType}: ${filename || source.root}`);
      });
      watcher.on("error", (error) => {
        console.error(`${source.label} history watcher error:`, error.message);
      });
      console.log(`${source.label} history file watcher: enabled`);
    } catch (error) {
      console.error(`${source.label} history file watcher disabled:`, error.message);
    }
  }
}

function shouldHandleHistoryWatchEvent(filename) {
  if (!filename) return true;
  const name = path.basename(String(filename));
  if (!name || name.startsWith(".") || name === "memory") return false;
  return shouldIncludeHistoryFile(null, name) || !path.extname(name);
}

function scheduleHistoryRefresh(source, reason) {
  clearTimeout(historyRefreshTimer);
  historyRefreshTimer = setTimeout(() => {
    refreshHistoryFromWatch(source, reason).catch((error) => {
      console.error("History refresh failed:", error.message);
    });
  }, 500);
}

async function refreshHistoryFromWatch(source, reason) {
  if (historyRefreshRunning) {
    historyRefreshQueued = true;
    return;
  }
  historyRefreshRunning = true;
  try {
    const before = cachedFilesBySource.get(source.id)?.length || 0;
    const files = await refreshFiles(source);
    console.log(`${source.label} history refreshed: ${files.length} sessions (${before} before, ${reason})`);
    if (TITLE_API_KEY) await generateMissingTitles({ source, logNoPending: false, logSkip: false });
  } finally {
    historyRefreshRunning = false;
    if (historyRefreshQueued) {
      historyRefreshQueued = false;
      await refreshHistoryFromWatch(source, "queued changes");
    }
  }
}

async function getFiles(source) {
  if (!cachedFilesBySource.has(source.id)) return refreshFiles(source);
  return cachedFilesBySource.get(source.id);
}

async function getTree(source) {
  return {
    source: source.id,
    sourceLabel: source.label,
    root: source.root,
    supportsProjectView: source.supportsProjectView,
    sources: Object.values(SOURCES).map((item) => ({
      id: item.id,
      label: item.label,
      supportsProjectView: item.supportsProjectView,
    })),
    files: await getFiles(source),
  };
}

async function getSession(url, source) {
  const relPath = url.searchParams.get("path");
  const filePath = safeResolveHistoryPath(source, relPath);
  const stat = await fs.stat(filePath);
  const text = await fs.readFile(filePath, "utf8");
  const parsed = source.parser(text);
  const info = await fileInfo(source, relPath, stat, parsed);
  return {
    ...info,
    rawLineCount: text.split(/\r?\n/).filter(Boolean).length,
    meta: parsed.meta,
    messages: parsed.messages,
  };
}

async function search(url, source) {
  const query = (url.searchParams.get("q") || "").trim();
  const files = await getFiles(source);
  if (!query) {
    return { root: source.root, query, totalMatches: 0, files };
  }

  const needle = query.toLocaleLowerCase();
  let totalMatches = 0;
  const matches = [];
  for (const file of files) {
    const filePath = safeResolveHistoryPath(source, file.path);
    let parsed;
    try {
      parsed = source.parser(await fs.readFile(filePath, "utf8"));
    } catch {
      continue;
    }
    const count = parsed.messages
      .filter((message) => !message.hidden)
      .reduce((total, message) => total + countOccurrences(String(message.text || "").toLocaleLowerCase(), needle), 0);
    if (count > 0) {
      totalMatches += count;
      matches.push({ ...file, matchCount: count });
    }
  }
  return { root: source.root, query, totalMatches, files: matches };
}

async function saveManualTitle(req, url, source) {
  if (req.method !== "POST") throw httpError(405, "Method not allowed");
  const relPath = url.searchParams.get("path");
  const filePath = safeResolveHistoryPath(source, relPath);
  const body = await readJsonBody(req);
  const title = sanitizeManualTitle(body.title || "");
  if (!title) throw httpError(400, "Title is required");

  const text = await fs.readFile(filePath, "utf8");
  const parsed = source.parser(text);
  const name = path.basename(relPath);
  const key = titleCacheKey(source, name);
  const existing = getTitleCache(source, name) || {};
  titleCache[key] = {
    ...existing,
    title,
    path: relPath,
    source: source.id,
    firstQuestion: existing.firstQuestion || findFirstUserQuestion(parsed.messages),
    model: "manual",
    manual: true,
    updatedAt: new Date().toISOString(),
  };
  await writeTitleCache();
  cachedFilesBySource.delete(source.id);
  return { path: relPath, name, title };
}

async function scanHistoryFiles(source) {
  const files = [];
  await walk(source, source.root, files);
  files.sort((a, b) => {
    const aTime = Date.parse(a.startedAt || a.modifiedAt || "") || 0;
    const bTime = Date.parse(b.startedAt || b.modifiedAt || "") || 0;
    return bTime - aTime || a.path.localeCompare(b.path);
  });
  return files;
}

async function walk(source, dir, out) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (dir === source.root) throw error;
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "memory") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(source, fullPath, out);
    } else if (entry.isFile() && shouldIncludeHistoryFile(source, entry.name)) {
      const relPath = toPosix(path.relative(source.root, fullPath));
      const stat = await fs.stat(fullPath);
      const parsed = await parseFileLight(source, fullPath);
      out.push(await fileInfo(source, relPath, stat, parsed));
    }
  }
}

function shouldIncludeHistoryFile(source, name) {
  if (name === "sessions-index.json") return false;
  if (/\.meta\.json$/i.test(name)) return false;
  if (source?.id === "codex") return /\.jsonl$/i.test(name);
  return /\.(jsonl|json|md|txt)$/i.test(name);
}

async function parseFileLight(source, filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return source.parser(text);
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

async function fileInfo(source, relPath, stat, parsed) {
  const name = path.basename(relPath);
  const cached = getTitleCache(source, name);
  const firstQuestion = findFirstUserQuestion(parsed.messages);
  const startedAt = source.id === "codex"
    ? parseCodexStartTime(name) || findStartedAt(parsed.messages, stat)
    : findStartedAt(parsed.messages, stat);
  return {
    source: source.id,
    path: relPath,
    name,
    title: cached?.title || fallbackTitle(firstQuestion, name),
    treeSegments: source.supportsProjectView ? treeSegmentsFor(relPath) : [],
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    startedAt,
    messageCount: parsed.messages.filter((m) => !m.hidden).length,
    workingDirectory: parsed.meta.cwd || "",
    project: source.supportsProjectView ? projectNameFromPath(relPath) : "",
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

function parseCodexJsonl(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const messages = [];
  const meta = {};

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

    const payload = record.payload || {};
    if (record.type === "session_meta") {
      Object.assign(meta, payload);
      return;
    }
    if (record.type !== "response_item") return;

    const base = {
      id: payload.id || payload.call_id || `${payload.type || "line"}-${index + 1}`,
      timestamp: record.timestamp || null,
    };

    if (payload.type === "message") {
      const textValue = codexContentToText(payload.content).trim();
      if (!textValue || !["user", "assistant"].includes(payload.role)) return;
      messages.push({
        ...base,
        role: payload.role,
        kind: "message",
        text: textValue,
        hidden: isCodexInternalText(textValue),
      });
      return;
    }

    if (payload.type === "function_call") {
      messages.push({
        ...base,
        role: "tool",
        kind: "function_call",
        name: payload.name || "tool",
        text: compactCodexCommand(payload.arguments),
      });
      return;
    }

    if (payload.type === "function_call_output") {
      messages.push({
        ...base,
        role: "tool",
        kind: "function_output",
        name: payload.call_id || "output",
        text: String(payload.output || "").trim(),
      });
    }
  });

  return { messages, meta };
}

function codexContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      return part.text || part.input_text || part.output_text || "";
    })
    .filter(Boolean)
    .join("\n");
}

function compactCodexCommand(args) {
  try {
    const parsed = JSON.parse(args);
    return parsed.cmd || JSON.stringify(parsed, null, 2);
  } catch {
    return String(args || "");
  }
}

function isCodexInternalText(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<collaboration_mode>") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<plugins_instructions>") ||
    trimmed.startsWith("<apps_instructions>");
}

function parseCodexStartTime(name) {
  const match = name.match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  return match ? match[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3") : "";
}

function safeResolveHistoryPath(source, relPath) {
  if (!relPath || path.isAbsolute(relPath)) throw httpError(400, "Missing or invalid path");
  const resolved = path.resolve(source.root, relPath);
  const relative = path.relative(source.root, resolved);
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
  const msg = messages.find((item) => !item.hidden && item.role === "user" && item.kind === "message" && item.text?.trim());
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

function titleCacheKey(source, name) {
  return `${source.id}:${name}`;
}

function getTitleCache(source, name) {
  const namespaced = titleCache[titleCacheKey(source, name)];
  if (namespaced) return namespaced;
  const legacy = titleCache[name];
  if (!legacy) return null;
  if (legacy.source && legacy.source !== source.id) return null;
  return source.id === "claude" || legacy.source === source.id ? legacy : null;
}

async function readTitleCache() {
  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(TITLES_FILE, "utf8"));
  } catch {
    cache = {};
  }
  return mergeLegacyCodexTitleCache(cache);
}

async function mergeLegacyCodexTitleCache(cache) {
  let legacy = {};
  try {
    legacy = JSON.parse(await fs.readFile(CODEX_LEGACY_TITLES_FILE, "utf8"));
  } catch {
    return cache;
  }

  let merged = 0;
  for (const [name, value] of Object.entries(legacy)) {
    const key = titleCacheKey(SOURCES.codex, name);
    if (cache[key]?.title || !value?.title) continue;
    cache[key] = {
      ...value,
      source: "codex",
    };
    merged += 1;
  }
  if (merged > 0) {
    await fs.writeFile(TITLES_FILE, `${JSON.stringify(cache, null, 2)}\n`);
    console.log(`Imported ${merged} Codex titles from ${CODEX_LEGACY_TITLES_FILE}`);
  }
  return cache;
}

async function writeTitleCache() {
  await fs.writeFile(TITLES_FILE, `${JSON.stringify(titleCache, null, 2)}\n`);
}

function startTitleGeneration() {
  if (titleGenerationStarted) return;
  titleGenerationStarted = true;
  generateMissingTitlesForAllSources({ logNoPending: true, logSkip: true }).catch((error) => {
    console.error("Title generation failed:", error.message);
  });
}

async function generateMissingTitlesForAllSources(options = {}) {
  for (const source of Object.values(SOURCES)) {
    await generateMissingTitles({ source, ...options });
  }
}

async function generateMissingTitles(options = {}) {
  const { source = getDefaultSource(), logNoPending = true, logSkip = true } = options;
  if (titleGenerationRunning) {
    titleGenerationQueued = true;
    return;
  }
  titleGenerationRunning = true;
  try {
    await generateMissingTitlesOnce({ source, logNoPending, logSkip });
  } finally {
    titleGenerationRunning = false;
    if (titleGenerationQueued) {
      titleGenerationQueued = false;
      await generateMissingTitles({ source, logNoPending: false, logSkip: false });
    }
  }
}

async function generateMissingTitlesOnce({ source, logNoPending, logSkip }) {
  const files = await getFiles(source);
  const pending = await findPendingTitleFiles(source, files);
  if (logNoPending || pending.length > 0) {
    console.log(`${source.label} DeepSeek title generation: ${pending.length} sessions pending`);
  }
  if (!TITLE_API_KEY) {
    if (logSkip) console.log("DeepSeek title generation skipped: no API key configured");
    return;
  }

  for (const item of pending) {
    try {
      const title = await generateChineseTitle(item.firstQuestion);
      titleCache[titleCacheKey(source, item.file.name)] = {
        title,
        path: item.file.path,
        source: source.id,
        firstQuestion: item.firstQuestion,
        model: TITLE_MODEL,
        updatedAt: new Date().toISOString(),
      };
      await writeTitleCache();
      console.log(`${source.label} title cached: ${item.file.name} -> ${title}`);
      cachedFilesBySource.delete(source.id);
    } catch (error) {
      console.error(`Generate title failed for ${item.file.path}:`, error.message);
    }
  }
}

async function findPendingTitleFiles(source, files) {
  const pending = [];
  for (const file of files) {
    if (getTitleCache(source, file.name)?.title) continue;
    const session = await getSession(new URL(`http://local/api/session?path=${encodeURIComponent(file.path)}`), source);
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
