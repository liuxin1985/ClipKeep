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
  const COLOR_NAMES = { yellow: "黄色", green: "绿色", pink: "粉色", blue: "蓝色" };
  // 分段锚点的上下文长度与段数上限，与后台 cleanSegs 同口径（后台是信任边界，这里是产出方）
  const SEG_CTX = 24;
  const SEG_MAX = 64;
  // 首段落点重试上限：够覆盖「同一句话在页面上重复几遍」，又不至于让长页面反复全量扫描
  const ANCHOR_RETRY = 8;

  let toolbar = null;
  let hlColor = "yellow"; // 工具条上当前选中的高亮色（页面级，刷新回到默认黄）
  let card = null;
  let toastTimer = null;
  let readerRoot = null;

  /* ---------- 工具函数 ---------- */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        API.runtime.sendMessage(msg, (res) => resolve(res || { ok: false }));
      } catch (e) {
        silentStorageDead(e);
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

  // 扩展更新 / 重新加载后，旧 content script 的 storage 调用会全部失效
  let contextLost = false;
  const RELOAD_HINT = "ClipKeep 已更新，请刷新页面后继续使用";
  const STORE_HINT = "保存失败：本地存储不可用，请稍后重试";
  const GONE_HINT = "这条高亮已经不在了"; // 别处删掉的：清标记就行，别谎报存储坏了

  function noteStorageDead(err) {
    const s = String((err && err.message) || err || "");
    if (/invalidated|context|deleted/i.test(s)) contextLost = true;
    toast(contextLost ? RELOAD_HINT : STORE_HINT);
  }
  function silentStorageDead(err) {
    const s = String((err && err.message) || err || "");
    if (/invalidated|context|deleted/i.test(s)) contextLost = true;
  }

  /** 读不到时返回 null（区别于「真的没有高亮」），调用方必须放弃本次改动 */
  async function getHighlights() {
    if (contextLost) return null;
    try {
      const o = await API.storage.local.get(HL_KEY);
      return Array.isArray(o[HL_KEY]) ? o[HL_KEY] : [];
    } catch (e) {
      silentStorageDead(e);
      return null;
    }
  }
  /**
   * 高亮的写入统一交给后台串行执行（页面只负责读）。
   * 返回 null 表示没落盘：调用方要回滚界面，别让页面和存储不一致；
   * 返回 "gone" 表示那条在存储里已经没有了（别处删的），同样要回滚界面。
   */
  async function hlWrite(msg) {
    if (contextLost) {
      toast(RELOAD_HINT);
      return null;
    }
    let res = null;
    try {
      res = await API.runtime.sendMessage(msg);
    } catch (e) {
      noteStorageDead(e);
      return null;
    }
    if (res && res.ok) return res;
    // 记录已被别处删掉：存储好得很，只是那条不在了，别报「存储不可用」
    if (res && res.error === "not_found") return "gone";
    noteStorageDead(res && res.error);
    return null;
  }
  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  // 同一页面跳到 #锚点 时 location.href 会变，比对时去掉片段标识
  function normUrl(u) {
    const s = String(u || "");
    const i = s.indexOf("#");
    return i < 0 ? s : s.slice(0, i);
  }

  /* ---------- 浮动工具条 ---------- */

  /* 色块不是 .clipkeep-btn：它们是「选颜色」，和四个动作按钮不是一类东西 */
  function swatchHtml() {
    return Object.keys(COLORS)
      .map(
        (k) =>
          `<button class="${NS}-swatch${k === hlColor ? " active" : ""}" type="button" data-color="${k}"` +
          ` style="background:${COLORS[k]}" title="以${COLOR_NAMES[k] || k}高亮"></button>`
      )
      .join("");
  }

  function markActiveSwatch() {
    if (!toolbar) return;
    toolbar.querySelectorAll("." + NS + "-swatch").forEach((b) => {
      b.classList.toggle("active", b.dataset.color === hlColor);
    });
  }

  function ensureToolbar() {
    if (toolbar) return toolbar;
    toolbar = document.createElement("div");
    toolbar.id = NS + "-toolbar";
    toolbar.className = NS + "-toolbar";
    toolbar.innerHTML = `
      <button class="${NS}-btn ${NS}-btn-save" type="button">★ 收藏</button>
      <button class="${NS}-btn ${NS}-btn-hl" type="button" title="用当前颜色高亮">🖍</button>
      <button class="${NS}-btn ${NS}-btn-note" type="button" title="批注">✎</button>
      <button class="${NS}-btn ${NS}-btn-read" type="button">阅读</button>
      <span class="${NS}-swatches">${swatchHtml()}</span>
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
      createHighlight(r, hlColor, "");
    });
    toolbar.querySelectorAll("." + NS + "-swatch").forEach((b) => {
      b.addEventListener("click", () => {
        const key = COLORS[b.dataset.color] ? b.dataset.color : "yellow";
        hlColor = key;
        markActiveSwatch();
        const r = currentRange();
        hideToolbar();
        // 有选区就顺手把这条涂上该色；没选区（比如刚高亮完）只记住颜色，下一步 🖍 用得上
        if (r) createHighlight(r, key, "");
      });
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
    c.querySelector("." + NS + "-btn-cancel").onclick = closeCard;
    c.querySelector("." + NS + "-btn-confirm").onclick = saveFromCard;
  }

  function closeCard() {
    if (card) card.style.display = "none";
  }

  /** 收藏结果的用户话术：重复入库要说「已经存过」，别报一个假的「已收藏」 */
  function saveToast(res) {
    if (res && res.dup) return "这条已经在收藏里了";
    if (res && res.ok) {
      // 只存了前半部分就说「已收藏 ✓」，用户会以为自己剪到了全文
      return res.item && res.item.truncated ? "已收藏 ✓（内容过长，已截断）" : "已收藏 ✓";
    }
    return "保存失败";
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
    toast(saveToast(res));
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

  /** 比对字符用的「去空白」：浏览器和 DOM 走查对空白的口径本来就不一致，抹掉空白才比得出真的字符差异 */
  const flatText = (x) => String(x == null ? "" : x).replace(/\s+/g, "");

  /**
   * 把选区按文本节点拆成分段锚点：每段记住自己的正文与前后各 24 字上下文。
   * 必须在包 mark 之前调用——包完节点边界就被我们改掉了。
   * 返回 null 表示这份锚点不值得存（太碎，或一个有效段都没有），交回整段查找兜底。
   */
  function captureSegs(range) {
    const parts = textNodesInRange(range).map(({ node, a, b }) => ({ node, a, b }));
    // 只掐头去尾地丢掉纯空白节点：中间那个空白是「Hello␠world」的词间空格、
    // 是段落之间的换行，它是用户选中的正文的一部分，吞掉就等于把正文改了
    const blank = (p) => !p.node.nodeValue.slice(p.a, p.b).trim();
    let lo = 0;
    let hi = parts.length - 1;
    while (lo <= hi && blank(parts[lo])) lo++;
    while (hi >= lo && blank(parts[hi])) hi--;
    const kept = parts.slice(lo, hi + 1);
    if (!kept.length || kept.length > SEG_MAX) return null;
    // 首尾按 trim 的口径收齐，正文与分段拼接才能一字不差
    const first = kept[0];
    const lead = first.node.nodeValue.slice(first.a, first.b).match(/^\s*/)[0].length;
    first.a += lead;
    const last = kept[kept.length - 1];
    const tail = last.node.nodeValue.slice(last.a, last.b).match(/\s*$/)[0].length;
    last.b -= tail;
    return kept.map(({ node, a, b }) => {
      const raw = node.nodeValue;
      return {
        t: raw.slice(a, b),
        pre: raw.slice(Math.max(0, a - SEG_CTX), a),
        post: raw.slice(b, b + SEG_CTX),
      };
    });
  }

  /** 选区覆盖到的文本节点，按文档顺序给出，并把起止偏移夹进各节点自身范围 */
  function textNodesInRange(range) {
    const out = [];
    if (!range) return out;
    const root = document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (range.intersectsNode && !range.intersectsNode(n)) continue;
      const len = n.nodeValue.length;
      let a = n === range.startContainer ? Math.min(range.startOffset, len) : 0;
      let b = n === range.endContainer ? Math.min(range.endOffset, len) : len;
      a = Math.max(0, a);
      b = Math.max(a, b);
      if (b > a) out.push({ node: n, a, b });
    }
    return out;
  }

  async function createHighlight(sel, colorKey, note) {
    if (!sel || !sel.range) {
      toast("请先选中文字");
      return;
    }
    let segs = captureSegs(sel.range);
    // DOM 走查能摸到 display:none 的字，浏览器划选的可见正文里没有它们（真浏览器审计抓到的一例）。
    // 比对时先把空白抹平——浏览器和我们数空格的方式本来就不完全一致，那不该作废锚点；
    // 抹平后还对不上，就只可能是「多字 / 少字」，整份丢掉退回 v1.9 的可见正文：
    // 存一排用户没见过、也没打算存的字，比丢掉重放能力糟得多。
    if (segs && flatText(segs.map((s) => s.t).join("")) !== flatText(sel.text)) segs = null;
    const text = segs ? segs.map((s) => s.t).join("") : sel.text;
    if (!text) {
      toast("请先选中文字");
      return;
    }
    const id = makeId();
    const color = COLORS[colorKey] || COLORS.yellow;
    const mark = makeMark(id, color, note);
    try {
      wrapRange(sel.range, mark);
    } catch (e) {
      toast("该处无法高亮");
      return;
    }
    // 写入走后台 upsert，不再读整表回写：那样会抹掉别的标签页同时新增的高亮
    const rec = {
      id,
      url: location.href,
      title: document.title || "",
      text,
      color: colorKey,
      note: note || "",
      createdAt: Date.now(),
      ...(segs ? { segs } : {}),
    };
    const wr = await hlWrite({ type: "clipkeep:hl-add", payload: rec });
    if (!wr || wr === "gone") { unwrapMark(mark); return; }
    window.getSelection().removeAllRanges();
    // 有了分段锚点，跨元素的选区也找得回来；只有锚点太碎、退回整段查找时才需要那句保留话术
    const word = note ? "已批注" : "已高亮";
    // 后台砍过正文就不能只报 ✓：少存的那一截刷新后不会再出现，得当场说清楚
    if (wr && wr.truncated) {
      toast(`${word}（正文超过 ${wr.limit} 字，已截断）`);
    } else {
      toast(segs || replayable(sel.range) ? word + " ✓" : word + "（跨元素，刷新后可能不显示）");
    }
  }

  /** 这条选区刷新后还重放得回来吗：起点终点在同一个文本节点里才行 */
  function replayable(range) {
    return !!range && range.startContainer === range.endContainer && range.startContainer.nodeType === 3;
  }

  /** 拆掉一个标记，把里面的原文放回原位 */
  function unwrapMark(mark) {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }

  /** 还原页面上所有 ClipKeep 标记，供重放前复位 */
  function unwrapAllMarks() {
    const marks = [...document.querySelectorAll("." + NS + "-hl")];
    marks.forEach(unwrapMark);
    if (marks.length && document.body && document.body.normalize) document.body.normalize();
    return marks.length;
  }

  /**
   * 一条高亮在页面上可能是好几个标记：和别的高亮重叠时，它会被区间边界切成几段，
   * 交集那段还要把别人套在里面。所以删掉/改批注都要按 id 找到全部片段一起处理，
   * 只动眼前这一个标记会留下半条颜色或半条批注。
   */
  function marksFor(id) {
    if (!id) return [];
    return [...document.querySelectorAll("." + NS + "-hl")].filter((m) => m.dataset.hlid === id);
  }

  /** 撤掉某条高亮的全部片段，外层的先拆（拆外层不会把内层摘走，只会让它往上挪一层） */
  function unwrapMarksFor(id) {
    const list = marksFor(id);
    list.forEach(unwrapMark);
    if (list.length && document.body && document.body.normalize) document.body.normalize();
    return list.length;
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
    c.querySelector("." + NS + "-btn-cancel").onclick = closeCard;
    c.querySelector("." + NS + "-btn-confirm").onclick = async () => {
      const note = noteEl.value.trim();
      closeCard();
      await createHighlight(sel, "pink", note);
    };
  }

  /** 覆盖同一区间的高亮排序：起点早的是外层，同起点终点晚的是外层，再按写入先后 */
  function outerFirst(spans) {
    return spans.slice().sort((a, b) =>
      a.start - b.start || b.end - a.end || a.hl.createdAt - b.hl.createdAt || (a.hl.id < b.hl.id ? -1 : 1));
  }

  /**
   * 把 [a,b) 从 node 里切出来，按 spans 从外到内套成 mark 链再放回原位。
   * 必须从右往左调用：splitText 会让 node 只留下前缀，左边还没处理的偏移才不会失效。
   */
  function wrapSegment(node, a, b, spans) {
    node.splitText(b); // node 的后半（原 b 之后）成为下一个兄弟节点
    // a 为 0 时不能再 splitText(0)：那会在 mark 前面留下一个空文本节点
    const mid = a > 0 ? node.splitText(a) : node; // mid 正是 [a,b) 这一段
    // 先记住落点：mid 一旦被 appendChild 装进 mark 就离开文档，那时再取 parentNode 已是空的
    const parent = mid.parentNode;
    const next = mid.nextSibling;
    let child = mid;
    for (let i = spans.length - 1; i >= 0; i--) {
      const hl = spans[i].hl;
      const mark = makeMark(hl.id, COLORS[hl.color] || COLORS.yellow, hl.note);
      mark.appendChild(child);
      child = mark;
    }
    parent.insertBefore(child, next);
  }

  /**
   * 本页可参与标记的文本节点，按文档顺序快照一份（切分前先定好落点，偏移才不会互相打架）。
   * 纯空白节点要留着：跨元素选区里那段空白也是正文（词间空格、段落换行），
   * 把它从节点表里剔掉，对应的那一段就再也找不回来了。
   */
  function collectTextNodes() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (n.parentElement && (n.parentElement.closest("script,style,." + NS + "-hl,." + NS + "-reader")))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  /** 从 (from, at) 起找这一段：整段文字命中且前后上下文对得上才算找到 */
  function findSeg(nodes, from, at, seg) {
    const t = String((seg && seg.t) || "");
    if (!t) return null;
    const pre = String((seg && seg.pre) || "");
    const post = String((seg && seg.post) || "");
    for (let i = from; i < nodes.length; i++) {
      const val = nodes[i].nodeValue;
      let idx = i === from ? Math.max(0, at) : 0;
      while (idx <= val.length) {
        const found = val.indexOf(t, idx);
        if (found < 0) break;
        const preOk = !pre || val.slice(Math.max(0, found - pre.length), found) === pre;
        const postOk = !post || val.slice(found + t.length, found + t.length + post.length) === post;
        if (preOk && postOk) return { i, start: found };
        idx = found + 1;
      }
    }
    return null;
  }

  /** 首尾命中之间「实际跨越的正文」——用来验证这几段是不是真的挨在一起 */
  function spannedText(nodes, hits) {
    const first = hits[0];
    const last = hits[hits.length - 1];
    if (first.node === last.node) return first.node.nodeValue.slice(first.start, last.end);
    let s = first.node.nodeValue.slice(first.start);
    for (let i = first.i + 1; i < last.i; i++) s += nodes[i].nodeValue;
    return s + last.node.nodeValue.slice(0, last.end);
  }

  /**
   * 一条高亮 → 一串「哪个节点的哪一段」。任何一段找不到就整条放弃：
   * 只标一半的话，用户看到的是「我标过的字少了一截」，比干脆没标更难解释。
   * 后一段必须落在更靠后的节点里；落完还要把跨过的正文拼回来看一眼，
   * 跟原文对不上说明这几段被拼到了页面各处（短段没有上下文时最容易这样），
   * 那就换个落点重试——宁可不标，也不能把一条高亮劈成满页。
   * 重试封顶是护着长页面：不封顶时，一个高频短段能把整页文本反复扫上百遍。
   */
  function resolveHighlight(hl, nodes) {
    const segs = Array.isArray(hl.segs) && hl.segs.length
      ? hl.segs
      : [{ t: String(hl.text || ""), pre: "", post: "" }];
    const want = flatText(hl.text);
    let cur = { i: 0, at: 0 };
    for (let attempt = 0; attempt < ANCHOR_RETRY; attempt++) {
      const head = findSeg(nodes, cur.i, cur.at, segs[0]);
      if (!head) return null;
      const hits = [{ node: nodes[head.i], i: head.i, start: head.start, end: head.start + String(segs[0].t).length }];
      let cursor = { i: head.i + 1, at: 0 };
      let okAll = true;
      for (let k = 1; k < segs.length; k++) {
        const at = findSeg(nodes, cursor.i, cursor.at, segs[k]);
        if (!at) {
          okAll = false;
          break;
        }
        hits.push({ node: nodes[at.i], i: at.i, start: at.start, end: at.start + String(segs[k].t).length });
        cursor = { i: at.i + 1, at: 0 };
      }
      if (okAll && flatText(spannedText(nodes, hits)) === want) return hits;
      cur = { i: head.i, at: head.start + 1 }; // 首段换下一处出现再试
    }
    return null;
  }

  async function applyHighlights() {
    if (contextLost) return;
    const list = await getHighlights();
    if (!list) return;
    const pageKey = normUrl(location.href);
    const mine = list.filter((h) => normUrl(h.url) === pageKey && h.text);
    // 先全部还原再按存储重放：别处删掉的高亮不会留下点不动的幽灵标记，
    // 改过的批注和颜色也能同步。normalize() 让上一次包裹切碎的文本节点重新合并
    if (unwrapAllMarks()) document.body.normalize();
    if (!mine.length) return;
    const nodes = collectTextNodes();
    // 按节点归堆：同一个节点上可能压着好几条高亮的不同片段
    const byNode = new Map();
    for (const hl of mine) {
      for (const hit of resolveHighlight(hl, nodes) || []) {
        if (!byNode.has(hit.node)) byNode.set(hit.node, []);
        byNode.get(hit.node).push({ start: hit.start, end: hit.end, hl });
      }
    }
    for (const [node, spans] of byNode) {
      if (!node.parentNode) continue;
      const full = node.nodeValue.length;
      // 按所有区间边界把这段文本切开，重叠处各占一段、交集那段两层套在一起。
      // 旧写法是从后往前整段包裹，一旦区间重叠，先落地那条会缩短 nodeValue，
      // 后一条的边界判定必然失败而被静默丢掉——重叠的高亮从此不再显示。
      const cuts = new Set([0, full]);
      spans.forEach((s) => {
        cuts.add(Math.max(0, Math.min(s.start, full)));
        cuts.add(Math.max(0, Math.min(s.end, full)));
      });
      const pts = [...cuts].sort((a, b) => a - b);
      const segs = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (a >= b) continue;
        const cover = outerFirst(spans.filter((s) => s.start <= a && s.end >= b));
        if (cover.length) segs.push({ a, b, cover });
      }
      // 从右往左落地：每次切分只影响 node 的后半，靠左的偏移才不会失效
      segs.sort((x, y) => y.a - x.a);
      for (const seg of segs) {
        try {
          wrapSegment(node, seg.a, seg.b, seg.cover);
        } catch (_) {
          continue;
        }
      }
    }
  }

  // 点击已有高亮：编辑批注 / 删除
  document.addEventListener("click", async (e) => {
    const mark = e.target.closest && e.target.closest("." + NS + "-hl");
    if (!mark) return;
    // 在高亮里拖着选一句话是「选中」，不是「点开」：这时候弹批注框会打断选取
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (r.intersectsNode && r.intersectsNode(mark)) return;
    }
    e.preventDefault();
    const id = mark.dataset.hlid;
    const list = await getHighlights();
    if (!list) return;
    const hl = list.find((h) => h.id === id);
    if (!hl) { unwrapMarksFor(id); return; } // 存储里已删除：顺手清掉页面上的残留（可能是好几段）
    const action = prompt(
      "ClipKeep 批注：" + (hl.note || "（无）") + "\n\n输入新批注内容并回车保存；输入 !d 回车删除该高亮。",
      hl.note || ""
    );
    if (action === null) return;
    if (action.trim().toLowerCase() === "!d") {
      // 先写存储（进回收站，可撤销），成功后再改页面：失败时标记还在，和存储保持一致
      const r = await hlWrite({ type: "clipkeep:hl-delete", id });
      if (r === "gone") {
        unwrapMarksFor(id); // 存储里早没了：清掉残留标记，提示说清去向
        toast(GONE_HINT);
      } else if (r) {
        unwrapMarksFor(id);
        toast("已删除高亮");
      }
    } else {
      const note = action.trim();
      const r = await hlWrite({ type: "clipkeep:hl-update", id, patch: { note } });
      if (r === "gone") {
        unwrapMarksFor(id);
        toast(GONE_HINT);
      } else if (r) {
        // 重叠的高亮在页面上是几段，批注要一起改，否则只有点到的那段带新批注
        marksFor(id).forEach((m) => {
          m.title = note ? "ClipKeep 批注：" + note : "";
          m.classList.toggle("has-note", !!note);
        });
        toast("批注已更新 ✓");
      }
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
    // 克隆里的高亮标记要拆掉：同一份 hlid 在页面上出现两次，重放和点击都会认错对象
    clone.querySelectorAll("." + NS + "-hl").forEach(unwrapMark);
    clone.normalize();
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
        const okAll = res && res.ok;
        const cut = okAll && res.item && res.item.truncated;
        toast(res && res.dup ? "全文已经收藏过了" : okAll ? (cut ? "已收藏全文 ✓（正文过长，已截断）" : "已收藏全文 ✓") : "收藏失败");
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

  async function saveSelection() {
    const text = getSelectionText();
    if (!text) {
      toast("没有选中的文字");
      return false;
    }
    const res = await send({
      type: "clipkeep:add",
      payload: { text, url: location.href, title: document.title },
    });
    toast(saveToast(res));
    return !!(res && res.ok);
  }

  if (API.runtime && API.runtime.onMessage) {
    API.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === "clipkeep:toast") {
        toast(msg.message || "");
        sendResponse({ ok: true });
      } else if (msg.type === "clipkeep:save-selection") {
        saveSelection(); // 结果用页面 toast 反馈，无需等待应答
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
