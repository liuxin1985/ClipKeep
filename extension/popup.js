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
  const CLAMP_AT = 240; // 超过这个长度的收藏在列表里默认折叠
  const DAY = 86400000;
  const INTERVALS = [0, 1, 3, 7, 21, 90]; // 各记忆盒对应的复习间隔（天）
  const HEAT_WEEKS = 8; // 热力图展示最近 8 周
  const HEAT_ROWS_MAX = 100; // 格子下钻最多渲染多少条明细（和后台 ACT_IDS_MAX 对齐）
  const TRASH_MINS = [1, 5, 10, 30, 60]; // 回收站可选保留时长
  const DEFAULT_TRASH_MINS = 10;
  const HEADINGS = ["numbered", "title", "text", "date"]; // Markdown 导出的小标题写法
  const DEFAULT_PREFS = {
    review: { cap: 20, mult: 1 },
    trash: { mins: DEFAULT_TRASH_MINS },
    export: { heading: "numbered", source: true, frontMatter: false },
  };

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

  let items = [];
  let marks = []; // 网页高亮 / 批注
  let trash = []; // 最近删除的收藏 / 高亮，保留时长见设置
  let activity = {}; // { "2026-09-27": 5 } 每日回顾条数
  let prefs = DEFAULT_PREFS;
  let activeTag = "";
  let view = "clips";
  let toastTimer = null;
  let pendingRestore = null;
  let grading = false; // 回顾打分写入中
  let heatDay = ""; // 热力图里点开要看明细的那一天，空表示没展开

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

  /** 列表里显示的可读标签 */
  function mediaLabel(it) {
    const url = mediaOf(it);
    if (!url) return "";
    return it.kind === "image" ? "查看原图" : hostname(url);
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
      const res = await API.runtime.sendMessage({ type: "clipkeep:trash-list" });
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

  function allTags() {
    const set = new Set();
    items.forEach((it) => (it.tags || []).forEach((t) => set.add(t)));
    return [...set].sort();
  }

  function renderTags() {
    const tags = allTags();
    if (activeTag && !tags.includes(activeTag)) activeTag = "";
    tagsEl.innerHTML = tags
      .map((t) => `<button class="chip ${t === activeTag ? "active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`)
      .join("");
  }

  function filtered() {
    const q = searchEl.value.trim().toLowerCase();
    let arr = items.filter((it) => {
      if (activeTag && !(it.tags || []).includes(activeTag)) return false;
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
    renderTrashbar();
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
      emptyEl.querySelector("p").textContent = items.length === 0 ? "还没有收藏" : "无匹配结果";
      emptyEl.querySelector("span").textContent =
        items.length === 0 ? "在网页上划选文字，点「收藏」即可留存到这里。" : "换个关键词或标签试试。";
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
    const media = mediaOf(it);
    const isMedia = it.kind === "image" || it.kind === "link";
    const kindBadge = isMedia
      ? `<span class="badge-kind">${it.kind === "image" ? "图片" : "链接"}</span>`
      : "";
    const mediaLink = media
      ? `<a class="item-kind" href="${esc(media)}" target="_blank" rel="noopener" title="${esc(media)}">${esc(hostname(media))}</a>`
      : "";
    const note = it.note ? `<div class="item-note">${hit(it.note, q)}</div>` : "";
    return `
      <div class="item" data-id="${esc(it.id)}">
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
      const res = await API.runtime.sendMessage({ type: "clipkeep:hl-update", id, patch: { color: nextHlColor(h.color) } });
      if (!res || !res.ok) return toast("换色失败，请重试");
      await load();
      toast("已换色");
    } else if (act === "hl-del") {
      // 走后台：进回收站 + 串行写，避免整表覆盖抹掉别处新增的高亮
      const res = await API.runtime.sendMessage({ type: "clipkeep:hl-delete", id });
      if (!res || !res.ok) return toast("删除失败，请重试");
      await load();
      toast("已删除高亮");
    }
  });

  $("btn-hl-export").addEventListener("click", exportHighlights);

  /* ---------- 回收站 / 撤销 ---------- */

  function renderTrashbar() {
    trashbarEl.hidden = trash.length === 0;
    if (!trash.length) return;
    const kinds = new Set(trash.map((t) => (t && t.kind === "hl" ? "高亮" : "收藏")));
    const what = kinds.size === 1 ? [...kinds][0] : "";
    trashTextEl.textContent = `已删除 ${trash.length} 条${what} · ${trashMins()} 分钟内可撤销`;
  }

  $("btn-undo").addEventListener("click", async () => {
    const entry = trash[0];
    if (!entry) return;
    const res = await API.runtime.sendMessage({ type: "clipkeep:trash-restore", tid: entry.tid });
    if (!res || !res.ok) {
      await load();
      toast(res && res.error === "not_found" ? "该条目已过期，无法撤销" : "撤销失败，请重试");
      return;
    }
    await load();
    toast(res.exists ? "该内容已存在，未重复添加" : "已撤销删除 ✓");
  });

  $("btn-trash-clear").addEventListener("click", async () => {
    if (!confirm("清空回收站？清空后无法再撤销。")) return;
    await API.runtime.sendMessage({ type: "clipkeep:trash-clear" });
    await load();
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
    const res = await API.runtime.sendMessage({ type: "clipkeep:tag-op", payload: { from, to } });
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
    // 明细最多存 100 条，手改过的记录可能有几百个 id：全渲染会把回顾页撑死
    const overflow = a.ids.length > listed.length
      ? `<p class="heat-day-note">仅显示前 ${listed.length} 条，另有 +${a.ids.length - listed.length} 条未列出。</p>`
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
      ? `<span class="badge-kind">${it.kind === "image" ? "图片" : "链接"}</span>` +
        `<a class="item-kind" href="${esc(media)}" target="_blank" rel="noopener" title="${esc(media)}">${esc(hostname(media))}</a>`
      : "";
    const capNote = due.length > queued.length ? ` · 今日上限 ${cap} 条，剩余 ${due.length - queued.length} 条明天继续` : "";
    reviewEl.innerHTML = heat + `
      <div class="rev-progress">本组待回顾 ${queued.length} 条 · 记忆盒 ${r.box}/${INTERVALS.length - 1}${capNote}</div>
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
    if (act === "reveal") {
      reviewEl.querySelector(".rev-back").hidden = false;
      btn.hidden = true;
      reviewEl.querySelector(".rev-grade").hidden = false;
    } else if (act === "grade") {
      if (grading) return; // 写入在途时忽略后续点击，否则连点会一次跳两盒
      const it = items.find((x) => x.id === id);
      if (!it) return;
      grading = true;
      const btns = [...reviewEl.querySelectorAll(".rev-grade button")];
      btns.forEach((b) => { b.disabled = true; });
      grade(it, Number(btn.dataset.g));
      let res = null;
      try {
        // 排期 + 当日打卡由后台一次写链完成，不会出现「分数存了、热力图没加」
        res = await API.runtime.sendMessage({ type: "clipkeep:grade", id, review: it.review });
        await load(); // 以存储为准：保存失败时把本地改动丢掉，不留下和存储不一致的排期
      } finally {
        grading = false; // 刷新完成后才交还点击权；卡片重渲染后按钮自然是可用状态
      }
      if (!res || !res.ok) toast("打分保存失败，已还原，请重试");
    }
  });

  /* ---------- 收藏列表交互 ---------- */

  listEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const row = e.target.closest(".item");
    if (!row) return;
    const id = row.dataset.id;
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const act = btn.dataset.act;
    if (act === "copy") copyText(mediaOf(it) || it.text);
    else if (act === "del") {
      // 提示要跟着真实结果走：后台没写成功就不能报「已删除」
      const res = await API.runtime.sendMessage({ type: "clipkeep:delete", id });
      await load();
      toast(res && res.ok ? "已删除，可撤销" : "删除失败，请重试");
    }
    else if (act === "tag") {
      const val = prompt("输入标签，用逗号分隔：", (it.tags || []).join(","));
      if (val === null) return;
      const res = await API.runtime.sendMessage({ type: "clipkeep:update", id, patch: { tags: val } });
      await load();
      toast(res && res.ok ? "标签已更新" : "保存失败，请重试");
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

  searchEl.addEventListener("input", render);
  sortEl.addEventListener("change", renderClips);
  $("btn-theme").addEventListener("click", toggleTheme);
  $("btn-export").addEventListener("click", exportMd);
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

  const hlKeyOf = (h) => h.id || (h.url + "|" + h.text + "|" + h.createdAt);
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

  /** 两类内容都交给后台串行写；takenAt 让「覆盖」只作用于弹窗看到的那份快照 */
  async function writeBoth(itemsArr, hlArr, takenAt) {
    const iRes = await API.runtime.sendMessage({ type: "clipkeep:replace", payload: { items: itemsArr, takenAt } });
    const hRes = await API.runtime.sendMessage({ type: "clipkeep:hl-replace", payload: { highlights: hlArr, takenAt } });
    return {
      items: iRes && iRes.ok ? iRes.count : itemsArr.length,
      hl: hRes && hRes.ok ? hRes.count : hlArr.length,
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
    const res = await API.runtime.sendMessage({ type: "clipkeep:merge", payload: { items: p.inItems } });
    if (!res || !res.ok) return toast("合并失败，请重试");
    // 高亮同理：逐条走后台 upsert，不再拿旧快照整表回写
    let hlAdded = 0;
    for (const h of p.addHl) {
      const r = await API.runtime.sendMessage({ type: "clipkeep:hl-add", payload: h });
      if (r && r.ok && !r.dup) hlAdded++;
    }
    closeRestoreModal();
    await load();
    toast(`已合并：新增 ${res.added} 收藏 · ${hlAdded} 高亮`);
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
    toast(`已用备份覆盖：共 ${written.items} 收藏 · ${written.hl} 高亮`);
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
      await API.runtime.sendMessage({ type: "clipkeep:clear" });
      // 既然提示了「不可恢复」，就别让回收站留着后门
      await API.runtime.sendMessage({ type: "clipkeep:trash-clear" });
      await load();
      toast("已清空");
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
