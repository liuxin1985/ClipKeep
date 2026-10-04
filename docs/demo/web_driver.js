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
