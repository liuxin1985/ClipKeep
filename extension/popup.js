/**
 * ClipKeep - popup 逻辑
 * 列表渲染、搜索、标签筛选、排序、复制、删除、加标签、Markdown 导出、深色模式。
 */
(() => {
  const API = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;
  const STORAGE_KEY = "clipkeep_items";
  const PREFS_KEY = "clipkeep_prefs";

  const $ = (id) => document.getElementById(id);
  const listEl = $("list");
  const emptyEl = $("empty");
  const countEl = $("count");
  const tagsEl = $("tags");
  const searchEl = $("search");
  const sortEl = $("sort");
  const toastEl = $("toast");

  let items = [];
  let activeTag = "";
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
    renderTags();
    countEl.textContent = String(items.length);
    const arr = filtered();
    const nodes = arr.map(itemNode);
    listEl.querySelectorAll(".item").forEach((n) => n.remove());
    if (arr.length === 0) {
      emptyEl.style.display = items.length === 0 ? "block" : "block";
      return;
    }
    emptyEl.style.display = "none";
    listEl.appendChild(frag(nodes));
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

  function hostname(url) {
    try { return new URL(url).hostname; } catch (_) { return url; }
  }

  /* ---------- 交互 ---------- */

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

  searchEl.addEventListener("input", render);
  sortEl.addEventListener("change", render);
  $("btn-theme").addEventListener("click", toggleTheme);
  $("btn-export").addEventListener("click", exportAll);
  $("btn-reader").addEventListener("click", triggerReader);
  $("btn-clear").addEventListener("click", async () => {
    if (!items.length) return toast("已经是空的了");
    if (confirm("确定清空全部收藏？此操作不可恢复。")) {
      await API.runtime.sendMessage({ type: "clipkeep:clear" });
      await load();
      toast("已清空");
    }
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

  /* ---------- 复制 / 导出 ---------- */

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

  function exportAll() {
    const arr = filtered();
    if (!arr.length) return toast("没有可导出的内容");
    download(mdOf(arr), `clipkeep-${Date.now()}.md`);
    toast(`已导出 ${arr.length} 条`);
  }

  function download(content, filename) {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ---------- 实时刷新 ---------- */
  if (API.storage && API.storage.onChanged) {
    API.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_KEY]) load();
    });
  }

  load();
})();
