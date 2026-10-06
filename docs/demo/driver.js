/* 演示动图驱动：等真界面渲染完再按 ?f= 逐步操作，供 headless Chrome 逐帧截图。 */
(() => {
  const f = new URLSearchParams(location.search).get("f") || "clips";
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const click = (el) => el && el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const key = (k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 轮询等条件成立：界面数据都是异步 load 回来的，抢跑会拍到空列表 */
  function until(pred, timeout = 3000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (pred()) return resolve(true);
        if (Date.now() - t0 > timeout) return resolve(false);
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  const listReady = () => qa("#list .item").length > 0;
  const reviewReady = () => !!q(".rev-card");
  const marksReady = () => q("#marks") && q("#marks").children.length > 0;

  const FRAMES = {
    clips: async () => { await until(listReady); },
    batch2: async () => {
      await until(listReady);
      click(qa('#list .item input[data-act="sel"]')[0]);
      click(qa('#list .item input[data-act="sel"]')[1]);
    },
    batchall: async () => {
      await until(listReady);
      click(qa('#list .item input[data-act="sel"]')[0]);
      click(q('#btn-batch-all'));
    },
    review: async () => {
      await until(listReady);
      click(q('.tab[data-view="review"]'));
      await until(reviewReady);
      q(".rev-keys").scrollIntoView({ block: "start" });
    },
    reveal: async () => {
      await until(listReady);
      click(q('.tab[data-view="review"]'));
      await until(reviewReady);
      key(" ");
      await until(() => !q(".rev-back").hidden);
      q(".rev-keys").scrollIntoView({ block: "start" });
    },
    marks: async () => {
      await until(listReady);
      click(q('.tab[data-view="marks"]'));
      await until(marksReady);
    },
    filter: async () => {
      await until(listReady);
      await until(() => q("#filterbar [data-kind]"));
      click(q('#filterbar [data-kind="image"]'));
      await until(() => qa("#list .item").length === 1);
    },
    focus: async () => {
      await until(listReady);
      key("ArrowDown");
      key("ArrowDown");
      key("ArrowDown");
      key("x");
      await until(() => q("#batchbar") && !q("#batchbar").hidden);
    },
    keys: async () => {
      await until(listReady);
      key("?");
      await until(() => q("#keys-help") && !q("#keys-help").hidden);
    },
    trash: async () => {
      await until(listReady);
      click(q('#list .item [data-act="del"]')); // 删两条，分属两个撤销号
      await wait(200);
      click(q('#list .item [data-act="del"]'));
      await until(() => q("#trashbar") && !q("#trashbar").hidden);
      click(q("#btn-trash-detail")); // 展开明细，逐条恢复
      await until(() => qa(".trash-row").length > 0);
    },
    dark: async () => {
      await until(listReady);
      click(q('#btn-theme'));
      click(qa('#list .item input[data-act="sel"]')[1]);
    },
    revfilter: async () => {
      await until(listReady);
      click(q('.tab[data-view="review"]'));
      await until(() => q('#revfilter [data-rtag]'));
      click(q('#revfilter [data-rtag="笔记"]'));
      await until(() => q('#revfilter .chip.active'));
      q("#revfilter").scrollIntoView({ block: "start" });
    },
    diag: async () => {
      await until(listReady);
      click(q('#btn-settings'));
      await until(() => q('#diag .diag-row'));
      // 滚到设置区底部：这里露的是「当前页面几条定位不回 / 上次备份差几条」这几行，
      // 面板顶部被切一行反而说明「上面还有内容」；切在底部看着就像界面坏了。
      q("#diag").scrollIntoView({ block: "end" });
    },
  };

  addEventListener("DOMContentLoaded", async () => {
    await (FRAMES[f] || FRAMES.clips)();
    setTimeout(() => { document.title = "READY"; }, 120);
  });
})();
