/* 演示动图驱动：等真界面渲染完再按 ?f= 逐步操作，供 headless Chrome 逐帧截图。 */
(() => {
  const f = new URLSearchParams(location.search).get("f") || "clips";
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const click = (el) => el && el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const key = (k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

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
    dark: async () => {
      await until(listReady);
      click(q('#btn-theme'));
      click(qa('#list .item input[data-act="sel"]')[1]);
    },
  };

  addEventListener("DOMContentLoaded", async () => {
    await (FRAMES[f] || FRAMES.clips)();
    setTimeout(() => { document.title = "READY"; }, 120);
  });
})();
