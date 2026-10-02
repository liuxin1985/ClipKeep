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
