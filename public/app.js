const state = {
  tree: null,
  files: [],
  activePath: "",
  query: "",
  showSystem: false,
  toolsExpanded: false,
  viewMode: "time",
  timeOrder: "desc",
  collapsedGroups: new Set(),
};

const rootPath = document.querySelector("#rootPath");
const treeEl = document.querySelector("#tree");
const projectView = document.querySelector("#projectView");
const timeView = document.querySelector("#timeView");
const timeOrderIcon = document.querySelector("#timeOrderIcon");
const searchInput = document.querySelector("#searchInput");
const searchSummary = document.querySelector("#searchSummary");
const sessionTitle = document.querySelector("#sessionTitle");
const sessionPath = document.querySelector("#sessionPath");
const sessionMeta = document.querySelector("#sessionMeta");
const chat = document.querySelector("#chat");
const refreshButton = document.querySelector("#refreshButton");
const toggleTools = document.querySelector("#toggleTools");
const toggleSystem = document.querySelector("#toggleSystem");
const scrollTopButton = document.querySelector("#scrollTop");
const scrollBottomButton = document.querySelector("#scrollBottom");

searchInput.addEventListener("input", debounce(async () => {
  state.query = searchInput.value.trim();
  if (!state.query) {
    state.files = state.tree.files;
    searchSummary.textContent = "";
    renderTree();
    return;
  }
  const result = await fetchJson(`/api/search?q=${encodeURIComponent(state.query)}`);
  state.files = result.files;
  searchSummary.textContent = `共匹配 ${result.totalMatches} 处，${result.files.length} 个会话`;
  renderTree();
}, 220));

projectView.addEventListener("click", () => setViewMode("project"));
timeView.addEventListener("click", () => {
  if (state.viewMode === "time") {
    state.timeOrder = state.timeOrder === "desc" ? "asc" : "desc";
  }
  setViewMode("time");
});

toggleSystem.addEventListener("click", () => {
  state.showSystem = !state.showSystem;
  chat.classList.toggle("show-system", state.showSystem);
  toggleSystem.textContent = state.showSystem ? "隐藏系统消息" : "显示系统消息";
});

toggleTools.addEventListener("click", () => {
  state.toolsExpanded = !state.toolsExpanded;
  updateToolDetails();
  updateToolButton();
});

refreshButton.addEventListener("click", () => {
  refreshPageData().catch((error) => {
    chat.textContent = "";
    chat.append(el("div", { class: "empty" }, `刷新失败：${error.message}`));
  });
});

sessionTitle.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    sessionTitle.blur();
  }
});

sessionTitle.addEventListener("blur", () => {
  saveSessionTitle().catch((error) => {
    sessionTitle.textContent = sessionTitle.dataset.savedTitle || "选择一个会话";
    chat.append(el("div", { class: "empty" }, `标题保存失败：${error.message}`));
  });
});

scrollTopButton.addEventListener("click", () => {
  chat.scrollTo({ top: 0, behavior: "smooth" });
});

scrollBottomButton.addEventListener("click", () => {
  chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" });
});

await init();

async function init() {
  state.tree = await fetchJson("/api/tree");
  state.files = state.tree.files;
  rootPath.textContent = state.tree.root;
  updateViewControls();
  updateToolButton();
  renderTree();
  if (state.files[0]) loadSession(state.files[0].path);
}

async function refreshPageData() {
  const previousPath = state.activePath;
  refreshButton.disabled = true;
  refreshButton.textContent = "刷新中";
  try {
    state.tree = await fetchJson("/api/refresh");
    rootPath.textContent = state.tree.root;
    await refreshVisibleFiles();
    renderTree();
    const nextPath = state.files.some((file) => file.path === previousPath)
      ? previousPath
      : state.tree.files.find((file) => file.path === previousPath)?.path || state.files[0]?.path || "";
    if (nextPath) await loadSession(nextPath);
    else {
      state.activePath = "";
      chat.textContent = "";
      chat.append(el("div", { class: "empty" }, "没有可展示的会话"));
    }
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "刷新";
  }
}

async function refreshVisibleFiles() {
  if (!state.query) {
    state.files = state.tree.files;
    searchSummary.textContent = "";
    return;
  }
  const result = await fetchJson(`/api/search?q=${encodeURIComponent(state.query)}`);
  state.files = result.files;
  searchSummary.textContent = `共匹配 ${result.totalMatches} 处，${result.files.length} 个会话`;
}

function setViewMode(mode) {
  state.viewMode = mode;
  updateViewControls();
  renderTree();
}

function updateViewControls() {
  projectView.classList.toggle("active", state.viewMode === "project");
  timeView.classList.toggle("active", state.viewMode === "time");
  timeView.title = state.timeOrder === "desc" ? "时间倒序，点击切换为正序" : "时间正序，点击切换为倒序";
  timeOrderIcon.textContent = state.timeOrder === "desc" ? "▼" : "▲";
}

function renderTree() {
  treeEl.textContent = "";
  if (!state.files.length) {
    treeEl.append(el("div", { class: "empty" }, "没有匹配的会话"));
    return;
  }
  const root = buildTree(state.files);
  renderNode(root, treeEl);
}

function buildTree(files) {
  const root = { children: new Map(), files: [] };
  for (const file of files) {
    let node = root;
    for (const segment of segmentsForFile(file)) {
      if (!node.children.has(segment)) node.children.set(segment, { label: segment, children: new Map(), files: [] });
      node = node.children.get(segment);
    }
    node.files.push(file);
  }
  return root;
}

function segmentsForFile(file) {
  if (state.viewMode !== "time") return file.treeSegments || [];
  const date = new Date(file.startedAt || file.modifiedAt);
  if (Number.isNaN(date.getTime())) return ["未知时间"];
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [`${year} 年`, `${month} 月`, `${day} 日`];
}

function renderNode(node, container, groupPath = "") {
  const groups = [...node.children.values()].sort((a, b) => sortGroupLabel(a.label, b.label));
  for (const group of groups) {
    const currentPath = groupPath ? `${groupPath}/${group.label}` : group.label;
    const collapsed = state.collapsedGroups.has(currentPath);
    const wrapper = el("div", { class: "tree-group" });
    const toggle = el("button", {
      class: "tree-label",
      type: "button",
      "aria-expanded": String(!collapsed),
      title: collapsed ? "展开" : "收起",
    });
    toggle.append(el("span", { class: "tree-caret" }, collapsed ? "▶" : "▼"));
    toggle.append(el("span", {}, group.label));
    toggle.addEventListener("click", () => {
      if (state.collapsedGroups.has(currentPath)) state.collapsedGroups.delete(currentPath);
      else state.collapsedGroups.add(currentPath);
      renderTree();
    });
    wrapper.append(toggle);
    const children = el("div", { class: `tree-children${collapsed ? " collapsed" : ""}` });
    renderNode(group, children, currentPath);
    wrapper.append(children);
    container.append(wrapper);
  }
  const files = [...node.files].sort(sortFiles);
  for (const file of files) {
    const button = el("button", {
      class: `file-button${file.path === state.activePath ? " active" : ""}`,
      type: "button",
      title: file.path,
    });
    button.append(el("div", { class: "file-title" }, file.title));
    const subtitle = file.matchCount
      ? `匹配结果 ${file.matchCount} 处`
      : `${formatDate(file.startedAt || file.modifiedAt)} · ${formatSize(file.size)}`;
    button.append(el("div", { class: "file-subtitle" }, subtitle));
    button.addEventListener("click", () => loadSession(file.path));
    container.append(button);
  }
}

function sortGroupLabel(a, b) {
  if (state.viewMode === "time") {
    const result = a.localeCompare(b, "zh-Hans-CN", { numeric: true });
    return state.timeOrder === "desc" ? -result : result;
  }
  return a.localeCompare(b, "zh-Hans-CN");
}

function sortFiles(a, b) {
  const result = (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0);
  if (state.viewMode === "time") return state.timeOrder === "desc" ? -result : result;
  return -result;
}

async function loadSession(path) {
  state.activePath = path;
  renderTree();
  chat.textContent = "";
  chat.append(el("div", { class: "empty" }, "加载中..."));

  const session = await fetchJson(`/api/session?path=${encodeURIComponent(path)}`);
  sessionTitle.textContent = session.title;
  sessionTitle.dataset.savedTitle = session.title;
  sessionPath.textContent = session.path;
  const meta = [
    `${session.messages.filter((m) => !m.hidden).length} 条消息`,
    formatSize(session.size),
    session.workingDirectory ? `工作目录：${session.workingDirectory}` : "",
  ].filter(Boolean);
  sessionMeta.textContent = meta.join(" · ");

  chat.textContent = "";
  chat.classList.toggle("show-system", state.showSystem);
  for (const message of session.messages) {
    chat.append(renderMessage(message));
  }

  const firstMatch = state.query ? chat.querySelector(".has-match") : null;
  if (firstMatch) firstMatch.scrollIntoView({ block: "center" });
}

async function saveSessionTitle() {
  if (!state.activePath) return;
  const title = sessionTitle.textContent.replace(/\s+/g, " ").trim();
  const previousTitle = sessionTitle.dataset.savedTitle || "";
  if (!title || title === previousTitle) {
    sessionTitle.textContent = previousTitle || "选择一个会话";
    return;
  }

  const result = await fetchJson(`/api/title?path=${encodeURIComponent(state.activePath)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  sessionTitle.textContent = result.title;
  sessionTitle.dataset.savedTitle = result.title;
  updateFileTitle(state.tree.files, result.path, result.title);
  updateFileTitle(state.files, result.path, result.title);
  renderTree();
}

function updateFileTitle(files, path, title) {
  const file = files.find((item) => item.path === path);
  if (file) file.title = title;
}

function renderMessage(message) {
  const row = el("article", {
    class: `message ${message.role}${message.hidden ? " hidden-message" : ""}`,
  });
  const stack = el("div", { class: "message-stack" });
  if (message.timestamp) {
    stack.append(el("div", { class: "message-time" }, formatMessageTime(message.timestamp)));
  }
  const bubble = el("div", { class: `bubble${hasQuery(message.text) ? " has-match" : ""}` });

  if (message.kind === "function_call") {
    const details = el("details", {
      class: "tool-details",
      open: state.toolsExpanded || hasQuery(message.text) ? "open" : null,
    });
    details.append(el("summary", {}, `工具调用：${message.name || "tool"}`));
    details.append(el("pre", {}, highlight(message.text || "")));
    bubble.append(details);
  } else if (message.kind === "function_output") {
    const details = el("details", {
      class: "tool-details",
      open: state.toolsExpanded || hasQuery(message.text) ? "open" : null,
    });
    details.append(el("summary", {}, `工具输出：${message.name || "tool"}`));
    details.append(el("pre", {}, highlight(message.text || "")));
    bubble.append(details);
  } else {
    if (message.name) bubble.append(el("span", { class: "message-name" }, message.name));
    bubble.append(highlight(message.text || ""));
  }

  stack.append(bubble);
  row.append(stack);
  return row;
}

function updateToolDetails() {
  chat.querySelectorAll("details.tool-details").forEach((details) => {
    details.open = state.toolsExpanded;
  });
}

function updateToolButton() {
  toggleTools.textContent = state.toolsExpanded ? "收起工具" : "展开工具";
}

function hasQuery(text) {
  return state.query && String(text || "").toLocaleLowerCase().includes(state.query.toLocaleLowerCase());
}

function highlight(text) {
  const value = String(text || "");
  if (!state.query) return document.createTextNode(value);
  const fragment = document.createDocumentFragment();
  const lower = value.toLocaleLowerCase();
  const needle = state.query.toLocaleLowerCase();
  let pos = 0;
  while (true) {
    const index = lower.indexOf(needle, pos);
    if (index === -1) break;
    fragment.append(document.createTextNode(value.slice(pos, index)));
    fragment.append(el("mark", {}, value.slice(index, index + needle.length)));
    pos = index + needle.length;
  }
  fragment.append(document.createTextNode(value.slice(pos)));
  return fragment;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child instanceof Node) node.append(child);
    else node.append(document.createTextNode(String(child)));
  }
  return node;
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatMessageTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
