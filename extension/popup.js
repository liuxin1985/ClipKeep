/**
 * ClipKeep - popup 逻辑
 * 收藏列表 / 搜索（命中高亮）/ 标签筛选与标签管理 / 排序 / 复制 / 删除 / Markdown 导出 / 深色模式
 * + 回顾（Leitner 间隔重复，可调每日上限与间隔倍率）
 * + JSON 备份 / 恢复（合并或覆盖本地）。
 */
(() => {
  const API = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;
  const STORAGE_KEY = "clipkeep_items";
  const HL_KEY = "clipkeep_highlights";
  const TRASH_KEY = "clipkeep_trash";
  const PREFS_KEY = "clipkeep_prefs";
  const ACTIVITY_KEY = "clipkeep_activity"; // 每天回顾了多少条，画热力图用
  const MAX_TEXT = 20000; // 与后台收藏写入的截断上限一致，标记时要说同一个数
  const BATCH_MAX = 1000; // 与后台 cleanIds 的单次批量上限一致，提示时要说同一个数
  const TAG_MAX = 12; // 与后台 cleanTags 的标签上限一致，提示时要说同一个数
  const CLAMP_AT = 240; // 超过这个长度的收藏在列表里默认折叠
  const DAY = 86400000;
  const INTERVALS = [0, 1, 3, 7, 21, 90]; // 各记忆盒对应的复习间隔（天）
  const HEAT_WEEKS = 8; // 热力图展示最近 8 周
  const HEAT_ROWS_MAX = 100; // 格子下钻最多渲染多少条明细（和后台 ACT_IDS_MAX 对齐）
  const TRASH_DETAIL_MAX = 50; // 回收站明细一次最多列几行，超出如实说还有多少
  const TRASH_MINS = [1, 5, 10, 30, 60]; // 回收站可选保留时长
  const DEFAULT_TRASH_MINS = 10;
  const KIND_LABELS = { text: "文字", image: "图片", link: "链接" }; // 列表筛选 chip 的文案
  const KIND_ORDER = ["text", "image", "link"]; // 后台只认这三种，顺序固定免得 chip 乱跳
  const SITE_CHIPS_MAX = 12; // 站点 chip 的渲染上限：库里几百个站时不能铺成一堵墙
  const HEADINGS = ["numbered", "title", "text", "date"]; // Markdown 导出的小标题写法
  const DEFAULT_PREFS = {
    review: { cap: 20, mult: 1 },
    trash: { mins: DEFAULT_TRASH_MINS },
    export: { heading: "numbered", source: true, frontMatter: false },
  };

  const DEAD_BACKEND = "ClipKeep 已更新，请重新打开弹窗再操作";

  /**
   * 统一发消息。扩展刚更新完、后台被换成新实例时，真 chrome 会让 sendMessage 直接
   * reject（"Extension context invalidated"）：裸调用会当场静默失灵，点了删除什么
   * 都没发生，用户只会以为是自己操作错了。兜住它，并说清「重开一次弹窗」。
   */
  async function send(msg) {
    try {
      return await API.runtime.sendMessage(msg); // 唯一一处裸调用：这里就是要抓失联异常
    } catch (_) {
      toast(DEAD_BACKEND);
      return { ok: false, error: "dead_backend" };
    }
  }

  /** 失败提示统一走这里：后台失联时「请重试」是句废话，重开弹窗才有用 */
  function failToast(res, fallback) {
    toast(res && res.error === "dead_backend" ? DEAD_BACKEND : fallback);
  }

  const $ = (id) => document.getElementById(id);
  const listEl = $("list");
  const emptyEl = $("empty");
  const countEl = $("count");
  const tagsEl = $("tags");
  const tagboxEl = $("tagbox");
  const searchEl = $("search");
  const sortEl = $("sort");
  const toastEl = $("toast");
  const dueEl = $("due");
  const markCountEl = $("mark-count");
  const marksEl = $("marks");
  const toolbarEl = $("toolbar");
  const reviewEl = $("review");
  const settingsEl = $("settings");
  const modalEl = $("modal");
  const trashbarEl = $("trashbar");
  const trashTextEl = $("trash-text");
  const trashListEl = $("trash-list");
  const batchEl = $("batchbar");
  const batchTextEl = $("batch-text");
  const filterEl = $("filterbar");
  const keysEl = $("keys-help");

  let items = [];
  let marks = []; // 网页高亮 / 批注
  let trash = []; // 最近删除的收藏 / 高亮，保留时长见设置
  let trashDetailOpen = false; // 回收站明细是否展开
  let activity = {}; // { "2026-09-27": 5 } 每日回顾条数
  let prefs = DEFAULT_PREFS;
  let activeTag = "";
  let activeKind = ""; // 列表按剪藏类型筛选，空表示不限
  let activeSite = ""; // 列表按来源站点筛选，空表示不限
  let focusId = ""; // 方向键在列表里选中的那条（键盘流的操作对象）
  let view = "clips";
  let toastTimer = null;
  let pendingRestore = null;
  let grading = false; // 回顾打分写入中
  let mutating = false; // 列表写操作在途：连点会对着已经消失的数据再发一遍，提示就成了谎话
  let heatDay = ""; // 热力图里点开要看明细的那一天，空表示没展开
  let selected = new Set(); // 批量操作选中的收藏 id，跨搜索 / 排序保留

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 转义正则元字符，保证按字面量搜索
  function reEsc(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** 先按 HTML 转义，再把命中的关键词包进 <mark class="hit"> */
  function hit(text, query) {
    const safe = esc(text);
    const q = query.trim();
    if (!q) return safe;
    try {
      return safe.replace(new RegExp(reEsc(esc(q)), "gi"), (m) => `<mark class="hit">${m}</mark>`);
    } catch (_) {
      return safe;
    }
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function hostname(url) {
    try { return new URL(url).hostname; } catch (_) { return url; }
  }

  /**
   * 来源地址是外部数据（备份文件里想写什么写什么）：
   * 只认 http(s) / file，javascript: 之类一律不作为链接渲染，也不写进 Markdown 链接。
   */
  function linkable(url) {
    return /^(https?:|file:)/i.test(String(url || "")) ? String(url) : "";
  }

  /**
   * 图片 / 链接收藏的目标地址：只认 http(s)。
   * 与后台的 mediaOf 同一套规则，列表里显示的才等于存下来的。
   */
  function mediaOf(it) {
    if (!it || (it.kind !== "image" && it.kind !== "link")) return "";
    const url = String((it.kind === "image" ? it.image : it.link) || "");
    return /^https?:\/\//i.test(url) ? url : "";
  }

  /**
   * 列表筛选用的类型：后台只写 image / link，文字收藏不写 kind。
   * 未知值一律当文字，免得备份里塞个 video 就冒出一个永远筛不出东西的 chip。
   */
  function kindOf(it) {
    return it && (it.kind === "image" || it.kind === "link") ? it.kind : "text";
  }

  /** 列表里显示的可读标签 */
  function mediaLabel(it) {
    const url = mediaOf(it);
    if (!url) return "";
    return it.kind === "image" ? "查看原图" : hostname(url);
  }

  /**
   * 媒体收藏的那枚可点链接：列表和回顾卡片共用一份，
   * 图片显示「查看原图」（CDN 域名对用户没意义），链接显示域名，悬停看真实地址。
   */
  function mediaLinkHtml(it) {
    const url = mediaOf(it);
    if (!url) return "";
    return `<a class="item-kind" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(url)}">${esc(mediaLabel(it))}</a>`;
  }

  /* ---------- 复习调度（Leitner 盒） ---------- */

  function reviewPrefs() {
    return reviewPrefsOf(prefs);
  }

  /** 回收站保留时长：只认档位，非法值回落到默认，别让人把回收站调成永久 */
  function trashMins() {
    return trashMinsOf(prefs);
  }

  function ensureReview(it) {
    if (!it.review || typeof it.review.box !== "number") {
      it.review = { box: 0, due: it.createdAt || Date.now(), seen: 0 };
    }
    return it.review;
  }
  function grade(it, g) {
    const r = ensureReview(it);
    if (g === 0) r.box = 0;                 // 忘记 → 回到盒 0
    else if (g === 1) r.box = Math.min(r.box + 1, INTERVALS.length - 1); // 记得 → 升 1
    else r.box = Math.min(r.box + 2, INTERVALS.length - 1);              // 简单 → 升 2
    const { mult } = reviewPrefs();
    r.due = Date.now() + Math.round(INTERVALS[r.box] * DAY * mult);
    r.seen = (r.seen || 0) + 1;
    return it;
  }
  function dueItems() {
    const now = Date.now();
    return items
      .filter((it) => ensureReview(it).due <= now)
      .sort((a, b) => ensureReview(a).due - ensureReview(b).due);
  }
  /** 今日队列 = 到期内容按最早优先，截断到每日上限 */
  function queue() {
    return dueItems().slice(0, reviewPrefs().cap);
  }

  /* ---------- 数据加载 ---------- */

  async function load() {
    const obj = await API.storage.local.get([STORAGE_KEY, HL_KEY, PREFS_KEY, ACTIVITY_KEY]);
    items = Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
    marks = Array.isArray(obj[HL_KEY]) ? obj[HL_KEY] : [];
    prefs = obj[PREFS_KEY] || {};
    const log = obj[ACTIVITY_KEY];
    activity = log && typeof log === "object" && !Array.isArray(log) ? log : {};
    trash = await readTrash();
    applyTheme(prefs.dark ? "dark" : "light");
    syncSettings();
    render();
  }

  /**
   * 回收站由后台统一做过期清理（顺带把清理结果写回存储），
   * 弹窗只读它，避免自己算一遍 TTL 跟后台口径不一致。
   */
  async function readTrash() {
    try {
      const res = await send({ type: "clipkeep:trash-list" });
      if (res && res.ok && Array.isArray(res.items)) return res.items;
    } catch (_) {
      /* 后台不可用时退回直读 */
    }
    const obj = await API.storage.local.get(TRASH_KEY);
    return Array.isArray(obj[TRASH_KEY]) ? obj[TRASH_KEY] : [];
  }

  function syncSettings() {
    const { cap, mult } = reviewPrefs();
    const tpl = exportPrefs();
    $("set-cap").value = String(cap);
    $("set-mult").value = String(mult);
    $("set-ttl").value = String(trashMins());
    $("set-heading").value = tpl.heading;
    $("set-source").checked = tpl.source;
    $("set-fm").checked = tpl.frontMatter;
  }

  /**
   * 偏好统一从这里写：一次读全量、按档位夹一遍再落盘，
   * 避免各面板各改各的字段互相覆盖。
   */
  async function savePrefs(section, patch) {
    const next = { ...prefs, [section]: { ...(prefs[section] || {}), ...patch } };
    next.review = reviewPrefsOf(next);
    next.trash = { mins: trashMinsOf(next) };
    next.export = exportPrefsOf(next);
    prefs = next;
    await API.storage.local.set({ [PREFS_KEY]: prefs });
    syncSettings();
    render();
  }

  function reviewPrefsOf(p) {
    const r = (p && p.review) || {};
    const cap = Math.max(1, Math.min(200, Number(r.cap) || DEFAULT_PREFS.review.cap));
    const mult = [0.5, 1, 2].indexOf(Number(r.mult)) >= 0 ? Number(r.mult) : DEFAULT_PREFS.review.mult;
    return { cap, mult };
  }

  function trashMinsOf(p) {
    const m = Number((p && p.trash || {}).mins);
    return TRASH_MINS.indexOf(m) >= 0 ? m : DEFAULT_TRASH_MINS;
  }

  /** 导出模板：只认枚举值与布尔，非法写法（含备份里塞进来的字符串）一律回落默认 */
  function exportPrefsOf(p) {
    const e = (p && p.export) || {};
    return {
      heading: HEADINGS.indexOf(e.heading) >= 0 ? e.heading : DEFAULT_PREFS.export.heading,
      source: e.source !== false,
      frontMatter: e.frontMatter === true,
    };
  }
  function exportPrefs() {
    return exportPrefsOf(prefs);
  }

  function applyTheme(mode) {
    document.body.classList.toggle("dark", mode === "dark");
    $("btn-theme").textContent = mode === "dark" ? "☀️" : "🌙";
  }

  async function toggleTheme() {
    const obj = await API.storage.local.get(PREFS_KEY);
    const prefs = obj[PREFS_KEY] || {};
    const dark = !prefs.dark;
    await API.storage.local.set({ [PREFS_KEY]: { ...prefs, dark } });
    applyTheme(dark ? "dark" : "light");
  }

  /**
   * chip 这类整条重绘的小控件，重绘前后要把焦点放回原来那个：
   * 否则键盘用户 Tab 到筛选条按回车，焦点掉回页面顶部，得重新 Tab 一遍。
   * 只在焦点原本就在这个容器里时才接管，不会把搜索框的光标抢走。
   */
  function chipKey(el) {
    const d = el && el.dataset;
    if (!d) return "";
    if (d.kind !== undefined) return "kind:" + d.kind;
    if (d.site !== undefined) return "site:" + d.site;
    if (d.tag !== undefined) return "tag:" + d.tag;
    return "";
  }

  function keepChipFocus(container) {
    const a = document.activeElement;
    return a && container.contains(a) ? chipKey(a) : "";
  }

  function restoreChipFocus(container, key) {
    if (!key) return;
    const next = [...container.querySelectorAll(".chip")].find((c) => chipKey(c) === key);
    if (next) next.focus();
  }

  function allTags() {
    const set = new Set();
    items.forEach((it) => (it.tags || []).forEach((t) => set.add(t)));
    return [...set].sort();
  }

  function renderTags() {
    const tags = allTags();
    if (activeTag && !tags.includes(activeTag)) activeTag = "";
    const keep = keepChipFocus(tagsEl);
    tagsEl.innerHTML = tags
      .map((t) => `<button class="chip ${t === activeTag ? "active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`)
      .join("");
    restoreChipFocus(tagsEl, keep);
  }

  /**
   * 类型 / 站点筛选条。只在「确实有得筛」时出现：
   * 库里一种类型、一个站点（或全是无来源的手动收藏）时摆一排 chip 只是骗人点。
   * chip 只列库里真存在的值，数据一变（比如最后一条图片被删）幽灵选项就跟着消失。
   */
  function renderFilterbar() {
    const keep = keepChipFocus(filterEl); // 先记焦点，下面每次 innerHTML 都会把它抹掉
    if (view !== "clips") {
      filterEl.hidden = true;
      filterEl.innerHTML = "";
      return;
    }
    const kinds = new Map();
    const sites = new Map();
    for (const it of items) {
      const k = kindOf(it);
      kinds.set(k, (kinds.get(k) || 0) + 1);
      const h = String(it && it.url ? hostname(it.url) : "");
      if (h) sites.set(h, (sites.get(h) || 0) + 1);
    }
    if (activeKind && !kinds.has(activeKind)) activeKind = "";
    if (activeSite && !sites.has(activeSite)) activeSite = "";
    if (kinds.size < 2 && sites.size < 2) {
      filterEl.hidden = true;
      filterEl.innerHTML = "";
      return;
    }
    filterEl.hidden = false;
    const kindHtml = kinds.size < 2 ? "" : [...kinds.keys()]
      .sort((a, b) => {
        const ia = KIND_ORDER.indexOf(a);
        const ib = KIND_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
      })
      .map((k) => `<button class="chip ${k === activeKind ? "active" : ""}" data-kind="${esc(k)}">${esc(KIND_LABELS[k] || k)} ${kinds.get(k)}</button>`)
      .join("");
    const sorted = [...sites.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = sorted.slice(0, SITE_CHIPS_MAX);
    const siteHtml = sorted.length < 2 ? ""
      : shown.map(([h, n]) => `<button class="chip site ${h === activeSite ? "active" : ""}" data-site="${esc(h)}" title="${esc(h)}">${esc(h)} ${n}</button>`).join("")
        + (sorted.length > shown.length
            ? `<span class="f-more" title="还有 ${sorted.length - shown.length} 个站点没有列出，用搜索找它们的域名">+${sorted.length - shown.length} 站</span>`
            : "");
    filterEl.innerHTML = kindHtml + siteHtml;
    restoreChipFocus(filterEl, keep);
  }

  function filtered() {
    const q = searchEl.value.trim().toLowerCase();
    let arr = items.filter((it) => {
      if (activeTag && !(it.tags || []).includes(activeTag)) return false;
      if (activeKind && kindOf(it) !== activeKind) return false;
      if (activeSite && String(it && it.url ? hostname(it.url) : "") !== activeSite) return false;
      if (!q) return true;
      return (
        (it.text || "").toLowerCase().includes(q) ||
        (it.note || "").toLowerCase().includes(q) ||
        (it.title || "").toLowerCase().includes(q) ||
        mediaOf(it).toLowerCase().includes(q) ||
        (it.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    });
    arr = arr.slice().sort((a, b) =>
      sortEl.value === "old" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt
    );
    return arr;
  }

  function render() {
    countEl.textContent = String(items.length);
    markCountEl.hidden = marks.length === 0;
    markCountEl.textContent = String(marks.length);
    renderFilterbar(); // 先洗掉失效的筛选，批量条的「全选」才不会跟着一个幽灵条件
    renderTrashbar();
    renderBatchbar();
    const due = dueItems().length;
    const queued = Math.min(due, reviewPrefs().cap);
    if (queued > 0) {
      dueEl.hidden = false;
      dueEl.textContent = due > queued ? `${queued}/${due}` : String(queued);
      dueEl.title = due > queued ? `每日上限 ${queued} 条，剩余 ${due - queued} 条明天继续` : "今日待回顾";
    } else {
      dueEl.hidden = true;
    }

    // 工具条按视图取用：收藏和高亮共用搜索框，回顾没有搜索
    toolbarEl.hidden = view === "review";
    searchEl.placeholder = view === "marks" ? "搜索高亮与批注…" : "搜索收藏内容…";
    sortEl.hidden = view !== "clips";
    $("btn-tags").hidden = view !== "clips";
    $("btn-hl-export").hidden = view !== "marks";

    if (view === "review") renderReview();
    else if (view === "marks") renderMarks();
    else renderClips();
  }

  function renderClips() {
    renderTags();
    renderTagbox();
    const arr = filtered();
    listEl.querySelectorAll(".item").forEach((n) => n.remove());
    if (arr.length === 0) {
      emptyEl.style.display = "block";
      // 库里明明有东西却一条不显示，提示就得说「是筛选筛掉的」，不能谎称还没有收藏
      const filtering = Boolean(activeTag || activeKind || activeSite || searchEl.value.trim());
      emptyEl.querySelector("p").textContent = items.length === 0 ? "还没有收藏" : filtering ? "筛选后没有结果" : "无匹配结果";
      emptyEl.querySelector("span").textContent =
        items.length === 0
          ? "在网页上划选文字，点「收藏」即可留存到这里。"
          : filtering
            ? "当前有关键词 / 标签 / 类型 / 站点筛选，去掉一个试试。"
            : "换个关键词或标签试试。";
      return;
    }
    emptyEl.style.display = "none";
    listEl.appendChild(frag(arr.map(itemNode)));
  }

  function frag(arr) {
    const tpl = document.createElement("template");
    tpl.innerHTML = arr.join("");
    return tpl.content;
  }

  function itemNode(it) {
    const q = searchEl.value;
    const text = String(it.text || "");
    const longClip = text.length > CLAMP_AT; // 一屏读不完的收藏默认折叠，别把整列顶走
    const tags = (it.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join("");
    const src = linkable(it.url);
    const link = it.url
      ? src
        ? `<a href="${esc(src)}" target="_blank" rel="noopener" title="${esc(it.title || src)}">${esc(it.title || hostname(src))}</a>`
        : `<span class="item-src" title="来源不是可点击的地址">${esc(it.title || it.url)}</span>`
      : "";
    // 收藏正文超过 2 万字会被截断，标记要露出来，否则用户不知道内容不完整
    const trunc = it.truncated
      ? `<span class="badge-warn" title="内容超过 ${MAX_TEXT} 字，仅保存了前半部分">已截断</span>`
      : "";
    // 图片 / 链接收藏：显示类型徽标 + 可点开的目标地址（不在扩展页里远程加载图）
    const isMedia = it.kind === "image" || it.kind === "link";
    const kindBadge = isMedia
      ? `<span class="badge-kind">${it.kind === "image" ? "图片" : "链接"}</span>`
      : "";
    const mediaLink = mediaLinkHtml(it);
    const note = it.note ? `<div class="item-note">${hit(it.note, q)}</div>` : "";
    const on = selected.has(it.id);
    return `
      <div class="item${on ? " selected" : ""}${it.id === focusId ? " focused" : ""}" data-id="${esc(it.id)}">
        <label class="item-sel" title="勾选后可批量删除 / 加标签 / 导出">
          <input type="checkbox" data-act="sel" aria-label="选择这条收藏"${on ? " checked" : ""} />
        </label>
        <div class="item-text${longClip ? " is-clamped" : ""}">${hit(text, q)}</div>
        ${note}
        <div class="item-meta">${trunc}${kindBadge}${tags}${mediaLink}${link}<span>${fmtDate(it.createdAt)}</span></div>
        <div class="item-actions">
          <button class="mini-btn" data-act="copy">复制</button>
          <button class="mini-btn" data-act="tag">加标签</button>
          <button class="mini-btn" data-act="export">导出</button>
          ${longClip ? `<button class="mini-btn" data-act="more">展开全文</button>` : ""}
          <button class="mini-btn danger" data-act="del">删除</button>
        </div>
      </div>`;
  }

  /* ---------- 高亮 / 批注视图 ---------- */

  const COLOR_HEX = { yellow: "#fff3a3", green: "#c7f5c7", pink: "#ffd0e0", blue: "#cfe3ff" };
  const COLOR_NAMES = { yellow: "黄色", green: "绿色", pink: "粉色", blue: "蓝色" };

  /** 换色按固定顺序轮转；库里颜色不合法时从黄色重新开始 */
  function nextHlColor(cur) {
    const i = HL_COLORS.indexOf(cur);
    return HL_COLORS[(i + 1) % HL_COLORS.length];
  }

  function hlFiltered() {
    const q = searchEl.value.trim().toLowerCase();
    return marks
      .filter((h) => h && h.text)
      .filter((h) =>
        !q ||
        h.text.toLowerCase().includes(q) ||
        String(h.note || "").toLowerCase().includes(q) ||
        String(h.title || "").toLowerCase().includes(q) ||
        String(h.url || "").toLowerCase().includes(q)
      )
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** 按页面分组，组按该页最新一条高亮的时间倒序 */
  function hlGroups() {
    const map = new Map();
    hlFiltered().forEach((h) => {
      const key = String(h.url || "");
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(h);
    });
    return [...map.entries()];
  }

  function hlPageName(url, list) {
    const withTitle = list.find((x) => x.title);
    return (withTitle && withTitle.title) || hostname(url) || url;
  }

  function hlNode(h, q) {
    const note = h.note ? `<div class="hl-note">✎ ${hit(h.note, q)}</div>` : "";
    const key = COLOR_HEX[h.color] ? h.color : "yellow";
    const bg = COLOR_HEX[key];
    const next = COLOR_NAMES[nextHlColor(h.color)] || "黄色";
    return `
      <div class="hl-item" data-hlid="${esc(h.id)}">
        <span class="hl-swatch" style="background:${bg}"></span>
        <div class="hl-body">
          <div class="hl-text">${hit(h.text, q)}</div>
          ${note}
          <div class="hl-meta">${fmtDate(h.createdAt)}</div>
        </div>
        <div class="hl-actions">
          <button class="mini-btn" data-act="hl-copy">复制</button>
          <button class="mini-btn" data-act="hl-color" title="当前${COLOR_NAMES[key]}，点击换成${next}">换色</button>
          <button class="mini-btn danger" data-act="hl-del">删除</button>
        </div>
      </div>`;
  }

  function hlEmpty(ico, title, tip) {
    return `<div class="empty"><div class="empty-ico">${ico}</div><p>${title}</p><span>${tip}</span></div>`;
  }

  function renderMarks() {
    const q = searchEl.value.trim();
    const groups = hlGroups();
    if (!marks.length) {
      marksEl.innerHTML = hlEmpty("🖍", "还没有高亮", "在网页上划选文字，点工具条的 🖍 高亮或 ✎ 批注。");
      return;
    }
    if (!groups.length) {
      marksEl.innerHTML = hlEmpty("🔍", "无匹配结果", "换个关键词试试。");
      return;
    }
    marksEl.innerHTML = groups
      .map(([url, list]) => {
        const name = hlPageName(url, list);
        const safe = /^(https?:|file:)/i.test(url) ? url : "";
        const page = safe
          ? `<a class="hl-page" href="${esc(safe)}" target="_blank" rel="noopener" title="${esc(url)}">${esc(name)}</a>`
          : `<span class="hl-page">${esc(name)}</span>`;
        return `
        <section class="hl-group" data-url="${esc(url)}">
          <div class="hl-group-head">${page}<span class="hl-num">${list.length}</span></div>
          ${list.map((h) => hlNode(h, q)).join("")}
        </section>`;
      })
      .join("");
  }

  /** 导出当前筛选结果为 Markdown，按页面分组 */
  function exportHighlights() {
    const groups = hlGroups();
    if (!groups.length) return toast("没有可导出的高亮");
    const lines = ["# ClipKeep 高亮与批注", "", `导出时间：${fmtDate(Date.now())}`, ""];
    groups.forEach(([url, list]) => {
      lines.push(`## ${hlPageName(url, list)}`);
      if (url) lines.push(`**来源**: ${url}`);
      lines.push("");
      list.forEach((h) => {
        const text = String(h.text).replace(/\s*\n\s*/g, " ");
        lines.push(`- ==${text}==` + (h.note ? ` — 批注：${String(h.note).replace(/\s*\n\s*/g, " ")}` : ""));
      });
      lines.push("");
    });
    download(lines.join("\n"), `clipkeep-highlights-${Date.now()}.md`);
    toast(`已导出 ${hlFiltered().length} 条高亮`);
  }

  marksEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const row = e.target.closest(".hl-item");
    if (!row) return;
    const id = row.dataset.hlid;
    const h = marks.find((x) => String(x.id) === id);
    if (!h) return;
    const act = btn.dataset.act;
    if (act === "hl-copy") copyText(h.text);
    else if (act === "hl-color") {
      // 换色也走后台：那里有颜色白名单，且整条写链保证不抹掉别处的改动
      const res = await send({ type: "clipkeep:hl-update", id, patch: { color: nextHlColor(h.color) } });
      if (!res || !res.ok) return failToast(res, "换色失败，请重试");
      await load();
      toast("已换色");
    } else if (act === "hl-del") {
      // 走后台：进回收站 + 串行写，避免整表覆盖抹掉别处新增的高亮
      const res = await send({ type: "clipkeep:hl-delete", id });
      if (!res || !res.ok) {
        if (res && res.error === "not_found") { await load(); toast("这条高亮已经不在了"); }
        else failToast(res, "删除失败，请重试");
        return;
      }
      await load();
      toast("已删除高亮");
    }
  });

  $("btn-hl-export").addEventListener("click", exportHighlights);

  /* ---------- 回收站 / 撤销 ---------- */

  function renderTrashbar() {
    trashbarEl.hidden = trash.length === 0;
    if (!trash.length) {
      trashListEl.hidden = true;
      trashListEl.innerHTML = "";
      return;
    }
    const kinds = new Set(trash.map((t) => (t && t.kind === "hl" ? "高亮" : "收藏")));
    const what = kinds.size === 1 ? [...kinds][0] : "";
    trashTextEl.textContent = `已删除 ${trash.length} 条${what} · ${trashMins()} 分钟内可撤销`;
    // 「撤销」只还原最近一批（同一个撤销号），回收站里可能还压着更早的批次。
    // 只写「撤销」配一句「已删除 5 条」，用户会以为点一下全回来，实际只捞回 2 条。
    const latestTid = trash[0] && trash[0].tid;
    const latest = trash.filter((t) => t && t.tid === latestTid).length;
    const batches = new Set(trash.map((t) => t && t.tid)).size;
    const undoBtn = $("btn-undo");
    undoBtn.textContent = batches > 1 ? `撤销这批 ${latest} 条` : "撤销";
    undoBtn.title = batches > 1 ? `回收站里还有更早的 ${trash.length - latest} 条，逐条恢复请点「明细」` : "";
    $("btn-trash-detail").textContent = trashDetailOpen ? "收起" : "明细";
    renderTrashDetail();
  }

  /**
   * 回收站明细。「撤销」是按撤销号整批还原的，一次删了 20 条又只想捞回其中一条时
   * 别无可选，所以逐条列出、逐条恢复。列表新→旧，最多列 TRASH_DETAIL_MAX 行，
   * 超出如实说明条数，不让人误以为回收站里就只有这些。
   */
  function renderTrashDetail() {
    trashListEl.hidden = !trashDetailOpen;
    if (!trashDetailOpen) {
      trashListEl.innerHTML = "";
      return;
    }
    const rows = trash.slice(0, TRASH_DETAIL_MAX).map((t) => {
      const it = (t && t.item) || {};
      const kind = t.kind === "hl" ? "hl" : "clip";
      const label = kind === "hl" ? "高亮" : "收藏";
      const text = String(it.text || "（无正文）");
      return `<div class="trash-row" data-kind="${kind}" data-id="${esc(it.id || "")}">`
        + `<span class="tr-kind">${label}</span>`
        + `<span class="tr-text">${esc(text)}</span>`
        + `<button class="mini-btn" data-act="trash-restore-one">恢复</button>`
        + `</div>`;
    }).join("");
    const more = trash.length > TRASH_DETAIL_MAX
      ? `<p class="tr-more">另有 ${trash.length - TRASH_DETAIL_MAX} 条未列出（只列最近 ${TRASH_DETAIL_MAX} 条）</p>`
      : "";
    trashListEl.innerHTML = rows + more;
  }

  $("btn-trash-detail").addEventListener("click", () => {
    trashDetailOpen = !trashDetailOpen;
    renderTrashbar();
  });

  trashListEl.addEventListener("click", async (e) => {
    const btn = e.target.closest && e.target.closest('[data-act="trash-restore-one"]');
    if (!btn) return;
    const row = btn.closest(".trash-row");
    const kind = row && row.dataset.kind;
    const id = row && row.dataset.id;
    if (!kind || !id) return;
    await withLock(async () => {
      const res = await send({ type: "clipkeep:trash-restore-one", payload: { kind, id } });
      await load(); // 恢复成功与否都要重画明细，点了没反应的行不能继续留在列表里
      if (!res || !res.ok) {
        if (res && res.error === "not_found") toast("这条已经不在回收站里了（可能已过期）");
        else failToast(res, "恢复失败，请重试");
        return;
      }
      const what = kind === "hl" ? "高亮" : "收藏";
      toast(Number(res.restored) > 0 ? `已恢复 1 条${what} ✓` : `这条${what}已经在列表里了，未重复添加`);
    });
  });

  $("btn-undo").addEventListener("click", async () => {
    const entry = trash[0];
    if (!entry) return;
    await withLock(async () => {
      const res = await send({ type: "clipkeep:trash-restore", tid: entry.tid });
      if (!res || !res.ok) {
        await load();
        if (res && res.error === "not_found") toast("该条目已过期，无法撤销");
        else failToast(res, "撤销失败，请重试");
        return;
      }
      await load();
      // 批量删除共用一个撤销号，一次撤销还原整批，提示就要报出真实条数
      const n = Number(res.restored) || 0;
      const skipped = Number(res.existed) || 0;
      if (skipped && n) toast(`已撤销 ${n} 条，另有 ${skipped} 条已存在未重复添加`);
      else if (skipped) toast("该内容已存在，未重复添加");
      else toast(n > 1 ? `已撤销 ${n} 条删除 ✓` : "已撤销删除 ✓");
    });
  });

  $("btn-trash-clear").addEventListener("click", async () => {
    if (!confirm("清空回收站？清空后无法再撤销。")) return;
    const res = await send({ type: "clipkeep:trash-clear" });
    await load();
    if (!res || !res.ok) return failToast(res, "清空回收站失败，请重试");
    toast("回收站已清空");
  });

  /* ---------- 标签管理面板 ---------- */

  function tagCounts() {
    const map = new Map();
    items.forEach((it) =>
      (it.tags || []).forEach((t) => map.set(t, (map.get(t) || 0) + 1))
    );
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function renderTagbox() {
    if (tagboxEl.hidden) return;
    const rows = tagCounts();
    if (!rows.length) {
      tagboxEl.innerHTML = `<p class="tagbox-empty">还没有标签。给收藏「加标签」后就能在这里重命名、合并或删除。</p>`;
      return;
    }
    tagboxEl.innerHTML = rows
      .map(
        ([t, n]) => `
        <div class="tagrow" data-tag="${esc(t)}">
          <span class="tagname">#${esc(t)}</span>
          <span class="tagnum">${n}</span>
          <span class="tagops">
            <button class="mini-btn" data-act="t-rename">重命名</button>
            <button class="mini-btn" data-act="t-merge">合并到…</button>
            <button class="mini-btn danger" data-act="t-del">删除</button>
          </span>
        </div>`
      )
      .join("");
  }

  async function applyTagOp(from, to) {
    const res = await send({ type: "clipkeep:tag-op", payload: { from, to } });
    if (!res || !res.ok) return toast("操作失败");
    if (activeTag === from) activeTag = to || "";
    await load();
    toast(to ? `已更新 ${res.changed} 条（${to === from ? "无变化" : "#" + from + " → #" + to}）` : `已从 ${res.changed} 条中删除 #${from}`);
  }

  tagboxEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const row = e.target.closest(".tagrow");
    if (!row) return;
    const from = row.dataset.tag;
    const act = btn.dataset.act;
    if (act === "t-rename") {
      const to = prompt("把标签重命名为：", from);
      if (to !== null && to.trim() && to.trim() !== from) await applyTagOp(from, to.trim());
    } else if (act === "t-merge") {
      const others = tagCounts().map(([t]) => t).filter((t) => t !== from);
      const to = prompt("把 #" + from + " 合并到哪个标签？\n现有标签：" + (others.join("、") || "（无）"), others[0] || "");
      if (to !== null && to.trim() && to.trim() !== from) await applyTagOp(from, to.trim());
    } else if (act === "t-del") {
      if (confirm(`从所有收藏中删除 #${from}？（不会删除内容本身）`)) await applyTagOp(from, "");
    }
  });

  $("btn-tags").addEventListener("click", () => {
    tagboxEl.hidden = !tagboxEl.hidden;
    $("btn-tags").classList.toggle("active", !tagboxEl.hidden);
    renderTagbox();
  });

  $("btn-settings").addEventListener("click", () => {
    settingsEl.hidden = !settingsEl.hidden;
    $("btn-settings").classList.toggle("active", !settingsEl.hidden);
  });
  $("set-cap").addEventListener("change", (e) => savePrefs("review", { cap: Number(e.target.value) }));
  $("set-mult").addEventListener("change", (e) => savePrefs("review", { mult: Number(e.target.value) }));
  $("set-ttl").addEventListener("change", (e) => savePrefs("trash", { mins: Number(e.target.value) }));
  $("set-heading").addEventListener("change", (e) => savePrefs("export", { heading: e.target.value }));
  $("set-source").addEventListener("change", (e) => savePrefs("export", { source: e.target.checked }));
  $("set-fm").addEventListener("change", (e) => savePrefs("export", { frontMatter: e.target.checked }));

  /* ---------- 回顾热力图 ---------- */

  function dayKey(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 档位：0 空白 / 1 少量 / 2 一般 / 3 较多 */
  function heatLvl(n) {
    return n <= 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : 3;
  }

  /** 活动记录兼容旧版数字与新版 { n, ids }，与后台 activityOf 同一套读法 */
  function activityOf(v) {
    if (typeof v === "number" && Number.isFinite(v)) return { n: Math.max(0, Math.floor(v)), ids: [] };
    if (v && typeof v === "object") {
      const n = Number(v.n);
      return {
        n: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0,
        ids: Array.isArray(v.ids) ? v.ids.map(String) : [],
      };
    }
    return { n: 0, ids: [] };
  }

  /** 8 周 × 7 天，按星期对齐（每列一周，周日到周六），本周末端之后的天留空格 */
  function heatCells() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = today.getTime() - ((HEAT_WEEKS - 1) * 7 + today.getDay()) * DAY;
    const cells = [];
    for (let i = 0; i < HEAT_WEEKS * 7; i++) {
      const t = start + i * DAY;
      const key = dayKey(t);
      const a = activityOf(activity[key]);
      cells.push({ key, n: a.n, future: t > today.getTime() });
    }
    return cells;
  }

  function heatHtml() {
    const cells = heatCells();
    // 含今天往前数 7 天：ISO 日期串按字典序比较即可，别用 Date.parse（它按 UTC 解析，有时区偏移）
    const from = dayKey(Date.now() - 6 * DAY);
    const week = cells.reduce((s, c) => (c.future || c.key < from ? s : s + c.n), 0);
    const total = Object.keys(activity).reduce((s, k) => s + activityOf(activity[k]).n, 0);
    let streak = 0;
    let idx = cells.length - 1;
    while (idx >= 0 && cells[idx].future) idx--; // 跳过本周还没到的格子
    if (idx >= 0 && cells[idx].n === 0) idx--;   // 今天还没打卡，连续纪录从昨天起算，别清零
    for (; idx >= 0; idx--) {
      if (cells[idx].n > 0) streak++;
      else break;
    }
    const grid = cells
      .map((c) => {
        const cls = c.future ? " future" : c.n > 0 ? " clickable" : "";
        const tip = `${c.key}${c.n ? ` · 回顾 ${c.n} 条，点开看明细` : ""}`;
        return `<i class="lv${heatLvl(c.n)}${cls}" data-day="${c.key}" data-n="${c.n}" data-lvl="${heatLvl(c.n)}" title="${esc(tip)}"></i>`;
      })
      .join("");
    return `
      <div class="heat-wrap">
        <div class="heat-head">
          <span class="heat-title">🔥 回顾打卡</span>
          <span class="heat-stats" id="heat-stats">本周 ${week} · 连续 ${streak} 天 · 累计 ${total}</span>
        </div>
        <div class="heat">${grid}</div>
        ${heatDayHtml()}
      </div>`;
  }

  /** 格子下钻：这一天复习了几条、分别是哪些收藏；旧记录只有条数时如实说明 */
  function heatDayHtml() {
    if (!heatDay) return `<div class="heat-day" id="heat-day" hidden></div>`;
    const a = activityOf(activity[heatDay]);
    if (a.n <= 0) return `<div class="heat-day" id="heat-day" hidden></div>`;
    const listed = a.ids.slice(0, HEAT_ROWS_MAX);
    const rows = listed
      .map((id) => {
        const it = items.find((x) => x && x.id === id);
        const label = it ? String(it.text).slice(0, 60) : "（这条收藏已删除）";
        return `<li>${it ? esc(label) : `<span class="muted">${esc(label)}</span>`}</li>`;
      })
      .join("");
    // 明细最多存 100 条，标题的 n 却照实累计：拿 ids 长度比 ids 长度永远相等，
    // 差额得从 n 里算，否则「复习 105 条」只列 100 行还不说明为什么
    const missing = a.n - listed.length;
    const overflow = missing > 0
      ? `<p class="heat-day-note">仅显示最近 ${listed.length} 条，另有 ${missing} 条未列出。</p>`
      : "";
    const note = a.ids.length
      ? ""
      : `<p class="heat-day-note">这条记录来自旧版本，只存了当天条数，没有复习明细。</p>`;
    return `
      <div class="heat-day" id="heat-day">
        <div class="heat-day-head">
          <span>${esc(heatDay)} · 复习 ${a.n} 条</span>
          <button class="mini-btn heat-day-close" data-act="heat-close">收起</button>
        </div>
        ${note}${a.ids.length ? `<ul class="heat-day-list">${rows}</ul>${overflow}` : ""}
      </div>`;
  }

  /* ---------- 回顾视图 ---------- */

  function renderReview() {
    const { cap } = reviewPrefs();
    const due = dueItems();
    const queued = queue();
    const heat = heatHtml();
    if (!items.length) {
      reviewEl.innerHTML = heat + `<div class="empty"><div class="empty-ico">🔁</div><p>还没有可回顾的内容</p><span>先去网页上划词收藏几条吧。</span></div>`;
      return;
    }
    if (!queued.length) {
      const next = items.map((it) => ensureReview(it).due).sort((a, b) => a - b)[0];
      reviewEl.innerHTML = heat + `<div class="empty done"><div class="empty-ico">🎉</div><p>今日回顾已完成</p><span>下一条将在 ${fmtDate(next)} 到期。明天再来 ~</span></div>`;
      return;
    }
    const it = queued[0];
    const r = ensureReview(it);
    const tags = (it.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join("");
    // 来源与目标地址都要过协议白名单：收藏列表洗过了，回顾卡片也得洗
    const src = linkable(it.url);
    const link = it.url
      ? src
        ? `<a href="${esc(src)}" target="_blank" rel="noopener">${esc(it.title || hostname(src))}</a>`
        : `<span class="item-src" title="来源不是可点击的地址">${esc(it.title || it.url)}</span>`
      : "";
    const media = mediaOf(it);
    const kindTag = media
      ? `<span class="badge-kind">${it.kind === "image" ? "图片" : "链接"}</span>` + mediaLinkHtml(it)
      : "";
    const capNote = due.length > queued.length ? ` · 今日上限 ${cap} 条，剩余 ${due.length - queued.length} 条明天继续` : "";
    reviewEl.innerHTML = heat + `
      <div class="rev-progress">本组待回顾 ${queued.length} 条 · 记忆盒 ${r.box}/${INTERVALS.length - 1}${capNote}</div>
      <p class="rev-keys">快捷键：<kbd>空格</kbd> 显示答案 · <kbd>1</kbd> 忘记 · <kbd>2</kbd> 记得 · <kbd>3</kbd> 简单</p>
      <div class="rev-card" data-id="${esc(it.id)}">
        <div class="rev-front">${esc(it.text)}</div>
        <div class="rev-back" hidden>
          ${it.note ? `<div class="rev-note">${esc(it.note)}</div>` : ""}
          <div class="rev-meta">${kindTag}${tags}${link}</div>
        </div>
        <button class="rev-reveal" data-act="reveal">显示答案</button>
        <div class="rev-grade" hidden>
          <button class="mini-btn again" data-act="grade" data-g="0">忘记</button>
          <button class="mini-btn good" data-act="grade" data-g="1">记得</button>
          <button class="mini-btn easy" data-act="grade" data-g="2">简单</button>
        </div>
      </div>`;
  }

  /** 显示答案：按钮和打分区互换，键盘和点击共用这一份 */
  function revealAnswer() {
    const back = reviewEl.querySelector(".rev-back");
    const gradeBox = reviewEl.querySelector(".rev-grade");
    if (!back || !gradeBox) return false;
    const btn = reviewEl.querySelector('[data-act="reveal"]');
    back.hidden = false;
    if (btn) btn.hidden = true;
    gradeBox.hidden = false;
    return true;
  }

  /** 答案是否已经露出来：没露就按数字，等于闭眼改排期 */
  function answerRevealed() {
    const gradeBox = reviewEl.querySelector(".rev-grade");
    return !!gradeBox && gradeBox.hidden === false;
  }

  async function gradeCurrent(id, g) {
    if (grading) return; // 写入在途时忽略后续点击，否则连点会一次跳两盒
    const it = items.find((x) => x.id === id);
    if (!it) return;
    grading = true;
    const btns = [...reviewEl.querySelectorAll(".rev-grade button")];
    btns.forEach((b) => { b.disabled = true; });
    grade(it, g);
    let res = null;
    try {
      // 排期 + 当日打卡由后台一次写链完成，不会出现「分数存了、热力图没加」
      res = await send({ type: "clipkeep:grade", id, review: it.review });
      await load(); // 以存储为准：保存失败时把本地改动丢掉，不留下和存储不一致的排期
    } finally {
      grading = false; // 刷新完成后才交还点击权；卡片重渲染后按钮自然是可用状态
    }
    if (!res || !res.ok) failToast(res, "打分保存失败，已还原，请重试");
    else if (res.actFailed) toast("分数存好了，但今天的打卡记录没写进去（热力图会少这一条）");
  }

  reviewEl.addEventListener("click", async (e) => {
    const cell = e.target.closest(".heat i");
    if (cell) {
      // 点格子下钻当天明细；没打卡的格子点了不展开，再点一次收起
      const day = cell.dataset.day;
      heatDay = Number(cell.dataset.n) > 0 ? (heatDay === day ? "" : day) : "";
      render();
      return;
    }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "heat-close") {
      heatDay = "";
      render();
      return;
    }
    const card = reviewEl.querySelector(".rev-card");
    if (!card) return;
    const id = card.dataset.id;
    const act = btn.dataset.act;
    if (act === "reveal") revealAnswer();
    else if (act === "grade") await gradeCurrent(id, Number(btn.dataset.g));
  });

  /* 回顾页键盘打分：一条几百次的复习，手手点按钮比键盘慢得多 */
  const GRADE_KEYS = { "1": 0, "2": 1, "3": 2 };

  document.addEventListener("keydown", (e) => {
    if (view !== "review" || !modalEl.hidden) return; // 确认弹窗开着时数字键归弹窗
    if (!keysEl.hidden) return; // 快捷键帮助浮层开着时，键盘归浮层
    const tag = e.target && e.target.tagName;
    // 输入框 / 按钮上的按键归它们自己，别把打字和回车当成打分
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return;
    if (!reviewEl.querySelector(".rev-card")) return;
    if (e.key === " " || e.key === "Enter") {
      if (revealAnswer()) e.preventDefault(); // 空格不拦掉就是页面往下滚
      return;
    }
    const g = GRADE_KEYS[e.key];
    if (g === undefined || !answerRevealed()) return;
    e.preventDefault();
    gradeCurrent(reviewEl.querySelector(".rev-card").dataset.id, g);
  });

  /**
   * 收藏列表的键盘流：↑/↓ 移焦点、x 勾选、Enter 展开、? 帮助。
   * 三条边界：正在打字不算快捷键；确认弹窗 / 帮助浮层开着时按键归它们；
   * 只在收藏视图生效，高亮和回顾各有自己的键位，不串台。
   */
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return;
    if (!keysEl.hidden) {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        setKeysHelp(false);
      }
      return;
    }
    if (e.key === "?") {
      e.preventDefault();
      setKeysHelp(true);
      return;
    }
    if (view !== "clips" || !modalEl.hidden) return; // 弹窗开着时按键归弹窗；高亮 / 回顾各有键位
    const arr = filtered();
    const at = arr.findIndex((it) => it.id === focusId);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); // 不拦掉就是整页往下滚，焦点看着像没动
      if (arr.length === 0) { focusId = ""; render(); return; }
      const next = e.key === "ArrowDown"
        ? Math.min(at + 1, arr.length - 1)
        : Math.max(at - 1, 0);
      focusId = arr[next < 0 ? 0 : next].id;
      render();
      const row = listEl.querySelector(".item.focused");
      if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "x" || e.key === "X") {
      if (!focusId || !arr.some((it) => it.id === focusId)) return;
      e.preventDefault();
      if (selected.has(focusId)) selected.delete(focusId);
      else selected.add(focusId);
      render();
      return;
    }
    if (e.key === "Enter") {
      const row = listEl.querySelector(".item.focused");
      const btn = row && row.querySelector('[data-act="more"]');
      if (btn) {
        e.preventDefault();
        btn.click(); // 展开逻辑只有列表那套，别再抄一份
      }
    }
  });

  /* ---------- 收藏列表交互 ---------- */

  /**
   * 批量条：只在收藏视图、且真勾了东西时出现。
   * 顺手把已经不存在的 id 剪掉——别处（另一个标签页、撤销过期）删过的收藏
   * 不能继续留在选择里，否则批量动作会对着空气报错，数量也会骗人。
   */
  function renderBatchbar() {
    const live = new Set(items.map((it) => it && it.id));
    selected.forEach((id) => {
      if (!live.has(id)) selected.delete(id);
    });
    const n = selected.size;
    batchEl.hidden = view !== "clips" || n === 0;
    batchTextEl.textContent = `已选 ${n} 条`;
    const arr = view === "clips" ? filtered() : [];
    const allOn = arr.length > 0 && arr.every((it) => selected.has(it.id));
    $("btn-batch-all").textContent = allOn ? "取消全选" : "全选";
  }

  function toggleSelect(id, row, box) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    const on = selected.has(id);
    if (row) row.classList.toggle("selected", on);
    if (box) box.checked = on; // 勾选状态以 Set 为准，重绘时也是它说了算
    renderBatchbar();
  }

  /**
   * 列表写操作排队：删除 / 加标签在途时忽略后续点击。
   * 不拦的话连点两次会发两条消息，第二条对着已经消失的数据什么也没做，
   * 却照样弹出「已删除，可撤销」——提示说谎比多一次点击更糟。
   */
  async function withLock(fn) {
    if (mutating) return;
    mutating = true;
    try {
      await fn();
    } finally {
      mutating = false;
    }
  }

  async function batchDelete() {
    const ids = [...selected];
    if (!ids.length) return;
    await withLock(async () => {
      const res = await send({ type: "clipkeep:delete-many", ids });
      await load(); // 以存储为准：删掉的 id 会在 renderBatchbar 里被剪掉
      if (!res || !res.ok) return failToast(res, "批量删除失败，请重试");
      // 一次能删的有上限，说清楚还剩多少，别让用户以为整批都干净了；
      // 回收站没写进去就没有「可撤销」可言，说了等于让人对着撤不回来的东西放心
      const undo = res.trashed === false ? "，但回收站没写进去，撤销不了" : "，可撤销";
      toast(res.limited
        ? `已删除 ${res.removed} 条（单次上限）${undo}，剩下的请再选一批`
        : `已删除 ${res.removed} 条${undo}`);
    });
  }

  async function batchTag() {
    const ids = [...selected];
    if (!ids.length) return;
    const val = prompt(`给选中的 ${ids.length} 条追加标签（逗号分隔）：`, "");
    if (val === null) return;
    if (!val.trim()) return toast("没有输入标签");
    await withLock(async () => {
      const res = await send({ type: "clipkeep:tag-add-many", ids, tags: val });
      await load();
      if (!res || !res.ok) return failToast(res, "批量加标签失败，请重试");
      const n = Number(res.changed) || 0;
      const drop = Number(res.dropped) || 0;
      // 一次处理不完就说清楚，别报「已给 N 条加标签」让用户以为整批都改完了
      if (res.limited && !n) return toast(`一次最多处理 ${BATCH_MAX} 条，请分批再选`);
      // 上限 12 个：一个都没加上时不能说「没有变化」（那是「本来就有」的意思），
      // 加上一部分也要说清有几个被挡在门外
      if (drop) {
        toast(n
          ? `已给 ${n} 条加标签，另有 ${drop} 个标签超上限（每条最多 ${TAG_MAX} 个）没存进去`
          : `${drop} 个标签超上限没存进去（每条最多 ${TAG_MAX} 个）`);
        return;
      }
      toast(res.limited
        ? `已给 ${n} 条加标签（单次上限 ${BATCH_MAX} 条），剩下的请再选一批`
        : n ? `已给 ${n} 条加标签` : "标签没有变化");
    });
  }

  /** 批量导出按当前列表顺序，导出的就是用户看到的那一批 */
  function batchExport() {
    const arr = filtered().filter((it) => selected.has(it.id));
    if (!arr.length) return toast("没有选中内容");
    download(mdOf(arr), `clipkeep-${Date.now()}.md`);
    toast(`已导出 ${arr.length} 条`);
  }

  listEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const row = e.target.closest(".item");
    if (!row) return;
    const id = row.dataset.id;
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const act = btn.dataset.act;
    if (act === "sel") toggleSelect(id, row, btn);
    else if (act === "copy") copyText(mediaOf(it) || it.text);
    else if (act === "del") {
      // 连点只认第一次：第二次对着已经消失的数据删除，提示就成了谎话
      await withLock(async () => {
        // 提示要跟着真实结果走：后台没写成功就不能报「已删除」
        const res = await send({ type: "clipkeep:delete", id });
        await load();
        // 三种结果三句话：真删了、这条早就不在了、写存储失败 / 后台失联
        if (res && res.ok) {
          toast(res.trashed === false ? "已删除，但回收站没写进去，这条撤销不了" : "已删除，可撤销");
        } else if (res && res.error === "not_found") {
          toast("这条已经不在收藏里了");
        } else {
          failToast(res, "删除失败，请重试");
        }
      });
    }
    else if (act === "tag") {
      const val = prompt("输入标签，用逗号分隔：", (it.tags || []).join(","));
      if (val === null) return;
      await withLock(async () => {
        const res = await send({ type: "clipkeep:update", id, patch: { tags: val } });
        await load();
        // 每条最多 TAG_MAX 个标签，超出的会被后台舍弃：只说「标签已更新」听不出少了几
        const drop = res && Number(res.tagDropped) || 0;
        if (res && res.ok) {
          toast(drop ? `标签已更新，${drop} 个超上限（最多 ${TAG_MAX} 个）没进去` : "标签已更新");
        } else {
          failToast(res, "保存失败，请重试");
        }
      });
    } else if (act === "export") {
      download(mdOf([it]), `clipkeep-${it.id}.md`);
    } else if (act === "more") {
      const box = row.querySelector(".item-text");
      const stillClamped = box.classList.toggle("is-clamped"); // 还折叠着就把按钮留作「展开」
      btn.textContent = stillClamped ? "展开全文" : "收起";
    }
  });

  tagsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    activeTag = activeTag === chip.dataset.tag ? "" : chip.dataset.tag;
    render();
  });

  filterEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    if (chip.dataset.kind !== undefined) {
      activeKind = activeKind === chip.dataset.kind ? "" : chip.dataset.kind;
    } else if (chip.dataset.site !== undefined) {
      activeSite = activeSite === chip.dataset.site ? "" : chip.dataset.site;
    } else {
      return;
    }
    render();
  });

  /* 快捷键帮助：鼠标和键盘走同一个开关，点遮罩也能关 */
  function setKeysHelp(on) {
    keysEl.hidden = !on;
    $("btn-keys").classList.toggle("active", on);
  }
  $("btn-keys").addEventListener("click", () => setKeysHelp(keysEl.hidden));
  keysEl.addEventListener("click", (e) => {
    if (e.target === keysEl || e.target.closest('[data-act="close"]')) setKeysHelp(false);
  });

  searchEl.addEventListener("input", render);
  sortEl.addEventListener("change", renderClips);

  $("btn-batch-all").addEventListener("click", () => {
    const arr = filtered();
    const allOn = arr.length > 0 && arr.every((it) => selected.has(it.id));
    // 全选的范围是「当前筛出来的这一批」：换筛选后再点，选中集合跟着换，
    // 不会把上一次筛选里没再显示出来的条目悄悄带进批量删除
    selected = new Set(allOn ? [] : arr.map((it) => it.id));
    render();
  });
  $("btn-batch-tag").addEventListener("click", batchTag);
  $("btn-batch-export").addEventListener("click", batchExport);
  $("btn-batch-del").addEventListener("click", batchDelete);
  $("btn-batch-cancel").addEventListener("click", () => {
    selected.clear();
    render();
  });
  $("btn-theme").addEventListener("click", toggleTheme);  $("btn-export").addEventListener("click", exportMd);
  $("btn-reader").addEventListener("click", triggerReader);

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    view = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $("view-clips").hidden = view !== "clips";
    $("view-marks").hidden = view !== "marks";
    $("view-review").hidden = view !== "review";
    render();
  });

  async function triggerReader() {
    try {
      const tabs = await API.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) await API.tabs.sendMessage(tabs[0].id, { type: "clipkeep:reader" });
      window.close();
    } catch (_) {
      toast("当前页面不支持净化阅读");
    }
  }

  /* ---------- 复制 / Markdown 导出 ---------- */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast("已复制 ✓"), () => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("已复制 ✓"); } catch (_) { toast("复制失败"); }
    document.body.removeChild(ta);
  }

  /** 小标题写法：编号+来源 / 仅来源标题 / 正文首句 / 收藏时间 */
  function headingOf(it, i, tpl) {
    if (tpl === "date") return fmtDate(it.createdAt);
    if (tpl === "text") {
      const first = String(it.text || "").split(/[\n。！？!?]/)[0].trim() || "未命名";
      return first.length > 24 ? first.slice(0, 24) + "…" : first;
    }
    const name = it.title || hostname(it.url) || "未命名";
    return tpl === "title" ? name : `${i + 1}. ${name}`;
  }

  function mdOf(arr) {
    const tpl = exportPrefs();
    const lines = [];
    if (tpl.frontMatter) {
      // Obsidian 读文件顶部的 YAML 块作为笔记属性
      lines.push("---", "title: ClipKeep 收藏", `exported: ${fmtDate(Date.now())}`, `count: ${arr.length}`, "---", "");
    }
    lines.push("# ClipKeep 收藏", "", `> 导出于 ${fmtDate(Date.now())} · 共 ${arr.length} 条`, "");
    arr.forEach((it, i) => {
      lines.push(`## ${headingOf(it, i, tpl.heading)}`);
      if (it.tags && it.tags.length) lines.push("", "`" + it.tags.map((t) => "#" + t).join(" ") + "`");
      const media = mediaOf(it);
      if (media) {
        // 尖括号目的地同来源行：地址里的括号不会把 Markdown 链接写断
        const label = String(it.text || "").replace(/[[\]\n\r]/g, " ").trim() || hostname(media);
        const dest = media.replace(/[<>\n\r]/g, " ");
        lines.push("", it.kind === "image" ? `![${label}](<${dest}>)` : `[${label}](<${dest}>)`);
      }
      lines.push("", "> " + String(it.text).replace(/\n/g, "\n> "));
      if (it.note) lines.push("", "**备注：** " + it.note);
      if (it.url && tpl.source) {
        const src = linkable(it.url);
        // 尖括号包住目的地：URL 里的括号（维基太常见）不会把链接写断
        lines.push("", src ? `[来源](<${src.replace(/[<>\n\r]/g, " ")}>)` : `来源：${String(it.url).replace(/\s+/g, " ")}`);
      }
      lines.push("", `*${fmtDate(it.createdAt)}*`, "", "---", "");
    });
    return lines.join("\n");
  }

  function exportMd() {
    const arr = view === "review" ? items : filtered();
    if (!arr.length) return toast("没有可导出的内容");
    download(mdOf(arr), `clipkeep-${Date.now()}.md`);
    toast(`已导出 ${arr.length} 条`);
  }

  function download(content, filename, type) {
    const blob = new Blob([content], { type: type || "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ---------- JSON 备份 / 恢复 ---------- */

  async function backup() {
    const obj = await API.storage.local.get([STORAGE_KEY, HL_KEY]);
    const data = {
      app: "ClipKeep",
      version: 1,
      exportedAt: new Date().toISOString(),
      items: Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [],
      highlights: Array.isArray(obj[HL_KEY]) ? obj[HL_KEY] : [],
    };
    if (!data.items.length && !data.highlights.length) return toast("没有可备份的数据");
    download(JSON.stringify(data, null, 2), `clipkeep-backup-${Date.now()}.json`, "application/json");
    toast(`已备份 ${data.items.length} 条收藏 · ${data.highlights.length} 条高亮`);
  }

  const SAFE_ID = /^[\w-]{1,64}$/;
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /** 备份是外部文件：盒号夹到合法区间，排期缺失/非法时视为立即到期，别让条目悄悄消失 */
  function normalizeReview(r) {
    if (!r || typeof r !== "object") return undefined;
    const box = Math.max(0, Math.min(INTERVALS.length - 1, Math.floor(Number(r.box)) || 0));
    const dueNum = Number(r.due);
    const due = Number.isFinite(dueNum) && dueNum > 0 ? dueNum : Date.now();
    const seen = Math.max(0, Math.floor(Number(r.seen)) || 0);
    return { box, due, seen };
  }

  function normalizeItem(it) {
    if (!it || typeof it !== "object" || !it.text) return null;
    const rawId = String(it.id === undefined || it.id === null ? "" : it.id);
    const media = mediaOf(it); // 图片 / 链接收藏的类型与地址，非法值在这里就丢掉
    return {
      id: SAFE_ID.test(rawId) ? rawId : genId(),
      text: String(it.text),
      note: String(it.note || ""),
      tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
      url: String(it.url || ""),
      title: String(it.title || ""),
      createdAt: Number(it.createdAt) || Date.now(),
      review: normalizeReview(it.review),
      ...(media ? { kind: it.kind, [it.kind === "image" ? "image" : "link"]: media } : {}),
    };
  }

  /**
   * 高亮的比对键按内容算，不按 id 算。
   * id 在导入时可能被现场生成（备份里的 id 非法就换一个），拿 id 比等于每条都是新的，
   * 同一份备份导第二次就把高亮翻倍；地址 + 正文 + 落点时间才是「同一条高亮」。
   */
  const hlKeyOf = (h) => `${h.url}|${h.text}|${h.createdAt}`;
  const HL_COLORS = ["yellow", "green", "pink", "blue"];

  /** 高亮记录同样是外部数据：id 白名单、颜色取合法值、字段补齐 */
  function normalizeHighlight(h) {
    if (!h || typeof h !== "object" || !h.text || !h.url) return null;
    const rawId = String(h.id === undefined || h.id === null ? "" : h.id);
    return {
      id: SAFE_ID.test(rawId) ? rawId : genId(),
      url: String(h.url),
      title: String(h.title || ""),
      text: String(h.text),
      note: String(h.note || ""),
      color: HL_COLORS.indexOf(h.color) >= 0 ? h.color : "yellow",
      createdAt: Number(h.createdAt) || Date.now(),
    };
  }

  async function restore(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (_) {
      return toast("恢复失败：文件解析错误");
    }
    const inItems = Array.isArray(data.items) ? data.items.map(normalizeItem).filter(Boolean) : [];
    const inHl = Array.isArray(data.highlights) ? data.highlights.map(normalizeHighlight).filter(Boolean) : [];
    if (!inItems.length && !inHl.length) return toast("备份文件为空或格式不符");

    const obj = await API.storage.local.get([STORAGE_KEY, HL_KEY]);
    const takenAt = Date.now(); // 快照读取时刻：比这更新的记录没出现在差异里，不能被覆盖抹掉
    const curItems = Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
    const curHl = Array.isArray(obj[HL_KEY]) ? obj[HL_KEY] : [];
    const inIds = new Set(inItems.map((x) => x.id));
    const curIds = new Set(curItems.map((x) => x.id));
    const curHlKeys = new Set(curHl.map(hlKeyOf));
    const inHlKeys = new Set(inHl.map(hlKeyOf));
    const plan = {
      addItems: inItems.filter((x) => !curIds.has(x.id)),
      sameItems: inItems.length - inItems.filter((x) => !curIds.has(x.id)).length,
      localOnly: curItems.filter((x) => !inIds.has(x.id)),
      addHl: inHl.filter((x) => !curHlKeys.has(hlKeyOf(x))),
      sameHl: inHl.length - inHl.filter((x) => !curHlKeys.has(hlKeyOf(x))).length,
      localOnlyHl: curHl.filter((x) => !inHlKeys.has(hlKeyOf(x))),
      inItems,
      inHl,
      curItems,
      curHl,
      takenAt,
    };
    if (!plan.addItems.length && !plan.addHl.length && plan.sameItems === curItems.length) {
      return toast("备份与本地一致，无需恢复");
    }
    pendingRestore = plan;
    openRestoreModal(plan);
  }

  function openRestoreModal(p) {
    $("modal-title").textContent = "恢复备份 · 差异确认";
    const hlNote = p.inHl.length === 0 && p.curHl.length
      ? `<li><b class="same">备份未含高亮</b>，覆盖会保留本地 ${p.curHl.length} 条高亮 / 批注</li>`
      : "";
    $("modal-body").innerHTML = `
      <ul class="diff">
        <li><b class="add">+${p.addItems.length}</b> 条备份里的新收藏</li>
        <li><b class="same">${p.sameItems}</b> 条两边已有（保留本地版本）</li>
        <li><b class="local">${p.localOnly.length}</b> 条仅存在于本地${p.localOnly.length ? "（覆盖会丢失）" : ""}</li>
        <li><b class="add">+${p.addHl.length}</b> 条新高亮 · ${p.sameHl} 条已存在</li>
        ${hlNote}
      </ul>
      <p class="diff-hint">合并：只补新内容，不动本地；覆盖本地：以备份为准（备份里没有的类别保留本地）。</p>`;
    modalEl.hidden = false;
  }

  function closeRestoreModal() {
    modalEl.hidden = true;
    pendingRestore = null;
  }

  /** 正文超过 MAX_TEXT 会被后台砍短：恢复类提示要顺口带一句，别让用户以为备份原样回来了 */
  function truncNote(n) {
    const k = Number(n) || 0;
    return k ? `（${k} 条正文过长，已截断到 ${MAX_TEXT} 字）` : "";
  }

  /** 两类内容都交给后台串行写；takenAt 让「覆盖」只作用于弹窗看到的那份快照 */
  async function writeBoth(itemsArr, hlArr, takenAt) {
    const iRes = await send({ type: "clipkeep:replace", payload: { items: itemsArr, takenAt } });
    const hRes = await send({ type: "clipkeep:hl-replace", payload: { highlights: hlArr, takenAt } });
    // 成败要各自带回去：没写成功却照报条数，就是当着用户的面说谎
    return {
      itemsOk: !!(iRes && iRes.ok),
      hlOk: !!(hRes && hRes.ok),
      items: iRes && iRes.ok ? iRes.count : 0,
      hl: hRes && hRes.ok ? hRes.count : 0,
      truncated: iRes && iRes.ok ? Number(iRes.truncated) || 0 : 0,
    };
  }

  $("modal-cancel").addEventListener("click", closeRestoreModal);
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) closeRestoreModal();
  });
  $("modal-ok").addEventListener("click", async () => {
    if (!pendingRestore) return;
    const p = pendingRestore;
    // 收藏交给 background 现读现写：弹窗开着时别的标签页存的内容不会被旧快照抹掉
    const res = await send({ type: "clipkeep:merge", payload: { items: p.inItems } });
    if (!res || !res.ok) return failToast(res, "合并失败，请重试");
    // 高亮同理：逐条走后台 upsert，不再拿旧快照整表回写
    let hlAdded = 0;
    for (const h of p.addHl) {
      const r = await send({ type: "clipkeep:hl-add", payload: h });
      if (r && r.ok && !r.dup) hlAdded++;
    }
    closeRestoreModal();
    await load();
    toast(`已合并：新增 ${res.added} 收藏 · ${hlAdded} 高亮${truncNote(res.truncated)}`);
  });
  $("modal-alt").addEventListener("click", async () => {
    if (!pendingRestore) return;
    const p = pendingRestore;
    if (p.localOnly.length && !confirm(`备份里没有这 ${p.localOnly.length} 条本地内容，覆盖后将丢失。继续？`)) return;
    // 备份没提到的类别保留本地，避免「覆盖」把高亮批注悄悄清空
    const itemsArr = (p.inItems.length ? p.inItems : p.curItems).slice().sort((a, b) => b.createdAt - a.createdAt);
    const hlArr = p.inHl.length ? p.inHl : p.curHl;
    const written = await writeBoth(itemsArr, hlArr, p.takenAt);
    closeRestoreModal();
    await load();
    if (!written.itemsOk || !written.hlOk) {
      // 后台没写成功就别报「已覆盖」：说清楚哪一类没进去，本地内容还是原样
      const bad = [!written.itemsOk ? "收藏" : "", !written.hlOk ? "高亮" : ""].filter(Boolean).join(" / ");
      toast(`覆盖失败：${bad}没有写入成功，本地内容未变，请重试`);
      return;
    }
    toast(`已用备份覆盖：共 ${written.items} 收藏 · ${written.hl} 高亮${truncNote(written.truncated)}`);
  });

  $("btn-backup").addEventListener("click", backup);
  $("btn-restore").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) restore(f);
    e.target.value = "";
  });

  $("btn-clear").addEventListener("click", async () => {
    if (!items.length) return toast("已经是空的了");
    if (confirm("确定清空全部收藏？此操作不可恢复（高亮批注不受影响）。")) {
      // 说了「不可恢复」就要真的不可恢复：先看收藏清没清，再看回收站关没关
      const res = await send({ type: "clipkeep:clear" });
      if (!res || !res.ok) { await load(); return failToast(res, "清空失败，收藏还在，请重试"); }
      const t = await send({ type: "clipkeep:trash-clear" });
      await load();
      toast(t && t.ok ? "已清空" : "收藏已清空，但回收站没关掉，撤销记录还在");
    }
  });

  /* ---------- 实时刷新 ---------- */
  if (API.storage && API.storage.onChanged) {
    API.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEY] || changes[HL_KEY] || changes[PREFS_KEY] || changes[TRASH_KEY] || changes[ACTIVITY_KEY]) load();
    });
  }

  load();
})();
