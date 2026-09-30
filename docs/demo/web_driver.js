/* 演示动图驱动（文章页）：真划选 → 真工具条 →（可选）真高亮 / 真收藏卡片。
   只用于生成 docs/demo.gif，不参与扩展运行。 */
addEventListener("load", () => setTimeout(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mode = new URLSearchParams(location.search).get("m") || "sel";
  const q = (s) => document.querySelector(s);
  const click = (s) => q(s).dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
