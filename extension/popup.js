/**
 * ClipKeep - popup 逻辑
 * 收藏列表 / 搜索 / 标签筛选 / 排序 / 复制 / 删除 / Markdown 导出 / 深色模式
 * + 回顾（Leitner 间隔重复）+ JSON 备份 / 恢复。
 */
(() => {
  const API = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;
  const STORAGE_KEY = "clipkeep_items";
  const HL_KEY = "clipkeep_highlights";
  const PREFS_KEY = "clipkeep_prefs";
  const DAY = 86400000;
  const INTERVALS = [0, 1, 3, 7, 21, 90]; // 各记忆盒对应的复习间隔（天）

  const $ = (id) => document.getElementById(id);
  const listEl = $("list");
  const emptyEl = $("empty");
  const countEl = $("count");
  const tagsEl = $("tags");
  const searchEl = $("search");
  const sortEl = $("sort");
  const toastEl = $("toast");
  const dueEl = $("due");
  const reviewEl = $("review");

  let items = [];
  let activeTag = "";
  let view = "clips";
  let toastTimer = null;

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

  function fmtDate(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function hostname(url) {
    try { return new URL(url).hostname; } catch (_) { return url; }
  }

  /* ---------- 复习调度（Leitner 盒） ---------- */

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
    r.due = Date.now() + INTERVALS[r.box] * DAY;
    r.seen = (r.seen || 0) + 1;
    return it;
  }
  function dueItems() {
    const now = Date.now();
    return items.filter((it) => ensureReview(it).due <= now);
  }

  /* ---------- 数据加载 ---------- */

  async function load() {
    const obj = await API.storage.local.get([STORAGE_KEY, PREFS_KEY]);
    items = Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
    const prefs = obj[PREFS_KEY] || {};
    applyTheme(prefs.dark ? "dark" : "light");
    render();
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
    const due = dueItems().length;
    if (due > 0) { dueEl.hidden = false; dueEl.textContent = due; }
    else dueEl.hidden = true;

    if (view === "review") renderReview();
    else renderClips();
  }

  function renderClips() {
    renderTags();
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
    const tags = (it.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join("");
    const link = it.url
      ? `<a href="${esc(it.url)}" target="_blank" rel="noopener" title="${esc(it.title || it.url)}">${esc(it.title || hostname(it.url))}</a>`
      : "";
    const note = it.note ? `<div class="item-note">${esc(it.note)}</div>` : "";
    return `
      <div class="item" data-id="${it.id}">
        <div class="item-text">${esc(it.text)}</div>
        ${note}
        <div class="item-meta">${tags}${link}<span>${fmtDate(it.createdAt)}</span></div>
        <div class="item-actions">
          <button class="mini-btn" data-act="copy">复制</button>
          <button class="mini-btn" data-act="tag">加标签</button>
          <button class="mini-btn" data-act="export">导出</button>
          <button class="mini-btn danger" data-act="del">删除</button>
        </div>
      </div>`;
  }

  /* ---------- 回顾视图 ---------- */

  function renderReview() {
    const due = dueItems();
    if (!items.length) {
      reviewEl.innerHTML = `<div class="empty"><div class="empty-ico">🔁</div><p>还没有可回顾的内容</p><span>先去网页上划词收藏几条吧。</span></div>`;
      return;
    }
    if (!due.length) {
      const next = items.map((it) => ensureReview(it).due).sort((a, b) => a - b)[0];
      reviewEl.innerHTML = `<div class="empty done"><div class="empty-ico">🎉</div><p>今日回顾已完成</p><span>下一条将在 ${fmtDate(next)} 到期。明天再来 ~</span></div>`;
      return;
    }
    const it = due[0];
    const r = ensureReview(it);
    const tags = (it.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join("");
    const link = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title || hostname(it.url))}</a>` : "";
    reviewEl.innerHTML = `
      <div class="rev-progress">待回顾 ${due.length} 条 · 记忆盒 ${r.box}/${INTERVALS.length - 1}</div>
      <div class="rev-card" data-id="${it.id}">
        <div class="rev-front">${esc(it.text)}</div>
        <div class="rev-back" hidden>
          ${it.note ? `<div class="rev-note">${esc(it.note)}</div>` : ""}
          <div class="rev-meta">${tags}${link}</div>
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
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const card = reviewEl.querySelector(".rev-card");
    if (!card) return;
    const id = card.dataset.id;
    const act = btn.dataset.act;
    if (act === "reveal") {
      reviewEl.querySelector(".rev-back").hidden = false;
      btn.hidden = true;
      reviewEl.querySelector(".rev-grade").hidden = false;
    } else if (act === "grade") {
      const it = items.find((x) => x.id === id);
      if (!it) return;
      grade(it, Number(btn.dataset.g));
      await API.runtime.sendMessage({ type: "clipkeep:update", id, patch: { review: it.review } });
      await load();
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
    if (act === "copy") copyText(it.text);
    else if (act === "del") { await API.runtime.sendMessage({ type: "clipkeep:delete", id }); await load(); toast("已删除"); }
    else if (act === "tag") {
      const val = prompt("输入标签，用逗号分隔：", (it.tags || []).join(","));
      if (val !== null) { await API.runtime.sendMessage({ type: "clipkeep:update", id, patch: { tags: val } }); await load(); }
    } else if (act === "export") {
      download(mdOf([it]), `clipkeep-${it.id}.md`);
    }
  });

  tagsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    activeTag = activeTag === chip.dataset.tag ? "" : chip.dataset.tag;
    render();
  });

  searchEl.addEventListener("input", renderClips);
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

  function mdOf(arr) {
    const lines = ["# ClipKeep 收藏", "", `> 导出于 ${fmtDate(Date.now())} · 共 ${arr.length} 条`, ""];
    arr.forEach((it, i) => {
      lines.push(`## ${i + 1}. ${it.title || hostname(it.url) || "未命名"}`);
      if (it.tags && it.tags.length) lines.push("", "`" + it.tags.map((t) => "#" + t).join(" ") + "`");
      lines.push("", "> " + String(it.text).replace(/\n/g, "\n> "));
      if (it.note) lines.push("", "**备注：** " + it.note);
      if (it.url) lines.push("", `[来源](${it.url})`);
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

  function normalizeItem(it) {
    if (!it || typeof it !== "object" || !it.text) return null;
    return {
      id: String(it.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      text: String(it.text),
      note: String(it.note || ""),
      tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
      url: String(it.url || ""),
      title: String(it.title || ""),
      createdAt: Number(it.createdAt) || Date.now(),
      review: it.review && typeof it.review.box === "number" ? it.review : undefined,
    };
  }

  async function restore(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const inItems = Array.isArray(data.items) ? data.items.map(normalizeItem).filter(Boolean) : [];
      const inHl = Array.isArray(data.highlights) ? data.highlights.filter((h) => h && h.text && h.url) : [];
      if (!inItems.length && !inHl.length) return toast("备份文件为空或格式不符");

      const obj = await API.storage.local.get([STORAGE_KEY, HL_KEY]);
      const curItems = Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
      const curHl = Array.isArray(obj[HL_KEY]) ? obj[HL_KEY] : [];

      // 按 id 合并，保留本地已有，新增缺失
      const itemMap = new Map(curItems.map((x) => [x.id, x]));
      let addI = 0;
      inItems.forEach((x) => { if (!itemMap.has(x.id)) { itemMap.set(x.id, x); addI++; } });
      const mergedItems = [...itemMap.values()].sort((a, b) => b.createdAt - a.createdAt);

      const hlKey = (h) => h.id || (h.url + "|" + h.text + "|" + h.createdAt);
      const hlMap = new Map(curHl.map((x) => [hlKey(x), x]));
      let addH = 0;
      inHl.forEach((x) => { if (!hlMap.has(hlKey(x))) { hlMap.set(hlKey(x), x); addH++; } });
      const mergedHl = [...hlMap.values()];

      await API.storage.local.set({ [STORAGE_KEY]: mergedItems, [HL_KEY]: mergedHl });
      await load();
      toast(`恢复完成：新增 ${addI} 收藏 · ${addH} 高亮`);
    } catch (e) {
      toast("恢复失败：文件解析错误");
    }
  }

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
      await load();
      toast("已清空");
    }
  });

  /* ---------- 实时刷新 ---------- */
  if (API.storage && API.storage.onChanged) {
    API.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes[STORAGE_KEY] || changes[PREFS_KEY])) load();
    });
  }

  load();
})();
