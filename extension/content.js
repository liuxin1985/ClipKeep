/**
 * ClipKeep - content script
 * 划词浮动工具条、快速收藏卡片、Toast、净化阅读、划词高亮 + 原文批注。
 * 纯原生 JS，零依赖，兼容 Chrome / Edge / Safari。
 */
(() => {
  if (window.__clipkeepInjected) return;
  window.__clipkeepInjected = true;

  const API = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;
  const NS = "clipkeep";
  const HL_KEY = "clipkeep_highlights";
  const COLORS = { yellow: "#fff3a3", green: "#c7f5c7", pink: "#ffd0e0", blue: "#cfe3ff" };

  let toolbar = null;
  let card = null;
  let toastTimer = null;
  let readerRoot = null;

  /* ---------- 工具函数 ---------- */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        API.runtime.sendMessage(msg, (res) => resolve(res || { ok: false }));
      } catch (e) {
        resolve({ ok: false });
      }
    });
  }

  function toast(message) {
    let el = document.getElementById(NS + "-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = NS + "-toast";
      el.className = NS + "-toast";
      document.documentElement.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("is-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-show"), 1800);
  }

  function getSelectionText() {
    const sel = window.getSelection();
    return sel ? sel.toString().trim() : "";
  }

  /* ---------- 高亮存储 ---------- */

  async function getHighlights() {
    const o = await API.storage.local.get(HL_KEY);
    return Array.isArray(o[HL_KEY]) ? o[HL_KEY] : [];
  }
  async function setHighlights(list) {
    await API.storage.local.set({ [HL_KEY]: list });
  }
  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------- 浮动工具条 ---------- */

  function ensureToolbar() {
    if (toolbar) return toolbar;
    toolbar = document.createElement("div");
    toolbar.id = NS + "-toolbar";
    toolbar.className = NS + "-toolbar";
    toolbar.innerHTML = `
      <button class="${NS}-btn ${NS}-btn-save" type="button">★ 收藏</button>
      <button class="${NS}-btn ${NS}-btn-hl" type="button" title="高亮">🖍</button>
      <button class="${NS}-btn ${NS}-btn-note" type="button" title="批注">✎</button>
      <button class="${NS}-btn ${NS}-btn-read" type="button">阅读</button>
    `;
    toolbar.addEventListener("mousedown", (e) => e.preventDefault());
    toolbar.querySelector("." + NS + "-btn-save").addEventListener("click", () => {
      const text = getSelectionText();
      hideToolbar();
      openCard(text);
    });
    toolbar.querySelector("." + NS + "-btn-hl").addEventListener("click", () => {
      const r = currentRange();
      hideToolbar();
      createHighlight(r, "yellow", "");
    });
    toolbar.querySelector("." + NS + "-btn-note").addEventListener("click", () => {
      const r = currentRange();
      hideToolbar();
      openNoteForRange(r);
    });
    toolbar.querySelector("." + NS + "-btn-read").addEventListener("click", () => {
      hideToolbar();
      enterReader();
    });
    document.documentElement.appendChild(toolbar);
    return toolbar;
  }

  function currentRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    return { range: sel.getRangeAt(0).cloneRange(), text };
  }

  function positionToolbar(rect) {
    const tb = ensureToolbar();
    tb.style.display = "flex";
    const pad = 8;
    const w = tb.offsetWidth || 200;
    const h = tb.offsetHeight || 34;
    let top = rect.top - h - pad;
    if (top < pad) top = rect.bottom + pad;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    tb.style.top = Math.round(top + window.scrollY) + "px";
    tb.style.left = Math.round(left + window.scrollX) + "px";
  }

  function hideToolbar() {
    if (toolbar) toolbar.style.display = "none";
  }

  function onMouseUp() {
    setTimeout(() => {
      const text = getSelectionText();
      if (!text || text.length < 1) {
        hideToolbar();
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        hideToolbar();
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        hideToolbar();
        return;
      }
      positionToolbar(rect);
    }, 10);
  }

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key === "Shift") onMouseUp();
  }, true);
  document.addEventListener("mousedown", (e) => {
    if (toolbar && toolbar.contains(e.target)) return;
    if (card && card.contains(e.target)) return;
    hideToolbar();
  }, true);
  window.addEventListener("scroll", hideToolbar, true);

  /* ---------- 快速收藏卡片 ---------- */

  function ensureCard() {
    if (card) return card;
    card = document.createElement("div");
    card.id = NS + "-card";
    card.className = NS + "-card";
    card.innerHTML = `
      <div class="${NS}-card-head">收藏内容</div>
      <div class="${NS}-quote"></div>
      <textarea class="${NS}-note" placeholder="添加备注（可选）" rows="2"></textarea>
      <input class="${NS}-tags" placeholder="标签，用逗号分隔（可选）" />
      <div class="${NS}-card-actions">
        <button class="${NS}-btn ${NS}-btn-cancel" type="button">取消</button>
        <button class="${NS}-btn ${NS}-btn-confirm" type="button">保存</button>
      </div>
    `;
    card.addEventListener("mousedown", (e) => e.stopPropagation());
    document.documentElement.appendChild(card);
    return card;
  }

  function centerCard(c, w, h) {
    c.style.display = "block";
    c.style.width = w + "px";
    c.style.top = Math.round(window.innerHeight * 0.18 + window.scrollY) + "px";
    c.style.left = Math.round((window.innerWidth - w) / 2 + window.scrollX) + "px";
  }

  function openCard(text) {
    if (!text) return;
    const c = ensureCard();
    c.querySelector("." + NS + "-card-head").textContent = "收藏内容";
    c.querySelector("." + NS + "-quote").textContent =
      text.length > 200 ? text.slice(0, 200) + "…" : text;
    c.querySelector("." + NS + "-quote").style.display = "block";
    c.querySelector("." + NS + "-note").value = "";
    c.querySelector("." + NS + "-note").placeholder = "添加备注（可选）";
    const tagsEl = c.querySelector("." + NS + "-tags");
    tagsEl.style.display = "block";
    tagsEl.value = "";
    c.dataset.text = text;
    centerCard(c, 300, 240);
    c.querySelector("." + NS + "-note").focus();
    c.querySelector("." + NS + "-cancel").onclick = closeCard;
    c.querySelector("." + NS + "-confirm").onclick = saveFromCard;
  }

  function closeCard() {
    if (card) card.style.display = "none";
  }

  async function saveFromCard() {
    const c = ensureCard();
    const text = c.dataset.text || "";
    const note = c.querySelector("." + NS + "-note").value.trim();
    const tags = c.querySelector("." + NS + "-tags").value;
    const res = await send({
      type: "clipkeep:add",
      payload: { text, note, tags, url: location.href, title: document.title },
    });
    closeCard();
    toast(res && res.ok ? "已收藏 ✓" : "保存失败");
  }

  /* ---------- 高亮 / 批注 ---------- */

  function wrapRange(range, mark) {
    try {
      range.surroundContents(mark);
    } catch (e) {
      // 选区跨越多个元素：抽取内容整体包裹
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
    }
  }

  function makeMark(id, color, note) {
    const mark = document.createElement("mark");
    mark.className = NS + "-hl";
    mark.dataset.hlid = id;
    mark.style.background = color;
    if (note) {
      mark.title = "ClipKeep 批注：" + note;
      mark.classList.add("has-note");
    }
    return mark;
  }

  async function createHighlight(sel, colorKey, note) {
    if (!sel || !sel.range) {
      toast("请先选中文字");
      return;
    }
    const id = makeId();
    const color = COLORS[colorKey] || COLORS.yellow;
    try {
      wrapRange(sel.range, makeMark(id, color, note));
    } catch (e) {
      toast("该处无法高亮");
      return;
    }
    const list = await getHighlights();
    list.push({
      id,
      url: location.href,
      text: sel.text,
      color: colorKey,
      note: note || "",
      createdAt: Date.now(),
    });
    await setHighlights(list);
    window.getSelection().removeAllRanges();
    toast(note ? "已批注 ✓" : "已高亮 ✓");
  }

  function openNoteForRange(sel) {
    if (!sel || !sel.range) {
      toast("请先选中文字");
      return;
    }
    const c = ensureCard();
    c.querySelector("." + NS + "-card-head").textContent = "添加批注";
    c.querySelector("." + NS + "-quote").style.display = "none";
    const noteEl = c.querySelector("." + NS + "-note");
    noteEl.value = "";
    noteEl.placeholder = "写下你的批注…";
    c.querySelector("." + NS + "-tags").style.display = "none";
    c.dataset.text = sel.text;
    centerCard(c, 300, 180);
    noteEl.focus();
    c.querySelector("." + NS + "-cancel").onclick = closeCard;
    c.querySelector("." + NS + "-confirm").onclick = async () => {
      const note = noteEl.value.trim();
      closeCard();
      await createHighlight(sel, "pink", note);
    };
  }

  // 在单个文本节点内查找并包裹（用于刷新后重放高亮）
  function reapplyOne(node, hl) {
    const val = node.nodeValue;
    const idx = val.indexOf(hl.text);
    if (idx < 0) return false;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + hl.text.length);
    range.surroundContents(makeMark(hl.id, COLORS[hl.color] || COLORS.yellow, hl.note));
    return true;
  }

  async function applyHighlights() {
    const list = await getHighlights();
    const mine = list.filter((h) => h.url === location.href);
    if (!mine.length) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (n.parentElement && (n.parentElement.closest("script,style,." + NS + "-hl,." + NS + "-reader")))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const remaining = mine.slice();
    let node;
    while ((node = walker.nextNode()) && remaining.length) {
      for (let i = remaining.length - 1; i >= 0; i--) {
        if (node.nodeValue.indexOf(remaining[i].text) >= 0) {
          // 每次只处理该节点一次，避免 walker 失效
          const hl = remaining[i];
          remaining.splice(i, 1);
          reapplyOne(node, hl);
          break;
        }
      }
    }
  }

  // 点击已有高亮：编辑批注 / 删除
  document.addEventListener("click", async (e) => {
    const mark = e.target.closest && e.target.closest("." + NS + "-hl");
    if (!mark) return;
    e.preventDefault();
    const id = mark.dataset.hlid;
    const list = await getHighlights();
    const hl = list.find((h) => h.id === id);
    if (!hl) return;
    const action = prompt(
      "ClipKeep 批注：" + (hl.note || "（无）") + "\n\n输入新批注内容并回车保存；输入 d 回车删除该高亮。",
      hl.note || ""
    );
    if (action === null) return;
    if (action.trim().toLowerCase() === "d") {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      await setHighlights(list.filter((h) => h.id !== id));
      toast("已删除高亮");
    } else {
      hl.note = action.trim();
      mark.title = hl.note ? "ClipKeep 批注：" + hl.note : "";
      mark.classList.toggle("has-note", !!hl.note);
      await setHighlights(list);
      toast("批注已更新 ✓");
    }
  }, true);

  /* ---------- 净化阅读模式 ---------- */

  const STRIP_SELECTORS = [
    "nav", "header", "footer", "aside", "form",
    "[role=navigation]", "[role=banner]", "[role=contentinfo]",
    ".ad", ".ads", ".advert", ".advertisement", ".sidebar",
    ".comment", ".comments", ".share", ".social", ".cookie",
    "#comments", ".menu", ".navbar", ".promo", ".popup", ".modal",
  ];

  function scoreNode(node) {
    const text = (node.innerText || node.textContent || "").trim();
    const len = text.length;
    if (len < 100) return 0;
    const links = node.querySelectorAll("a");
    const linkChars = [...links].reduce((s, a) => s + (a.textContent || "").length, 0);
    const linkRatio = linkChars / len;
    const pCount = node.querySelectorAll("p").length;
    return len * (1 - linkRatio) + pCount * 40;
  }

  function findMainContent() {
    const candidates = document.querySelectorAll(
      "article, main, [role=main], section, div, td"
    );
    let best = null;
    let bestScore = 0;
    candidates.forEach((node) => {
      const s = scoreNode(node);
      if (s > bestScore) {
        bestScore = s;
        best = node;
      }
    });
    return best || document.body;
  }

  function enterReader() {
    if (readerRoot) return;
    const main = findMainContent();
    if (!main) {
      toast("未能提取正文");
      return;
    }
    const clone = main.cloneNode(true);
    STRIP_SELECTORS.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((n) => n.remove());
    });
    clone.querySelectorAll("script,style,noscript,iframe,video,audio,svg,button,input,select").forEach((n) => n.remove());

    readerRoot = document.createElement("div");
    readerRoot.id = NS + "-reader";
    readerRoot.className = NS + "-reader";
    readerRoot.innerHTML = `
      <div class="${NS}-reader-bar">
        <span class="${NS}-reader-title">ClipKeep 净化阅读</span>
        <button class="${NS}-btn" type="button" data-act="save-all">收藏全文</button>
        <button class="${NS}-btn" type="button" data-act="exit">退出</button>
      </div>
      <article class="${NS}-reader-body"></article>
    `;
    const body = readerRoot.querySelector("." + NS + "-reader-body");
    body.appendChild(clone);
    document.documentElement.appendChild(readerRoot);
    document.body.classList.add(NS + "-reader-open");
    window.scrollTo(0, 0);

    readerRoot.addEventListener("click", async (e) => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      if (act === "exit") exitReader();
      else if (act === "save-all") {
        const full = (clone.innerText || "").trim();
        const res = await send({
          type: "clipkeep:add",
          payload: { text: full, tags: "全文", url: location.href, title: document.title },
        });
        toast(res && res.ok ? "已收藏全文 ✓" : "收藏失败");
      }
    });
  }

  function exitReader() {
    if (readerRoot) {
      readerRoot.remove();
      readerRoot = null;
    }
    document.body.classList.remove(NS + "-reader-open");
  }

  /* ---------- 来自 background / popup 的消息 ---------- */

  if (API.runtime && API.runtime.onMessage) {
    API.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === "clipkeep:toast") {
        toast(msg.message || "");
        sendResponse({ ok: true });
      } else if (msg.type === "clipkeep:reader") {
        if (readerRoot) exitReader();
        else enterReader();
        sendResponse({ ok: true });
      }
    });
  }

  // 跨标签页高亮实时同步
  if (API.storage && API.storage.onChanged) {
    API.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[HL_KEY]) applyHighlights();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeCard();
      hideToolbar();
      exitReader();
    }
  });

  // 初始重放本页高亮
  if (document.readyState === "complete" || document.readyState === "interactive") {
    applyHighlights();
  } else {
    document.addEventListener("DOMContentLoaded", applyHighlights);
  }
})();
