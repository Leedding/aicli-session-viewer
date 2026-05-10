console.log(
`%c         \\/      \\/
         /\\      /\\
     .--------------.
    /   .--------.   \\
   /   |  >    o  |   \\
  |    |   \\__/   |    | %cb
%c   \\   '----------'   /
%co%c  \\                /
     '--------------'
        |        |
       %c===      ===%c`,
  "color: #FF3B30; font-family: monospace; font-weight: bold; font-size: 14px;",
  "color: #FFCC00; font-family: monospace; font-weight: bold; font-size: 14px;",
  "color: #FF3B30; font-family: monospace; font-weight: bold; font-size: 14px;",
  "color: #FFCC00; font-family: monospace; font-weight: bold; font-size: 14px;",
  "color: #FF3B30; font-family: monospace; font-weight: bold; font-size: 14px;",
  "color: #FFCC00; font-family: monospace; font-weight: bold; font-size: 14px;",
  ""
);

const state = {
  tree: null,
  files: [],
  activePath: "",
  treeSignature: "",
  query: "",
  showSystem: false,
  viewMode: "time",
  timeOrder: "desc",
  collapsedGroups: new Set(),
  touchedGroups: new Set(),
  source: "claude",
  sidebarWidth: 340,
  sidebarHidden: false,
  theme: "tokyo",
};

const COLLAPSE_STORAGE_PREFIX = "aiHistoryCollapsedGroups";
const SIDEBAR_WIDTH_STORAGE_KEY = "aiHistorySidebarWidth";
const SIDEBAR_HIDDEN_STORAGE_KEY = "aiHistorySidebarHidden";
const THEME_STORAGE_KEY = "aiHistoryTheme";
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 640;

const sidebar = document.querySelector("#sidebar");
const sidebarResizer = document.querySelector("#sidebarResizer");
const toggleSidebar = document.querySelector("#toggleSidebar");
const rootPath = document.querySelector("#rootPath");
const treeEl = document.querySelector("#tree");
const sourceButtons = [...document.querySelectorAll(".source-switch button")];
const themeToggle = document.querySelector("#themeToggle");
const themePanel = document.querySelector("#themePanel");
const themeButtons = [...document.querySelectorAll(".theme-panel button")];
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
const toggleSystem = document.querySelector("#toggleSystem");
const scrollTopButton = document.querySelector("#scrollTop");
const scrollBottomButton = document.querySelector("#scrollBottom");
let imagePreview = null;
let sidebarDragStart = null;

searchInput.addEventListener("input", debounce(async () => {
  state.query = searchInput.value.trim();
  
  if (state.query === "sudo rm -rf /") {
    document.body.classList.add("glitch-active");
    setTimeout(() => document.body.classList.remove("glitch-active"), 1500);
    state.files = [];
    searchSummary.innerHTML = `<span style="color: red; font-family: monospace; font-weight: bold; font-size: 14px;">[SYSTEM FATAL ERROR] ACCESS DENIED: Nice try, hacker.</span>`;
    renderTree();
    return;
  }
  
  if (!state.query) {
    state.files = state.tree.files;
    searchSummary.textContent = "";
    renderTree();
    return;
  }
  const result = await fetchJson(apiUrl("/api/search", { q: state.query }));
  state.files = result.files;
  searchSummary.textContent = `共匹配 ${result.totalMatches} 处，${result.files.length} 个会话`;
  renderTree();
}, 220));

sourceButtons.forEach((button) => {
  button.addEventListener("click", () => switchSource(button.dataset.source));
});

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
  toggleSystem.textContent = state.showSystem ? "隐藏系统及工具" : "显示系统及工具";
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

toggleSidebar.addEventListener("click", () => setSidebarHidden(!state.sidebarHidden));
sidebarResizer.addEventListener("pointerdown", startSidebarResize);
sidebarResizer.addEventListener("keydown", resizeSidebarWithKeyboard);
window.addEventListener("resize", () => setSidebarWidth(state.sidebarWidth));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeImagePreview();
  if (event.key === "b" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    setSidebarHidden(!state.sidebarHidden);
  }
});

themeToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  themePanel.hidden = !themePanel.hidden;
});

themeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setTheme(button.dataset.theme);
    themePanel.hidden = true;
  });
});

document.addEventListener("click", (e) => {
  if (!themePanel.hidden && !themePanel.contains(e.target) && e.target !== themeToggle) {
    themePanel.hidden = true;
  }
});

loadTheme();
loadSidebarLayout();
await init();

async function init() {
  state.tree = await fetchJson(apiUrl("/api/tree"));
  state.source = state.tree.source || state.source;
  state.files = state.tree.files;
  loadCollapseState();
  updateSourceUi();
  updateViewControls();
  renderTree();
  if (state.files[0]) loadSession(state.files[0].path);
  startAutoRefresh();
}

async function refreshPageData() {
  const previousPath = state.activePath;
  refreshButton.disabled = true;
  refreshButton.textContent = "刷新中";
  try {
    state.tree = await fetchJson(apiUrl("/api/refresh"));
    updateSourceUi();
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

function startAutoRefresh() {
  setInterval(() => {
    refreshTreeInBackground().catch(() => {
      // Manual refresh surfaces errors. Background refresh stays quiet.
    });
  }, 5000);
}

async function refreshTreeInBackground() {
  const previousPath = state.activePath;
  const previousSignature = treeSignature(state.tree.files);
  const nextTree = await fetchJson(apiUrl("/api/refresh"));
  const nextSignature = treeSignature(nextTree.files);
  if (nextSignature === previousSignature) return;

  state.tree = nextTree;
  state.treeSignature = nextSignature;
  updateSourceUi();
  await refreshVisibleFiles();
  renderTree();

  if (!previousPath && state.files[0]) {
    await loadSession(state.files[0].path);
  } else if (previousPath && !state.tree.files.some((file) => file.path === previousPath)) {
    state.activePath = "";
    chat.textContent = "";
    chat.append(el("div", { class: "empty" }, "当前会话文件已不存在"));
  }
}

function treeSignature(files) {
  return files.map((file) => `${file.path}:${file.modifiedAt}:${file.title}`).join("|");
}

async function refreshVisibleFiles() {
  if (!state.query) {
    state.files = state.tree.files;
    searchSummary.textContent = "";
    return;
  }
  const result = await fetchJson(apiUrl("/api/search", { q: state.query }));
  state.files = result.files;
  searchSummary.textContent = `共匹配 ${result.totalMatches} 处，${result.files.length} 个会话`;
}

async function switchSource(source) {
  if (!source || source === state.source) return;
  state.source = source;
  state.activePath = "";
  state.query = "";
  state.viewMode = "time";
  loadCollapseState();
  searchInput.value = "";
  searchSummary.textContent = "";
  chat.textContent = "";
  chat.append(el("div", { class: "empty" }, "加载中..."));
  state.tree = await fetchJson(apiUrl("/api/tree"));
  state.files = state.tree.files;
  updateSourceUi();
  updateViewControls();
  renderTree();
  if (state.files[0]) await loadSession(state.files[0].path);
  else {
    sessionTitle.textContent = "选择一个会话";
    sessionTitle.dataset.savedTitle = "";
    sessionPath.textContent = "";
    sessionMeta.textContent = "";
    chat.textContent = "";
    chat.append(el("div", { class: "empty" }, "没有可展示的会话"));
  }
}

function setViewMode(mode) {
  if (mode === "project" && !state.tree?.supportsProjectView) mode = "time";
  if (mode !== state.viewMode) {
    saveCollapseState();
    state.viewMode = mode;
    loadCollapseState();
  } else {
    state.viewMode = mode;
  }
  updateViewControls();
  renderTree();
}

function updateViewControls() {
  if (!state.tree?.supportsProjectView && state.viewMode === "project") state.viewMode = "time";
  projectView.hidden = !state.tree?.supportsProjectView;
  projectView.classList.toggle("active", state.viewMode === "project");
  projectView.disabled = !state.tree?.supportsProjectView;
  projectView.title = state.tree?.supportsProjectView ? "按项目展示" : "Codex 只按时间展示";
  timeView.classList.toggle("active", state.viewMode === "time");
  timeView.title = state.timeOrder === "desc" ? "时间倒序，点击切换为正序" : "时间正序，点击切换为倒序";
  timeOrderIcon.textContent = state.timeOrder === "desc" ? "▼" : "▲";
}

function updateSourceUi() {
  state.source = state.tree?.source || state.source;
  const label = state.tree?.sourceLabel || (state.source === "codex" ? "Codex" : "Claude");
  document.title = `${label} 历史对话`;
  rootPath.textContent = state.tree?.root || "";
  sourceButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.source === state.source);
  });
}

function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved && themeButtons.some((b) => b.dataset.theme === saved)) {
      state.theme = saved;
    }
  } catch {
    // ignore
  }
  applyTheme();
}

function setTheme(theme) {
  state.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme is a convenience; ignore storage failures.
  }
  applyTheme();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  themeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.theme === state.theme);
  });
}

function loadSidebarLayout() {
  try {
    const savedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(savedWidth)) state.sidebarWidth = clampSidebarWidth(savedWidth);
    state.sidebarHidden = localStorage.getItem(SIDEBAR_HIDDEN_STORAGE_KEY) === "true";
  } catch {
    state.sidebarWidth = clampSidebarWidth(state.sidebarWidth);
    state.sidebarHidden = false;
  }
  applySidebarLayout();
}

function setSidebarHidden(hidden) {
  state.sidebarHidden = hidden;
  try {
    localStorage.setItem(SIDEBAR_HIDDEN_STORAGE_KEY, String(hidden));
  } catch {
    // Sidebar layout is a convenience; ignore storage failures.
  }
  applySidebarLayout();
}

function setSidebarWidth(width) {
  state.sidebarWidth = clampSidebarWidth(width);
  document.documentElement.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(state.sidebarWidth));
  } catch {
    // Sidebar layout is a convenience; ignore storage failures.
  }
}

function applySidebarLayout() {
  setSidebarWidth(state.sidebarWidth);
  document.body.classList.toggle("sidebar-hidden", state.sidebarHidden);
  sidebar.setAttribute("aria-hidden", String(state.sidebarHidden));
}

function startSidebarResize(event) {
  if (state.sidebarHidden || event.button !== 0) return;
  sidebarDragStart = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: state.sidebarWidth,
  };
  sidebarResizer.setPointerCapture(event.pointerId);
  sidebarResizer.classList.add("resizing");
  document.body.classList.add("resizing-sidebar");
  sidebarResizer.addEventListener("pointermove", resizeSidebar);
  sidebarResizer.addEventListener("pointerup", stopSidebarResize);
  sidebarResizer.addEventListener("pointercancel", stopSidebarResize);
  event.preventDefault();
}

function resizeSidebar(event) {
  if (!sidebarDragStart || event.pointerId !== sidebarDragStart.pointerId) return;
  setSidebarWidth(sidebarDragStart.startWidth + event.clientX - sidebarDragStart.startX);
}

function stopSidebarResize(event) {
  if (!sidebarDragStart || event.pointerId !== sidebarDragStart.pointerId) return;
  sidebarDragStart = null;
  sidebarResizer.classList.remove("resizing");
  document.body.classList.remove("resizing-sidebar");
  sidebarResizer.removeEventListener("pointermove", resizeSidebar);
  sidebarResizer.removeEventListener("pointerup", stopSidebarResize);
  sidebarResizer.removeEventListener("pointercancel", stopSidebarResize);
}

function resizeSidebarWithKeyboard(event) {
  if (state.sidebarHidden) return;
  const step = event.shiftKey ? 40 : 16;
  if (event.key === "ArrowLeft") {
    setSidebarWidth(state.sidebarWidth - step);
    event.preventDefault();
  } else if (event.key === "ArrowRight") {
    setSidebarWidth(state.sidebarWidth + step);
    event.preventDefault();
  }
}

function clampSidebarWidth(width) {
  const viewportMax = Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - 360);
  return Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), Math.min(MAX_SIDEBAR_WIDTH, viewportMax));
}

function collapseStorageKey() {
  return `${COLLAPSE_STORAGE_PREFIX}:${state.source}:${state.viewMode}`;
}

function loadCollapseState() {
  state.collapsedGroups.clear();
  state.touchedGroups.clear();
  try {
    const saved = JSON.parse(localStorage.getItem(collapseStorageKey()) || "{}");
    if (Array.isArray(saved.collapsedGroups)) state.collapsedGroups = new Set(saved.collapsedGroups);
    if (Array.isArray(saved.touchedGroups)) state.touchedGroups = new Set(saved.touchedGroups);
  } catch {
    state.collapsedGroups.clear();
    state.touchedGroups.clear();
  }
}

function saveCollapseState() {
  try {
    localStorage.setItem(collapseStorageKey(), JSON.stringify({
      collapsedGroups: [...state.collapsedGroups],
      touchedGroups: [...state.touchedGroups],
    }));
  } catch {
    // Folding state is a convenience; ignore storage failures.
  }
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
    const collapsed = isGroupCollapsed(currentPath, groupPath);
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
      state.touchedGroups.add(currentPath);
      if (collapsed) state.collapsedGroups.delete(currentPath);
      else state.collapsedGroups.add(currentPath);
      saveCollapseState();
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

function isGroupCollapsed(currentPath, groupPath) {
  if (state.touchedGroups.has(currentPath)) return state.collapsedGroups.has(currentPath);
  return state.viewMode === "project" && !groupPath;
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

  const session = await fetchJson(apiUrl("/api/session", { path }));
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

  const result = await fetchJson(apiUrl("/api/title", { path: state.activePath }), {
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
  const isTool = message.kind === "function_call" || message.kind === "function_output";
  const row = el("article", {
    class: `message ${message.role}${message.hidden || isTool ? " hidden-message" : ""}`,
  });
  const stack = el("div", { class: "message-stack" });
  if (message.timestamp) {
    stack.append(el("div", { class: "message-time" }, formatMessageTime(message.timestamp)));
  }
  const bubble = el("div", { class: `bubble${hasQuery(message.text) ? " has-match" : ""}` });

  if (message.kind === "function_call") {
    const details = el("details", {
      class: "tool-details",
      open: null,
    });
    details.append(el("summary", {}, `工具调用：${message.name || "tool"}`));
    details.append(el("pre", {}, highlight(message.text || "")));
    bubble.append(details);
  } else if (message.kind === "function_output") {
    const details = el("details", {
      class: "tool-details",
      open: null,
    });
    details.append(el("summary", {}, `工具输出：${message.name || "tool"}`));
    details.append(el("pre", {}, highlight(message.text || "")));
    bubble.append(details);
  } else {
    if (message.name) bubble.append(el("span", { class: "message-name" }, message.name));
    if (message.text) bubble.append(renderMarkdown(message.text));
    if (Array.isArray(message.images) && message.images.length) {
      bubble.append(renderMessageImages(message.images));
    }
  }

  stack.append(bubble);
  row.append(stack);
  return row;
}

function renderMessageImages(images) {
  const gallery = el("div", { class: "message-images" });
  images.forEach((image, index) => {
    if (!image?.src) return;
    const img = el("img", {
      class: "message-image",
      src: image.src,
      alt: `对话图片 ${index + 1}`,
      loading: "lazy",
    });
    const button = el("button", {
      class: "message-image-button",
      type: "button",
      "aria-label": `放大图片 ${index + 1}`,
    }, img);
    button.addEventListener("click", () => openImagePreview(image.src, img.alt));
    gallery.append(button);
  });
  return gallery;
}

function openImagePreview(src, alt) {
  closeImagePreview();
  imagePreview = el("div", { class: "image-preview", role: "dialog", "aria-modal": "true" },
    el("button", { class: "image-preview-close", type: "button", "aria-label": "关闭图片预览" }, "×"),
    el("img", { class: "image-preview-image", src, alt }),
  );
  imagePreview.addEventListener("click", (event) => {
    if (event.target === imagePreview || event.target.closest(".image-preview-close")) closeImagePreview();
  });
  document.body.append(imagePreview);
  document.body.classList.add("preview-open");
  imagePreview.querySelector(".image-preview-close").focus();
}

function closeImagePreview() {
  if (!imagePreview) return;
  imagePreview.remove();
  imagePreview = null;
  document.body.classList.remove("preview-open");
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

function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([^`]*)$/);
    if (fence) {
      const info = fence[1].trim();
      const lang = /^[\w-]+$/.test(info) ? info : "";
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      
      const codeContent = codeLines.join("\n");
      const isLongCode = codeLines.length > 25;
      const pre = el("pre", { class: `markdown-code ${isLongCode ? 'is-collapsed' : ''}` });
      
      const header = el("div", { class: "markdown-code-header" });
      header.append(el("span", {}, info || "Code"));
      
      const copyBtn = el("button", { class: "copy-button", type: "button", title: "Copy Code" });
      copyBtn.append("Copy");
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(codeContent);
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
        } catch (err) {
          copyBtn.textContent = "Error";
        }
      });
      header.append(copyBtn);
      pre.append(header);
      
      const codeWrapper = el("div", { class: "markdown-code-content" });
      const code = el("code", lang ? { class: `language-${lang}` } : {});
      code.append(highlight(codeContent));
      codeWrapper.append(code);
      pre.append(codeWrapper);
      
      if (isLongCode) {
        const expandBtn = el("button", { class: "code-expand-button", type: "button" });
        expandBtn.append("展开全部代码");
        expandBtn.addEventListener("click", () => {
          const collapsed = pre.classList.contains("is-collapsed");
          if (collapsed) {
            pre.classList.remove("is-collapsed");
            expandBtn.textContent = "收起代码";
          } else {
            pre.classList.add("is-collapsed");
            expandBtn.textContent = "展开全部代码";
          }
        });
        pre.append(expandBtn);
      }
      
      fragment.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const node = el(`h${level}`, { class: "markdown-heading" });
      appendInlineMarkdown(node, heading[2]);
      fragment.append(node);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      fragment.append(el("blockquote", { class: "markdown-quote" }, renderMarkdown(quoteLines.join("\n"))));
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const list = el(ordered ? "ol" : "ul", { class: "markdown-list" });
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
        if (!item || /\d/.test(item[2]) !== ordered) break;
        const li = el("li");
        appendInlineMarkdown(li, item[3]);
        list.append(li);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    if (looksLikeTable(lines, index)) {
      const tableLines = [lines[index]];
      index += 2;
      while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      fragment.append(renderTable(tableLines));
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines, index)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    if (!paragraphLines.length) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = el("p", { class: "markdown-paragraph" });
    appendInlineMarkdown(paragraph, paragraphLines.join("\n"));
    fragment.append(paragraph);
  }

  return el("div", { class: "markdown-body" }, fragment);
}

function isMarkdownBlockStart(lines, index) {
  const line = lines[index];
  return /^```([^`]*)$/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^(\s*)([-*+]|\d+[.)])\s+/.test(line) ||
    looksLikeTable(lines, index);
}

function looksLikeTable(lines, index) {
  return /\|/.test(lines[index] || "") && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[index + 1] || "");
}

function renderTable(lines) {
  const table = el("table", { class: "markdown-table" });
  const [headerLine, ...bodyLines] = lines;
  const thead = el("thead");
  const headerRow = el("tr");
  splitTableRow(headerLine).forEach((cell) => {
    const th = el("th");
    appendInlineMarkdown(th, cell);
    headerRow.append(th);
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = el("tbody");
  bodyLines.forEach((line) => {
    const row = el("tr");
    splitTableRow(line).forEach((cell) => {
      const td = el("td");
      appendInlineMarkdown(td, cell);
      row.append(td);
    });
    tbody.append(row);
  });
  table.append(tbody);
  return table;
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function appendInlineMarkdown(container, text) {
  const value = String(text || "");
  const tokenPattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\n)/g;
  let position = 0;
  let match;

  while ((match = tokenPattern.exec(value))) {
    if (match.index > position) container.append(highlight(value.slice(position, match.index)));
    const token = match[0];
    if (token === "\n") {
      container.append(el("br"));
    } else if (token.startsWith("`")) {
      const code = el("code", { class: "inline-code" });
      code.append(highlight(token.slice(1, -1)));
      container.append(code);
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      container.append(renderMarkdownLink(link[1], link[2]));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = el("strong");
      strong.append(highlight(token.slice(2, -2)));
      container.append(strong);
    } else {
      const em = el("em");
      em.append(highlight(token.slice(1, -1)));
      container.append(em);
    }
    position = match.index + token.length;
  }

  if (position < value.length) container.append(highlight(value.slice(position)));
}

function renderMarkdownLink(label, href) {
  const safeHref = safeLinkHref(href);
  if (!safeHref) {
    const span = el("span");
    appendInlineMarkdown(span, label);
    return span;
  }
  const link = el("a", { href: safeHref, target: "_blank", rel: "noreferrer" });
  appendInlineMarkdown(link, label);
  return link;
}

function safeLinkHref(href) {
  const value = String(href || "").trim();
  if (/^(https?:|mailto:|#)/i.test(value)) return value;
  return "";
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function apiUrl(path, params = {}) {
  const searchParams = new URLSearchParams({ source: state.source });
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") searchParams.set(key, value);
  });
  return `${path}?${searchParams.toString()}`;
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

// Easter Eggs
const konamiSequence = 'ArrowUp,ArrowUp,ArrowDown,ArrowDown,ArrowLeft,ArrowRight,ArrowLeft,ArrowRight,b,a';
let konamiKeys = [];
let matrixInterval = null;

document.addEventListener('keydown', (e) => {
  konamiKeys.push(e.key);
  if (konamiKeys.length > 10) konamiKeys.shift();
  if (konamiKeys.join(',').toLowerCase() === konamiSequence.toLowerCase()) {
    toggleMatrix();
    konamiKeys = [];
  }
});

function toggleMatrix() {
  document.body.classList.toggle('matrix-active');
  const canvas = document.getElementById('matrixCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  if (document.body.classList.contains('matrix-active')) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*]*'.split('');
    const fontSize = 16;
    const columns = canvas.width / fontSize;
    const drops = [];
    for(let x = 0; x < columns; x++) drops[x] = 1;
    
    matrixInterval = setInterval(() => {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#0F0';
      ctx.font = fontSize + 'px monospace';
      for(let i = 0; i < drops.length; i++) {
        const text = letters[Math.floor(Math.random() * letters.length)];
        ctx.fillText(text, i * fontSize, drops[i] * fontSize);
        if(drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
    }, 33);
  } else {
    clearInterval(matrixInterval);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}
