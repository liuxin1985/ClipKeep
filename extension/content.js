/**
 * ClipKeep - content script
 * 划词浮动工具条、快速收藏卡片、Toast 提示、净化阅读模式。
 * 纯原生 JS，零依赖，兼容 Chrome / Edge / Safari。
 */
(() => {
  if (window.__clipkeepInjected) return;
  window.__clipkeepInjected = true;

  const API = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;
  const NS = "clipkeep";
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

  /* ---------- 浮动工具条 ---------- */

  function ensureToolbar() {
    if (toolbar) return toolbar;
    toolbar = document.createElement("div");
    toolbar.id = NS + "-toolbar";
    toolbar.className = NS + "-toolbar";
    toolbar.innerHTML = `
      <button class="${NS}-btn ${NS}-btn-save" type="button">★ 收藏</button>
      <button class="${NS}-btn ${NS}-btn-read" type="button">阅读</button>
    `;
    toolbar.addEventListener("mousedown", (e) => e.preventDefault());
    toolbar.querySelector("." + NS + "-btn-save").addEventListener("click", () => {
      const text = getSelectionText();
      hideToolbar();
      openCard(text);
    });
    toolbar.querySelector("." + NS + "-btn-read").addEventListener("click", () => {
      hideToolbar();
      enterReader();
    });
    document.documentElement.appendChild(toolbar);
    return toolbar;
  }

  function positionToolbar(rect) {
    const tb = ensureToolbar();
    tb.style.display = "flex";
    const pad = 8;
    const w = tb.offsetWidth || 150;
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

  function openCard(text) {
    if (!text) return;
    const c = ensureCard();
    c.querySelector("." + NS + "-quote").textContent =
      text.length > 200 ? text.slice(0, 200) + "…" : text;
    c.querySelector("." + NS + "-note").value = "";
    c.querySelector("." + NS + "-tags").value = "";
    c.dataset.text = text;
    c.style.display = "block";
    const w = 300;
    const h = c.offsetHeight || 240;
    c.style.top = Math.round(window.innerHeight * 0.18 + window.scrollY) + "px";
    c.style.left = Math.round((window.innerWidth - w) / 2 + window.scrollX) + "px";
    c.style.width = w + "px";
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeCard();
      hideToolbar();
      exitReader();
    }
  });
})();
