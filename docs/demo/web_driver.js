/* 演示动图驱动（文章页）：真划选 → 真工具条 →（可选）真高亮 / 真收藏卡片。
   只用于生成 docs/demo.gif，不参与扩展运行。 */
addEventListener("load", () => setTimeout(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mode = new URLSearchParams(location.search).get("m") || "sel";
  const q = (s) => document.querySelector(s);
  const click = (s) => q(s).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const until = (pred, ms = 3000) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (pred() ? resolve(true) : Date.now() - t0 > ms ? resolve(false) : setTimeout(tick, 40));
    tick();
  });
  if (mode === "ov") {
    // 两条区间只部分相交的高亮，走真 storage.onChanged 重放：重叠那段应该套两层颜色
    const mk = (text, color, note) => ({
      id: "ov" + Math.random().toString(36).slice(2, 8),
      text, color, note, url: location.href, createdAt: Date.now(),
    });
    const a = mk("量子比特可以同时处于两种状态", "green", "外层：整句");
    const b = mk("处于两种状态的叠加态", "pink", "内层：只盖住后半");
    chrome.storage.local.set({ clipkeep_highlights: [a, b] });
    await until(() => document.querySelectorAll(".clipkeep-hl").length >= 4);
    document.title = "READY";
    return;
  }
  if (mode === "anchor") {
    // 真跨元素划选：选中「码用多个物理比特拼一个」，中间那个词被 <strong> 切走了，
    // 单节点整词查找一定找不回来——这就是 v1.10 分段锚点要解决的那件事。
    const strong = q("#p3 strong");
    const before = strong.previousSibling;
    const after = strong.nextSibling;
    const r = document.createRange();
    r.setStart(before, before.data.length - 4); // 「纠错码用多个」的后 4 字
    r.setEnd(after, 3); // 「拼一个」
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await wait(200);
    click('.clipkeep-swatch[data-color="green"]');
    click(".clipkeep-btn-hl");
    await until(() => window.__ckStore.clipkeep_highlights.length === 1);
    const rec = window.__ckStore.clipkeep_highlights[0] || {};
    const got = (rec.segs || []).length;
    getSelection().removeAllRanges();
    // 再重放一遍：把存储原样 set 回去，桩会广播 onChanged，content.js 会先还原再按锚点重标，
    // 走的正是刷新后那条路（unwrapAllMarks + resolveHighlight + wrapSegment）
    const marks0 = document.querySelectorAll(".clipkeep-hl").length;
    chrome.storage.local.set({ clipkeep_highlights: [rec] });
    await wait(400);
    const marks1 = document.querySelectorAll(".clipkeep-hl").length;
    const text1 = [...document.querySelectorAll(".clipkeep-hl")].map((m) => m.textContent).join("");
    q("#log").style.display = "block";
    q("#log").textContent =
      `选区跨了 <strong> 边界 → 锚点 ${got} 段 · 正文「${rec.text}」\n` +
      `重放前 ${marks0} 个标记 → 重放后 ${marks1} 个：${text1 === rec.text ? "一字不差 ✓" : "对不上 ✗"}`;
    document.title = "READY";
    return;
  }
  if (mode === "repair") {
    // 两条高亮存的上下文都已被作者改掉，页面上标不回来（自检会列成「定位不回」）。
    // 这一帧先当真修好第一条——弹窗式交接、真划选、真换锚点、标记回来、批注颜色不动，
    // 然后把横幅停在第二条上等划选：图上同时给出「修回来了」和「正在等哪一句」。
    const stale = (id, text) => ({
      id, url: location.href, title: document.title, text, color: "green",
      note: "这段是重点", createdAt: Date.now(),
      segs: [{ t: text, pre: "作者已经改掉的上一句", post: "作者已经改掉的下一句" }],
    });
    const A = "量子比特可以同时处于两种状态的叠加态";
    const B = "再通过干涉把错误答案相消、把正确答案放大";
    chrome.storage.local.set({ clipkeep_highlights: [stale("fixA", A), stale("fixB", B)] });
    await until(() => document.querySelectorAll(".clipkeep-hl").length === 0);
    const pick = (want) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = n.data.indexOf(want);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + want.length);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return true;
      }
      return false;
    };
    const armedA = await window.__ckAskPage({ type: "clipkeep:repair-arm", id: "fixA", url: location.href });
    const selected = pick(A);
    await until(() => document.querySelectorAll('.clipkeep-hl[data-hlid="fixA"]').length > 0, 2000);
    const rec = window.__ckStore.clipkeep_highlights.find((x) => x.id === "fixA") || {};
    await window.__ckAskPage({ type: "clipkeep:repair-arm", id: "fixB", url: location.href });
    const rep = await window.__ckAskPage({ type: "clipkeep:diag" });
    const d = (rep && rep.diag) || {};
    q("#log").style.display = "block";
    q("#log").textContent =
      `弹窗点「修复」→ 页面接了（${armedA && armedA.ok ? "ok ✓" : "没接手 ✗"}）→ 真划选 ${selected ? "✓" : "✗"}\n` +
      `正文换成页面上现抓的一句、锚点 ${
        (rec.segs || []).length} 段 · 批注「${rec.note}」和颜色「${rec.color}」原样保留\n` +
      `自检回包：存 ${d.stored} 条 · 标出 ${d.placed} 条 · ${
        (d.missing || []).length} 条定位不回 · 正在等 ${d.armed}（横幅就是它）`;
    document.title = "READY";
    return;
  }
  window.__ckSelect("p1", 0, 58);
  await wait(160); // 工具条是 10ms 防抖后定位显示的
  if (mode === "hl") {
    click('.clipkeep-swatch[data-color="green"]');
    click(".clipkeep-btn-hl");
    await wait(300);
    window.__ckSelect("p2", 0, 40);
    await wait(160);
    click('.clipkeep-swatch[data-color="pink"]');
    click(".clipkeep-btn-hl");
    await wait(400);
    getSelection().removeAllRanges();
  } else if (mode === "card") {
    click(".clipkeep-btn-save");
    await wait(300);
    q(".clipkeep-note").value = "复习时先看干涉那两句";
    q(".clipkeep-tags").value = "量子, 笔记";
    await wait(120);
  }
  document.title = "READY";
}, 400));
