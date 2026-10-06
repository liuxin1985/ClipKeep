/* 浏览器里跑 popup 用的最小 chrome 桩：内存 storage + 万能消息回执 */
(() => {
  const LONG = "量子比特可以同时处于两种状态的叠加态，这意味着 n 个量子比特能够同时表示 2 的 n 次方个状态。" +
    "在算法层面，量子并行让我们有机会一次评估指数级多的输入分支，再通过干涉把错误答案相消、把正确答案放大。" +
    "Grover 搜索给出平方级加速，Shor 分解则在多项式时间内完成大整数分解——这也是为什么后量子密码要提前换轨。" +
    "再补一段：退相干时间决定了我们能做多少层门，纠错码用多个物理比特拼一个逻辑比特，代价是门保真度必须高于阈值。" +
    "追加一段足够长的内容，让这条收藏明确超过 240 字的折叠阈值：测量本身不改变结果，" +
    "但把笔记只存进收藏夹而不复习，就等于没有存。所以 ClipKeep 把回顾排期、热力图打卡、" +
    "回收站撤销和 Markdown 导出串成一条链，任何一环掉链子都会被自动化测试当场抓住。";
  // 界面语言必须钉住：无头 Chrome 的界面语言是 en-US，偏好留空等于 auto，
  // 整套演示会静默换成英文，README 上那张动图就不再是给它看的那群人熟悉的界面。
  // ?lang=en 单独抓一帧英文，证明文案层是真的，而不是只有中文一套能看。
  const UI_LANG = (() => {
    try {
      const p = new URLSearchParams(location.search).get("lang");
      return ["auto", "zh", "en"].indexOf(p) >= 0 ? p : "zh";
    } catch (_) { return "zh"; }
  })();
  const store = {
    clipkeep_items: [
      { id: "a1", text: LONG, url: "https://en.wikipedia.org/wiki/Quantum_computing_(history)", title: "量子计算入门：从比特到量子比特",
        tags: ["物理", "笔记"], note: "复习时先看干涉那两句", createdAt: Date.now() - 2 * 86400000,
        review: { box: 1, due: Date.now() - 86400000 } },
      { id: "a2", text: "Grover 搜索给出平方级加速，Shor 分解则在多项式时间内完成大整数分解——这也是后量子密码要提前换轨的原因。",
        url: "https://en.wikipedia.org/wiki/Shor%27s_algorithm", title: "Shor 算法", tags: ["算法"],
        createdAt: Date.now() - 86400000, review: { box: 2, due: Date.now() - 43200000 } },
      { id: "a3", text: "退相干时间决定了我们能做多少层门，纠错码用多个物理比特拼一个逻辑比特，代价是门保真度必须高于阈值。",
        url: "https://example.com/quantum-error-correction", title: "量子纠错速览", tags: ["硬件", "笔记"],
        createdAt: Date.now() - 3600000, review: { box: 0, due: Date.now() - 600000 } },
      { id: "a4", text: "后量子密码迁移时间表", kind: "image", image: "http://127.0.0.1:8731/pqc.png",
        url: "https://blog.example.com/p/post-quantum", title: "博文：后量子密码", tags: ["密码"], createdAt: Date.now() - 700000 },
      { id: "a5", text: "NIST 官方指南", kind: "link", link: "https://csrc.nist.gov/publications/detail/fips/203/final",
        url: "https://csrc.nist.gov/", title: "NIST CSRC", tags: [], createdAt: Date.now() - 600000 },
      { id: "a6", text: "测量本身不改变结果，但把笔记只存进收藏夹而不复习，就等于没有存。",
        url: "https://example.com/notes/spaced-repetition", title: "关于复习", tags: ["随笔"],
        createdAt: Date.now() - 500000, review: { box: 1, due: Date.now() - 300000 } },
    ],
    clipkeep_highlights: [
      { id: "h1", url: "https://en.wikipedia.org/wiki/Quantum_computing_(history)", title: "量子计算入门：从比特到量子比特",
        text: "量子并行让我们有机会一次评估指数级多的输入分支", color: "yellow", note: "再看一遍干涉那两句", createdAt: Date.now() - 3600000 },
      // 这条是「页面上已经找不到」的那一类：句子不在演示文章里，自检面板就该把它列成定位不回
      { id: "h4", url: "https://en.wikipedia.org/wiki/Quantum_computing_(history)", title: "量子计算入门：从比特到量子比特",
        text: "玻恩规则把测得某个结果的概率交给振幅的平方，这一步至今仍是解释的争点", color: "blue", note: "", createdAt: Date.now() - 1800000 },
      { id: "h2", url: "https://example.com/notes/spaced-repetition", title: "关于复习",
        text: "把笔记只存进收藏夹而不复习，就等于没有存", color: "pink", note: "ClipKeep 做回顾的理由", createdAt: Date.now() - 7200000 },
      { id: "h3", url: "https://blog.example.com/p/post-quantum", title: "博文：后量子密码",
        text: "密钥尺寸变大不是问题，迁移周期才是", color: "green", note: "", createdAt: Date.now() - 9000000 },
    ],
    clipkeep_trash: [],
    clipkeep_activity: (() => {
      const k = (back) => { const d = new Date(Date.now() - back * 86400000);
        const p = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
      const o = {};
      o[k(1)] = { n: 3, ids: ["a1", "a4", "gone-id"] };
      o[k(2)] = 5;
      o[k(4)] = { n: 2, ids: ["a2", "a3"] };
      o[k(30)] = 7; return o;
    })(),
    clipkeep_prefs: {
      lang: UI_LANG,
      // 备份基线：桩给一个三天前的旧基线，自检面板那一行才会说出「几条还没进备份」，
      // 而不是一句「还没备份过」——后者是默认状态，画在动图里等于没演示这个功能。
      lastBackup: { at: Date.now() - 3 * 86400000, items: 5, highlights: 2 },
    },
  };
  // 桩扮演的「当前标签页」就是那篇文章：弹窗的页面重放自检会往这个 tab 发消息
  const PAGE_URL = "https://en.wikipedia.org/wiki/Quantum_computing_(history)";
  const clone = (v) => JSON.parse(JSON.stringify(v));
  chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          list.forEach((k) => { if (k in store) out[k] = clone(store[k]); });
          return out;
        },
        async set(obj) { Object.assign(store, clone(obj)); },
        // 真浏览器会报实际落盘字节数；桩按同一份数据的 UTF-8 长度回一个同口径的数，
        // 否则演示帧上「存储占用」那一行永远写着「这个浏览器不报存储占用」。
        async getBytesInUse() { return new TextEncoder().encode(JSON.stringify(store)).length; },
        QUOTA_BYTES: 10485760,
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      async sendMessage(msg) {
        if (msg && msg.type === "clipkeep:trash-list") return { ok: true, items: store.clipkeep_trash };
        if (msg && msg.type === "clipkeep:delete") {
          const i = store.clipkeep_items.findIndex((x) => x.id === msg.id);
          if (i >= 0) {
            const tid = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            store.clipkeep_trash.unshift({ tid, kind: "clip", item: store.clipkeep_items[i], deletedAt: Date.now() });
            store.clipkeep_items.splice(i, 1);
          }
          return { ok: true, trashed: true };
        }
        if (msg && msg.type === "clipkeep:delete-many") {
          const want = new Set((msg.ids || []).filter((x) => typeof x === "string" && /^[\w-]{1,64}$/.test(x)));
          const hit = store.clipkeep_items.filter((x) => want.has(x.id));
          const tid = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          hit.forEach((x) => store.clipkeep_trash.unshift({ tid, kind: "clip", item: x, deletedAt: Date.now() }));
          store.clipkeep_items = store.clipkeep_items.filter((x) => !want.has(x.id));
          return { ok: true, removed: hit.length, count: store.clipkeep_items.length, trashed: true, tid, limited: false };
        }
        if (msg && msg.type === "clipkeep:tag-add-many") {
          const norm = (v) => [...new Set((Array.isArray(v) ? v : String(v || "").split(/[,，\s]+/)).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
          const add = norm(msg.tags);
          const want = new Set((msg.ids || []).filter((x) => typeof x === "string" && /^[\w-]{1,64}$/.test(x)));
          let changed = 0;
          store.clipkeep_items.forEach((it) => {
            if (!want.has(it.id)) return;
            const merged = norm((it.tags || []).concat(add));
            if (merged.join("\n") !== (it.tags || []).join("\n")) { it.tags = merged; changed++; }
          });
          return { ok: true, changed };
        }
        if (msg && msg.type === "clipkeep:trash-restore") {
          const hit = store.clipkeep_trash.filter((t) => t.tid === msg.tid);
          if (!hit.length) return { ok: false, error: "not_found" };
          let existed = 0;
          hit.forEach((e) => {
            if (store.clipkeep_items.some((x) => x.id === e.item.id)) { existed++; return; }
            store.clipkeep_items.unshift(e.item);
          });
          store.clipkeep_items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          store.clipkeep_trash = store.clipkeep_trash.filter((t) => t.tid !== msg.tid);
          return { ok: true, kind: hit[0].kind, restored: hit.length - existed, existed };
        }
        // 逐条恢复：与后台 trashRestoreOne 同口径（只认最近那条、撞 id 不重复插、记录一并清掉）
        if (msg && msg.type === "clipkeep:trash-restore-one") {
          const kind = msg.payload && msg.payload.kind;
          const id = String((msg.payload && msg.payload.id) || "");
          if ((kind !== "clip" && kind !== "hl") || !/^[\w-]{1,64}$/.test(id)) return { ok: false, error: "invalid" };
          const idx = store.clipkeep_trash.findIndex((t) => t && t.kind === kind && t.item && t.item.id === id);
          if (idx === -1) return { ok: false, error: "not_found" };
          const entry = store.clipkeep_trash[idx];
          const key = kind === "hl" ? "clipkeep_highlights" : "clipkeep_items";
          const list = store[key];
          const dup = list.some((x) => x && x.id === entry.item.id);
          if (!dup) {
            if (kind === "hl") list.push(entry.item);
            else {
              list.unshift(entry.item);
              list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            }
          }
          store.clipkeep_trash.splice(idx, 1);
          return { ok: true, kind, id, restored: dup ? 0 : 1, existed: dup ? 1 : 0 };
        }
        if (msg && msg.type === "clipkeep:grade") {
          const it = store.clipkeep_items.find((x) => x.id === msg.id);
          if (it) it.review = msg.review;
          return { ok: true };
        }
        if (msg && msg.type === "clipkeep:hl-update") {
          const h = store.clipkeep_highlights.find((x) => x.id === msg.id);
          const patch = msg.patch || {};
          if (h) {
            const allowed = {};
            if (patch.note !== undefined) allowed.note = String(patch.note);
            if (patch.title !== undefined) allowed.title = String(patch.title);
            if (["yellow", "green", "pink", "blue"].includes(patch.color)) allowed.color = patch.color;
            Object.assign(h, allowed);
          }
          return { ok: true };
        }
        return { ok: true, items: store.clipkeep_items };
      },
      getURL: (p) => p,
    },
    tabs: {
      async query() { return [{ id: 1, url: PAGE_URL, active: true }]; },
      // clipkeep:diag 是弹窗直接问页面「这些高亮还在不在」的自检消息：桩在这里替内容脚本
      // 回一次，字段和 content.js 的 replayReport 一字不差。哪些能重放按种子里的句子实算——
      // h1 那句真的在演示文章里，h4 那句不在，所以「存 2 / 标出 1 / 1 条定位不回」是数据的现状，
      // 不是手写的好看数字；以后改种子，这一帧跟着变，不会变成一张骗人的截图。
      async sendMessage(_id, msg) {
        if (msg && msg.type === "clipkeep:diag") {
          const article = [
            "量子比特可以同时处于两种状态的叠加态，这意味着 n 个量子比特能够同时表示 2 的 n 次方个状态。",
            "在算法层面，量子并行让我们有机会一次评估指数级多的输入分支，再通过干涉把错误答案相消、把正确答案放大。",
            "Grover 搜索给出平方级加速，Shor 分解则在多项式时间内完成大整数分解，这也是后量子密码要提前换轨的原因。",
            "退相干时间决定了能做多少层门，纠错码用多个物理比特拼一个逻辑比特，代价是门保真度必须高于阈值。",
          ].join("");
          const mine = store.clipkeep_highlights.filter((h) => h.url === PAGE_URL);
          const missing = mine.filter((h) => article.indexOf(String(h.text)) < 0)
            .map((h) => ({ id: String(h.id), text: String(h.text).slice(0, 60), len: String(h.text).length }));
          return { ok: true, diag: { page: PAGE_URL, stored: mine.length, placed: mine.length - missing.length, missing } };
        }
        return { ok: true };
      },
    },
  };
})();
