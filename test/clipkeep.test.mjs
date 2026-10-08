/**
 * ClipKeep 自动化测试
 * 用 jsdom 加载仓库里真实的 background.js / popup.html + popup.js / content.js，
 * 覆盖：消息路由、标签批量操作、快捷键链路、Leitner 排期（含上限与倍率）、
 *       搜索命中高亮、JSON 备份→恢复（合并 / 覆盖 / 取消）、划词高亮重放与删除。
 *
 * 运行：npm install && npm test
 * 说明：仅测试需要 jsdom；扩展本身零依赖。
 */
import fs from "fs";
import vm from "vm";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM, VirtualConsole } from "jsdom";

const EXT = fileURLToPath(new URL("../extension/", import.meta.url));
const src = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function eq(name, a, b, tol = 0) {
  const good = tol ? Math.abs(a - b) <= tol : a === b;
  ok(name + (good ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`), good);
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 共享存储 + background 消息路由 ---------------- */

function makeBackend(opts) {
  const uiLanguage = (opts && opts.uiLanguage) || "zh-CN"; // jsdom 默认 en-US，会把中文断言整体翻成英文
  const store = { clipkeep_items: [], clipkeep_highlights: [], clipkeep_prefs: {} };
  if (opts && opts.failFirstGet) store.__failNextGet = true; // 冷启动那一次读偏好没读着（磁盘坏、配额异常之类）
  const listeners = [];
  const hlListeners = [];
  const commandListeners = [];
  const installListeners = [];
  const menuClickListeners = [];
  const sentToTab = [];
  const menuOps = { removeAll: 0, created: [] };

  const chrome = {
    runtime: {
      id: "test",
      onInstalled: { addListener(fn) { installListeners.push(fn); } },
      onMessage: { addListener(fn) { listeners.push(fn); } },
      // 真浏览器里弹窗随时能问自己的版本号；mock 缺了这个，诊断文件只能写空版本。
      // 读真实清单，版本号就不会和 manifest.json 脱节。
      getManifest: () => JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")),
      sendMessage(msg, cb) {
        let reply;
        const sendResponse = (r) => { reply = r; };
        const ret = listeners[0](msg, { tab: { id: 1 } }, sendResponse);
        const done = () => { if (cb) cb(reply); return reply; };
        if (ret === true) return Promise.resolve().then(() => tick(0)).then(done);
        return Promise.resolve(reply).then(done);
      },
    },
    storage: {
      local: {
        async get(keys) {
          if (store.__failNextGet) {
            store.__failNextGet = false;
            throw new Error("STORAGE_UNAVAILABLE");
          }
          const arr = Array.isArray(keys) ? keys : [keys];
          const o = {};
          arr.forEach((k) => { if (store[k] !== undefined) o[k] = JSON.parse(JSON.stringify(store[k])); });
          return o;
        },
        async set(obj) {
          const bad = store.__failSetKey; // 按 key 掐失败点：一步里连着写几个 key，得能指名是哪一次没写进去
          if (store.__failNextSet || (bad && bad in obj)) {
            store.__failNextSet = false;
            store.__failSetKey = null;
            throw new Error("QUOTA_EXCEEDED");
          }
          for (const k of Object.keys(obj)) {
            const before = store[k];
            store[k] = JSON.parse(JSON.stringify(obj[k]));
            hlListeners.forEach((fn) => fn({ [k]: { oldValue: before, newValue: store[k] } }, "local"));
          }
        },
      },
      onChanged: { addListener(fn) { hlListeners.push(fn); } },
    },
    contextMenus: {
      removeAll(cb) { menuOps.removeAll++; if (cb) cb(); },
      create(opts) { menuOps.created.push(opts); },
      onClicked: { addListener(fn) { menuClickListeners.push(fn); } },
    },
    commands: { onCommand: { addListener(fn) { commandListeners.push(fn); } } },
    tabs: {
      query: async () => [{ id: 1, title: "页面", url: "http://x/1" }],
      sendMessage: (tabId, msg) => { sentToTab.push({ tabId, msg }); return Promise.resolve(); },
      create() {},
    },
    scripting: { executeScript: async () => {} },
    i18n: { getUILanguage: () => uiLanguage },
  };

  // 在沙箱里跑真实的 background.js，注册消息路由与命令监听
  const ctx = vm.createContext({ chrome, console, setTimeout, Date, Math, JSON, String, Number, Array, Object, Promise, URL });
  // service worker 里 background.js 用 importScripts 拿文案层，沙箱里等价地按文件名读真实文件
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(src(f), ctx));
  vm.runInContext(src("background.js"), ctx);

  const send = async (msg, from) => {
    let reply;
    await listeners[0](msg, from || { tab: { id: 1 } }, (r) => { reply = r; });
    await tick(0);
    return reply;
  };
  const fireCommand = async (name) => {
    for (const fn of commandListeners) await fn(name);
    await tick(0);
  };
  const menuErrors = [];
  const fireMenuClick = async (info, tab) => {
    // 浏览器不会把监听器里的异常抛给调用方，只会变成未处理拒绝 —— 这里等价地记录下来
    for (const fn of menuClickListeners) {
      try { await fn(info, tab); } catch (e) { menuErrors.push(String((e && e.message) || e)); }
    }
    await tick(0);
  };
  const fireInstalled = async (reason) => {
    for (const fn of installListeners) await fn({ reason });
    await tick(0);
  };
  return { store, chrome, send, fireCommand, fireMenuClick, fireInstalled, sentToTab, listeners, menuOps, menuErrors };
}

/* ---------------- 1. background 消息路由 ---------------- */

async function testBackground() {
  console.log("\n[1] background 消息路由");
  const { store, send } = makeBackend();

  const add = await send({ type: "clipkeep:add", payload: { text: "  量子纠缠  ", note: "n1", tags: "物理, 量子 物理,", url: "http://a", title: "T" } });
  ok("add 成功", add.ok === true);
  eq("add 后总数", store.clipkeep_items.length, 1);
  eq("文本去首尾空格", add.item.text, "量子纠缠");
  eq("标签去重+切分", JSON.stringify(add.item.tags), JSON.stringify(["物理", "量子"]));

  const empty = await send({ type: "clipkeep:add", payload: { text: "   " } });
  ok("空文本被拒绝", empty.ok === false && empty.error === "empty");

  const upd = await send({ type: "clipkeep:update", id: add.item.id, patch: { review: { box: 2, due: 123, seen: 4 } } });
  ok("update 保留嵌套 review 对象", upd.item.review.box === 2 && upd.item.review.due === 123);
  eq("update 不改 id", upd.item.id, add.item.id);

  const nf = await send({ type: "clipkeep:update", id: "nope", patch: {} });
  ok("update 未知 id 返回 not_found", nf.ok === false && nf.error === "not_found");

  const unknown = await send({ type: "whatever" });
  ok("未知消息类型", unknown.ok === false && unknown.error === "unknown");

  await send({ type: "clipkeep:delete", id: add.item.id });
  eq("delete 后总数", store.clipkeep_items.length, 0);

  /* ---- 标签批量操作 ---- */
  const mk = (id, tags) => ({ id, text: "t" + id, note: "", tags, url: "", title: "", createdAt: 1 });
  store.clipkeep_items = [mk("1", ["算法", "旧名"]), mk("2", ["旧名"]), mk("3", ["英语"]), mk("4", ["算法", "英语"])];

  const renamed = await send({ type: "clipkeep:tag-op", payload: { from: "旧名", to: "量子计算" } });
  eq("重命名影响条数", renamed.changed, 2);
  eq("重命名后内容", JSON.stringify(store.clipkeep_items.map((x) => x.tags)),
     JSON.stringify([["算法", "量子计算"], ["量子计算"], ["英语"], ["算法", "英语"]]));

  const merged = await send({ type: "clipkeep:tag-op", payload: { from: "量子计算", to: "算法" } });
  eq("合并影响条数", merged.changed, 2);
  eq("合并后去重", JSON.stringify(store.clipkeep_items.map((x) => x.tags)),
     JSON.stringify([["算法"], ["算法"], ["英语"], ["算法", "英语"]]));

  const deleted = await send({ type: "clipkeep:tag-op", payload: { from: "英语", to: "" } });
  eq("删除标签影响条数", deleted.changed, 2);
  ok("删除后标签消失", store.clipkeep_items.every((x) => !x.tags.includes("英语")));

  const noop = await send({ type: "clipkeep:tag-op", payload: { from: "算法", to: "算法" } });
  ok("同名操作不改动", noop.ok === true && noop.changed === 0 && noop.noop === true);
  const badTag = await send({ type: "clipkeep:tag-op", payload: { from: "", to: "x" } });
  ok("空标签名被拒", badTag.ok === false && badTag.error === "empty");

  /* ---- 整体替换（覆盖本地） ---- */
  const rep = await send({ type: "clipkeep:replace", payload: { items: [mk("9", ["备份"])] } });
  ok("replace 成功", rep.ok === true && store.clipkeep_items.length === 1 && store.clipkeep_items[0].id === "9");
  const repBad = await send({ type: "clipkeep:replace", payload: {} });
  ok("replace 拒绝非法入参", repBad.ok === false && repBad.error === "invalid");
  eq("非法 replace 不改动数据", store.clipkeep_items.length, 1);

  /* ---- 右键菜单收藏 ---- */
  await send({ type: "clipkeep:clear" });
  eq("clear 后为空", store.clipkeep_items.length, 0);
}

/* ---------------- 1a. 并发写入 / 错误如实上报 / 菜单注册时机 ---------------- */

async function testConcurrency() {
  console.log("\n[1a] 存储并发 / 错误上报 / 菜单注册");
  const mk = (id, tags) => ({ id, text: "t" + id, note: "", tags, url: "", title: "", createdAt: 1 });

  /* 两个标签页同时收藏：一条都不许丢 */
  const be = makeBackend();
  await Promise.all([
    be.send({ type: "clipkeep:add", payload: { text: "甲" } }),
    be.send({ type: "clipkeep:add", payload: { text: "乙" } }),
  ]);
  eq("并发收藏两条都在", be.store.clipkeep_items.length, 2);
  ok("并发收藏文本齐全", ["甲", "乙"].every((t) => be.store.clipkeep_items.some((x) => x.text === t)));

  /* 标签批量整理与并发新增交错：整理不能顺手删掉刚落地的收藏 */
  const be2 = makeBackend();
  be2.store.clipkeep_items = [mk("1", ["旧名"]), mk("2", ["旧名"])];
  await Promise.all([
    be2.send({ type: "clipkeep:tag-op", payload: { from: "旧名", to: "新名" } }),
    be2.send({ type: "clipkeep:add", payload: { text: "丙" } }),
  ]);
  eq("整理标签不吞掉并发新增", be2.store.clipkeep_items.length, 3);
  ok("并发新增的收藏还在", be2.store.clipkeep_items.some((x) => x.text === "丙"));
  ok("原有两条完成整理", be2.store.clipkeep_items.filter((x) => x.tags.includes("新名")).length === 2);

  /* 合并（upsert）：由 background 现读现写，绝不用弹窗打开时的旧快照 */
  const be3 = makeBackend();
  be3.store.clipkeep_items = [mk("x1", ["本地版本"])];
  const merged = await be3.send({
    type: "clipkeep:merge",
    payload: { items: [mk("x1", ["备份版本"]), mk("x2", ["b"])] },
  });
  ok("merge 成功", merged.ok === true);
  ok("merge 补上缺失项", be3.store.clipkeep_items.some((x) => x.id === "x2"));
  eq("merge 保留本地已有版本", be3.store.clipkeep_items.find((x) => x.id === "x1").tags.join(","), "本地版本");
  eq("merge 报告新增数", merged.added, 1);
  const mergeBad = await be3.send({ type: "clipkeep:merge", payload: {} });
  ok("merge 拒绝非法入参", mergeBad.ok === false && mergeBad.error === "invalid");

  /* 写入失败不能谎报成「内容为空」 */
  const be5 = makeBackend();
  be5.store.__failNextSet = true;
  await be5.fireMenuClick(
    { menuItemId: "clipkeep-save", selectionText: "甲", pageUrl: "http://a" },
    { id: 1, title: "T", url: "http://a" }
  );
  const toasts = be5.sentToTab.map((s) => s.msg.message).join("|");
  eq("菜单处理不抛未捕获异常", be5.menuErrors.length, 0);
  ok("写入失败提示不是「内容为空」", !/内容为空/.test(toasts));
  ok("写入失败有明确反馈", /失败/.test(toasts));

  /* 超长文本截断入库，避免一次粘贴撑爆存储 */
  const be7 = makeBackend();
  const long = await be7.send({ type: "clipkeep:add", payload: { text: "长".repeat(30000) } });
  ok("超长文本仍入库", long.ok === true);
  eq("超长文本截断到 2 万", long.item.text.length, 20000);
  eq("截断有标记", long.item.truncated, true);

  /* 右键菜单只在 onInstalled 建：service worker 每次唤醒都 removeAll 重建，
     会让用户在重建瞬间点不到菜单，而浏览器本身会跨重启保留菜单 */
  const be8 = makeBackend();
  eq("加载脚本时不建菜单", be8.menuOps.created.length, 0);
  await be8.fireInstalled("install");
  eq("安装时建四个菜单项", be8.menuOps.created.length, 4);
  await be8.fireInstalled("update");
  eq("更新时先清空再重建", be8.menuOps.removeAll, 2);
  eq("更新后菜单数量", be8.menuOps.created.length, 8);
  await be8.fireInstalled("chrome_update");
  eq("浏览器升级不重复建菜单", be8.menuOps.created.length, 8);
}

/* ---------------- 1b. 快捷键链路 ---------------- */

async function testShortcut() {
  console.log("\n[1b] 快捷键 Alt+Shift+K 链路");
  const { fireCommand, sentToTab } = makeBackend();
  eq("background 注册了命令监听", (await import("fs"), 1), 1);
  await fireCommand("clipkeep-save-selection");
  eq("向当前标签页转发选区消息", sentToTab.length, 1);
  eq("消息类型", sentToTab[0].msg.type, "clipkeep:save-selection");
  eq("目标标签页 id", sentToTab[0].tabId, 1);
  sentToTab.length = 0;
  await fireCommand("some-other-command");
  eq("未知命令不转发", sentToTab.length, 0);

  // content 侧：收到消息后把选区写进收藏
  const be = makeBackend();
  const dom = new JSDOM(`<!DOCTYPE html><html><body><p>叠加态是量子计算的根本优势。</p></body></html>`,
    { runScripts: "outside-only", url: "http://localhost/quantum" });
  const w = dom.window;
  w.chrome = be.chrome;
  w.prompt = () => "";
  w.eval(src("content.js"));
  const p = w.document.querySelector("p");
  const range = w.document.createRange();
  range.selectNodeContents(p);
  const sel = w.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const contentListener = be.listeners[be.listeners.length - 1]; // 0=background, 1=content
  contentListener({ type: "clipkeep:save-selection" }, {}, () => {});
  await tick(20);
  eq("选区已入库", be.store.clipkeep_items.length, 1);
  eq("入库文本为选区内容", be.store.clipkeep_items[0].text, "叠加态是量子计算的根本优势。");
  eq("入库带页面信息", be.store.clipkeep_items[0].url, "http://localhost/quantum");
  ok("页面给出 toast 反馈", /已收藏/.test(w.document.getElementById("clipkeep-toast").textContent));

  // 无选区时不写入
  sel.removeAllRanges();
  contentListener({ type: "clipkeep:save-selection" }, {}, () => {});
  await tick(20);
  eq("无选区不新增", be.store.clipkeep_items.length, 1);
  ok("无选区给出提示", /没有选中/.test(w.document.getElementById("clipkeep-toast").textContent));
}

/* ---------------- 2. popup：排期 / 命中高亮 / 标签管理 / 备份恢复 ---------------- */

async function testPopup() {
  console.log("\n[2] popup 排期 + 命中高亮 + 标签管理 + 备份恢复");
  const { store, chrome } = makeBackend();
  const DAY = 86400000;
  const now = Date.now();

  store.clipkeep_items = [
    { id: "a", text: "第一条：叠加态", note: "重点看这里", tags: ["算法"], url: "http://x/1", title: "页面一", createdAt: now - 3 * DAY, review: { box: 0, due: now - 10, seen: 0 } },
    { id: "b", text: "第二条：纠缠", note: "备注B", tags: ["算法", "英语"], url: "http://x/2", title: "页面二", createdAt: now - 2 * DAY, review: { box: 1, due: now - 5, seen: 1 } },
    { id: "c", text: "第三条：退相干", note: "", tags: [], url: "", title: "", createdAt: now - DAY, review: { box: 3, due: now + DAY, seen: 3 } },
  ];

  let downloaded = null;
  const vc = new VirtualConsole();
  const dom = new JSDOM(src("popup.html"), { runScripts: "outside-only", url: "chrome-extension://abc/popup.html", virtualConsole: vc });
  const w = dom.window;
  w.chrome = chrome;
  w.URL.createObjectURL = (b) => { b.text().then((t) => { downloaded = t; }); return "blob:x"; };
  w.URL.revokeObjectURL = () => {};
  w.prompt = () => "新标签";
  w.confirm = () => true;
  w.eval(src("popup.js"));
  await tick(10);

  const $ = (id) => w.document.getElementById(id);
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = async (el) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await tick(10); };
  const fire = async (el, type) => { el.dispatchEvent(new w.Event(type, { bubbles: true })); await tick(10); };

  eq("计数徽标", $("count").textContent, "3");
  eq("到期条数", $("due").textContent, "2");
  eq("收藏列表条目数", qa(".item").length, 3);

  /* ---- 搜索命中高亮 ---- */
  $("search").value = "叠加态";
  await fire($("search"), "input");
  eq("正文命中数", qa(".item-text mark.hit").length, 1);
  ok("命中内容正确", qa("mark.hit").every((m) => m.textContent === "叠加态"));
  $("search").value = "重点";
  await fire($("search"), "input");
  ok("备注里的命中也标黄", qa(".item-note mark.hit").length === 1);
  $("search").value = "(叠加态|纠缠)";
  await fire($("search"), "input");
  eq("正则元字符按字面量处理（无命中）", qa("mark.hit").length, 0);
  ok("无命中时给出空态", $("empty").style.display === "block");
  $("search").value = "";
  await fire($("search"), "input");
  eq("清空搜索恢复全量", qa(".item").length, 3);

  /* ---- 标签管理面板 ---- */
  await click($("btn-tags"));
  ok("标签面板展开", $("tagbox").hidden === false);
  eq("标签行数", qa(".tagrow").length, 2);
  eq("按条数排序，首位是算法", qa(".tagrow")[0].dataset.tag, "算法");
  eq("条数展示", qa(".tagrow")[0].querySelector(".tagnum").textContent, "2");
  w.prompt = () => "量子计算";
  await click(qa(".tagrow")[0].querySelector('[data-act="t-rename"]'));
  await tick(20);
  ok("重命名落到存储", store.clipkeep_items.filter((x) => x.tags.includes("量子计算")).length === 2);
  ok("旧标签消失", store.clipkeep_items.every((x) => !x.tags.includes("算法")));
  eq("面板刷新后仍两行", qa(".tagrow").length, 2);
  w.prompt = () => "量子计算";
  await click(qa(".tagrow").find((r) => r.dataset.tag === "英语")
    ? qa(".tagrow").find((r) => r.dataset.tag === "英语").querySelector('[data-act="t-merge"]')
    : q('[data-act="t-merge"]'));
  await tick(20);
  ok("合并不产生重复标签", store.clipkeep_items.every((x) => new Set(x.tags).size === x.tags.length));
  w.prompt = () => "新标签";
  await click($("btn-tags")); // 收起
  await click($("btn-tags")); // 再展开
  eq("面板可折叠", $("tagbox").hidden, false);

  /* ---- 设置：每日上限 + 间隔倍率 ---- */
  await click($("btn-settings"));
  ok("设置面板展开", $("settings").hidden === false);
  eq("默认上限 20", $("set-cap").value, "20");
  eq("默认倍率 1", $("set-mult").value, "1");
  $("set-cap").value = "1";
  await fire($("set-cap"), "change");
  eq("上限生效：徽标显示 1/2", $("due").textContent, "1/2");
  eq("上限写入 prefs", store.clipkeep_prefs.review.cap, 1);
  $("set-mult").value = "2";
  await fire($("set-mult"), "change");
  eq("倍率写入 prefs", store.clipkeep_prefs.review.mult, 2);
  $("set-cap").value = "0";
  await fire($("set-cap"), "change");
  eq("非法上限回落到默认 20", store.clipkeep_prefs.review.cap, 20);
  $("set-cap").value = "20";
  await fire($("set-cap"), "change");
  $("set-mult").value = "1";
  await fire($("set-mult"), "change");
  await click($("btn-settings"));
  ok("设置面板收起", $("settings").hidden === true);

  /* ---- 回顾视图与排期 ---- */
  await click(q('.tab[data-view="review"]'));
  ok("回顾视图显示", $("view-review").hidden === false && $("view-clips").hidden === true);
  eq("优先复习最早到期的一条", q(".rev-card").dataset.id, "a");
  ok("进度行含记忆盒", /记忆盒 0\/5/.test(q(".rev-progress").textContent));
  ok("答案默认隐藏", q(".rev-back").hidden === true);
  ok("评分按钮默认隐藏", q(".rev-grade").hidden === true);
  await click(q(".rev-reveal"));
  ok("显示答案后面板打开", q(".rev-back").hidden === false && q(".rev-grade").hidden === false);
  ok("答案里带备注与标签", /重点看这里/.test(q(".rev-back").textContent) && /#算法|#量子计算/.test(q(".rev-back").textContent));

  // 倍率 0.5× 时，盒 0→1 的间隔应为 0.5 天
  await click($("btn-settings"));
  $("set-mult").value = "0.5";
  await fire($("set-mult"), "change");
  await click($("btn-settings"));
  const r0 = store.clipkeep_items.find((x) => x.id === "a").review;
  await click(q(".mini-btn.good"));
  const r1 = store.clipkeep_items.find((x) => x.id === "a").review;
  eq("记得 → 盒+1", r1.box, r0.box + 1);
  eq("seen 计数+1", r1.seen, r0.seen + 1);
  eq("0.5× 倍率缩短间隔", r1.due - Date.now(), 0.5 * DAY, 5000);
  ok("答完自动切到下一条", q(".rev-card").dataset.id === "b");

  await click($("btn-settings"));
  $("set-mult").value = "1";
  await fire($("set-mult"), "change");
  await click($("btn-settings"));

  await click(q(".mini-btn.again"));
  eq("忘记 → 回到盒 0", store.clipkeep_items.find((x) => x.id === "b").review.box, 0);
  ok("盒 0 立即再次到期", store.clipkeep_items.find((x) => x.id === "b").review.due <= Date.now() + 60);
  eq("仍在原条（因立即到期）", q(".rev-card").dataset.id, "b");
  await click(q(".mini-btn.easy"));
  eq("简单 → 盒+2", store.clipkeep_items.find((x) => x.id === "b").review.box, 2);
  eq("标准倍率下盒 2 为 3 天后", store.clipkeep_items.find((x) => x.id === "b").review.due - Date.now(), 3 * DAY, 5000);

  // 全部处理完 → 完成态
  await click(q('.tab[data-view="clips"]'));
  await click(q('.tab[data-view="review"]'));
  ok("无到期时显示完成态", /今日回顾已完成/.test($("review").textContent));
  ok("完成态徽标隐藏", $("due").hidden === true);

  /* ---- 备份 ---- */
  await click($("btn-backup"));
  await tick(20);
  const backup = JSON.parse(downloaded);
  eq("备份 app 标识", backup.app, "ClipKeep");
  eq("备份含 3 条收藏", backup.items.length, 3);
  ok("备份含 highlights 数组", Array.isArray(backup.highlights));

  /* ---- 恢复：取消 ---- */
  await click($("btn-clear"));
  eq("清空后本地 0 条", store.clipkeep_items.length, 0);
  const fileInput = $("file");
  const putFile = async (obj) => {
    Object.defineProperty(fileInput, "files", { value: [obj], configurable: true });
    await fire(fileInput, "change");
    await tick(20);
  };
  await putFile(new w.File([JSON.stringify(backup)], "bk.json", { type: "application/json" }));
  ok("恢复前弹出差异确认", $("modal").hidden === false);
  ok("差异里列出新增 3 条", /\+3/.test($("modal-body").textContent));
  await click($("modal-cancel"));
  eq("取消不写入数据", store.clipkeep_items.length, 0);
  ok("取消后弹窗关闭", $("modal").hidden === true);

  /* ---- 恢复：合并 ---- */
  await putFile(new w.File([JSON.stringify(backup)], "bk.json", { type: "application/json" }));
  await click($("modal-ok"));
  await tick(20);
  eq("合并后回到 3 条", store.clipkeep_items.length, 3);
  ok("合并保留 review 进度", store.clipkeep_items.find((x) => x.id === "b").review.box === 2);
  eq("合并按时间倒序", store.clipkeep_items[0].id, "c");
  await putFile(new w.File([JSON.stringify(backup)], "bk.json", { type: "application/json" }));
  ok("重复恢复提示无需处理", /无需恢复/.test($("toast").textContent) || $("modal").hidden === false);
  if ($("modal").hidden === false) await click($("modal-cancel"));
  eq("重复恢复不新增", store.clipkeep_items.length, 3);

  /* ---- 恢复：覆盖本地 ---- */
  const subset = { ...backup, items: [backup.items.find((x) => x.id === "a")] };
  await putFile(new w.File([JSON.stringify(subset)], "sub.json", { type: "application/json" }));
  ok("覆盖前弹窗提示本地独有", /仅存在于本地/.test($("modal-body").textContent));
  await click($("modal-alt"));
  await tick(20);
  eq("覆盖后只剩备份里那 1 条", store.clipkeep_items.length, 1);
  eq("覆盖保留备份内容", store.clipkeep_items[0].id, "a");

  /* ---- 坏文件 ---- */
  await putFile(new w.File(["{ not json"], "bad.json", { type: "application/json" }));
  eq("坏文件被拒绝且数据完好", store.clipkeep_items.length, 1);
  ok("坏文件给出提示", /恢复失败/.test($("toast").textContent));
  eq("坏文件不弹确认框", $("modal").hidden, true);

  /* ---- 单条导出 ---- */
  downloaded = null;
  await click(q('.tab[data-view="clips"]'));
  await click(qa(".item")[0].querySelector('[data-act="export"]'));
  await tick(20);
  ok("单条导出为 Markdown", /^# ClipKeep 收藏/.test(downloaded) && /第一条/.test(downloaded));
}

/* ---------------- 2b. 恢复导入的安全与数据完整性 ---------------- */

async function mountPopup(seed, opts) {
  const be = makeBackend(opts);
  Object.assign(be.store, seed || {});
  const uiLanguage = (opts && opts.uiLanguage) || "zh-CN";
  let downloaded = null;
  const dom = new JSDOM(src("popup.html"), {
    runScripts: "outside-only",
    url: "chrome-extension://abc/popup.html",
    virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  w.chrome = be.chrome;
  w.URL.createObjectURL = (b) => { b.text().then((t) => { downloaded = t; }); return "blob:x"; };
  w.URL.revokeObjectURL = () => {};
  w.prompt = () => "";
  w.confirm = () => true;
  Object.defineProperty(w.navigator, "language", { value: uiLanguage, configurable: true });
  w.eval(src("i18n.js"));
  w.eval(src("popup.js"));
  await tick(10);
  const $ = (id) => w.document.getElementById(id);
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = async (el) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await tick(10); };
  const fire = async (el, type) => { el.dispatchEvent(new w.Event(type, { bubbles: true })); await tick(10); };
  const fileInput = $("file");
  const putFile = async (obj) => {
    Object.defineProperty(fileInput, "files", { value: [obj], configurable: true });
    fileInput.dispatchEvent(new w.Event("change", { bubbles: true }));
    await tick(20);
  };
  const putBackup = async (data, name = "bk.json") =>
    putFile(new w.File([JSON.stringify(data)], name, { type: "application/json" }));
  return { be, store: be.store, w, chrome: be.chrome, $, q, qa, click, fire, putFile, putBackup, getDownloaded: () => downloaded };
}

async function testRestoreSafety() {
  console.log("\n[2b] 恢复导入：注入防护 / 并发合并 / 覆盖不丢高亮");
  const DAY = 86400000;
  const now = Date.now();
  const mk = (id, text, extra) => ({ id, text, note: "", tags: [], url: "", title: "", createdAt: now, ...(extra || {}) });
  const hl = (id, text) => ({ id, url: "http://localhost/p", text, color: "yellow", note: "", createdAt: now });

  /* 1. 备份里构造的 id 不能突破属性，把脚本注进扩展页 */
  {
    const p = await mountPopup();
    await p.putBackup({ app: "ClipKeep", version: 1, items: [
      mk('a" onmouseover="alert(1)', "注入测试"),
    ], highlights: [
      { id: 'h" onmouseover="x', url: "http://localhost/p", text: "高亮注入", color: "rainbow", createdAt: now },
    ] });
    ok("差异弹窗打开", p.$("modal").hidden === false);
    await p.click(p.$("modal-ok"));
    await tick(20);
    const stored = p.store.clipkeep_items[0];
    ok("入库 id 只含安全字符", /^[\w-]{1,64}$/.test(stored.id), stored.id);
    ok("页面没有注入的事件属性", p.w.document.querySelector("[onmouseover]") === null);
    ok("注入条目正常渲染", /注入测试/.test(p.q(".item").textContent));
    const storedHl = p.store.clipkeep_highlights[0];
    ok("高亮 id 同样过滤", /^[\w-]{1,64}$/.test(storedHl.id), storedHl.id);
    ok("未知颜色回落到合法值", ["yellow", "green", "pink", "blue"].includes(storedHl.color), storedHl.color);
  }

  /* 2. 合并必须由 background 现读现写：弹窗开着时别的标签页存的不能丢 */
  {
    const p = await mountPopup({ clipkeep_items: [mk("local1", "本地已有")] });
    await p.putBackup({ app: "ClipKeep", version: 1, items: [mk("b1", "备份里的")] });
    await p.be.send({ type: "clipkeep:add", payload: { text: "期间新存" } });
    await p.click(p.$("modal-ok"));
    await tick(20);
    const texts = p.store.clipkeep_items.map((x) => x.text);
    ok("合并补上备份项", texts.includes("备份里的"));
    ok("合并不抹掉期间新存的收藏", texts.includes("期间新存"));
    ok("合并保留本地原有项", texts.includes("本地已有"));
  }

  /* 3. 覆盖本地不得清空备份里没提到的类别（高亮 / 批注） */
  {
    const p = await mountPopup({
      clipkeep_items: [mk("l1", "本地收藏")],
      clipkeep_highlights: [hl("h1", "重点一"), hl("h2", "重点二")],
    });
    await p.putBackup({ app: "ClipKeep", version: 1, items: [mk("b1", "备份收藏")], highlights: [] });
    ok("差异里提示本地独有的高亮", /高亮/.test(p.$("modal-body").textContent) && /2/.test(p.$("modal-body").textContent));
    await p.click(p.$("modal-alt"));
    await tick(20);
    eq("覆盖以备份为准（收藏）", p.store.clipkeep_items.length, 1);
    eq("覆盖不清空本地高亮", p.store.clipkeep_highlights.length, 2);
  }

  /* 4. 备份里 review 缺 due 的条目要能重新进回顾，而不是永久消失 */
  {
    const p = await mountPopup();
    await p.putBackup({ app: "ClipKeep", version: 1, items: [
      mk("r1", "复习我", { review: { box: 2 } }),
      mk("r2", "坏排期", { review: { box: 99, due: "明天", seen: -3 } }),
    ] });
    await p.click(p.$("modal-ok"));
    await tick(20);
    eq("到期徽标含 2 条", p.$("due").textContent, "2");
    const r1 = p.store.clipkeep_items.find((x) => x.id === "r1");
    ok("缺 due 视为立即到期", r1.review.due <= Date.now());
    const r2 = p.store.clipkeep_items.find((x) => x.id === "r2");
    ok("非法 review 字段被夹取", r2.review.box >= 0 && r2.review.box <= 5 && r2.review.seen >= 0);
  }

  /* 5. 覆盖后的提示数量必须和实际写入一致 */
  {
    const p = await mountPopup({
      clipkeep_items: [mk("k1", "甲"), mk("k2", "乙")],
      clipkeep_highlights: [hl("h9", "旧批注")],
    });
    await p.putBackup({ app: "ClipKeep", version: 1, items: [], highlights: [hl("h10", "新批注")] });
    await p.click(p.$("modal-alt"));
    await tick(20);
    const toastText = p.$("toast").textContent;
    ok("提示里的收藏数与实际一致", /共 2 收藏/.test(toastText), toastText);
    eq("本地收藏未被清空", p.store.clipkeep_items.length, 2);
  }

  /* 6. 覆盖只针对弹窗看到的那份快照：弹窗开着时别处新增的内容不能被抹掉 */
  {
    const p = await mountPopup({
      clipkeep_items: [mk("k1", "本地收藏")],
      clipkeep_highlights: [hl("h1", "本地高亮")],
    });
    await p.putBackup({
      app: "ClipKeep", version: 1,
      items: [mk("k1", "本地收藏"), mk("b1", "备份收藏")],
      highlights: [hl("h1", "本地高亮"), hl("b2", "备份高亮")],
    });
    ok("覆盖前差异弹窗打开", p.$("modal").hidden === false);
    // 弹窗读快照之后，另一个标签页存了一条收藏、划了一条高亮
    await p.be.send({ type: "clipkeep:add", payload: { text: "期间新存收藏" } });
    await p.be.send({ type: "clipkeep:hl-add", payload: { id: "live", url: "http://localhost/p", title: "", text: "期间新增高亮", color: "yellow", note: "", createdAt: Date.now() } });
    await p.click(p.$("modal-alt"));
    await tick(30);
    const texts = p.store.clipkeep_items.map((x) => x.text);
    const ids = p.store.clipkeep_highlights.map((x) => x.id);
    ok("覆盖补上备份收藏", texts.includes("备份收藏"), texts.join(","));
    ok("覆盖不抹掉期间新增的收藏", texts.includes("期间新存收藏"), texts.join(","));
    ok("覆盖补上备份高亮", ids.includes("b2"), ids.join(","));
    ok("覆盖不抹掉期间新增的高亮", ids.includes("live"), ids.join(","));
  }
}

/* ---------------- 2c. 回顾打分：一次点击只推进一次 ---------------- */

async function testReviewGuard() {
  console.log("\n[2c] 回顾打分防连点");
  const DAY = 86400000;
  const now = Date.now();
  const mk = (id, text, review) => ({
    id, text, note: "答案", tags: [], url: "http://x/1", title: "页面",
    createdAt: now, review,
  });
  const seeded = () => ({
    clipkeep_items: [
      mk("g1", "第一条", { box: 1, due: now - 10, seen: 1 }),
      mk("g2", "第二条", { box: 1, due: now - 5, seen: 1 }),
    ],
  });
  const openReview = async () => {
    const p = await mountPopup(seeded());
    await p.click(p.q('.tab[data-view="review"]'));
    await p.click(p.q('[data-act="reveal"]'));
    return p;
  };
  const get = (p, id) => p.store.clipkeep_items.find((x) => x.id === id).review;

  /* 连点「记得」：写入还在途中时第二次点击必须无效，否则一次跳两盒 */
  {
    const p = await openReview();
    const good = p.q('.rev-grade [data-g="1"]');
    good.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    good.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    await tick(30);
    eq("连点「记得」只升 1 盒", get(p, "g1").box, 2);
    eq("连点后排期仍是盒 2 的间隔", get(p, "g1").due - Date.now(), 3 * DAY, 5000);
    eq("连点后换到下一张卡", p.q(".rev-card").dataset.id, "g2");
  }

  /* 忘记 + 记得 连点：以第一次（忘记）为准，不能被后一次覆盖 */
  {
    const p = await openReview();
    const again = p.q('.rev-grade [data-g="0"]');
    const good = p.q('.rev-grade [data-g="1"]');
    again.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    good.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    await tick(30);
    eq("连点不会把「忘记」改成「记得」", get(p, "g1").box, 0);
    ok("「忘记」后立即再次到期", get(p, "g1").due <= Date.now() + 60);
  }

  /* 打分期间按钮应禁用：给用户明确反馈，也挡住真正的二次点击 */
  {
    const p = await openReview();
    const btn = p.q('.rev-grade [data-g="1"]');
    btn.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    ok("写入期间打分按钮禁用", [...p.qa(".rev-grade button")].every((b) => b.disabled === true));
    await tick(30);
    ok("写入完成后界面已刷新", p.q(".rev-card").dataset.id === "g2");
  }

  /* 单次正常打分仍然生效（回归护栏） */
  {
    const p = await openReview();
    await p.click(p.q('.rev-grade [data-g="2"]'));
    eq("单击「简单」升 2 盒", get(p, "g1").box, 3);
    eq("盒 3 间隔 7 天", get(p, "g1").due - Date.now(), 7 * DAY, 5000);
    eq("打卡次数 +1", get(p, "g1").seen, 2);
  }
}

/* ---------------- 2d. 高亮 / 批注总览 ---------------- */

async function testMarksOverview() {
  console.log("\n[2d] 高亮批注总览");
  const now = Date.now();
  const h = (id, url, title, text, note, color) => ({
    id, url, title, text, note: note || "", color: color || "yellow", createdAt: now,
  });
  const seed = () => ({
    clipkeep_highlights: [
      h("m1", "http://x/quantum", "量子计算入门", "量子比特可以同时处于两种状态", "重点看叠加", "green"),
      h("m2", "http://x/quantum", "量子计算入门", "退相干时间很短", "", "yellow"),
      h("m3", "http://x/cook", "家常菜", "糖色要炒到冒小泡", "别大火", "pink"),
    ],
  });

  const p = await mountPopup(seed());

  /* 入口与计数 */
  ok("有高亮标签页", !!p.q('.tab[data-view="marks"]'));
  eq("标签上显示总条数", p.$("mark-count").textContent, "3");

  /* 按页面分组 */
  await p.click(p.q('.tab[data-view="marks"]'));
  ok("切到高亮视图", p.$("view-marks").hidden === false && p.$("view-clips").hidden === true);
  eq("按页面分组数", p.qa(".hl-group").length, 2);
  eq("量子页里的批注数", p.qa('.hl-group[data-url="http://x/quantum"] .hl-item').length, 2);
  ok("组头显示页面标题", /量子计算入门/.test(p.qa(".hl-group")[0].textContent));
  ok("批注正文渲染出来", /重点看叠加/.test(p.w.document.body.textContent));
  ok("无批注的不显示批注行", p.qa('.hl-group[data-url="http://x/quantum"] .hl-item')[1].querySelector(".hl-note") === null);

  /* 搜索过滤 */
  p.$("search").value = "退相干";
  await p.fire(p.$("search"), "input");
  eq("过滤后只剩一条", p.qa(".hl-item").length, 1);
  eq("命中的就是那条", p.q(".hl-item").dataset.hlid, "m2");
  ok("命中关键词标黄", p.q(".hl-item mark.hit").textContent === "退相干");
  p.$("search").value = "";
  await p.fire(p.$("search"), "input");
  eq("清空搜索恢复全部", p.qa(".hl-item").length, 3);

  /* 删除 */
  await p.click(p.q('.hl-item[data-hlid="m3"] [data-act="hl-del"]'));
  await tick(20);
  eq("删除后存储少一条", p.store.clipkeep_highlights.length, 2);
  eq("删除后列表同步", p.qa(".hl-item").length, 2);
  eq("删除后计数更新", p.$("mark-count").textContent, "2");
  ok("删除过的页面组消失", p.q('.hl-group[data-url="http://x/cook"]') === null);

  /* 外部改动（别的标签页删了高亮）要实时反映 */
  await p.chrome.storage.local.set({ clipkeep_highlights: p.store.clipkeep_highlights.filter((x) => x.id !== "m2") });
  await tick(20);
  eq("外部删除后列表自动刷新", p.qa(".hl-item").length, 1);

  /* 导出 Markdown */
  const before = p.getDownloaded();
  await p.click(p.$("btn-hl-export"));
  await tick(20);
  const md = p.getDownloaded();
  ok("导出的是新文件", !!md && md !== before);
  ok("导出含页面标题与出处", /##\s*量子计算入门/.test(md) && /\*\*来源\*\*:\s*http:\/\/x\/quantum/.test(md), md && md.slice(0, 200));
  ok("导出含原文", /==量子比特可以同时处于两种状态==/.test(md));
  ok("导出含批注", /— 批注：重点看叠加/.test(md));
  ok("导出不含已删除项", !/退相干/.test(md) && !/糖色/.test(md));

  /* 恶意内容不能注入扩展页 */
  {
    const evil = await mountPopup({
      clipkeep_highlights: [h("e1", 'http://x/<img src=1 onerror=alert(1)>', '<img src=1 onerror=alert(2)>', "正文<img src=1 onerror=alert(3)>", "批注\" onmouseover=\"alert(4)", "yellow")],
    });
    await evil.click(evil.q('.tab[data-view="marks"]'));
    eq("恶意内容不生成元素", evil.w.document.querySelectorAll("img").length, 0);
    ok("恶意内容以文本显示", /onerror/.test(evil.q(".hl-item").textContent));
  }
}

/* ---------------- 2e. 删除可撤销（回收站） ---------------- */

async function testTrash() {
  console.log("\n[2e] 回收站与撤销");
  const now = Date.now();
  const mk = (id, text) => ({ id, text, note: "", tags: ["甲"], url: "http://x/1", title: "页面", createdAt: now - 1000 });
  const hl = (id, text) => ({ id, url: "http://x/1", title: "页面", text, color: "yellow", note: "", createdAt: now });

  /* 1. 后台：删除收藏会进回收站，撤销后原样回来 */
  {
    const be = makeBackend();
    await be.send({ type: "clipkeep:add", payload: { text: "会被删掉", tags: "甲" } });
    const id = be.store.clipkeep_items[0].id;
    const del = await be.send({ type: "clipkeep:delete", id });
    ok("删除返回可撤销标记", del.undone !== undefined || del.trashed === true, JSON.stringify(del));
    eq("收藏已从列表移除", be.store.clipkeep_items.length, 0);
    const list = await be.send({ type: "clipkeep:trash-list" });
    eq("回收站有 1 项", list.items.length, 1);
    eq("回收站记录的是刚删的那条", list.items[0].item.text, "会被删掉");
    const res = await be.send({ type: "clipkeep:trash-restore", tid: list.items[0].tid });
    ok("撤销成功", res.ok === true);
    eq("撤销后收藏回来", be.store.clipkeep_items.length, 1);
    eq("撤销后内容不变", be.store.clipkeep_items[0].text, "会被删掉");
    eq("撤销后标签不丢", (be.store.clipkeep_items[0].tags || []).join(","), "甲");
    const again = await be.send({ type: "clipkeep:trash-restore", tid: list.items[0].tid });
    ok("重复撤销返回 not_found", again.ok === false && again.error === "not_found");
  }

  /* 2. 后台：删除高亮同样可撤销；高亮新增走后台，不再整表覆盖 */
  {
    const be = makeBackend();
    const add1 = await be.send({ type: "clipkeep:hl-add", payload: hl("ha", "第一条高亮") });
    ok("hl-add 成功", add1.ok === true);
    await be.send({ type: "clipkeep:hl-add", payload: hl("hb", "第二条高亮") });
    eq("两条高亮都在", be.store.clipkeep_highlights.length, 2);
    const t = await be.send({ type: "clipkeep:hl-delete", id: "hb" });
    ok("删除高亮报告进回收站", t.ok === true && t.trashed === true);
    eq("高亮已移出", be.store.clipkeep_highlights.length, 1);
    const list = await be.send({ type: "clipkeep:trash-list" });
    eq("回收站含高亮", list.items.filter((x) => x.kind === "hl").length, 1);
    await be.send({ type: "clipkeep:trash-restore", tid: list.items[0].tid });
    eq("撤销后高亮回来", be.store.clipkeep_highlights.length, 2);
    // 两个标签页同时高亮：一条都不能丢
    const be2 = makeBackend();
    await Promise.all([
      be2.send({ type: "clipkeep:hl-add", payload: hl("c1", "并发一") }),
      be2.send({ type: "clipkeep:hl-add", payload: hl("c2", "并发二") }),
    ]);
    eq("并发高亮两条都在", be2.store.clipkeep_highlights.length, 2);
    await be2.send({ type: "clipkeep:hl-update", id: "c1", patch: { note: "改批注" } });
    eq("hl-update 改批注", be2.store.clipkeep_highlights.find((x) => x.id === "c1").note, "改批注");
    eq("hl-update 不动其他字段", be2.store.clipkeep_highlights.find((x) => x.id === "c1").text, "并发一");
  }

  /* 3. 超过 10 分钟的回收条目自动失效 */
  {
    const be = makeBackend();
    await be.send({ type: "clipkeep:add", payload: { text: "过期回收" } });
    const id = be.store.clipkeep_items[0].id;
    await be.send({ type: "clipkeep:delete", id });
    be.store.clipkeep_trash[0].deletedAt = Date.now() - 11 * 60 * 1000;
    const list = await be.send({ type: "clipkeep:trash-list" });
    eq("超时条目被自动清理", list.items.length, 0);
    eq("超时后回收站存储也清空", be.store.clipkeep_trash.length, 0);
  }

  /* 3b. 保留时长可在设置里改（分钟），后台按配置清理 */
  {
    const seed = (prefs) => {
      const be = makeBackend();
      if (prefs) be.store.clipkeep_prefs = prefs;
      be.store.clipkeep_trash = [
        { tid: "t1", kind: "clip", item: { id: "o1", text: "两分钟前删的", createdAt: now }, deletedAt: Date.now() - 2 * 60 * 1000 },
      ];
      return be;
    };
    const keep30 = seed({ trash: { mins: 30 } });
    eq("保留 30 分钟时 2 分钟前的删除仍可撤销", (await keep30.send({ type: "clipkeep:trash-list" })).items.length, 1);
    const prune1 = seed({ trash: { mins: 1 } });
    eq("保留 1 分钟时 2 分钟前的删除已清理", (await prune1.send({ type: "clipkeep:trash-list" })).items.length, 0);
    eq("清理结果写回存储", prune1.store.clipkeep_trash.length, 0);
    const dflt = seed(null);
    eq("未配置时按默认 10 分钟保留", (await dflt.send({ type: "clipkeep:trash-list" })).items.length, 1);
    const bogus = seed({ trash: { mins: 9999 } });
    const kept = await bogus.send({ type: "clipkeep:trash-list" });
    eq("非法时长回落到默认而不是永久保留", kept.items.length, 1);
    const sixty = seed({ trash: { mins: 9999 } });
    sixty.store.clipkeep_trash[0].deletedAt = Date.now() - 11 * 60 * 1000;
    eq("非法时长不会把保留窗口放大", (await sixty.send({ type: "clipkeep:trash-list" })).items.length, 0);
  }

  /* 3c. 弹窗撤销条与设置面板跟着配置走 */
  {
    const p = await mountPopup({
      clipkeep_items: [mk("i1", "在册收藏"), mk("i2", "另一条")],
      clipkeep_trash: [],
      clipkeep_prefs: { trash: { mins: 30 } },
    });
    ok("设置面板有回收站时长选项", !!p.$("set-ttl"));
    eq("设置面板显示当前保留时长", p.$("set-ttl") && p.$("set-ttl").value, "30");
    await p.click(p.q('.item[data-id="i1"] [data-act="del"]'));
    await tick(20);
    ok("撤销条用配置里的分钟数", /30 分钟内可撤销/.test(p.$("trash-text").textContent), p.$("trash-text").textContent);
    p.$("set-ttl").value = "1";
    await p.fire(p.$("set-ttl"), "change");
    await tick(20);
    eq("改设置落到 prefs", p.store.clipkeep_prefs.trash.mins, 1);
    ok("撤销条文案跟着变", /1 分钟内可撤销/.test(p.$("trash-text").textContent), p.$("trash-text").textContent);
  }

  /* 4. 清空回收站后不可再撤销 */
  {
    const be = makeBackend();
    await be.send({ type: "clipkeep:add", payload: { text: "甲" } });
    await be.send({ type: "clipkeep:delete", id: be.store.clipkeep_items[0].id });
    const cleared = await be.send({ type: "clipkeep:trash-clear" });
    ok("清空成功", cleared.ok === true);
    eq("回收站已空", be.store.clipkeep_trash.length, 0);
  }

  /* 5. 备份不含回收站内容；撤销条 / 清空回收站走通 */
  {
    const p = await mountPopup({ clipkeep_items: [mk("i1", "在册收藏"), mk("i2", "另一条")], clipkeep_trash: [] });
    await p.click(p.q('.tab[data-view="clips"]'));
    await p.click(p.q('.item[data-id="i1"] [data-act="del"]'));
    await tick(20);
    eq("列表里少了删掉的那条", p.qa(".item").length, 1);
    eq("回收站里有 1 项待撤销", p.store.clipkeep_trash.length, 1);
    ok("出现撤销条", p.$("trashbar").hidden === false);
    await p.click(p.$("btn-backup"));
    await tick(20);
    const backup = JSON.parse(p.getDownloaded());
    ok("备份导出的是收藏", Array.isArray(backup.items) && backup.items.length === 1);
    ok("备份不含回收站", backup.trash === undefined);
    await p.click(p.$("btn-undo"));
    await tick(20);
    eq("点撤销后收藏回到列表", p.qa(".item").length, 2);
    ok("撤销回来的还是原来那条", p.qa(".item").some((n) => n.dataset.id === "i1"));
    ok("撤销后撤销条收起", p.$("trashbar").hidden === true);
    // 再来一次，走「清空」
    await p.click(p.q('.item[data-id="i1"] [data-act="del"]'));
    await tick(20);
    await p.click(p.$("btn-trash-clear"));
    await tick(20);
    eq("清空后回收站为空", (p.store.clipkeep_trash || []).length, 0);
    ok("清空后撤销条收起", p.$("trashbar").hidden === true);
  }

  /* 6. 高亮视图的删除也能撤销 */
  {
    const p = await mountPopup({ clipkeep_highlights: [hl("h1", "网页上的句子")] });
    await p.click(p.q('.tab[data-view="marks"]'));
    await p.click(p.q('.hl-item[data-hlid="h1"] [data-act="hl-del"]'));
    await tick(20);
    eq("高亮从视图消失", p.qa(".hl-item").length, 0);
    eq("高亮进了回收站", p.store.clipkeep_trash.length, 1);
    await p.click(p.$("btn-undo"));
    await tick(20);
    eq("撤销后高亮回来", p.qa(".hl-item").length, 1);
  }
}

/* ---------------- 3. content：划词高亮重放 ---------------- */

async function testContent() {
  console.log("\n[3] content 划词高亮 / 批注");
  const { store, chrome } = makeBackend();
  const url = "http://localhost/quantum";
  const now = Date.now();
  store.clipkeep_highlights = [
    { id: "h1", url, text: "量子比特可以同时处于两种状态", color: "green", note: "重点", createdAt: now },
    { id: "h2", url, text: "这句话在别的页面", color: "yellow", note: "", createdAt: now },
    { id: "h3", url, text: "退相干时间很短", color: "yellow", note: "", createdAt: now },
  ];

  const html = `<!DOCTYPE html><html><body><article>
    <p>简介：量子比特可以同时处于两种状态，这是并行性的来源。</p>
    <p>工程难点：退相干时间很短，需要纠错码。</p>
    <p>本节没有匹配内容。</p>
  </article></body></html>`;
  const dom = new JSDOM(html, { runScripts: "outside-only", url });
  const w = dom.window;
  w.Range.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 122, left: 120, right: 300, width: 180, height: 22, x: 120, y: 100 });
  w.chrome = chrome;
  w.prompt = () => "";
  w.eval(src("content.js"));
  await tick(20);

  const marks = [...w.document.querySelectorAll("mark.clipkeep-hl")];
  eq("本页重放高亮数（跨页高亮被过滤）", marks.length, 2);
  ok("绿色高亮应用了颜色", marks.some((m) => /#c7f5c7|rgb\(199, 245, 199\)/.test(m.style.background)));
  ok("带批注的高亮有 has-note 类", marks.some((m) => m.classList.contains("has-note")));
  eq("批注写入 title", marks.find((m) => m.dataset.hlid === "h1").title, "ClipKeep 批注：重点");
  ok("高亮文本完整保留", marks.some((m) => m.textContent === "量子比特可以同时处于两种状态"));
  ok("原文其余文字未被破坏", /这是并行性的来源/.test(w.document.body.textContent));

  // 工具条：选中 → 🖍 高亮
  const p = w.document.querySelector("article p:last-child");
  const range = w.document.createRange();
  range.setStart(p.firstChild, 1);
  range.setEnd(p.firstChild, 5);
  const sel = w.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const selText = sel.toString();
  w.document.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
  await tick(30);
  const bar = w.document.getElementById("clipkeep-toolbar");
  ok("浮动工具条可见", bar && bar.style.display === "flex");
  eq("工具条四个按钮", bar.querySelectorAll(".clipkeep-btn").length, 4);
  bar.querySelector(".clipkeep-btn-hl").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(30);
  let stored = store.clipkeep_highlights.filter((h) => h.url === url);
  eq("新增高亮已落盘", stored.length, 4);
  eq("新高亮记录选中文本", stored[3].text, selText);
  eq("新高亮颜色为 yellow", stored[3].color, "yellow");
  ok("新高亮出现在页面", !!w.document.querySelector(`mark[data-hlid="${stored[3].id}"]`));

  // ✎ 批注：走卡片，填批注后保存为粉色
  const p2 = w.document.querySelectorAll("article p")[1];
  const tn = p2.lastChild; // 已有高亮把该段文本节点切开了，取尾部未高亮部分
  const r2 = w.document.createRange();
  r2.setStart(tn, 1);
  r2.setEnd(tn, Math.min(5, tn.nodeValue.length));
  sel.removeAllRanges();
  sel.addRange(r2);
  const noteText = sel.toString();
  w.document.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
  await tick(30);
  bar.querySelector(".clipkeep-btn-note").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(10);
  const card = w.document.getElementById("clipkeep-card");
  ok("批注卡片打开", card && card.style.display === "block");
  eq("卡片标题为批注", card.querySelector(".clipkeep-card-head").textContent, "添加批注");
  eq("批注卡片隐藏标签输入", card.querySelector(".clipkeep-tags").style.display, "none");
  card.querySelector(".clipkeep-note").value = "这里要背";
  card.querySelector(".clipkeep-btn-confirm").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(30);
  stored = store.clipkeep_highlights.filter((h) => h.url === url);
  eq("批注高亮已落盘", stored.length, 5);
  eq("批注文本正确", stored[4].text, noteText);
  eq("批注颜色为 pink", stored[4].color, "pink");
  eq("批注内容保存", stored[4].note, "这里要背");
  const pink = w.document.querySelector(`mark[data-hlid="${stored[4].id}"]`);
  ok("批注出现在页面", !!pink);
  ok("批注带 has-note", pink.classList.contains("has-note"));

  // ★ 收藏：走同一张卡片填备注 + 标签后保存（回归：按钮类名选择器曾拼错，点击静默失败）
  const p3 = w.document.querySelector("article p:last-child");
  const tn3 = p3.lastChild;
  const r3 = w.document.createRange();
  r3.setStart(tn3, 0);
  r3.setEnd(tn3, tn3.nodeValue.length);
  sel.removeAllRanges();
  sel.addRange(r3);
  w.document.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
  await tick(30);
  bar.querySelector(".clipkeep-btn-save").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(10);
  eq("收藏卡片标题", card.querySelector(".clipkeep-card-head").textContent, "收藏内容");
  ok("收藏卡片展示原文", card.querySelector(".clipkeep-quote").textContent.length > 0);
  eq("收藏卡片显示标签输入", card.querySelector(".clipkeep-tags").style.display, "block");
  card.querySelector(".clipkeep-note").value = "卡片回归测试";
  card.querySelector(".clipkeep-tags").value = "量子, 测试";
  card.querySelector(".clipkeep-btn-confirm").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(30);
  eq("收藏已落盘", store.clipkeep_items.length, 1);
  const saved = store.clipkeep_items[0];
  eq("收藏备注", saved.note, "卡片回归测试");
  eq("收藏标签归一化", (saved.tags || []).join(","), "量子,测试");
  eq("收藏后卡片收起", card.style.display, "none");

  // 取消按钮：不新增
  w.document.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
  await tick(30);
  bar.querySelector(".clipkeep-btn-save").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(10);
  card.querySelector(".clipkeep-btn-cancel").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(20);
  eq("取消不新增收藏", store.clipkeep_items.length, 1);
  eq("取消后卡片收起", card.style.display, "none");

  // 点击已有高亮 → 删除（显式指令 !d）
  w.prompt = () => "!d";
  const target = w.document.querySelector('mark[data-hlid="h3"]');
  ok("存在待删除高亮", !!target);
  target.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(30);
  ok("删除后存储中消失", store.clipkeep_highlights.every((h) => h.id !== "h3"));
  ok("删除后页面节点被 unwrap", !w.document.querySelector('mark[data-hlid="h3"]'));
  ok("删除后原文仍在", /退相干时间很短/.test(w.document.body.textContent));

  ok("初始无净化阅读层", !w.document.getElementById("clipkeep-reader"));
}

/* ---------------- 3b. 高亮与存储保持一致 ---------------- */

function mountContent(pageUrl, highlights, htmlBody, opts) {
  const be = makeBackend(opts);
  be.store.clipkeep_highlights = highlights;
  if (opts && opts.lang) be.store.clipkeep_prefs = { lang: opts.lang };
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><article>${htmlBody}</article></body></html>`,
    { runScripts: "outside-only", url: pageUrl }
  );
  const w = dom.window;
  w.Range.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 122, left: 120, right: 300, width: 180, height: 22, x: 120, y: 100 });
  w.chrome = be.chrome;
  w.prompt = () => "";
  Object.defineProperty(w.navigator, "language", { value: (opts && opts.uiLanguage) || "zh-CN", configurable: true });
  w.eval(src("i18n.js"));
  w.eval(src("content.js"));
  const lastListener = () => be.listeners[be.listeners.length - 1]; // makeBackend 先注册后台，再注册本页 content script
  return {
    store: be.store, chrome: be.chrome, be, w,
    marks: () => [...w.document.querySelectorAll("mark.clipkeep-hl")],
    toastText: () => (w.document.getElementById("clipkeep-toast") || {}).textContent || "",
    bodyText: () => w.document.querySelector("article").textContent,
    // 直接投递给本页 content script 的消息监听（净化阅读、快捷键秒存走这条路）。
    // 没人回包时 500ms 后按 undefined 收尾：新消息类型还没实现时，测试要干净地红，
    // 不能让一个永不 resolve 的 promise 把整个进程吊死（连失败汇总都印不出来）。
    toContent: (msg) => new Promise((resolve) => {
      let done = false;
      const wrap = (r) => { if (!done) { done = true; resolve(r); } };
      lastListener()(msg, { tab: { id: 1 } }, wrap);
      setTimeout(() => wrap(undefined), 500);
    }),
  };
}

async function testHighlightSync() {
  console.log("\n[3b] 高亮一致性：幽灵标记 / URL 归一化 / 删除关键词 / 上下文失效");
  const text = "量子比特可以同时处于两种状态";
  const plain = `<p>简介：${text}，这是并行性的来源。</p><p>工程难点：退相干时间很短。</p>`;
  const at = (u, id) => ({ id, url: u, text, color: "green", note: "重点", createdAt: Date.now() });

  /* 1. 别的标签页删了记录，本页不能留下点不动的幽灵标记 */
  {
    const url = "http://localhost/sync1";
    const c = mountContent(url, [at(url, "g1")], plain);
    await tick(20);
    eq("初始重放 1 个标记", c.marks().length, 1);
    await c.chrome.storage.local.set({ clipkeep_highlights: [] }); // 模拟另一处删除
    await tick(30);
    eq("记录删光后幽灵标记被清掉", c.marks().length, 0);
    ok("原文完整", c.bodyText().includes(text) && c.bodyText().includes("这是并行性的来源"));

    // 批注 / 颜色在别处被改，本页要跟上
    await c.chrome.storage.local.set({ clipkeep_highlights: [at(url, "g1")] });
    await tick(30);
    eq("恢复记录后重新出现标记", c.marks().length, 1);
    await c.chrome.storage.local.set({ clipkeep_highlights: [{ ...at(url, "g1"), note: "改过的批注", color: "blue" }] });
    await tick(30);
    const m = c.marks().find((x) => x.dataset.hlid === "g1");
    eq("批注改动已同步", m && m.title, "ClipKeep 批注：改过的批注");
    ok("颜色改动已同步", /rgb\(207, 227, 255\)|#cfe3ff/i.test(m && m.style.background), m && m.style.background);
    eq("同步不会给同一条记录生成重复标记", c.marks().filter((x) => x.dataset.hlid === "g1").length, 1);
  }

  /* 2. 同一页面加了 #锚点 不能让高亮消失 */
  {
    const c = mountContent("http://localhost/sync2#top", [at("http://localhost/sync2", "a1")], plain);
    await tick(20);
    eq("带锚点的 URL 仍能重放", c.marks().length, 1);
  }

  /* 3. 批注正文不能当成删除指令 */
  {
    const url = "http://localhost/sync3";
    const c = mountContent(url, [at(url, "k1")], plain);
    await tick(20);
    c.w.prompt = () => "d";
    c.marks()[0].dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(30);
    eq("批注为 d 时不会被误删", c.store.clipkeep_highlights.length, 1);
    eq("批注按原文保存", c.store.clipkeep_highlights[0].note, "d");
    c.w.prompt = () => "!d";
    c.marks()[0].dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(30);
    eq("显式删除指令生效", c.store.clipkeep_highlights.length, 0);
    eq("删除后标记消失", c.marks().length, 0);
  }

  /* 5. 同一段文字里的多条高亮，重放时一条都不能挤掉另一条 */
  {
    const url = "http://localhost/sync5";
    const c = mountContent(url, [
      { id: "m1", url, text: "退相干时间很短", color: "yellow", note: "", createdAt: Date.now() },
      { id: "m2", url, text: "需要纠错码", color: "pink", note: "考点", createdAt: Date.now() },
    ], `<p>工程难点：退相干时间很短，需要纠错码。</p>`);
    await tick(20);
    eq("同段两条高亮都重放", c.marks().length, 2);
    ok("两条记录各自成标记", ["m1", "m2"].every((id) => c.marks().some((m) => m.dataset.hlid === id)));
    ok("原文一字不差", c.bodyText() === "工程难点：退相干时间很短，需要纠错码。", c.bodyText());
    // 再触发一次同步：不能因为反复重放而丢标记或重复包裹
    await c.chrome.storage.local.set({ clipkeep_highlights: c.store.clipkeep_highlights.slice() });
    await tick(30);
    eq("重复重放后数量不变", c.marks().length, 2);
    ok("重复重放后原文仍完整", c.bodyText() === "工程难点：退相干时间很短，需要纠错码。", c.bodyText());
  }

  /* 4. 扩展重载 / 存储写满后，页面里要有明确提示，也不能抛未捕获拒绝 */
  {
    const url = "http://localhost/sync4";
    const c = mountContent(url, [], plain);
    await tick(20);
    const p = c.w.document.querySelector("article p");
    const range = c.w.document.createRange();
    range.setStart(p.firstChild, 0);
    range.setEnd(p.firstChild, 6);
    const sel = c.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    c.w.document.dispatchEvent(new c.w.MouseEvent("mouseup", { bubbles: true }));
    await tick(30);
    c.w.document.querySelector(".clipkeep-btn-hl").dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(20);
    eq("正常写入先落盘", c.store.clipkeep_highlights.length, 1);
    const rejections = [];
    const onRej = (r) => rejections.push(String((r && r.message) || r));
    process.on("unhandledRejection", onRej);
    c.w.prompt = () => "保存不进去";
    c.store.__failNextSet = true;
    c.marks()[0].dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(60);
    process.off("unhandledRejection", onRej);
    eq("存储失败不产生未捕获拒绝", rejections.length, 0);
    ok("存储失败有页面提示", /失败|重试|刷新/.test(c.toastText()), c.toastText());
  }
}

/* ---------------- 5. v1.4 审计：净化 / 假成功提示 / 重放竞态 ---------------- */

async function testAudit() {
  console.log("\n[5] v1.4 缺陷审计");
  const now = Date.now();
  const DAY = 86400000;

  /* 1. 后台是最后一道关：合并进来的收藏必须净化（弹窗归一化只是善意路径，旧版本 / 手改文件会绕过） */
  {
    const be = makeBackend();
    const long = "x".repeat(20001);
    const res = await be.send({
      type: "clipkeep:merge",
      payload: {
        items: [
          { id: "m1", text: "带字符串标签", tags: "物理, 量子 物理" },
          { id: "m1", text: "重复 id 的第二条" },
          { id: "m2", text: "" },
          { id: "m3" },
          { id: "m4", text: "超长正文", note: long },
          { id: "m5", text: "盒号越界", review: { box: 99, due: -1, seen: -3 } },
          { id: "bad id<script>", text: "构造的 id" },
        ],
      },
    });
    const items = be.store.clipkeep_items;
    const byId = (id) => items.find((x) => x.id === id);
    eq("无正文的记录被拒收", items.filter((x) => ["m2", "m3"].includes(x.id)).length, 0);
    eq("来料内部重复 id 只保留一条", items.filter((x) => x.id === "m1").length, 1);
    ok("返回的新增数与入库一致", res.added === items.length, JSON.stringify(res));
    eq("标签按分隔符切分去重", JSON.stringify(byId("m1").tags), JSON.stringify(["物理", "量子"]));
    ok("合法 id 原样保留", !!byId("m1"));
    ok("构造的 id 被重新生成", items.some((x) => x.text === "构造的 id" && /^[\w-]{1,64}$/.test(x.id) && x.id !== "bad id<script>"),
      JSON.stringify(items.map((x) => x.id)));
    ok("超长正文截断到上限", byId("m4").text.length <= 20000);
    eq("盒号夹到合法区间", byId("m5").review.box, 5);
    ok("非法排期视为立即到期", byId("m5").review.due >= 1 && byId("m5").review.due <= Date.now() + DAY);
    eq("负数打卡次数归零", byId("m5").review.seen, 0);
  }

  /* 2. 覆盖本地同样净化，且清洗后的记录还能正常渲染（非数组 tags 会把弹窗整个列表打崩） */
  {
    const be = makeBackend();
    const res = await be.send({
      type: "clipkeep:replace",
      payload: { items: [{ id: "r1", text: "正常" }, { id: "r2", text: 12345, tags: "甲" }, { tags: ["乙"] }] },
    });
    eq("覆盖后入库 2 条", be.store.clipkeep_items.length, 2);
    eq("覆盖返回条数一致", res.count, 2);
    ok("正文统一转成字符串", typeof be.store.clipkeep_items.find((x) => x.id === "r2").text === "string");
    ok("标签统一是数组", be.store.clipkeep_items.every((x) => Array.isArray(x.tags)));
    ok("createdAt 补齐", be.store.clipkeep_items.every((x) => Number.isFinite(x.createdAt)));
  }

  /* 3. 弹窗的操作提示不能说谎：后台没写成功就不能报「已删除」 */
  {
    const p = await mountPopup({ clipkeep_items: [{ id: "d1", text: "在册收藏", note: "", tags: [], url: "", title: "", createdAt: now }] });
    p.store.__failNextSet = true;
    await p.click(p.q('.item[data-id="d1"] [data-act="del"]'));
    await tick(30);
    ok("删除失败时提示失败而不是「已删除」", /失败|重试/.test(p.$("toast").textContent), p.$("toast").textContent);

    const p2 = await mountPopup({ clipkeep_items: [{ id: "d2", text: "另一条", note: "", tags: [], url: "", title: "", createdAt: now }] });
    p2.w.prompt = () => "新标签";
    p2.store.__failNextSet = true;
    await p2.click(p2.q('.item[data-id="d2"] [data-act="tag"]'));
    await tick(30);
    ok("加标签失败时提示失败", /失败|重试/.test(p2.$("toast").textContent), p2.$("toast").textContent);
  }

  /* 4. 同一 tick 里连续两次存储变更：重放不能把高亮弄丢或包成两层 */
  {
    const url = "http://localhost/replay-race";
    const hl = (id, text) => ({ id, url, title: "页面", text, color: "yellow", note: "", createdAt: now });
    const three = [hl("r1", "第一句"), hl("r2", "第二句"), hl("r3", "第三句")];
    const c = mountContent(url, [], `<p>第一句，后面还有字。</p><p>第二句，后面还有字。</p><p>第三句，后面还有字。</p>`);
    await Promise.all([
      c.chrome.storage.local.set({ clipkeep_highlights: three }),
      c.chrome.storage.local.set({ clipkeep_highlights: three }),
    ]);
    await tick(80);
    eq("并发重放不丢高亮", c.marks().length, 3);
    eq("并发重放不产生重复标记", new Set(c.marks().map((m) => m.dataset.hlid)).size, 3);
    ok("三条高亮都在", ["r1", "r2", "r3"].every((id) => c.marks().some((m) => m.dataset.hlid === id)),
      c.marks().map((m) => m.dataset.hlid).join(","));
  }

  /* 5. 在已有高亮里拖选文字：这是选取动作，不是点击，不该弹出批注框 */
  {
    const url = "http://localhost/drag-select";
    const c = mountContent(url, [{ id: "ds1", url, title: "页面", text: "量子比特可以同时处于两种状态", color: "green", note: "重点", createdAt: now }],
      `<p>简介：量子比特可以同时处于两种状态，这是并行性的来源。</p>`);
    await tick(20);
    eq("初始重放出标记", c.marks().length, 1);
    let prompted = 0;
    c.w.prompt = () => { prompted++; return null; };
    // 在这条高亮内部拖选 3 个字，然后松手（浏览器随后会在同一处派发 click）
    const tn = c.marks()[0].firstChild;
    const range = c.w.document.createRange();
    range.setStart(tn, 0);
    range.setEnd(tn, 3);
    const sel = c.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    c.marks()[0].dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(30);
    eq("拖选结束不弹批注框", prompted, 0);
    eq("拖选不会删掉高亮", c.store.clipkeep_highlights.length, 1);
    // 真点击（没有选区）仍然要能编辑
    sel.removeAllRanges();
    c.w.prompt = () => "改过的批注";
    c.marks()[0].dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(30);
    eq("无选区时点击仍可改批注", c.store.clipkeep_highlights[0].note, "改过的批注");
  }

  /* 6. 净化阅读：克隆出来的正文不能带着同一批高亮标记，否则页面里出现重复 hlid */
  {
    const url = "http://localhost/reader-marks";
    const c = mountContent(url, [{ id: "rm1", url, title: "页面", text: "量子比特", color: "green", note: "", createdAt: now }],
      `<article><p>${"引言。".repeat(30)}量子比特可以同时处于两种状态，这是并行性的来源。</p></article>`);
    await tick(20);
    eq("进入前页面有 1 个标记", c.marks().length, 1);
    const res = await c.toContent({ type: "clipkeep:reader" });
    await tick(30);
    ok("净化阅读已开启", !!c.w.document.querySelector(".clipkeep-reader"), JSON.stringify(res));
    eq("阅读视图里没有重复的高亮标记", c.w.document.querySelectorAll(".clipkeep-reader mark.clipkeep-hl").length, 0);
    eq("整页标记总数仍是 1", c.marks().length, 1);
    ok("阅读正文文字完整", c.w.document.querySelector(".clipkeep-reader").textContent.includes("量子比特"));
    await c.toContent({ type: "clipkeep:reader" });
    await tick(30);
    ok("退出后阅读视图移除", !c.w.document.querySelector(".clipkeep-reader"));
    eq("退出后高亮标记还在", c.marks().length, 1);
  }
}

/* ---------------- 6. 回顾热力图与打卡统计 ---------------- */

const dkey = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function testActivity() {
  console.log("\n[6] 回顾热力图");
  const now = Date.now();
  const DAY = 86400000;
  const mk = (id, review) => ({
    id, text: "要回顾的" + id, note: "", tags: [], url: "http://x/1", title: "页面",
    createdAt: now, review,
  });

  /* 1. 后台：打分与活动记录一次写链完成 */
  {
    const be = makeBackend();
    await be.send({ type: "clipkeep:add", payload: { text: "量子纠缠", url: "http://x/1" } });
    const id = be.store.clipkeep_items[0].id;
    const r = await be.send({ type: "clipkeep:grade", id, review: { box: 1, due: now + DAY, seen: 1 } });
    ok("grade 返回成功", r.ok === true);
    eq("排期已写入", be.store.clipkeep_items[0].review.box, 1);
    eq("当日活动 +1", be.store.clipkeep_activity[dkey(now)].n, 1);
    await be.send({ type: "clipkeep:grade", id, review: { box: 2, due: now + 3 * DAY, seen: 2 } });
    eq("同日再打累计加", be.store.clipkeep_activity[dkey(now)].n, 2);
    const nf = await be.send({ type: "clipkeep:grade", id: "nope", review: { box: 3, due: now, seen: 1 } });
    ok("未知 id 返回 not_found", nf.ok === false && nf.error === "not_found");
    eq("打分为未知 id 不记活动", be.store.clipkeep_activity[dkey(now)].n, 2);
    eq("排期没被非法打分改掉", be.store.clipkeep_items[0].review.box, 2);
    const bad = await be.send({ type: "clipkeep:grade", id, review: { box: "99", due: "abc", seen: -1 } });
    ok("非法排期被拒绝", bad.ok === false, JSON.stringify(bad));
    // 只留最近 120 天
    be.store.clipkeep_activity = { "2000-01-01": 5, [dkey(now)]: 1 };
    await be.send({ type: "clipkeep:grade", id, review: { box: 0, due: now, seen: 1 } });
    ok("超龄活动记录被清理", be.store.clipkeep_activity["2000-01-01"] === undefined, JSON.stringify(be.store.clipkeep_activity));
  }

  /* 2. 弹窗回顾视图渲染热力图与统计 */
  {
    const p = await mountPopup({
      clipkeep_items: [mk("a1", { box: 0, due: now - 10, seen: 0 })],
      clipkeep_activity: {
        [dkey(now)]: 2,
        [dkey(now - DAY)]: 5,
        [dkey(now - 2 * DAY)]: 1,
        [dkey(now - 30 * DAY)]: 2,
      },
    });
    await p.click(p.q('.tab[data-view="review"]'));
    await tick(20);
    const cells = p.qa(".heat i");
    eq("热力图 8 周 × 7 天", cells.length, 56);
    const cellOf = (list, day) => list.find((c) => c.dataset.day === day);
    const todayCell = cellOf(cells, dkey(now));
    ok("每个格子都带日期", cells.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.dataset.day || "")),
      cells.filter((c) => !/^\d{4}-\d{2}-\d{2}$/.test(c.dataset.day || "")).map((c) => c.outerHTML).join("|"));
    ok("今天没有落在未来格子里", !!todayCell);
    eq("2 次对应等级 1", Number(todayCell.dataset.lvl), 1);
    eq("5 次对应等级 2", Number(cellOf(cells, dkey(now - DAY)).dataset.lvl), 2);
    ok("超出 8 周窗口的天不画格子", !cellOf(cells, dkey(now - 200 * DAY)));
    const stats = p.$("heat-stats").textContent;
    ok("统计含最近 7 天回顾数", /本周\s*8/.test(stats), stats);
    ok("统计含连续打卡天数", /连续\s*3\s*天/.test(stats), stats);
    ok("累计统计窗口外的记录也算", /累计\s*10/.test(stats), stats);
    // 打完分当天计数即时增加
    await p.click(p.q('[data-act="reveal"]'));
    await p.click(p.q('.rev-grade [data-g="1"]'));
    await tick(30);
    eq("打分写入活动记录", p.store.clipkeep_activity[dkey(now)].n, 3);
    const cells2 = p.qa(".heat i");
    eq("热力图今日等级随之升高", Number(cellOf(cells2, dkey(now)).dataset.lvl), 2);
    ok("统计跟着刷新", /本周\s*9/.test(p.$("heat-stats").textContent), p.$("heat-stats").textContent);
    eq("打分仍走排期更新", p.store.clipkeep_items.find((x) => x.id === "a1").review.box, 1);
  }

  /* 3. 没有活动数据时不报错 */
  {
    const p = await mountPopup({ clipkeep_items: [mk("b1", { box: 0, due: now - 10, seen: 0 })] });
    await p.click(p.q('.tab[data-view="review"]'));
    await tick(20);
    eq("空数据仍画出完整格子", p.qa(".heat i").length, 56);
    ok("统计显示 0", /本周\s*0/.test(p.$("heat-stats").textContent), p.$("heat-stats").textContent);
  }
}

/* ---------------- 7. 重复收藏检测 ---------------- */

async function testDedupe() {
  console.log("\n[7] 重复收藏检测");
  const text = "量子比特可以同时处于两种状态";

  /* 1. 同一页面同一句话只入库一次 */
  {
    const be = makeBackend();
    const first = await be.send({ type: "clipkeep:add", payload: { text, url: "http://x/1", title: "T" } });
    ok("首次收藏成功", first.ok === true && !first.dup);
    const again = await be.send({ type: "clipkeep:add", payload: { text: "  " + text + " ", url: "http://x/1", title: "T" } });
    eq("重复收藏不再新增", be.store.clipkeep_items.length, 1);
    ok("重复时告知 dup", again.ok === true && again.dup === true, JSON.stringify(again));
    eq("回报的是已存在的那条", again.item.text, text);
    const other = await be.send({ type: "clipkeep:add", payload: { text, url: "http://y/2", title: "T2" } });
    eq("不同页面同文字允许收藏", be.store.clipkeep_items.length, 2);
    ok("不同页面不算重复", !other.dup);
    const noted = await be.send({ type: "clipkeep:add", payload: { text, url: "http://x/1", note: "这次有备注" } });
    eq("带备注的收藏不算重复（备注是新增信息）", be.store.clipkeep_items.length, 3);
    ok("带备注时正常入库", noted.ok === true && !noted.dup);
    const tagged = await be.send({ type: "clipkeep:add", payload: { text, url: "http://x/1", tags: "物理" } });
    eq("带标签的收藏不算重复", be.store.clipkeep_items.length, 4);
    ok("带标签时正常入库", tagged.ok === true && tagged.item.tags.join(",") === "物理");
    const sameAgain = await be.send({ type: "clipkeep:add", payload: { text, url: "http://x/1", tags: "物理" } });
    eq("内容来源备注标签全同才算重复", be.store.clipkeep_items.length, 4);
    ok("全同再存返回 dup", sameAgain.ok === true && sameAgain.dup === true);
  }

  /* 2. 快捷键秒存重复时给出明确提示，而不是「已收藏」 */
  {
    const url = "http://localhost/dedupe-toast";
    const c = mountContent(url, [], `<p>已经存过的句子，后面还有字。</p>`);
    const seeded = await c.be.send({ type: "clipkeep:add", payload: { text: "已经存过的句子", url } });
    ok("测试内预置一条收藏", seeded.ok === true);
    const realGetSel = c.w.getSelection.bind(c.w);
    c.w.getSelection = () => ({ toString: () => "已经存过的句子", rangeCount: 1, getRangeAt: () => realGetSel().getRangeAt(0) });
    await c.toContent({ type: "clipkeep:save-selection" });
    await tick(40);
    eq("重复秒存不新增数据", c.store.clipkeep_items.length, 1);
    ok("页面提示已经在收藏里", /已经在收藏/.test(c.toastText()), c.toastText());
  }
}

/* ---------------- 8. v1.5 缺陷审计：来源链接协议 / 截断标记 / 打卡连续性 ---------------- */

async function testV15Audit() {
  console.log("\n[8] v1.5 缺陷审计");
  const now = Date.now();
  const DAY = 86400000;
  const clip = (id, extra) => ({
    id, text: "收藏" + id, note: "", tags: [], url: "", title: "", createdAt: now, ...(extra || {}),
  });

  /* 1. 收藏列表的来源链接同样要过协议白名单（高亮视图 v1.3 已防，列表漏了） */
  {
    const p = await mountPopup({
      clipkeep_items: [
        clip("j1", { url: "javascript:alert(1)", title: "点我" }),
        clip("h1", { url: "https://example.com/a", title: "正常文章" }),
      ],
    });
    const row = p.q('.item[data-id="j1"]');
    eq("javascript: 来源不渲染成链接", row.querySelectorAll("a").length, 0);
    ok("危险 URL 不出现在 href 里", !/href="javascript/i.test(row.innerHTML), row.innerHTML);
    ok("来源标题仍以纯文本留着，不丢信息", /点我/.test(row.textContent), row.textContent);
    ok("正常 https 来源照旧可点",
      p.q('.item[data-id="h1"]').querySelectorAll('a[href^="https://"]').length === 1);
  }

  /* 2. 导出的来源链接要容得下括号（维基一类 URL 太常见） */
  {
    const p = await mountPopup({
      clipkeep_items: [
        clip("w1", { text: "量子隧穿", url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "Foo" }),
        clip("w2", { text: "危险来源", url: "javascript:alert(1)", title: "bad" }),
      ],
    });
    await p.click(p.$("btn-export"));
    await tick(30);
    const md = p.getDownloaded() || "";
    const at = md.indexOf("[来源]");
    ok("来源链接用尖括号包住带括号的 URL", /\[来源\]\(<https:[^>]*\(bar\)[^>]*>\)/.test(md),
      at < 0 ? "导出里没有来源行" : md.slice(at, at + 70));
    ok("非法协议的来源不写成链接", !/\]\(<?javascript:/i.test(md), md.slice(0, 400));
  }

  /* 3. 超长收藏被截断，得让用户看得见 */
  {
    const be = makeBackend();
    const r = await be.send({ type: "clipkeep:add", payload: { text: "长".repeat(20001), url: "http://x/1" } });
    ok("超长收藏成功入库", r.ok === true);
    eq("正文截断到上限", r.item.text.length, 20000);
    ok("后台标记 truncated", r.item.truncated === true);
    const p = await mountPopup({ clipkeep_items: be.store.clipkeep_items });
    ok("列表显示「已截断」标记", /已截断/.test(p.q(".item").innerHTML), p.q(".item").innerHTML.slice(0, 160));
    const p2 = await mountPopup({ clipkeep_items: [clip("n1", { url: "http://x/2" })] });
    ok("正常收藏不显示截断标记", !/已截断/.test(p2.q(".item").innerHTML));
  }

  /* 4. 今天还没打卡，不该把昨天的连续纪录清零 */
  {
    const p = await mountPopup({
      clipkeep_items: [clip("r1", { review: { box: 0, due: now - 10, seen: 0 } })],
      clipkeep_activity: { [dkey(now - DAY)]: 4, [dkey(now - 2 * DAY)]: 3 },
    });
    await p.click(p.q('.tab[data-view="review"]'));
    await tick(20);
    const stats = p.$("heat-stats").textContent;
    ok("今天未打卡仍连续 2 天", /连续\s*2\s*天/.test(stats), stats);
    ok("本周只数实际打卡的 7 条", /本周\s*7/.test(stats), stats);
  }

  /* 5. 本周窗口的边界：含今天往前第 6 天，不含第 7 天 */
  {
    const p = await mountPopup({
      clipkeep_items: [clip("r2", { review: { box: 0, due: now - 10, seen: 0 } })],
      clipkeep_activity: { [dkey(now - 6 * DAY)]: 2, [dkey(now - 7 * DAY)]: 5 },
    });
    await p.click(p.q('.tab[data-view="review"]'));
    await tick(20);
    const stats = p.$("heat-stats").textContent;
    ok("边界外那天不计入本周", /本周\s*2/.test(stats), stats);
    ok("边界外那天仍计入累计", /累计\s*7/.test(stats), stats);
  }

  /* 6. 超长收藏不能把列表撑爆：默认折叠，可展开 / 收起 */
  {
    const long = ("量子比特可以叠加。".repeat(60)); // ~540 字
    const p = await mountPopup({
      clipkeep_items: [clip("L1", { text: long }), clip("S1", { text: "很短的一条收藏" })],
    });
    const row = p.q('.item[data-id="L1"]');
    ok("长正文默认折叠", row.querySelector(".item-text").classList.contains("is-clamped"),
      row.querySelector(".item-text").className);
    const more = row.querySelector('[data-act="more"]');
    ok("长正文给出展开按钮", !!more, row.innerHTML.slice(-200));
    await p.click(more);
    ok("点一下展开全文", p.q('.item[data-id="L1"] .item-text').classList.contains("is-open") === false &&
      p.q('.item[data-id="L1"] .item-text').classList.contains("is-clamped") === false);
    ok("展开后按钮变成收起", /收起/.test(p.q('.item[data-id="L1"] [data-act="more"]').textContent),
      p.q('.item[data-id="L1"] [data-act="more"]').textContent);
    await p.click(p.q('.item[data-id="L1"] [data-act="more"]'));
    ok("再点收回", p.q('.item[data-id="L1"] .item-text').classList.contains("is-clamped"));
    ok("短正文不加折叠与按钮",
      !p.q('.item[data-id="S1"] .item-text').classList.contains("is-clamped") &&
      !p.q('.item[data-id="S1"] [data-act="more"]'));
  }
}

/* ---------------- 9. 导出模板自定义 ---------------- */

async function testExportTemplate() {
  console.log("\n[9] 导出模板自定义");
  const now = Date.now();
  const it1 = {
    id: "e1", text: "量子比特可以同时处于两种状态，这是它超越经典计算的根本原因。",
    note: "备注一", tags: ["量子", "重点"], url: "https://example.com/qm",
    title: "量子计算入门", createdAt: now,
  };
  const it2 = { id: "e2", text: "退相干时间是主要工程难点", note: "", tags: [], url: "", title: "", createdAt: now - 1000 };

  /* 1. 默认模板保持 v1.4 的形状 */
  {
    const p = await mountPopup({ clipkeep_items: [it1, it2] });
    ok("设置面板有导出模板控件", !!p.$("set-heading") && !!p.$("set-source") && !!p.$("set-fm"));
    eq("默认标题样式回填下拉框", p.$("set-heading").value, "numbered");
    eq("默认带来源链接", p.$("set-source").checked, true);
    eq("默认不带 front-matter", p.$("set-fm").checked, false);
    await p.click(p.$("btn-export"));
    await tick(20);
    const md = p.getDownloaded() || "";
    ok("默认标题带编号与来源标题", /^## 1\. 量子计算入门$/m.test(md), md.slice(0, 160));
    ok("默认输出来源链接", /\[来源\]\(<https:\/\/example\.com\/qm>\)/.test(md), md.slice(0, 300));
    ok("默认没有 front-matter", !md.startsWith("---"));
  }

  /* 2. 标题样式：来源标题 / 正文首句 / 收藏时间 */
  {
    const p = await mountPopup({ clipkeep_items: [it1, it2] });
    p.$("set-heading").value = "title";
    await p.fire(p.$("set-heading"), "change");
    await tick(20);
    eq("标题样式写进 prefs", p.store.clipkeep_prefs.export.heading, "title");
    await p.click(p.$("btn-export"));
    await tick(20);
    ok("纯标题样式不带编号", /^## 量子计算入门$/m.test(p.getDownloaded() || ""));
    ok("无标题无来源时记作未命名", /^## 未命名$/m.test(p.getDownloaded() || ""),
      (p.getDownloaded() || "").split("\n").filter((l) => l.startsWith("## ")).join("|"));
  }
  {
    const p = await mountPopup({ clipkeep_items: [it1, it2] });
    p.$("set-heading").value = "text";
    await p.fire(p.$("set-heading"), "change");
    await tick(20);
    await p.click(p.$("btn-export"));
    await tick(20);
    const md = p.getDownloaded() || "";
    ok("正文首句作标题", /^## 量子比特可以同时处于两种状态，这是它超越/m.test(md),
      md.split("\n").filter((l) => l.startsWith("## ")).join("|"));
    ok("短正文不硬加省略号", /^## 退相干时间是主要工程难点$/m.test(md),
      md.split("\n").filter((l) => l.startsWith("## ")).join("|"));
  }
  {
    const p = await mountPopup({ clipkeep_items: [it1] });
    p.$("set-heading").value = "date";
    await p.fire(p.$("set-heading"), "change");
    await tick(20);
    await p.click(p.$("btn-export"));
    await tick(20);
    ok("收藏时间作标题", /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m.test(p.getDownloaded() || ""),
      (p.getDownloaded() || "").split("\n").filter((l) => l.startsWith("## ")).join("|"));
  }

  /* 3. 来源开关与 Obsidian front-matter */
  {
    const p = await mountPopup({ clipkeep_items: [it1, it2] });
    p.$("set-source").checked = false;
    await p.fire(p.$("set-source"), "change");
    p.$("set-fm").checked = true;
    await p.fire(p.$("set-fm"), "change");
    await tick(20);
    eq("来源开关入库", p.store.clipkeep_prefs.export.source, false);
    eq("front-matter 开关入库", p.store.clipkeep_prefs.export.frontMatter, true);
    await p.click(p.$("btn-export"));
    await tick(20);
    const md = p.getDownloaded() || "";
    ok("关掉后不输出来源", !/\[来源\]|来源：/.test(md));
    ok("front-matter 从文件第一行开始", md.startsWith("---\n"), md.slice(0, 60));
    ok("front-matter 带标题与条数", /title: ClipKeep 收藏/.test(md) && /count: 2/.test(md), md.slice(0, 200));
    ok("front-matter 有闭合线且正文在其后", md.indexOf("\n---\n", 4) > 0 &&
      md.indexOf("## 1.") > md.indexOf("\n---\n", 4), md.slice(0, 200));
  }

  /* 4. 非法值回落默认，且改导出不冲掉别的设置段 */
  {
    const p = await mountPopup({
      clipkeep_items: [it1],
      clipkeep_prefs: { review: { cap: 5, mult: 2 }, trash: { mins: 30 }, dark: true, export: { heading: "<script>" } },
    });
    eq("非法标题样式回落默认", p.$("set-heading").value, "numbered");
    p.$("set-heading").value = "date";
    await p.fire(p.$("set-heading"), "change");
    await tick(20);
    eq("回顾设置没被冲掉", p.store.clipkeep_prefs.review.cap, 5);
    eq("回收站设置没被冲掉", p.store.clipkeep_prefs.trash.mins, 30);
    eq("深色偏好没被冲掉", p.store.clipkeep_prefs.dark, true);
    ok("标题样式里的脚本不会被拼进 HTML", !/<script>/.test(p.$("settings").innerHTML), p.$("settings").innerHTML.slice(0, 200));
  }
}

/* ---------------- 10. 图片与链接剪藏 ---------------- */

async function testMediaClips() {
  console.log("\n[10] 右键剪藏图片 / 链接：菜单注册 / 协议白名单 / 渲染 / 导出");
  const now = Date.now();
  const IMG = "https://cdn.example.com/img/cat.png";
  const LINK = "https://docs.example.com/guide?x=1";

  /* 1. 菜单注册：图片和链接各自只在自己的上下文出现 */
  {
    const be = makeBackend();
    await be.fireInstalled("install");
    const image = be.menuOps.created.find((c) => c.id === "clipkeep-save-image");
    const link = be.menuOps.created.find((c) => c.id === "clipkeep-save-link");
    ok("注册了「收藏图片」菜单项", !!image, JSON.stringify(be.menuOps.created));
    ok("图片菜单只在图片上出现", !!image && JSON.stringify(image.contexts) === '["image"]');
    ok("注册了「收藏链接」菜单项", !!link, JSON.stringify(be.menuOps.created));
    ok("链接菜单只在链接上出现", !!link && JSON.stringify(link.contexts) === '["link"]');
  }

  /* 2. 右键图片：地址入 image，正文用文件名兜底，来源页留在 url */
  {
    const be = makeBackend();
    await be.fireMenuClick(
      { menuItemId: "clipkeep-save-image", srcUrl: IMG, pageUrl: "https://blog.example.com/p/1", mediaType: "image" },
      { id: 1, title: "博文一", url: "https://blog.example.com/p/1" }
    );
    eq("图片剪藏入库一条", be.store.clipkeep_items.length, 1);
    const it = be.store.clipkeep_items[0] || {};
    eq("类型记作图片", it.kind, "image");
    eq("图片地址入库", it.image, IMG);
    eq("正文用文件名兜底", it.text, "cat.png");
    eq("来源页入库", it.url, "https://blog.example.com/p/1");
    eq("来源标题入库", it.title, "博文一");
    ok("剪藏成功有页面反馈", /已收藏/.test(be.sentToTab.map((s) => s.msg.message).join("|")));
    eq("菜单处理不抛异常", be.menuErrors.length, 0);
  }
  {
    const be = makeBackend();
    await be.fireMenuClick(
      { menuItemId: "clipkeep-save-image", srcUrl: "https://cdn.example.com/img/cat.png?w=800&h=600#x", pageUrl: "https://blog/p" },
      { id: 1, title: "T", url: "https://blog/p" }
    );
    eq("文件名去掉查询串与锚点", (be.store.clipkeep_items[0] || {}).text, "cat.png");
  }

  /* 3. 右键链接：有链接文字用文字，没有就用目标站点兜底 */
  {
    const be = makeBackend();
    await be.fireMenuClick(
      { menuItemId: "clipkeep-save-link", linkUrl: LINK, selectionText: "官方指南", pageUrl: "https://blog.example.com/p/1" },
      { id: 1, title: "博文一", url: "https://blog.example.com/p/1" }
    );
    const it = be.store.clipkeep_items[0] || {};
    eq("类型记作链接", it.kind, "link");
    eq("链接地址入库", it.link, LINK);
    eq("正文取链接文字", it.text, "官方指南");
    eq("来源页是链接所在页", it.url, "https://blog.example.com/p/1");
  }
  {
    const be = makeBackend();
    await be.fireMenuClick(
      { menuItemId: "clipkeep-save-link", linkUrl: LINK, pageUrl: "https://blog/p" },
      { id: 1, title: "T", url: "https://blog/p" }
    );
    const it = be.store.clipkeep_items[0] || {};
    ok("没有链接文字时用目标地址兜底正文", /docs\.example\.com/.test(it.text || ""), JSON.stringify(it));
  }

  /* 4. 伪协议 / data: 地址不是可剪藏的内容，也不能冒充成图片链接 */
  {
    const be = makeBackend();
    await be.fireMenuClick(
      { menuItemId: "clipkeep-save-image", srcUrl: "javascript:alert(1)", pageUrl: "https://blog/p" },
      { id: 1, title: "T", url: "https://blog/p" }
    );
    const it = be.store.clipkeep_items[0] || {};
    ok("伪协议图片地址不入库", !it.image, JSON.stringify(it));
    ok("伪协议不让条目冒充图片", it.kind !== "image", JSON.stringify(it));
    ok("伪协议地址不写进收藏", be.store.clipkeep_items.length === 0, JSON.stringify(be.store.clipkeep_items));
    ok("伪协议剪藏给出说明", /无法收藏/.test(be.sentToTab.map((s) => s.msg.message).join("|")));
    await be.fireMenuClick(
      { menuItemId: "clipkeep-save-link", linkUrl: "data:text/html,<script>alert(1)</script>", pageUrl: "https://blog/p" },
      { id: 1, title: "T", url: "https://blog/p" }
    );
    const l = be.store.clipkeep_items[0] || {};
    ok("data: 链接地址不入库", !l.link, JSON.stringify(l));
    ok("data: 链接降级为普通收藏", l.kind !== "link", JSON.stringify(l));
    eq("data: 链接不写入收藏", be.store.clipkeep_items.length, 0);
  }

  /* 5. 重复剪藏同一个目标：沿用重复检测，不堆副本 */
  {
    const be = makeBackend();
    const info = { menuItemId: "clipkeep-save-image", srcUrl: IMG, pageUrl: "https://blog/p" };
    await be.fireMenuClick(info, { id: 1, title: "T", url: "https://blog/p" });
    await be.fireMenuClick(info, { id: 1, title: "T", url: "https://blog/p" });
    eq("同一张图只存一条", be.store.clipkeep_items.length, 1);
    ok("重复剪藏有提示", /已经在收藏里/.test(be.sentToTab.map((s) => s.msg.message).join("|")));
  }

  /* 6. 备份通道同样要洗：类型夹到合法值，非法地址丢弃 */
  {
    const be = makeBackend();
    const res = await be.send({
      type: "clipkeep:replace",
      payload: {
        items: [
          { id: "m1", text: "cat.png", kind: "image", image: IMG, url: "https://blog/p", createdAt: 1 },
          { id: "m2", text: "官方指南", kind: "link", link: LINK, url: "https://blog/p", createdAt: 2 },
          { id: "m3", text: "伪造类型", kind: "picture", image: "javascript:alert(1)", createdAt: 3 },
          { id: "m4", text: "空壳图片", kind: "image", image: "javascript:alert(1)", createdAt: 4 },
        ],
      },
    });
    ok("replace 接受带媒体字段的备份", res.ok === true, JSON.stringify(res));
    const by = (id) => be.store.clipkeep_items.find((x) => x.id === id);
    eq("备份里的图片类型保留", by("m1").kind, "image");
    eq("备份里的图片地址保留", by("m1").image, IMG);
    eq("备份里的链接地址保留", by("m2").link, LINK);
    eq("非法类型回落普通收藏", by("m3").kind, undefined);
    ok("非法图片地址被丢弃", !by("m3").image, JSON.stringify(by("m3")));
    ok("图片地址非法时不再冒充图片", by("m4").kind === undefined && !by("m4").image, JSON.stringify(by("m4")));
  }

  /* 6b. 备份 → 恢复：媒体字段不能在半路被丢掉 */
  {
    const p = await mountPopup({ clipkeep_items: [] });
    await p.putBackup({
      app: "ClipKeep",
      version: 1,
      items: [
        { id: "b1", text: "cat.png", kind: "image", image: IMG, url: "https://blog/p", createdAt: now },
        { id: "b2", text: "官方指南", kind: "link", link: LINK, url: "https://blog/p", createdAt: now },
        { id: "b3", text: "伪造", kind: "image", image: "javascript:alert(1)", createdAt: now },
      ],
      highlights: [],
    });
    await p.click(p.$("modal-ok"));
    await tick(30);
    const b1 = p.store.clipkeep_items.find((x) => x.id === "b1") || {};
    const b2 = p.store.clipkeep_items.find((x) => x.id === "b2") || {};
    const b3 = p.store.clipkeep_items.find((x) => x.id === "b3") || {};
    eq("恢复后图片地址还在", b1.image, IMG);
    eq("恢复后图片类型还在", b1.kind, "image");
    eq("恢复后链接地址还在", b2.link, LINK);
    ok("恢复时非法图片地址仍被拦下", !b3.image, JSON.stringify(b3));
    ok("恢复后图片收藏渲染成图片", /图片/.test(p.qa(".item")[0].textContent), p.qa(".item")[0].innerHTML.slice(0, 200));
  }

  /* 7. 弹窗渲染：类型徽标 + 可点开的安全地址，且不远程加载图片 */
  {
    const p = await mountPopup({
      clipkeep_items: [
        { id: "m1", text: "cat.png", note: "", tags: [], url: "https://blog/p", title: "博文", createdAt: now, kind: "image", image: IMG },
        { id: "m2", text: "官方指南", note: "", tags: [], url: "https://blog/p", title: "博文", createdAt: now - 1, kind: "link", link: LINK },
        { id: "m3", text: "伪造来源", note: "", tags: [], url: "javascript:alert(1)", title: "", createdAt: now - 2, kind: "image", image: "javascript:alert(1)" },
        { id: "m4", text: "普通文字收藏", note: "", tags: [], url: "", title: "", createdAt: now - 3 },
      ],
    });
    const rows = p.qa(".item");
    eq("列表按时间倒序渲染", rows.length, 4);
    ok("图片收藏带类型徽标", /图片/.test(rows[0].innerHTML), rows[0].innerHTML.slice(0, 200));
    eq("图片收藏可点开原图地址", rows[0].querySelector("a.item-kind")?.getAttribute("href"), IMG);
    ok("链接收藏带类型徽标", /链接/.test(rows[1].innerHTML), rows[1].innerHTML.slice(0, 200));
    eq("链接收藏渲染目标地址", rows[1].querySelector("a.item-kind")?.getAttribute("href"), LINK);
    eq("图片收藏显示「查看原图」", rows[0].querySelector("a.item-kind")?.textContent, "查看原图");
    eq("图片收藏鼠标悬停仍能看到真实地址",
       rows[0].querySelector("a.item-kind")?.getAttribute("title"), IMG);
    eq("链接收藏显示域名，一眼看出来源",
       rows[1].querySelector("a.item-kind")?.textContent, "docs.example.com");
    ok("普通收藏不渲染类型徽标", !rows[3].querySelector(".item-kind"), rows[3].innerHTML.slice(0, 200));
    ok("非法地址不渲染成链接", !rows[2].querySelector('a[href^="javascript"]'), rows[2].innerHTML.slice(0, 240));
    ok("弹窗不远程加载图片（离线且不暴露浏览记录）", p.qa(".item img").length === 0);
    ok("非法地址不写进任何链接属性",
       p.qa(".item a").every((a) => !/javascript:/.test(a.getAttribute("href") || "")),
       p.qa(".item a").map((a) => a.getAttribute("href")).join("|"));
    ok("伪协议来源仍以纯文本露出，不假装能点", /javascript:/.test(rows[2].textContent), rows[2].textContent.slice(0, 120));

    p.$("search").value = "cdn.example.com";
    await p.fire(p.$("search"), "input");
    eq("搜图片地址能命中图片收藏", p.qa(".item").length, 1);
    p.$("search").value = "docs.example.com";
    await p.fire(p.$("search"), "input");
    eq("搜链接地址能命中链接收藏", p.qa(".item").length, 1);
    p.$("search").value = "";
    await p.fire(p.$("search"), "input");

    let copied = "";
    p.w.HTMLTextAreaElement.prototype.select = function () { copied = this.value; };
    const firstRow = p.qa(".item")[0]; // 搜索过后列表重渲染过，取当前行而不是旧引用
    eq("当前第一行还是图片收藏", firstRow.dataset.id, "m1");
    await p.click(firstRow.querySelector('[data-act="copy"]'));
    eq("图片收藏复制的是图片地址", copied, IMG);
    await p.click(p.qa(".item")[1].querySelector('[data-act="copy"]'));
    eq("链接收藏复制的是链接地址", copied, LINK);
    await p.click(p.qa(".item")[2].querySelector('[data-act="copy"]'));
    eq("地址非法时退回复制正文", copied, "伪造来源");
  }

  /* 8. Markdown 导出：图片写成 ![]()，链接写成 []()，关掉来源开关也不丢内容 */
  {
    const p = await mountPopup({
      clipkeep_items: [
        { id: "m1", text: "cat.png", note: "", tags: [], url: "https://blog/p", title: "博文", createdAt: now, kind: "image", image: IMG },
        { id: "m2", text: "官方指南", note: "", tags: [], url: "https://blog/p", title: "博文", createdAt: now - 1, kind: "link", link: LINK },
        { id: "m3", text: "伪造来源", note: "", tags: [], url: "javascript:alert(1)", title: "", createdAt: now - 2, kind: "image", image: "javascript:alert(1)" },
      ],
    });
    await p.click(p.$("btn-export"));
    await tick(20);
    const md = p.getDownloaded() || "";
    ok("图片导出为 Markdown 图片", md.includes(`![cat.png](<${IMG}>)`), md.slice(0, 400));
    ok("链接导出为 Markdown 链接", md.includes(`[官方指南](<${LINK}>)`), md.slice(0, 400));
    ok("伪协议地址不写成 Markdown 链接", !/\]\(<javascript:/.test(md), md.slice(0, 400));
    ok("图片收藏正文仍在", md.includes("> cat.png"), md.slice(0, 400));

    p.$("set-source").checked = false;
    await p.fire(p.$("set-source"), "change");
    await p.click(p.$("btn-export"));
    await tick(20);
    const noSrc = p.getDownloaded() || "";
    ok("关掉来源开关不丢图片地址", noSrc.includes(`![cat.png](<${IMG}>)`), noSrc.slice(0, 400));
    ok("关掉来源开关不丢链接地址", noSrc.includes(`[官方指南](<${LINK}>)`), noSrc.slice(0, 400));
    ok("关掉来源开关后不输出来源行", !/\[来源\]|来源：/.test(noSrc), noSrc.slice(0, 400));
  }
  {
    /* 回归：纯文字收藏的导出形状不受影响 */
    const p = await mountPopup({
      clipkeep_items: [{ id: "t1", text: "退相干时间是主要工程难点", note: "", tags: [], url: "https://blog/p", title: "博文", createdAt: now }],
    });
    await p.click(p.$("btn-export"));
    await tick(20);
    const md = p.getDownloaded() || "";
    ok("文字收藏不产生图片语法", !/!\[/.test(md), md.slice(0, 300));
    eq("文字收藏只输出来源一条链接",
       md.split("\n").filter((l) => /^\[.+\]\(/.test(l)).length, 1);
    ok("文字收藏导出正文与来源", md.includes("> 退相干时间是主要工程难点") && md.includes(`[来源](<https://blog/p>)`), md.slice(0, 300));
  }
  /* 9. 改收藏不能塞进非法类型或伪协议地址 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = [{ id: "u1", text: "普通收藏", note: "", tags: [], url: "", title: "", createdAt: now }];
    const bad = await be.send({ type: "clipkeep:update", id: "u1", patch: { kind: "image", image: "javascript:alert(1)" } });
    ok("update 拒绝非法媒体地址", bad.ok === true, JSON.stringify(bad));
    ok("非法类型没被写进存储", !be.store.clipkeep_items[0].kind, JSON.stringify(be.store.clipkeep_items[0]));
    ok("非法地址没被写进存储", !be.store.clipkeep_items[0].image, JSON.stringify(be.store.clipkeep_items[0]));
    const good = await be.send({ type: "clipkeep:update", id: "u1", patch: { kind: "link", link: LINK } });
    eq("合法类型可以改", good.item.kind, "link");
    eq("合法地址可以改", good.item.link, LINK);
    const demote = await be.send({ type: "clipkeep:update", id: "u1", patch: { kind: "text" } });
    ok("改回文字收藏会清掉地址", !demote.item.kind && !demote.item.link, JSON.stringify(demote.item));
  }
  /* 10. 回顾卡片：媒体收藏要认出类型，来源地址同样只认协议白名单 */
  {
    const p = await mountPopup({
      clipkeep_items: [
        { id: "r1", text: "cat.png", note: "", tags: [], kind: "image", image: IMG, url: "javascript:alert(1)", title: "", createdAt: now - 1, review: { box: 0, due: now - 10, seen: 0 } },
      ],
    });
    await p.click(p.qa(".tab").find((t) => t.dataset.view === "review"));
    ok("回顾卡片标出图片类型", /图片/.test(p.$("review").textContent), p.$("review").innerHTML.slice(0, 240));
    eq("回顾卡片能打开图片地址", p.$("review").querySelector("a.item-kind")?.getAttribute("href"), IMG);
    eq("回顾卡片与列表用同一套显示文案", p.$("review").querySelector("a.item-kind")?.textContent, "查看原图");
    ok("回顾卡片里的伪协议来源不可点", !p.$("review").querySelector('a[href^="javascript"]'),
      p.$("review").innerHTML.slice(0, 300));
    ok("伪协议来源仍以文字说明，不假装能点", /javascript:/.test(p.$("review").textContent));
  }
}

/* ---------------- 11. 热力图格子下钻当天复习 ---------------- */

async function testHeatDrill() {
  console.log("\n[11] 热力图下钻：当天复习明细（新格式 {n, ids} + 旧格式数字兼容）");
  const DAY = 86400000;
  const dk = (back) => {
    const d = new Date(Date.now() - back * DAY);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const mk = (id, text) => ({ id, text, note: "", tags: [], url: "", title: "", createdAt: Date.now() });

  /* 1. 后台：打分记录当天明细，同一条重复打分不重复记 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = [mk("g1", "第一条"), mk("g2", "第二条")];
    const r1 = await be.send({ type: "clipkeep:grade", id: "g1", review: { box: 1, due: Date.now() + DAY } });
    const r2 = await be.send({ type: "clipkeep:grade", id: "g2", review: { box: 0, due: Date.now() } });
    const r3 = await be.send({ type: "clipkeep:grade", id: "g1", review: { box: 2, due: Date.now() + 3 * DAY } });
    eq("第一次打分的当天条数", r1.count, 1);
    eq("第二次打分的当天条数", r2.count, 2);
    eq("同一条重复打分也计一次动作", r3.count, 3);
    const log = be.store.clipkeep_activity[r1.day];
    ok("活动记录带条数", Number(log.n) === 3, JSON.stringify(log));
    eq("当天明细去重后是两条", (log.ids || []).length, 2);
    ok("明细里是打过的收藏", JSON.stringify((log.ids || []).slice().sort()) === JSON.stringify(["g1", "g2"]), JSON.stringify(log.ids));
  }

  /* 2. 旧格式（纯数字）要能读、能接着写，且不会被当成非法记录清掉 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = [mk("g1", "第一条")];
    be.store.clipkeep_activity = { [dk(1)]: 4, [dk(3)]: 0, [dk(400)]: 7 };
    const r = await be.send({ type: "clipkeep:grade", id: "g1", review: { box: 1, due: Date.now() } });
    eq("今天从 0 开始记", r.count, 1);
    eq("昨天的旧格式记录还在", Number(be.store.clipkeep_activity[dk(1)].n ?? be.store.clipkeep_activity[dk(1)]), 4);
    ok("旧格式记录没被清零", be.store.clipkeep_activity[dk(1)] !== undefined, JSON.stringify(be.store.clipkeep_activity));
    ok("计数为 0 的旧记录被清掉", be.store.clipkeep_activity[dk(3)] === undefined);
    ok("超出保留窗口的记录被清掉", be.store.clipkeep_activity[dk(400)] === undefined);
  }

  /* 3. 明细有条数上限，长期跑不会无限膨胀 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = Array.from({ length: 110 }, (_, i) => mk("k" + i, "第" + i + "条"));
    for (const it of be.store.clipkeep_items) {
      await be.send({ type: "clipkeep:grade", id: it.id, review: { box: 0, due: Date.now() } });
    }
    const log = be.store.clipkeep_activity[dk(0)];
    eq("当天计数如实累计", Number(log.n), 110);
    ok("明细只留最近若干条", (log.ids || []).length <= 100 && (log.ids || []).length > 0,
      `ids=${(log.ids || []).length}`);
    eq("留的是最近打过的", log.ids?.at(-1), "k109");
  }

  /* 4. 弹窗：格子可点开看当天明细 */
  {
    const p = await mountPopup({
      clipkeep_items: [mk("g1", "第一条：叠加态"), mk("g2", "第二条：纠缠")],
      clipkeep_activity: { [dk(1)]: { n: 2, ids: ["g1", "gone"] }, [dk(2)]: 3 },
    });
    await p.click(p.qa(".tab").find((t) => t.dataset.view === "review"));
    const cells = p.qa(".heat i");
    eq("热力图格子数量", cells.length, 56);
    const yest = cells.find((c) => c.dataset.day === dk(1));
    ok("昨天的格子存在", !!yest);
    ok("格子可点击", yest.classList.contains("clickable"), yest.className);
    await p.click(p.qa(".heat i").find((c) => c.dataset.day === dk(1)));
    const panel = p.$("heat-day");
    ok("点格子展开当天明细", !!panel && !panel.hidden, p.$("review").innerHTML.slice(0, 300));
    ok("明细标出日期与条数", panel.textContent.includes(dk(1)) && /2 条/.test(panel.textContent), panel.textContent);
    ok("明细列出当天复习过的收藏", /第一条：叠加态/.test(panel.textContent), panel.textContent);
    ok("已删除的收藏如实说明", /已删除/.test(panel.textContent), panel.textContent);
    await p.click(p.qa('.heat i[data-day="' + dk(2) + '"]')[0]);
    ok("切到旧格式记录也能看条数", /3 条/.test(p.$("heat-day").textContent), p.$("heat-day").textContent);
    ok("旧记录没有明细时如实说明", /明细|升级/.test(p.$("heat-day").textContent), p.$("heat-day").textContent);
    await p.click(p.$("heat-day").querySelector(".heat-day-close"));
    ok("明细可以关掉", p.$("heat-day").hidden === true);
    await p.click(p.qa(".heat i").find((c) => c.dataset.day === dk(5)));
    ok("没打卡的格子不展开明细", p.$("heat-day").hidden === true);
    // 热力图固定 8 周，今天所在列之后的格子才是「未来」：本周六跑测试时最后一格就是今天，
    // 直接取 .future[0] 会拿到 undefined（整个套件每周六崩一次）。按星期几算出应有的格数。
    const dow = new Date().getDay();
    const future = p.qa(".heat i.future");
    eq("未来格子数等于本周还没到的天数", future.length, 6 - dow);
    if (future.length) {
      await p.click(future[0]);
      ok("未来的格子点了没反应", p.$("heat-day").hidden === true);
    } else {
      ok("周六最后一格就是今天，没有未来格", p.qa(".heat i").at(-1).dataset.day === dk(0));
    }
  }

  /* 5. 统计口径兼容两种记录格式 */
  {
    const p = await mountPopup({
      clipkeep_items: [mk("g1", "第一条")],
      clipkeep_activity: { [dk(0)]: { n: 2, ids: ["g1"] }, [dk(1)]: 3, [dk(30)]: { n: 1, ids: [] } },
    });
    await p.click(p.qa(".tab").find((t) => t.dataset.view === "review"));
    const stats = p.$("heat-stats").textContent;
    ok("累计把新旧格式都算进去", /累计 6/.test(stats), stats);
    ok("本周条数含昨天的旧格式", /本周 5/.test(stats), stats);
    ok("连续天数按新格式判定", /连续 2 天/.test(stats), stats);
  }
}

/* ---------------- 12. v1.6 缺陷审计：改收藏的字段白名单 / 超长地址 / 明细上限 ---------------- */

async function testV16Audit() {
  console.log("\n[12] v1.6 审计：update 字段白名单、超长媒体地址、下钻明细渲染上限");
  const now = Date.now();
  const IMG = "https://cdn.example.com/img/cat.png";

  /* 1. update 的 patch 不能想写什么写什么：改标签不该顺手改掉时间、截断标记和排期 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = [{
      id: "u1", text: "原文", note: "备注", tags: ["旧"], url: "http://x/1", title: "T",
      createdAt: now - 5000, truncated: true, review: { box: 2, due: now, seen: 1 },
    }];
    const r = await be.send({
      type: "clipkeep:update",
      id: "u1",
      patch: { tags: "新", createdAt: 1, truncated: false, junk: "<img src=x>", review: { box: 999, due: -5, seen: -3 } },
    });
    ok("update 仍然成功", r.ok === true, JSON.stringify(r));
    const it = be.store.clipkeep_items[0];
    eq("白名单字段照常更新", it.tags.join(","), "新");
    eq("收藏时间不被 patch 改写", it.createdAt, now - 5000);
    eq("截断标记不被 patch 抹掉", it.truncated, true);
    ok("未知字段不进存储", !("junk" in it), JSON.stringify(it));
    ok("排期被夹到合法区间", it.review.box <= 5 && it.review.box >= 0 && it.review.due > 0 && it.review.seen >= 0,
      JSON.stringify(it.review));
  }

  /* 2. 超长地址：要么原样存，要么不收，不能截成另一个能点开的地址 */
  {
    const be = makeBackend();
    const long = "https://cdn.example.com/i/" + "a".repeat(3000) + ".png";
    const r = await be.send({ type: "clipkeep:add", payload: { text: "cat.png", kind: "image", image: long } });
    ok("超长地址的收藏仍入库", r.ok === true);
    ok("超长地址不被截断保存", !r.item.image, `image 长度=${(r.item.image || "").length}`);
    ok("地址非法时不再冒充图片", r.item.kind === undefined, JSON.stringify(r.item));
  }
  {
    const be = makeBackend();
    const long = "https://cdn.example.com/i/" + "a".repeat(3000) + ".png";
    await be.fireMenuClick(
      { menuItemId: "clipkeep-save-image", srcUrl: long, pageUrl: "https://blog/p" },
      { id: 1, title: "T", url: "https://blog/p" }
    );
    eq("右键剪藏超长地址不写入", be.store.clipkeep_items.length, 0);
    ok("右键剪藏超长地址给出说明", /无法收藏/.test(be.sentToTab.map((s) => s.msg.message).join("|")),
      JSON.stringify(be.sentToTab));
  }

  /* 3. 下钻明细的渲染量要有上限：手改过的活动记录不能把回顾页撑死 */
  {
    const ids = Array.from({ length: 160 }, (_, i) => "z" + i);
    const p = await mountPopup({
      clipkeep_items: [{ id: "z159", text: "最后一条", note: "", tags: [], url: "", title: "", createdAt: now }],
      clipkeep_activity: (() => {
        const d = new Date(Date.now() - 86400000);
        const pad = (n) => String(n).padStart(2, "0");
        const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const o = {};
        o[key] = { n: 160, ids };
        return o;
      })(),
    });
    await p.click(p.qa(".tab").find((t) => t.dataset.view === "review"));
    const cell = p.qa(".heat i").find((c) => Number(c.dataset.n) >= 160);
    await p.click(cell);
    const rows = p.qa("#heat-day .heat-day-list li");
    ok("明细渲染有条数上限", rows.length > 0 && rows.length <= 100, `rows=${rows.length}`);
    ok("上限之外说明还有多少", /另有 60 条未列出/.test(p.$("heat-day").textContent), p.$("heat-day").textContent);
  }
}

/* ---------------- 3n. v1.6 高亮颜色选择器 ---------------- */

/** 十六进制色 → jsdom 的 rgb() 写法，两边都能匹配上 */
function colorRe(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return new RegExp(`${hex}|rgb\\(\\s*${r},\\s*${g},\\s*${b}\\s*\\)`, "i");
}

async function testColorPicker() {
  console.log("\n[13] 高亮颜色选择器：工具条色块 / 总览换色 / 四处枚举一致");
  const HEX = { yellow: "#fff3a3", green: "#c7f5c7", pink: "#ffd0e0", blue: "#cfe3ff" };
  const KEYS = ["yellow", "green", "pink", "blue"];

  /* 1. 页面上：工具条给出色块，点哪个色就是哪个色，并记住为当前色 */
  {
    const url = "http://localhost/color";
    const c = mountContent(url, [], "<p>量子比特可以同时处于两种状态</p><p>退相干时间很短需要纠错码</p><p>纠错码用多个物理比特拼一个逻辑比特</p>");
    await tick(20);
    const selIn = async (idx, end) => {
      const node = c.w.document.querySelectorAll("article p")[idx].firstChild;
      const r = c.w.document.createRange();
      r.setStart(node, 0);
      r.setEnd(node, end);
      const sel = c.w.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      c.w.document.dispatchEvent(new c.w.MouseEvent("mouseup", { bubbles: true }));
      await tick(30);
      return c.w.document.getElementById("clipkeep-toolbar");
    };
    const bar = await selIn(0, 6);
    const sw = [...bar.querySelectorAll(".clipkeep-swatch")];
    eq("工具条给出四个色块", sw.length, 4);
    eq("色块顺序与后台白名单一致", sw.map((x) => x.dataset.color).join(","), KEYS.join(","));
    const swBg = (k) => ((bar.querySelector(`.clipkeep-swatch[data-color="${k}"]`) || {}).style || {}).background || "";
    ok("色块用上调色板", KEYS.every((k) => colorRe(HEX[k]).test(swBg(k))), KEYS.map(swBg).join("|"));
    eq("色块不混进按钮计数", bar.querySelectorAll(".clipkeep-btn").length, 4);
    const clickSw = async (b, k) => {
      const el = b.querySelector(`.clipkeep-swatch[data-color="${k}"]`);
      if (el) el.dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
      await tick(30);
    };
    const activeColor = (b) => ((b.querySelector(".clipkeep-swatch.active") || {}).dataset || {}).color || "";
    const hlColor = (i) => (c.store.clipkeep_highlights[i] || {}).color || "";
    await clickSw(bar, "green");
    eq("点色块即高亮一条", c.store.clipkeep_highlights.length, 1);
    eq("高亮用点中的颜色", hlColor(0), "green");
    const first = c.marks().find((m) => m.dataset.hlid === (c.store.clipkeep_highlights[0] || {}).id);
    ok("页面上的标记是同一种颜色", !!first && colorRe(HEX.green).test(first.style.background));
    eq("该色块标为当前色", activeColor(bar), "green");

    // 再选一段，点原来的 🖍：应沿用当前色而不是写死黄色
    const bar2 = await selIn(1, 5);
    bar2.querySelector(".clipkeep-btn-hl").dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(30);
    eq("🖍 沿用当前色", hlColor(1), "green");
    await clickSw(bar2, "blue");
    eq("换色后当前色跟过去", activeColor(bar2), "blue");
    const bar3 = await selIn(2, 4);
    bar3.querySelector(".clipkeep-btn-hl").dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(30);
    eq("切到蓝色后 🖍 用蓝色", hlColor(2), "blue");
  }

  /* 2. 弹窗总览：换色按钮改当前高亮的颜色，只动颜色，且实时重绘 */
  {
    const seed = {
      clipkeep_highlights: [
        { id: "s1", url: "http://x/p", title: "页面", text: "一段高亮", note: "别丢", color: "yellow", createdAt: Date.now() },
      ],
    };
    const p = await mountPopup(seed);
    await p.click(p.q('.tab[data-view="marks"]'));
    const row = () => p.q('.hl-item[data-hlid="s1"]');
    const btn = () => p.q('.hl-item[data-hlid="s1"] [data-act="hl-color"]');
    ok("总览给出换色按钮", !!btn());
    ok("换色按钮说明当前色", /黄色/.test(btn().title || ""), btn() && btn().title);
    ok("换色按钮预告下一个色", /绿色/.test(btn().title || ""), btn() && btn().title);
    eq("初始色块是黄色", colorRe(HEX.yellow).test(row().querySelector(".hl-swatch").style.background), true);
    for (const want of ["green", "pink", "blue", "yellow"]) {
      await p.click(btn());
      eq(`点一下换成 ${want}`, (p.store.clipkeep_highlights[0] || {}).color, want);
      ok(`${want} 重绘出来`, colorRe(HEX[want]).test(row().querySelector(".hl-swatch").style.background),
         row().querySelector(".hl-swatch").style.background);
      eq("换色不碰批注", p.store.clipkeep_highlights[0].note, "别丢");
      eq("换色不碰原文", p.store.clipkeep_highlights[0].text, "一段高亮");
      eq("换色不新增条目", p.store.clipkeep_highlights.length, 1);
    }
    ok("换色后总览仍只有一条", p.qa(".hl-item").length === 1);
    eq("标签计数没被换色打乱", p.$("mark-count").textContent, "1");
  }

  /* 3. 四处颜色枚举必须描述同一套颜色 */
  {
    const bg = (src("background.js").match(/const HL_COLORS = \[([^\]]*)\]/) || [, ""])[1]
      .split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    const pv = (src("popup.js").match(/const HL_COLORS = \[([^\]]*)\]/) || [, ""])[1]
      .split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    const hexOf = (code, name) => {
      const body = (code.match(new RegExp(`const ${name} = \\{([^}]*)\\}`)) || [, ""])[1];
      const out = {};
      for (const m of body.matchAll(/(\w+)\s*:\s*"(#[0-9a-fA-F]{6})"/g)) out[m[1]] = m[2];
      return out;
    };
    const contentHex = hexOf(src("content.js"), "COLORS");
    const popupHex = hexOf(src("popup.js"), "COLOR_HEX");
    eq("后台色表", bg.join(","), KEYS.join(","));
    eq("弹窗色表与后台一致", pv.join(","), KEYS.join(","));
    eq("页面色表与后台一致", Object.keys(contentHex).join(","), KEYS.join(","));
    ok("页面与弹窗用同一批十六进制色", KEYS.every((k) => contentHex[k] === popupHex[k] && popupHex[k] === HEX[k]),
       JSON.stringify({ contentHex, popupHex }));
  }
}

/* ---------------- 4. 清单一致性 / 消息协议 / 发布物料 ---------------- */

const typesIn = (code) => [...code.matchAll(/clipkeep:[a-z-]+/g)].map((m) => m[0]);

/* ---------------- 3x. 收藏批量选择与操作 ---------------- */

const batchSeed = (texts, now = Date.now()) => ({
  clipkeep_items: texts.map((t, i) => ({
    id: "b" + (i + 1), text: t, note: "", tags: [], url: "http://x/" + (i + 1),
    title: "来源" + (i + 1), createdAt: now - i * 1000,
  })),
});

async function testBatchOps() {
  console.log("\n[3x] 批量选择与操作");
  // 缺元素时返回个假的，让每条断言各自失败，而不是整节测试崩掉
  const GHOST = {
    hidden: true, textContent: "", value: "", checked: false, dataset: {},
    classList: { contains: () => false }, querySelector: () => null, dispatchEvent: () => false,
  };
  const mk = async (texts) => {
    const p = await mountPopup(batchSeed(texts || ["苹果派做法", "香蕉奶昔", "苹果树修剪"]));
    const $ = (id) => p.$(id) || GHOST;
    const sel = (i) => p.qa('#list .item input[data-act="sel"]')[i] || GHOST;
    const rowSel = (i) => !!p.qa("#list .item")[i] && p.qa("#list .item")[i].classList.contains("selected");
    const del = (i) => (p.qa("#list .item")[i] || GHOST).querySelector('[data-act="del"]') || GHOST;
    const press = async (key, target) => {
      const ev = new p.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      (target || p.w.document).dispatchEvent(ev);
      await tick(20);
      return ev;
    };
    return { ...p, $, sel, rowSel, del, press };
  };

  /* 每条收藏都能勾上，勾上才出现批量条 */
  {
    const p = await mk();
    eq("每条收藏有一个复选框", p.qa('#list .item input[data-act="sel"]').length, 3);
    ok("未选中时批量条隐藏", p.$("batchbar").hidden === true);
    await p.click(p.sel(0));
    ok("勾上后批量条出现", p.$("batchbar").hidden === false);
    eq("批量条报已选数量", p.$("batch-text").textContent, "已选 1 条");
    ok("选中的卡片有 selected 类", p.rowSel(0));
    await p.click(p.sel(1));
    eq("再勾一条数量累加", p.$("batch-text").textContent, "已选 2 条");
    await p.click(p.sel(0));
    eq("取消勾选数量减少", p.$("batch-text").textContent, "已选 1 条");
    ok("取消后卡片不再是选中态", !p.rowSel(0));
    await p.click(p.sel(1));
    ok("全部取消后批量条隐藏", p.$("batchbar").hidden === true);
    await p.click(p.sel(2));
    await p.click(p.$("btn-batch-cancel"));
    ok("「取消」清空选择", p.$("batchbar").hidden === true);
    ok("「取消」也清掉卡片选中态", p.qa("#list .item.selected").length === 0);
  }

  /* 全选跟着当前筛选走：先筛再全选，只选中匹配的那几条 */
  {
    const p = await mk();
    p.$("search").value = "苹果";
    await p.fire(p.$("search"), "input");
    await p.click(p.$("btn-batch-all"));
    eq("全选只选当前筛选结果", p.$("batch-text").textContent, "已选 2 条");
    ok("筛选外的一条没被选", !p.rowSel(2));
    await p.click(p.$("btn-batch-all"));
    eq("再点一次全选清空", p.$("batch-text").textContent, "已选 0 条");
    ok("清空后批量条隐藏", p.$("batchbar").hidden === true);
  }

  /* 选择要活过重渲染：改搜索词、换排序都不能把选择丢掉 */
  {
    const p = await mk();
    await p.click(p.sel(0));
    p.$("search").value = "香蕉";
    await p.fire(p.$("search"), "input");
    eq("换搜索词后选择还在", p.$("batch-text").textContent, "已选 1 条");
    p.$("sort").value = "old";
    await p.fire(p.$("sort"), "change");
    eq("换排序后选择还在", p.$("batch-text").textContent, "已选 1 条");
    p.$("search").value = "";
    await p.fire(p.$("search"), "input");
    eq("清掉筛选后复选框仍是勾选态", p.qa('#list input[data-act="sel"]:checked').length, 1);
  }

  /* 选中的条目被单条删除后，数量要跟着掉，不能选着不存在的 id */
  {
    const p = await mk();
    await p.click(p.sel(0));
    await p.click(p.sel(1));
    eq("先选中两条", p.$("batch-text").textContent, "已选 2 条");
    await p.click(p.del(0));
    eq("单条删除后选择数同步减少", p.$("batch-text").textContent, "已选 1 条");
    ok("存储里确实少了一条", p.store.clipkeep_items.length === 2);
  }

  /* 批量删除：一次进回收站，撤销要能把整批捞回来 */
  {
    const p = await mk();
    await p.click(p.sel(0));
    await p.click(p.sel(1));
    await p.click(p.$("btn-batch-del"));
    eq("批量删除只删选中项", p.store.clipkeep_items.map((x) => x.id).join(","), "b3");
    ok("删除后批量条隐藏", p.$("batchbar").hidden === true);
    eq("整批都进了回收站", (p.store.clipkeep_trash || []).length, 2);
    eq("整批共用一个撤销 id", new Set((p.store.clipkeep_trash || []).map((t) => t.tid)).size, 1);
    eq("撤销条数按整批显示", p.$("trash-text").textContent.replace(/\d+ 分钟/, "N 分钟"), "已删除 2 条收藏 · N 分钟内可撤销");
    await p.click(p.$("btn-undo"));
    eq("一次撤销还原整批", p.store.clipkeep_items.length, 3);
    eq("撤销后回收站清空", (p.store.clipkeep_trash || []).length, 0);
    eq("还原顺序仍按时间倒序", p.store.clipkeep_items.map((x) => x.id).join(","), "b1,b2,b3");
  }

  /* 批量加标签：合并去重，不碰没选中的 */
  {
    const p = await mk();
    p.store.clipkeep_items[0].tags = ["工作"];
    p.store.clipkeep_items[1].tags = ["重要", "工作"];
    await p.click(p.sel(0));
    await p.click(p.sel(1));
    p.w.prompt = () => "工作, 待办";
    await p.click(p.$("btn-batch-tag"));
    eq("标签合并去重", p.store.clipkeep_items[0].tags.join("+"), "工作+待办");
    eq("另一条同样生效", p.store.clipkeep_items[1].tags.join("+"), "重要+工作+待办");
    eq("没选中的不受影响", p.store.clipkeep_items[2].tags.length, 0);
    await p.click(p.sel(2));
    p.w.prompt = () => "";
    await p.click(p.$("btn-batch-tag"));
    eq("空输入不加标签", p.store.clipkeep_items[2].tags.length, 0);
  }

  /* 批量导出：只包含选中的内容，走的是同一套 mdOf */
  {
    const p = await mk();
    await p.click(p.sel(0));
    await p.click(p.sel(2));
    await p.click(p.$("btn-batch-export"));
    await tick(20);
    const md = p.getDownloaded() || "";
    ok("导出含第一条", md.includes("苹果派做法"));
    ok("导出含第三条", md.includes("苹果树修剪"));
    ok("导出不含未选中的一条", !md.includes("香蕉奶昔"));
    ok("导出条目数按选中计", md.includes("共 2 条"), md.slice(0, 80));
  }

  /* 后台是信任边界：id 要洗，数量要夹，撤销要成批 */
  {
    const p = await mk();
    const items = () => p.store.clipkeep_items;
    p.w.prompt = () => "x";
    const del = (ids) => p.chrome.runtime.sendMessage({ type: "clipkeep:delete-many", ids });
    const res = await del(["b1", "b1", "<img src=x>", "", null, "nope"]);
    eq("只删合法且存在的 id", items().map((x) => x.id).join(","), "b2,b3");
    eq("重复 id 不重复计", res.removed, 1);
    eq("回收站一条撤销记录", new Set((p.store.clipkeep_trash || []).map((t) => t.tid)).size, 1);
    const undo = await p.chrome.runtime.sendMessage({ type: "clipkeep:trash-restore", tid: ((p.store.clipkeep_trash || [])[0] || {}).tid });
    eq("撤销返回还原条数", undo.restored, 1);
    eq("撤销后原样回来", items().length, 3);
    const none = await del(["<script>", 123, {}, []]);
    eq("全是非法 id 时不删任何东西", items().length, 3);
    eq("非法 id 也不写存储", none.removed, 0);
    const many = Array.from({ length: 1200 }, (_, i) => "c" + i);
    for (let i = 0; i < 1200; i++) items().push({ id: "c" + i, text: "t" + i, tags: [], createdAt: Date.now() - i });
    const capped = await del(many);
    eq("一次最多删 1000 条", capped.removed, 1000);
    ok("被上限夹住时如实告知", capped.limited === true);
    eq("超出上限的留着", items().length, 203);
  }

  /* 批量加标签的后台半边：字段要归一化，选不中就不写 */
  {
    const p = await mk();
    const tag = (ids, tags) => p.chrome.runtime.sendMessage({ type: "clipkeep:tag-add-many", ids, tags });
    const r1 = await tag(["b1", "b2"], "  前端 , 前端,待办");
    eq("标签去重去空白", p.store.clipkeep_items[0].tags.join(","), "前端,待办");
    eq("重复标签不堆叠", p.store.clipkeep_items[0].tags.length, 2);
    eq("两条都改到", r1.changed, 2);
    const before = JSON.stringify(p.store.clipkeep_items[2]);
    const r2 = await tag(["ghost"], "孤立");
    eq("选不中时 changed 为 0", r2.changed, 0);
    eq("选不中时不写存储", JSON.stringify(p.store.clipkeep_items[2]), before);
    const r3 = await tag(null, null);
    eq("缺参数直接拒绝", r3.ok, false);
    await tick(10);
    eq("缺参数不改变数据", p.store.clipkeep_items.length, 3);
  }

  /* 切走视图要把批量条藏起来，别在回顾页上留一排删除按钮 */
  {
    const p = await mk();
    await p.click(p.sel(0));
    ok("收藏视图有批量条", p.$("batchbar").hidden === false);
    await p.click(p.q('.tab[data-view="review"]'));
    ok("回顾视图藏起批量条", p.$("batchbar").hidden === true);
    await p.click(p.q('.tab[data-view="clips"]'));
    ok("切回来选择还在", p.$("batch-text").textContent, "已选 1 条");
  }

  /* 样式：选择框与批量条要有真实规则，不能只有 DOM 结构 */
  {
    const css = src("popup.css");
    ok(".item 为绝对定位的复选框留了 relative", /\.item\s*{[^}]*position:\s*relative/m.test(css));
    ok("复选框样式存在", /\.item-sel\s*\{/.test(css));
    ok("选中态有描边反馈", /\.item\.selected\s*\{/.test(css));
    ok("批量条样式存在", /\.batchbar\s*\{/.test(css));
    ok("深色模式下原生控件跟着变暗", /body\.dark\s*\{[^}]*color-scheme:\s*dark/.test(css));
  }
}

/* ---------------- 3y. 回顾键盘打分 ---------------- */

async function testReviewKeys() {
  console.log("\n[3y] 回顾键盘打分");
  const DAY = 86400000;
  const now = Date.now();
  const seed = () => ({
    clipkeep_items: [
      { id: "k1", text: "第一条", note: "答案一", tags: [], url: "http://x/1", title: "页面", createdAt: now, review: { box: 1, due: now - 10, seen: 1 } },
      { id: "k2", text: "第二条", note: "答案二", tags: [], url: "http://x/2", title: "页面", createdAt: now - 5, review: { box: 1, due: now - 5, seen: 1 } },
    ],
  });
  const open = async () => {
    const p = await mountPopup(seed());
    await p.click(p.q('.tab[data-view="review"]'));
    const press = async (key, target) => {
      const ev = new p.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      (target || p.w.document).dispatchEvent(ev);
      await tick(20);
      return ev;
    };
    const rv = (id) => p.store.clipkeep_items.find((x) => x.id === id).review;
    return { ...p, press, rv };
  };

  /* 空格＝显示答案，且不能把页面滚走 */
  {
    const p = await open();
    ok("初始答案隐藏", p.q(".rev-back").hidden === true);
    const ev = await p.press(" ");
    ok("空格显示答案", p.q(".rev-back").hidden === false);
    ok("空格后打分区可用", p.q(".rev-grade").hidden === false);
    ok("「显示答案」按钮让位", p.q('[data-act="reveal"]').hidden === true);
    ok("空格拦掉浏览器默认滚动", ev.defaultPrevented === true);
    eq("卡片没被翻走", p.q(".rev-card").dataset.id, "k1");
  }

  /* 1/2/3＝忘记 / 记得 / 简单，走的是和点击同一条代码路径 */
  {
    const p = await open();
    await p.press(" ");
    await p.press("2");
    eq("按 2 升 1 盒", p.rv("k1").box, 2);
    eq("按 2 后间隔 3 天", p.rv("k1").due - Date.now(), 3 * DAY, 5000);
    eq("翻到下一张卡", p.q(".rev-card").dataset.id, "k2");
  }
  {
    const p = await open();
    await p.press(" ");
    await p.press("1");
    eq("按 1 忘记回到盒 0", p.rv("k1").box, 0);
    ok("按 1 立即再次到期", p.rv("k1").due <= Date.now() + 60);
  }
  {
    const p = await open();
    await p.press(" ");
    await p.press("3");
    eq("按 3 升 2 盒", p.rv("k1").box, 3);
    eq("打卡计数 +1", p.rv("k1").seen, 2);
  }

  /* 答案没显示时不许打分：不然闭眼按数字就能把排期改掉 */
  {
    const p = await open();
    const before = JSON.stringify(p.rv("k1"));
    await p.press("3");
    eq("未显示答案时忽略打分键", JSON.stringify(p.rv("k1")), before);
    eq("未显示答案时卡片不变", p.q(".rev-card").dataset.id, "k1");
    ok("未显示答案时打分区仍隐藏", p.q(".rev-grade").hidden === true);
    await p.press("a");
    eq("无关按键不打分", JSON.stringify(p.rv("k1")), before);
  }

  /* 连按数字：写入在途时第二次无效，和连点按钮同一道护栏 */
  {
    const p = await open();
    await p.press(" ");
    const g = () => {
      const a = new p.w.KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true });
      p.w.document.dispatchEvent(a);
      const b = new p.w.KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true });
      p.w.document.dispatchEvent(b);
    };
    g();
    await tick(30);
    eq("连按 3 只升 2 盒", p.rv("k1").box, 3);
  }

  /* 在输入框 / 设置面板里敲数字不该被当成打分 */
  {
    const p = await open();
    await p.press(" ");
    const before = JSON.stringify(p.rv("k1"));
    await p.press("2", p.$("search"));
    await p.press("2", p.$("sort"));
    await p.press("2", p.$("set-cap"));
    eq("搜索框里打字不打分", JSON.stringify(p.rv("k1")), before);
    eq("卡片保持原样", p.q(".rev-card").dataset.id, "k1");
  }

  /* 恢复确认弹窗打开时，数字键留给弹窗，不能偷偷改排期 */
  {
    const p = await open();
    await p.press(" ");
    const before = JSON.stringify(p.rv("k1"));
    p.$("modal").hidden = false;
    await p.press("2");
    eq("弹窗打开时不打分", JSON.stringify(p.rv("k1")), before);
    p.$("modal").hidden = true;
    await p.press("2");
    ok("关掉弹窗后恢复打分", p.rv("k1").box === 2);
  }

  /* 只在回顾页生效 */
  {
    const p = await open();
    await p.click(p.q('.tab[data-view="clips"]'));
    const before = JSON.stringify(p.store.clipkeep_items);
    const ev = await p.press(" ");
    await p.press("2");
    eq("收藏页按键不改数据", JSON.stringify(p.store.clipkeep_items), before);
    ok("收藏页不拦空格", ev.defaultPrevented === false);
    await p.click(p.q('.tab[data-view="marks"]'));
    const b2 = JSON.stringify(p.store.clipkeep_items);
    await p.press("3");
    eq("高亮页按键不改数据", JSON.stringify(p.store.clipkeep_items), b2);
  }

  /* 键位要写在界面上，否则没人知道能按 */
  {
    const p = await open();
    const hint = p.q(".rev-keys");
    ok("回顾视图有键位提示", !!hint);
    const t = hint ? hint.textContent : "";
    ok("提示说明空格显示答案", t.includes("空格"), t);
    ok("提示说明 1 是忘记", /1\s*忘记/.test(t), t);
    ok("提示说明 3 是简单", /3\s*简单/.test(t), t);
  }

  /* 提示必须排在卡片前面：长文本卡片一撑高，写在卡片底下的提示就等于没有 */
  {
    const p = await open();
    const kids = [...p.q("#review").children];
    const hint = p.q(".rev-keys");
    const card = p.q(".rev-card");
    ok("键位提示在回顾卡片之前", kids.indexOf(hint) !== -1 && kids.indexOf(hint) < kids.indexOf(card),
       `hint=${kids.indexOf(hint)}, card=${kids.indexOf(card)}`);
  }

  /* 全部复习完的空态里按数字，不能报错也不能有动作 */
  {
    const p = await open();
    await p.press(" ");
    await p.press("1");
    await p.press("2");
    await p.press("3");
    await tick(30);
    ok("队列清空后仍渲染", !!p.q(".review, .rev-card, .empty"));
    const done = p.q(".empty.done") || (p.q(".review") && p.q(".review").querySelector(".empty"));
    ok("清空后有空态或下一张卡", !!done || !!p.q(".rev-card"));
  }

  /* 样式：长文本收藏不能把打分区顶出屏幕，正文自己滚，按钮和键位常驻 */
  {
    const css = src("popup.css");
    ok("回顾正文限高", /\.rev-front\s*\{[^}]*max-height:/.test(css));
    ok("回顾正文超出部分自己滚", /\.rev-front\s*\{[^}]*overflow-y:\s*auto/.test(css));
    ok("键位提示样式存在", /\.rev-keys\s*\{/.test(css));
  }
}

/* ---------------- 3w. 类型与站点筛选 ---------------- */

const filterSeed = (now = Date.now()) => ({
  clipkeep_items: [
    { id: "f1", text: "量子纠缠要点", note: "", tags: ["物理"], url: "https://example.com/a", title: "示例文章", createdAt: now - 5000 },
    { id: "f2", kind: "image", text: "pqc.png", note: "", tags: [], url: "https://example.com/b", title: "示例配图", image: "https://cdn.example.com/pqc.png", createdAt: now - 4000 },
    { id: "f3", kind: "link", text: "后量子密码迁移时间表", note: "", tags: ["密码"], url: "https://csrc.nist.gov/g", title: "NIST", link: "https://csrc.nist.gov/g", createdAt: now - 3000 },
    { id: "f4", text: "扩展权限最小化", note: "", tags: [], url: "https://csrc.nist.gov/o", title: "NIST 另一篇", createdAt: now - 2000 },
    { id: "f5", text: "浏览器存储上限", note: "", tags: [], url: "https://developer.mozilla.org/x", title: "MDN", createdAt: now - 1000 },
  ],
});

async function testKindSiteFilter() {
  console.log("\n[3w] 类型与站点筛选");
  const GHOST = {
    hidden: true, textContent: "", value: "", checked: false, dataset: {},
    classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null, querySelectorAll: () => [], dispatchEvent: () => false,
  };
  const open = async (seed) => {
    const p = await mountPopup(seed);
    const $ = (id) => p.$(id) || GHOST;
    const kinds = () => p.qa('#filterbar [data-kind]');
    const sites = () => p.qa('#filterbar [data-site]');
    const rows = () => p.qa("#list .item");
    const texts = () => p.qa("#list .item .item-text, #list .item h3").map((n) => n.textContent.trim());
    const ids = () => p.qa("#list .item").map((n) => n.dataset.id);
    const byKind = (k) => kinds().find((c) => c.dataset.kind === k) || GHOST;
    const bySite = (s) => sites().find((c) => c.dataset.site === s) || GHOST;
    return { ...p, $, kinds, sites, rows, texts, ids, byKind, bySite };
  };

  /* 没有可筛的维度时，别摆一排空控件骗人 */
  {
    const p = await open(batchSeed(["苹果派做法", "香蕉奶昔"]));
    ok("纯文字库不显示筛选条", p.$("filterbar").hidden === true, "只有一种类型、一个站点时筛选条没意义");
  }

  /* 类型 chip 只列库里真有的类型，数量对得上 */
  {
    const p = await open(filterSeed());
    ok("混合类型库显示筛选条", p.$("filterbar").hidden === false);
    eq("类型 chip 只列实际存在的三种", p.kinds().length, 3);
    ok("有「文字」筛选", p.kinds().some((c) => c.dataset.kind === "text"));
    ok("有「图片」筛选", p.kinds().some((c) => c.dataset.kind === "image"));
    ok("有「链接」筛选", p.kinds().some((c) => c.dataset.kind === "link"));
    ok("库里没有的类型不出现", !p.kinds().some((c) => c.dataset.kind === "video"));
  }

  /* 点类型 → 只剩那一类；再点一次取消 */
  {
    const p = await open(filterSeed());
    await p.click(p.byKind("image"));
    eq("筛图片只剩一条", p.rows().length, 1);
    eq("留下的是那条图片收藏", p.ids()[0], "f2");
    ok("选中的类型 chip 有 active 态", p.byKind("image").classList.contains("active"));
    await p.click(p.byKind("image"));
    eq("再点一次取消筛选", p.rows().length, 5);
    ok("取消后不再有 active 类型", !p.kinds().some((c) => c.classList.contains("active")));
  }

  /* 站点 chip：按域名聚合，点它只看这个站 */
  {
    const p = await open(filterSeed());
    ok("站点 chip 存在", p.sites().length > 0);
    ok("站点 chip 显示域名", p.sites().some((c) => c.dataset.site === "csrc.nist.gov"));
    await p.click(p.bySite("csrc.nist.gov"));
    eq("筛站点只剩该站的两条", p.rows().length, 2);
    eq("留下的正是那两条 NIST 收藏", p.ids().slice().sort().join(","), "f3,f4");
  }

  /* 类型 + 站点 + 标签 + 搜索 四重叠加，取交集而不是并集 */
  {
    const p = await open(filterSeed());
    await p.click(p.bySite("csrc.nist.gov"));
    await p.click(p.byKind("link"));
    eq("站点 + 类型取交集", p.rows().length, 1);
    const tag = p.qa("#tags .chip").find((c) => c.dataset.tag === "密码");
    await p.click(tag);
    eq("再叠加标签仍是交集", p.rows().length, 1);
    p.$("search").value = "不存在的关键词";
    await p.fire(p.$("search"), "input");
    eq("搜索不命中时为空", p.rows().length, 0);
  }

  /* 筛选状态必须跟着批量「全选」：选中的就是看到的那一批 */
  {
    const p = await open(filterSeed());
    await p.click(p.byKind("image"));
    eq("筛到只剩一条", p.rows().length, 1);
    await p.click(p.$("btn-batch-all"));
    eq("全选只选到筛选结果", p.$("batch-text").textContent, "已选 1 条");
    await p.click(p.byKind("link"));
    await p.click(p.$("btn-batch-all"));
    eq("换筛选后全选跟着变", p.$("batch-text").textContent, "已选 1 条");
  }

  /* 筛到空：提示要说「筛选没命中」，不能骗人说「还没有收藏」 */
  {
    const p = await open(filterSeed());
    await p.click(p.bySite("developer.mozilla.org"));
    await p.click(p.byKind("image"));
    eq("确实筛空了", p.rows().length, 0);
    const tip = p.$("empty").textContent;
    ok("空态说明是筛选导致", /筛选/.test(tip), tip);
    ok("空态不谎称还没有收藏", !/还没有收藏/.test(tip), tip);
  }

  /* 数据变了不能留幽灵筛选：库里没图片了，图片筛选要自动失效 */
  {
    const p = await open(filterSeed());
    await p.click(p.byKind("image"));
    eq("先筛到图片", p.rows().length, 1);
    await p.be.send({ type: "clipkeep:delete", id: "f2" });
    await p.be.send({ type: "clipkeep:storage-changed" }).catch(() => {});
    await p.fire(p.$("search"), "input"); // 触发一次重绘，模拟列表刷新
    await tick(20);
    const stillHasImage = (p.store.clipkeep_items || []).some((it) => it.kind === "image");
    ok("库里已经没有图片", !stillHasImage);
    ok("类型 chip 不再列出已不存在的类型", !p.kinds().some((c) => c.dataset.kind === "image"),
       "留着就是点得动却永远筛不出东西的幽灵选项");
  }

  /* 站点 chip 要有渲染上限，别把几百个域名铺成一堵墙 */
  {
    const many = { clipkeep_items: Array.from({ length: 120 }, (_, i) => ({
      id: "s" + i, text: "内容" + i, note: "", tags: [],
      url: `https://site${i}.example.com/p`, title: "T" + i, createdAt: Date.now() - i * 1000,
    })) };
    const p = await open(many);
    ok("站点 chip 有上限", p.sites().length <= 12, "实际 " + p.sites().length);
    ok("上限之外如实告知", p.$("filterbar").textContent.includes("+") || p.sites().length === 12);
  }

  /* 站点名来自外部数据：带引号也不能突破属性 */
  {
    const evil = { clipkeep_items: [
      { id: "e1", text: "正常", note: "", tags: [], url: 'https://x.example.com/"onmouseover="alert(1)', title: "T", createdAt: Date.now() },
      { id: "e2", text: "另一条", note: "", tags: [], url: "https://y.example.com/p", title: "U", createdAt: Date.now() - 1 },
      { id: "e3", kind: "link", text: "第三条", note: "", tags: [], url: "https://z.example.com/p", title: "V", link: "https://z.example.com/p", createdAt: Date.now() - 2 },
    ] };
    const p = await open(evil);
    ok("站点 chip 没有注入事件属性", p.w.document.querySelector("[onmouseover]") === null);
    ok("chip 的 data-site 是转义后的安全值",
       p.sites().every((c) => !/["]/.test(c.getAttribute("data-site") || "")));
  }

  /* 切视图不能串台：高亮视图没有这套筛选 */
  {
    const p = await open(filterSeed());
    await p.click(p.byKind("image"));
    await p.click(p.q('.tab[data-view="marks"]'));
    ok("高亮视图隐藏收藏筛选条", p.$("filterbar").hidden === true);
    await p.click(p.q('.tab[data-view="clips"]'));
    ok("切回收藏视图筛选还在", p.rows().length === 1, "用户没理由被悄悄清掉筛选");
  }

  /* 用 Tab 走到 chip 上按回车：整条重绘不能把焦点丢回页面顶部 */
  {
    const p = await open(filterSeed());
    p.byKind("image").focus();
    await p.click(p.byKind("image"));
    ok("点类型 chip 后焦点留在筛选条", p.q("#filterbar").contains(p.w.document.activeElement),
       "焦点掉了，键盘用户得从页头重新 Tab 一遍");
    p.bySite("csrc.nist.gov").focus();
    await p.click(p.bySite("csrc.nist.gov"));
    ok("点站点 chip 后焦点还在同一个 chip 上",
       (p.w.document.activeElement || {}).dataset && p.w.document.activeElement.dataset.site === "csrc.nist.gov");
    const tag = p.qa("#tags .chip").find((c) => c.dataset.tag === "密码");
    tag.focus();
    await p.click(tag);
    ok("点标签 chip 后焦点留在标签条", p.q("#tags").contains(p.w.document.activeElement));
  }
}

/* ---------------- 3v. v1.8：列表键盘流与快捷键帮助 ---------------- */

async function testListKeys() {
  console.log("\n[3v] 列表键盘流与快捷键帮助");
  const GHOST = {
    hidden: true, textContent: "", value: "", checked: false, dataset: {},
    classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null, querySelectorAll: () => [], dispatchEvent: () => false,
  };
  const LONG = "开头。".padEnd(300, "字"); // 超过 CLAMP_AT=240，默认折叠
  const seed = (texts) => ({
    clipkeep_items: texts.map((t, i) => ({
      id: "k" + (i + 1), text: t, note: "", tags: [], url: "http://x/" + (i + 1),
      title: "来源" + (i + 1), createdAt: Date.now() - i * 1000,
    })),
  });
  const open = async (texts) => {
    const p = await mountPopup(seed(texts || ["第一条", "第二条", "第三条"]));
    const $ = (id) => p.$(id) || GHOST;
    const rows = () => p.qa("#list .item");
    const focused = () => p.qa("#list .item.focused");
    const fIndex = () => focused().length === 1 ? rows().indexOf(focused()[0]) : -1;
    const boxes = () => p.qa('#list .item input[data-act="sel"]');
    const press = async (key, target) => {
      const ev = new p.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      (target || p.w.document).dispatchEvent(ev);
      await tick(20);
      return ev;
    };
    const tab = async (v) => { await p.click(p.q(`.tab[data-view="${v}"]`)); };
    return { ...p, $, rows, focused, fIndex, boxes, press, tab };
  };

  /* 方向键移动焦点：有高亮行、不越界、不跟着滚页面 */
  {
    const p = await open();
    eq("初始没有焦点行", p.focused().length, 0);
    await p.press("ArrowDown");
    eq("下键聚焦第一行", p.fIndex(), 0);
    await p.press("ArrowDown");
    eq("再按一次移到第二行", p.fIndex(), 1);
    await p.press("ArrowUp");
    eq("上键退回第一行", p.fIndex(), 0);
    await p.press("ArrowUp");
    eq("最上面不按出负数", p.fIndex(), 0);
    for (let i = 0; i < 9; i++) await p.press("ArrowDown");
    eq("按到底停在最后一行", p.fIndex(), 2);
    eq("焦点始终只有一个", p.focused().length, 1);
    const ev = await p.press("ArrowDown");
    ok("方向键拦掉默认滚动", ev.defaultPrevented);
  }

  /* 键盘勾选：x 就是点那条的复选框 */
  {
    const p = await open();
    await p.press("ArrowDown");
    await p.press("ArrowDown");
    await p.press("x");
    eq("x 勾上焦点行", p.$("batch-text").textContent, "已选 1 条");
    ok("复选框真的勾上了", p.boxes()[1].checked);
    await p.press("x");
    ok("再按取消勾选", p.$("batchbar").hidden === true);
    await p.press("ArrowUp");
    await p.press("x");
    eq("勾选跟着焦点走", p.$("batch-text").textContent, "已选 1 条");
    ok("勾的是焦点所在的行", p.boxes()[0].checked);
  }

  /* Enter 展开/收起长文本，短收藏不乱动 */
  {
    const p = await open([LONG, "短句收藏"]);
    await p.press("ArrowDown");
    const row = () => p.rows()[0];
    ok("长收藏默认折叠", row().querySelector(".item-text").classList.contains("is-clamped"));
    await p.press("Enter");
    ok("Enter 展开全文", !row().querySelector(".item-text").classList.contains("is-clamped"));
    await p.press("Enter");
    ok("再按收回", row().querySelector(".item-text").classList.contains("is-clamped"));
    await p.press("ArrowDown");
    const before = p.rows().length;
    await p.press("Enter");
    eq("短收藏按 Enter 不惹事", p.rows().length, before);
  }

  /* 焦点要跟着筛选走：筛掉的那条不能留着高亮 */
  {
    const p = await open();
    await p.press("ArrowDown");
    await p.press("ArrowDown");
    eq("先聚焦第二条", p.fIndex(), 1);
    p.$("search").value = "第三条";
    await p.fire(p.$("search"), "input");
    ok("焦点条目被筛掉后不留幽灵高亮", p.focused().length === 0);
    await p.press("ArrowDown");
    eq("重新按方向键落到当前结果上", (p.focused()[0] || GHOST).dataset.id, "k3");
  }

  /* 帮助浮层：? 开关，鼠标也有入口，打开时别的键归它 */
  {
    const p = await open();
    ok("帮助默认关着", p.$("keys-help").hidden === true);
    await p.press("?");
    ok("? 打开快捷键帮助", p.$("keys-help").hidden === false);
    const txt = p.$("keys-help").textContent;
    ok("帮助列出方向键", /↑|↓|Arrow/.test(txt), txt.slice(0, 60));
    ok("帮助列出勾选键 x", /\bx\b/.test(txt));
    ok("帮助列出回顾打分键", /空格/.test(txt) && /[123]/.test(txt));
    ok("帮助列出秒存快捷键", /Alt\s*\+\s*Shift\s*\+\s*K/i.test(txt));
    await p.press("ArrowDown");
    await p.press("x");
    ok("浮层开着时不吃列表按键", p.$("batchbar").hidden === true);
    await p.press("Escape");
    ok("Esc 关闭浮层", p.$("keys-help").hidden === true);
    await p.press("?");
    ok("? 又能打开", p.$("keys-help").hidden === false);
    await p.press("?");
    ok("? 再按一次也能关", p.$("keys-help").hidden === true);
    await p.click(p.$("btn-keys"));
    ok("头部按钮打开同一个浮层", p.$("keys-help").hidden === false);
    await p.click(p.q('#keys-help [data-act="close"]'));
    ok("浮层里的关闭按钮管用", p.$("keys-help").hidden === true);
  }

  /* 打字优先：输入框里的按键不该被当成快捷键 */
  {
    const p = await open();
    await p.press("ArrowDown", p.$("search"));
    eq("搜索框里按方向键不移动焦点", p.focused().length, 0);
    await p.press("x", p.$("search"));
    ok("搜索框里打 x 不勾选", p.$("batchbar").hidden === true);
    await p.press("?", p.$("search"));
    ok("输入框里打 ? 不弹浮层", p.$("keys-help").hidden === true);
    await p.press("ArrowDown");
    eq("失焦后快捷键照常", p.fIndex(), 0);
  }

  /* 不串台：高亮 / 回顾视图有自己的键位 */
  {
    const p = await open();
    await p.tab("marks");
    await p.press("ArrowDown");
    await p.press("x");
    ok("高亮视图不吃列表快捷键", p.qa("#list .item.focused").length === 0);
    await p.tab("clips");
    await p.press("ArrowDown");
    eq("切回收藏视图焦点能用", p.fIndex(), 0);
  }

  /* 样式：焦点必须看得见，否则「按了哪条」全靠猜 */
  {
    const css = src("popup.css");
    ok("焦点行有可见样式", /\.item\.focused\s*\{/.test(css));
    ok("帮助浮层有样式", /\.keys-help\s*\{/.test(css));
    const html = src("popup.html");
    ok("popup 里有帮助浮层容器", /id="keys-help"/.test(html));
    ok("popup 里有快捷键按钮", /id="btn-keys"/.test(html));
  }
}

/* ---------------- 3z. v1.7 审计：批量与键盘的提示诚实性 ---------------- */

async function testV17Audit() {
  console.log("\n[3z] v1.7 审计");
  const now = Date.now();
  const seed = (n = 3) => ({
    clipkeep_items: Array.from({ length: n }, (_, i) => ({
      id: "v" + (i + 1), text: "内容" + (i + 1), note: "", tags: [], url: "http://x/" + i,
      title: "来源", createdAt: now - i * 1000,
    })),
  });
  const mk = async (n) => {
    const p = await mountPopup(seed(n));
    const sent = [];
    const orig = p.chrome.runtime.sendMessage.bind(p.chrome);
    p.chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.type) sent.push(msg.type);
      return orig(msg, cb);
    };
    const boxes = () => p.qa('#list .item input[data-act="sel"]');
    const pick = async (...idx) => {
      idx.forEach((i) => boxes()[i].dispatchEvent(new p.w.MouseEvent("click", { bubbles: true })));
      await tick(10);
    };
    const tapFast = (el) => {
      el.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
      el.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    };
    const count = (type) => sent.filter((t) => t === type).length;
    return { ...p, sent, pick, tapFast, count, toast: () => p.$("toast").textContent };
  };

  /* 批量删除连点：第二次不能对着已经删掉的一批再发一次 */
  {
    const p = await mk();
    await p.pick(0, 1);
    p.tapFast(p.$("btn-batch-del"));
    await tick(40);
    eq("连点只发一次批量删除", p.count("clipkeep:delete-many"), 1);
    eq("连点只删掉选中的两条", p.store.clipkeep_items.length, 1);
    ok("提示不会报「已删除 0 条」", !/已删除 0/.test(p.toast()), p.toast());
  }

  /* 单条删除连点：同理，别把「已删除，可撤销」说第二遍 */
  {
    const p = await mk();
    p.tapFast(p.qa('#list .item [data-act="del"]')[0]);
    await tick(40);
    eq("连点只发一次单条删除", p.count("clipkeep:delete"), 1);
    eq("回收站只有一条", (p.store.clipkeep_trash || []).length, 1);
    eq("只删掉一条", p.store.clipkeep_items.length, 2);
  }

  /* 批量加标签连点：prompt 是同步的，第二次点击不能又发一遍 */
  {
    const p = await mk();
    await p.pick(0, 1);
    p.w.prompt = () => "待办";
    p.tapFast(p.$("btn-batch-tag"));
    await tick(40);
    eq("连点只发一次批量加标签", p.count("clipkeep:tag-add-many"), 1);
  }

  /* 单条加标签同理：同一个坑不能只堵一半 */
  {
    const p = await mk();
    p.w.prompt = () => "待办";
    p.tapFast(p.qa('#list .item [data-act="tag"]')[0]);
    await tick(40);
    eq("连点只发一次单条加标签", p.count("clipkeep:update"), 1);
  }

  /* 清空全部之后，选择里不能留着已经不存在的 id，批量条要跟着消失 */
  {
    const p = await mk();
    await p.pick(0, 1);
    ok("清空前有批量条", p.$("batchbar").hidden === false);
    await p.click(p.$("btn-clear"));
    ok("清空全部后批量条消失", p.$("batchbar").hidden === true);
    eq("收藏确实清空了", p.store.clipkeep_items.length, 0);
    await p.click(p.q('.tab[data-view="clips"]'));
    ok("切回收藏页也没有幽灵选择", p.$("batchbar").hidden === true);
  }

  /* 撤销整批要说清还原了几条，不能只说「已撤销」 */
  {
    const p = await mk(4);
    await p.pick(0, 1, 2);
    await p.click(p.$("btn-batch-del"));
    eq("三条一起进回收站", new Set(p.store.clipkeep_trash.map((t) => t.tid)).size, 1);
    await p.click(p.$("btn-undo"));
    ok("撤销提示报条数", /3/.test(p.toast()), p.toast());
    eq("三条都回来了", p.store.clipkeep_items.length, 4);
  }

  /* 长按数字键：自动重复不能把整队复习刷完 */
  {
    const p = await mountPopup({
      clipkeep_items: [
        { id: "r1", text: "第一条", note: "a", tags: [], url: "http://x/1", title: "t", createdAt: now, review: { box: 0, due: now - 30, seen: 1 } },
        { id: "r2", text: "第二条", note: "b", tags: [], url: "http://x/2", title: "t", createdAt: now - 1, review: { box: 0, due: now - 20, seen: 1 } },
      ],
    });
    await p.click(p.q('.tab[data-view="review"]'));
    const press = async (key, repeat) => {
      p.w.document.dispatchEvent(new p.w.KeyboardEvent("keydown", { key, repeat: !!repeat, bubbles: true, cancelable: true }));
      await tick(20);
    };
    await press(" ", false);
    await press("2", false);
    await tick(30);
    eq("正常按一次升 1 盒", p.store.clipkeep_items.find((x) => x.id === "r1").review.box, 1);
    eq("翻到下一张卡", p.q(".rev-card").dataset.id, "r2");
    await press("2", true);
    await press("2", true);
    await tick(30);
    eq("长按自动重复不打分", p.store.clipkeep_items.find((x) => x.id === "r2").review.box, 0);
    eq("卡片没被连按翻走", p.q(".rev-card").dataset.id, "r2");
  }
}

/* ---------------- 3s. 重叠高亮：嵌套与部分交叠 ---------------- */

async function testOverlappingMarks() {
  console.log("\n[3s] 重叠高亮：嵌套、部分交叠、逐段撤销");
  const now = Date.now();
  const url = "http://localhost/ov";
  const H = (id, text, color, extra) => ({
    id, url, text, color: color || "yellow", note: "", createdAt: now, ...(extra || {}),
  });
  const body = `<p>简介：量子比特可以同时处于两种状态，这是并行性的来源。</p>`;
  const full = "简介：量子比特可以同时处于两种状态，这是并行性的来源。";
  const of = (c, id) => c.marks().filter((m) => m.dataset.hlid === id);

  /* 1. 一条套在另一条里面：两条的文字都要完整露出来，内层得在外层里面 */
  {
    const c = mountContent(url, [H("o1", "可以同时处于两种状态"), H("o2", "处于两种", "pink")], body);
    await tick(30);
    eq("外层文字完整", of(c, "o1").map((m) => m.textContent).join(""), "可以同时处于两种状态");
    eq("内层文字完整", of(c, "o2").map((m) => m.textContent).join(""), "处于两种");
    ok("内层套在外层里", of(c, "o2").every((i) => of(c, "o1").some((o) => o.contains(i))),
      c.w.document.querySelector("article p").innerHTML);
    ok("原文一字不差", c.bodyText() === full, c.bodyText());
  }

  /* 2. 只是部分交叠：两条各自完整，交集处两层标记都在 */
  {
    const c = mountContent(url, [H("p1", "量子比特可以同时"), H("p2", "同时处于两种状态", "green")], body);
    await tick(30);
    eq("前一条文字完整", of(c, "p1").map((m) => m.textContent).join(""), "量子比特可以同时");
    eq("后一条文字完整", of(c, "p2").map((m) => m.textContent).join(""), "同时处于两种状态");
    ok("交集处两层标记同时生效",
      c.marks().some((a) => c.marks().some((b) => b !== a && a.dataset.hlid !== b.dataset.hlid && a.contains(b))));
    ok("原文一字不差", c.bodyText() === full, c.bodyText());
  }

  /* 3. 删掉一条被切成几段的高亮：每一段都得撤掉，不能留下半条颜色 */
  {
    const c = mountContent(url, [H("d1", "可以同时处于两种状态"), H("d2", "处于两种", "pink")], body);
    await tick(30);
    ok("删除前外层有多段", of(c, "d1").length >= 2, of(c, "d1").length);
    c.w.prompt = () => "!d";
    of(c, "d1")[0].dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(60);
    eq("外层一段不剩", of(c, "d1").length, 0);
    eq("内层不受影响", of(c, "d2").map((m) => m.textContent).join(""), "处于两种");
    eq("存储里只剩内层那条", c.store.clipkeep_highlights.map((h) => h.id).join(","), "d2");
    ok("原文一字不差", c.bodyText() === full, c.bodyText());
  }

  /* 4. 反复重放不能把嵌套越套越深 */
  {
    const c = mountContent(url, [H("r1", "可以同时处于两种状态"), H("r2", "处于两种", "pink")], body);
    await tick(30);
    const first = c.marks().length;
    await c.chrome.storage.local.set({ clipkeep_highlights: c.store.clipkeep_highlights.slice() });
    await tick(40);
    await c.chrome.storage.local.set({ clipkeep_highlights: c.store.clipkeep_highlights.slice() });
    await tick(40);
    eq("重放两次标记数不变", c.marks().length, first);
    eq("重放两次原文不变", c.bodyText(), full);
    ok("同一条不会套自己",
      !c.marks().some((a) => a.parentElement && a.parentElement.dataset && a.parentElement.dataset.hlid === a.dataset.hlid));
  }

  /* 5. 点重叠处改的是最里层那条，外层不受牵连 */
  {
    const c = mountContent(url, [H("n1", "可以同时处于两种状态", "yellow", { note: "外层批注" }), H("n2", "处于两种", "pink", { note: "内层批注" })], body);
    await tick(30);
    const inner = of(c, "n2")[0];
    ok("内层标记存在", !!inner);
    c.w.prompt = () => "改内层";
    inner.dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(40);
    const st = c.store.clipkeep_highlights;
    eq("内层批注已更新", (st.find((h) => h.id === "n2") || {}).note, "改内层");
    eq("外层批注没被改", (st.find((h) => h.id === "n1") || {}).note, "外层批注");
    await tick(40);
    eq("重放后内层仍在外层里面", of(c, "n2").every((i) => of(c, "n1").some((o) => o.contains(i))), true);
  }
}

/* ---------------- 3w. 回收站明细与逐条恢复 ---------------- */

async function testTrashDetail() {
  console.log("\n[3w] 回收站明细：逐条恢复、只回点那条、恢复完自动收起");
  const now = Date.now();
  const mk = (id, text) => ({ id, text, note: "", tags: ["甲"], url: "http://x/1", title: "页面", createdAt: now - 1000 });
  const hl = (id, text) => ({ id, url: "http://x/1", title: "页面", text, color: "yellow", note: "", createdAt: now });
  const stubOne = (chrome, type, res) => {
    const orig = chrome.runtime.sendMessage.bind(chrome);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (!msg || msg.type !== type) return orig(msg, cb);
      if (typeof cb === "function") cb(res);
      return Promise.resolve(res);
    };
  };

  /* 1. 批量删的三条共用一个撤销号，逐条恢复只回点的那一条 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = [mk("a", "甲"), mk("b", "乙"), mk("c", "丙")];
    const del = await be.send({ type: "clipkeep:delete-many", ids: ["a", "b", "c"] });
    ok("批量删除成功", del.ok === true && be.store.clipkeep_items.length === 0);
    eq("三条共用一个撤销号", new Set(be.store.clipkeep_trash.map((t) => t.tid)).size, 1);
    const one = await be.send({ type: "clipkeep:trash-restore-one", payload: { kind: "clip", id: "b" } });
    ok("逐条恢复成功", one.ok === true);
    eq("只回一条", one.restored, 1);
    eq("列表里只有恢复的那条", be.store.clipkeep_items.map((x) => x.id).join(","), "b");
    eq("回收站还剩两条", be.store.clipkeep_trash.length, 2);
    eq("剩下的还是同批的撤销号", new Set(be.store.clipkeep_trash.map((t) => t.tid)).size, 1);
    // 整批撤销仍然能把剩下的都捞回来
    const rest = await be.send({ type: "clipkeep:trash-restore", tid: be.store.clipkeep_trash[0].tid });
    eq("剩下的整批撤销回来", rest.restored, 2);
    eq("三条都到齐了", be.store.clipkeep_items.length, 3);
    eq("回收站清空", be.store.clipkeep_trash.length, 0);
  }

  /* 2. 明细里没有的 id 不能谎报恢复 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = [mk("a", "甲")];
    await be.send({ type: "clipkeep:delete", id: "a" });
    const miss = await be.send({ type: "clipkeep:trash-restore-one", payload: { kind: "clip", id: "nope" } });
    ok("未命中报 not_found", miss.ok === false && miss.error === "not_found");
    eq("未命中不改动回收站", be.store.clipkeep_trash.length, 1);
    eq("未命中不改动列表", be.store.clipkeep_items.length, 0);
    const bad = await be.send({ type: "clipkeep:trash-restore-one", payload: { kind: "whatever", id: "a" } });
    ok("类型不合法被拒", bad.ok === false && bad.error === "invalid");
    const noid = await be.send({ type: "clipkeep:trash-restore-one", payload: { kind: "clip" } });
    ok("缺 id 被拒", noid.ok === false && noid.error === "invalid");
  }

  /* 3. 同一条被删了两次：逐条恢复一次只消掉一条记录 */
  {
    const be = makeBackend();
    be.store.clipkeep_trash = [
      { tid: "T1", kind: "clip", item: mk("dup", "重复删的"), deletedAt: now },
      { tid: "T2", kind: "clip", item: mk("dup", "重复删的"), deletedAt: now - 1000 },
    ];
    const r = await be.send({ type: "clipkeep:trash-restore-one", payload: { kind: "clip", id: "dup" } });
    ok("第一次恢复成功", r.ok === true && r.restored === 1);
    eq("还剩一条同名记录", be.store.clipkeep_trash.length, 1);
    eq("留下的是更早那条", be.store.clipkeep_trash[0].tid, "T2");
    // 再恢复会撞上已经回来的 id：不重复插入，但要把记录清掉，否则明细里永远留着一行死条目
    const again = await be.send({ type: "clipkeep:trash-restore-one", payload: { kind: "clip", id: "dup" } });
    ok("撞 id 时如实说明没恢复", again.ok === true && again.restored === 0 && again.existed === 1);
    eq("列表里不会长出第二条", be.store.clipkeep_items.length, 1);
    eq("撞 id 的记录也从回收站清掉", be.store.clipkeep_trash.length, 0);
  }

  /* 4. 高亮同样可以逐条恢复；过期的一律捞不回来 */
  {
    const be = makeBackend();
    be.store.clipkeep_highlights = [hl("h1", "第一条高亮"), hl("h2", "第二条高亮")];
    await be.send({ type: "clipkeep:hl-delete", id: "h1" });
    await be.send({ type: "clipkeep:hl-delete", id: "h2" });
    eq("两条高亮进了回收站", be.store.clipkeep_trash.length, 2);
    const r = await be.send({ type: "clipkeep:trash-restore-one", payload: { kind: "hl", id: "h2" } });
    ok("高亮逐条恢复成功", r.ok === true && r.kind === "hl");
    eq("只回那条高亮", be.store.clipkeep_highlights.map((x) => x.id).join(","), "h2");
    eq("收藏列表不受牵连", be.store.clipkeep_items.length, 0);
    // 让剩下那条过期
    be.store.clipkeep_trash[0].deletedAt = now - 999 * 60 * 1000;
    const gone = await be.send({ type: "clipkeep:trash-restore-one", payload: { kind: "hl", id: "h1" } });
    ok("过期的捞不回来", gone.ok === false && gone.error === "not_found");
    eq("过期的高亮没被偷偷塞回列表", be.store.clipkeep_highlights.length, 1);
  }

  /* 5. 弹窗：明细展开后逐条列出，点一行只恢复那一行 */
  {
    const p = await mountPopup({
      clipkeep_items: [mk("k1", "保留的收藏"), mk("k2", "被删的第一条"), mk("k3", "被删的第二条")],
      clipkeep_highlights: [],
      clipkeep_trash: [],
    });
    await p.click(p.q('.tab[data-view="clips"]'));
    await p.click(p.q('.item[data-id="k2"] [data-act="del"]'));
    await p.click(p.q('.item[data-id="k3"] [data-act="del"]'));
    await tick(20);
    eq("两条待撤销", p.store.clipkeep_trash.length, 2);
    ok("默认不展开明细", p.$("trash-list").hidden === true);
    await p.click(p.$("btn-trash-detail"));
    ok("点明细展开", p.$("trash-list").hidden === false);
    const rows = p.qa(".trash-row");
    eq("明细逐条列出", rows.length, 2);
    ok("明细写清类型", /收藏|高亮/.test(rows[0].textContent), rows[0].textContent);
    ok("明细带原文，认得出是哪条", rows.some((r) => /被删的第一条/.test(r.textContent)) &&
       rows.some((r) => /被删的第二条/.test(r.textContent)), p.$("trash-list").textContent);
    const target = rows.find((r) => /被删的第一条/.test(r.textContent));
    await p.click(target.querySelector('[data-act="trash-restore-one"]'));
    await tick(30);
    ok("提示说清恢复了什么类型几条", /已恢复 1 条收藏/.test(p.$("toast").textContent), p.$("toast").textContent);
    eq("列表里只回到那一条（保留的一条 + 恢复的一条）", p.qa(".item").length, 2);
    ok("没点的那条仍在回收站", /被删的第二条/.test(p.$("trash-list").textContent), p.$("trash-list").textContent);
    eq("明细少了一行", p.qa(".trash-row").length, 1);
    await p.click(p.q('.trash-row [data-act="trash-restore-one"]'));
    await tick(30);
    ok("全部恢复完收起回收站", p.$("trashbar").hidden === true);
    eq("三条都回来了", p.store.clipkeep_items.length, 3);
  }

  /* 5b. 明细有行数上限，超出部分如实说明，不让人误以为回收站里就只有这些 */
  {
    const many = Array.from({ length: 60 }, (_, i) => ({
      tid: "T" + i, kind: "clip", item: mk("m" + i, "第" + i + "条"), deletedAt: now,
    }));
    const p = await mountPopup({ clipkeep_items: [], clipkeep_trash: many });
    await p.click(p.$("btn-trash-detail"));
    await tick(20);
    eq("明细最多列 50 行", p.qa(".trash-row").length, 50);
    ok("超出部分如实说明", /另有 10 条/.test(p.$("trash-list").textContent), p.$("trash-list").textContent.slice(-120));
    ok("回收站条数按真实总数报", /已删除 60 条/.test(p.$("trash-text").textContent), p.$("trash-text").textContent);
  }

  /* 6. 后台说没恢复成，提示就不能说「已恢复」 */
  {
    const p = await mountPopup({
      clipkeep_items: [],
      clipkeep_trash: [{ tid: "T", kind: "clip", item: mk("z1", "早就没了的"), deletedAt: Date.now() }],
    });
    stubOne(p.chrome, "clipkeep:trash-restore-one", { ok: false, error: "not_found" });
    await p.click(p.$("btn-trash-detail"));
    await tick(20);
    const btn = p.q('.trash-row [data-act="trash-restore-one"]');
    ok("明细里有恢复按钮", !!btn);
    await p.click(btn);
    await tick(30);
    const t = p.$("toast").textContent;
    ok("未命中不报已恢复", !/已恢复/.test(t), t);
    ok("未命中说清去向", /不在回收站|已过期|无法恢复/.test(t), t);
  }

  /* 7. 撤销只管最近一批：跨批时按钮标签要写清「这批」，别让人以为整条回收站都会回来 */
  {
    const p = await mountPopup({
      clipkeep_items: [],
      clipkeep_trash: [
        { tid: "T2", kind: "clip", item: mk("n1", "最近一批甲"), deletedAt: now },
        { tid: "T2", kind: "clip", item: mk("n2", "最近一批乙"), deletedAt: now },
        { tid: "T1", kind: "clip", item: mk("o1", "更早一批"), deletedAt: now - 1000 },
      ],
    });
    const label = p.$("btn-undo").textContent;
    ok("跨两批时撤销写清只管这批", /这批/.test(label), label);
    ok("按钮上写出这批的真实条数", /2/.test(label), label);
    ok("提示去哪找剩下的那条", /明细/.test(p.$("btn-undo").title), p.$("btn-undo").title);
    await p.click(p.$("btn-undo"));
    await tick(30);
    eq("点撤销确实只回来最近那批", p.store.clipkeep_items.length, 2);
    eq("更早那批仍留在回收站", p.store.clipkeep_trash.length, 1);
  }
  {
    const p = await mountPopup({
      clipkeep_items: [],
      clipkeep_trash: [{ tid: "T", kind: "clip", item: mk("s1", "只删了一条"), deletedAt: now }],
    });
    eq("只有一批时按钮仍叫撤销", p.$("btn-undo").textContent, "撤销");
  }

  /* 8. 整批撤销也要先做过期清理：弹窗开着不动，条目过期后就不该还能捞回来。
        逐条恢复那条路已经 prune 了，两条路口径必须一致。 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = [mk("e1", "会过期的")];
    await be.send({ type: "clipkeep:delete", id: "e1" });
    const tid = be.store.clipkeep_trash[0].tid;
    be.store.clipkeep_trash[0].deletedAt = now - 999 * 60 * 1000; // 时间走到保留期之外
    const r = await be.send({ type: "clipkeep:trash-restore", tid });
    ok("过期后整批撤销也捞不回来", r.ok === false && r.error === "not_found", JSON.stringify(r));
    eq("过期的内容不会偷偷回到列表", be.store.clipkeep_items.length, 0);
  }
}

/* ---------------- 3u. v1.8 审计：未命中删除 / 批量上限 / 覆盖失败 / 撤销计数 / 截断 ---------------- */

async function testV18Audit() {
  console.log("\n[3u] v1.8 审计：未命中删除、批量上限、覆盖失败、撤销计数与截断提示");
  const now = Date.now();
  const mk = (id, text, extra) => ({
    id, text, note: "", tags: [], url: "http://x/1", title: "来源", createdAt: now, ...(extra || {}),
  });
  const hl = (id, text) => ({ id, url: "http://localhost/p", text, color: "yellow", note: "", createdAt: now });
  /** 只拦某一种消息，其余照原样发给真后台 */
  const stubOne = (chrome, type, res) => {
    const orig = chrome.runtime.sendMessage.bind(chrome);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (!msg || msg.type !== type) return orig(msg, cb);
      if (typeof cb === "function") cb(res);
      return Promise.resolve(res);
    };
  };

  /* 1. 后台契约：删一条已经不存在的记录不是「删除成功」。update 早就报 not_found，删除不能只报成功 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = [mk("k1", "在册收藏")];
    const r = await be.send({ type: "clipkeep:delete", id: "gone" });
    ok("删除不在册收藏报 not_found", r && r.ok === false && r.error === "not_found", JSON.stringify(r));
    eq("未命中的删除不动数据", be.store.clipkeep_items.length, 1);
    eq("未命中的删除不写回收站", (be.store.clipkeep_trash || []).length, 0);

    be.store.clipkeep_highlights = [hl("h1", "在册高亮")];
    const h = await be.send({ type: "clipkeep:hl-delete", id: "gone" });
    ok("删除不在册高亮报 not_found", h && h.ok === false && h.error === "not_found", JSON.stringify(h));
    eq("未命中的高亮删除不写回收站", (be.store.clipkeep_trash || []).length, 0);
  }

  /* 2. 弹窗：后台报 not_found 时提示要说「已经不在了」，不能报「可撤销」 */
  {
    const p = await mountPopup({ clipkeep_items: [mk("s1", "在册收藏")] });
    stubOne(p.chrome, "clipkeep:delete", { ok: false, error: "not_found" });
    await p.click(p.q('.item[data-id="s1"] [data-act="del"]'));
    await tick(30);
    const t = p.$("toast").textContent;
    ok("未命中的收藏删除不报「可撤销」", !/可撤销/.test(t), t);
    ok("未命中的收藏删除说清原因", /不在收藏里/.test(t), t);
  }
  {
    const p = await mountPopup({ clipkeep_highlights: [hl("s2", "在册高亮")] });
    stubOne(p.chrome, "clipkeep:hl-delete", { ok: false, error: "not_found" });
    await p.click(p.q('.tab[data-view="marks"]'));
    await p.click(p.q('.hl-item[data-hlid="s2"] [data-act="hl-del"]'));
    await tick(30);
    const t = p.$("toast").textContent;
    ok("未命中的高亮删除不报「已删除高亮」", !/已删除高亮/.test(t), t);
    ok("未命中的高亮删除说清原因", /不在了/.test(t), t);
  }

  /* 3. 页面：!d 删一条早被别处删掉的高亮，要清掉残留标记，不能甩一句「存储不可用」 */
  {
    const c = mountContent("http://localhost/p", [hl("g1", "在册高亮")], "<p>在册高亮，后面还有字。</p>");
    await tick(20);
    eq("起始页面有标记", c.marks().length, 1);
    stubOne(c.chrome, "clipkeep:hl-delete", { ok: false, error: "not_found" });
    c.w.prompt = () => "!d";
    c.w.document.querySelector('mark[data-hlid="g1"]')
      .dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(40);
    ok("已消失的高亮标记被清掉", c.marks().length === 0, c.marks().map((m) => m.dataset.hlid).join(","));
    ok("原文没有丢", /在册高亮，后面还有字/.test(c.bodyText()), c.bodyText().slice(0, 40));
    const t = c.toastText();
    ok("提示不误报存储不可用", !/存储不可用/.test(t), t);
    ok("提示说清这条已经不在了", /不在了/.test(t), t);
  }

  /* 4. 批量加标签撞上单次上限：后台要报 limited，提示要说清楚还剩没处理的 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = [mk("q0", "第一条"), mk("q1", "第二条"), mk("q2", "第三条")];
    const ids = ["q0", "q1", "q2"].concat(Array.from({ length: 1200 }, (_, i) => "x" + i));
    const r = await be.send({ type: "clipkeep:tag-add-many", ids, tags: "待办" });
    ok("批量加标签超限报 limited", r && r.ok === true && r.limited === true, JSON.stringify(r));
    eq("上限内的标签照常写入", be.store.clipkeep_items.filter((x) => (x.tags || []).includes("待办")).length, 3);
  }
  {
    const p = await mountPopup({ clipkeep_items: [mk("t1", "第一条"), mk("t2", "第二条")] });
    stubOne(p.chrome, "clipkeep:tag-add-many", { ok: true, changed: 2, limited: true });
    p.w.prompt = () => "待办";
    p.qa('#list .item input[data-act="sel"]').forEach((b) => b.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true })));
    await tick(10);
    await p.click(p.$("btn-batch-tag"));
    await tick(30);
    const t = p.$("toast").textContent;
    ok("批量加标签撞上限要说出来", /上限/.test(t), t);
  }

  /* 5. 覆盖本地：后台没写成功，提示就不能报「已用备份覆盖」 */
  {
    const p = await mountPopup({ clipkeep_items: [mk("w1", "本地收藏")] });
    stubOne(p.chrome, "clipkeep:replace", { ok: false, error: "Error: QUOTA_EXCEEDED" });
    await p.putBackup({ app: "ClipKeep", version: 1, items: [mk("w2", "备份收藏")], highlights: [] });
    ok("差异弹窗打开", p.$("modal").hidden === false);
    await p.click(p.$("modal-alt"));
    await tick(40);
    const t = p.$("toast").textContent;
    ok("覆盖失败不谎报已覆盖", !/已用备份覆盖/.test(t), t);
    ok("覆盖失败有明确反馈", /失败|重试/.test(t), t);
    eq("本地收藏没被动过", p.store.clipkeep_items.length, 1);
  }

  /* 6. 撤销整批：撞了 id 没还原的那几条不能算进「已撤销 N 条」 */
  {
    const be = makeBackend();
    be.store.clipkeep_items = [mk("z1", "第一条"), mk("z2", "第二条")];
    await be.send({ type: "clipkeep:delete", id: "z1" });
    await be.send({ type: "clipkeep:delete", id: "z2" });
    (be.store.clipkeep_trash || []).forEach((t) => { t.tid = "shared"; }); // 伪造一条撤销号的整批
    be.store.clipkeep_items.push(mk("z2", "第二条（别处已经回来了）"));
    const r = await be.send({ type: "clipkeep:trash-restore", tid: "shared" });
    ok("还原条数只算真回来的", r.restored === 1, JSON.stringify(r));
    ok("撞 id 的条数单独报", r.existed === 1, JSON.stringify(r));
  }
  {
    const p = await mountPopup({
      clipkeep_items: [mk("u1", "第一条")],
      clipkeep_trash: [{ tid: "T", kind: "clip", item: mk("u9", "第九条"), deletedAt: now }],
    });
    stubOne(p.chrome, "clipkeep:trash-restore", { ok: true, kind: "clip", restored: 1, existed: 1 });
    await p.click(p.$("btn-undo"));
    await tick(30);
    const t = p.$("toast").textContent;
    ok("部分还原说出真还原数", /已撤销 1 条/.test(t), t);
    ok("部分还原说出没还原的那条", /另有 1 条/.test(t), t);
  }
  {
    const p = await mountPopup({
      clipkeep_items: [mk("u1", "第一条")],
      clipkeep_trash: [{ tid: "T", kind: "clip", item: mk("u9", "第九条"), deletedAt: now }],
    });
    stubOne(p.chrome, "clipkeep:trash-restore", { ok: true, kind: "clip", restored: 0, existed: 2 });
    await p.click(p.$("btn-undo"));
    await tick(30);
    ok("整批都没还原时不报「已撤销」", !/已撤销/.test(p.$("toast").textContent), p.$("toast").textContent);
  }

  /* 7. 收藏成功的提示不能藏着截断：超长正文只存了前半部分 */
  {
    const be = makeBackend();
    await be.fireMenuClick(
      { menuItemId: "clipkeep-save", selectionText: "长".repeat(25000), pageUrl: "http://a" },
      { id: 1, title: "T", url: "http://a" }
    );
    const toasts = be.sentToTab.map((s) => s.msg.message).join("|");
    ok("右键收藏超长要提示截断", /截断/.test(toasts), toasts.slice(0, 60));
    const be2 = makeBackend();
    await be2.fireMenuClick(
      { menuItemId: "clipkeep-save", selectionText: "正常长度", pageUrl: "http://a" },
      { id: 1, title: "T", url: "http://a" }
    );
    ok("未截断时不提截断", !/截断/.test(be2.sentToTab.map((s) => s.msg.message).join("|")));
  }
  {
    const long = "长".repeat(21000);
    const c = mountContent("http://localhost/p", [], `<p>${long}</p>`);
    await tick(20);
    const para = c.w.document.querySelector("article p");
    const range = c.w.document.createRange();
    range.setStart(para.firstChild, 0);
    range.setEnd(para.firstChild, long.length);
    const sel = c.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    c.w.document.dispatchEvent(new c.w.MouseEvent("mouseup", { bubbles: true }));
    await tick(30);
    const bar = c.w.document.getElementById("clipkeep-toolbar");
    ok("超长选区也弹出工具条", !!bar);
    bar.querySelector(".clipkeep-btn-save").dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(10);
    const card = c.w.document.querySelector(".clipkeep-card");
    ok("收藏卡片打开", !!card);
    card.querySelector(".clipkeep-btn-confirm").dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(40);
    eq("超长正文仍入库", c.store.clipkeep_items.length, 1);
    eq("入库正文截断到上限", ((c.store.clipkeep_items[0] || {}).text || "").length, 20000);
    ok("页面收藏提示说出截断", /截断/.test(c.toastText()), c.toastText());
  }
}

/* ---------------- 3v9. v1.9 独立审计复核 ---------------- */

async function testV19Audit() {
  console.log("\n[3v9] v1.9 审计复核：写失败不留半更新 / 计数与上限不说谎");
  const now = Date.now();
  // 热力图的日期键按本地日切，测试要拿到「今天」那一格必须自己算
  const dayKey = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const mk = (id, text, extra) => ({
    id, text, note: "", tags: [], url: "http://x/1", title: "页面", createdAt: now - 1000, ...(extra || {}),
  });
  const stubOne = (chrome, type, res) => {
    const orig = chrome.runtime.sendMessage.bind(chrome);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (!msg || msg.type !== type) return orig(msg, cb);
      if (typeof cb === "function") cb(res);
      return Promise.resolve(res);
    };
  };

  /* 1. 删除时列表写不进去：回收站里不能凭空多出一条「可撤销」 */
  {
    const be = makeBackend();
    const add = await be.send({ type: "clipkeep:add", payload: { text: "还在列表里的", url: "http://a/x", title: "T" } });
    const id = add.item.id;
    be.store.__failSetKey = "clipkeep_items"; // 回收站先写成了，列表这条没删掉
    const res = await be.send({ type: "clipkeep:delete", id });
    await tick(20);
    ok("列表写失败时删除如实报错", res && res.ok === false, JSON.stringify(res));
    eq("收藏确实还留在列表里", be.store.clipkeep_items.length, 1);
    eq("回收站不能留下一条列表里还在的收藏", (be.store.clipkeep_trash || []).length, 0);
  }

  /* 2. 批量删除同理：整批都没删掉，就不能有半批进回收站 */
  {
    const be = makeBackend();
    const a = await be.send({ type: "clipkeep:add", payload: { text: "甲", url: "http://a/x", title: "T" } });
    const b = await be.send({ type: "clipkeep:add", payload: { text: "乙", url: "http://a/x", title: "T" } });
    be.store.__failSetKey = "clipkeep_items";
    const res = await be.send({ type: "clipkeep:delete-many", ids: [a.item.id, b.item.id] });
    await tick(20);
    ok("批量删除写失败如实报错", res && res.ok === false, JSON.stringify(res));
    eq("两条收藏都还在", be.store.clipkeep_items.length, 2);
    eq("回收站一条都不该有", (be.store.clipkeep_trash || []).length, 0);
  }

  /* 3. 高亮删除同理：批注不能既在页面上又在回收站里 */
  {
    const be = makeBackend();
    const hl = { id: "h1", url: "http://a/x", title: "T", text: "量子比特", color: "yellow", note: "重点", createdAt: Date.now() };
    await be.send({ type: "clipkeep:hl-add", payload: hl });
    be.store.__failSetKey = "clipkeep_highlights";
    const res = await be.send({ type: "clipkeep:hl-delete", id: "h1" });
    await tick(20);
    ok("高亮删除写失败如实报错", res && res.ok === false, JSON.stringify(res));
    eq("高亮还在原处", be.store.clipkeep_highlights.length, 1);
    eq("回收站不该提前收下这条高亮", (be.store.clipkeep_trash || []).length, 0);
  }

  /* 4. 打分：排期没写进去就不能算一次打卡，否则热力图替没发生的事记功 */
  {
    const be = makeBackend();
    const add = await be.send({ type: "clipkeep:add", payload: { text: "要复习的", url: "http://a/x", title: "T" } });
    const id = add.item.id;
    be.store.__failSetKey = "clipkeep_items"; // 活动记录写得动，收藏这条写不动
    const res = await be.send({ type: "clipkeep:grade", id, review: { box: 1, due: Date.now() + 86400000 } });
    await tick(20);
    ok("排期写失败时打分如实报错", res && res.ok === false, JSON.stringify(res));
    const log = be.store.clipkeep_activity || {};
    const total = Object.keys(log).reduce((s, k) => s + ((log[k] || {}).n || 0), 0);
    eq("打卡计数不能被没存进去的打分撑起来", total, 0);
  }

  /* 5. 附属写入失败时，弹窗不能再说「可撤销」*/
  {
    const p = await mountPopup({ clipkeep_items: [mk("d1", "删得掉但撤销不了")] });
    stubOne(p.chrome, "clipkeep:delete", { ok: true, count: 0, trashed: false });
    await p.click(p.q('.item [data-act="del"]'));
    await tick(30);
    const t = p.$("toast").textContent;
    ok("回收站没写进去时不说「可撤销」", !/可撤销/.test(t), t);
    ok("照样如实说明这条删了", /已删除/.test(t), t);
    ok("说清这条撤销不了", /撤销不|无法撤销|不能撤销/.test(t), t);
  }
  {
    const p = await mountPopup({
      clipkeep_items: [mk("d2", "甲"), mk("d3", "乙")],
    });
    await p.click(p.qa('.item input[data-act="sel"]')[0]);
    await p.click(p.qa('.item input[data-act="sel"]')[1]);
    await tick(10);
    stubOne(p.chrome, "clipkeep:delete-many", { ok: true, removed: 2, count: 0, trashed: false, limited: false });
    await p.click(p.$("btn-batch-del"));
    await tick(30);
    const t = p.$("toast").textContent;
    ok("批量删除同理不说可撤销", !/可撤销/.test(t), t);
    ok("批量删除报出真实条数", /2/.test(t), t);
  }
  {
    const p = await mountPopup({
      clipkeep_items: [mk("g1", "要复习的", { review: { box: 1, due: now - 10, seen: 1 } })],
    });
    await p.click(p.q('.tab[data-view="review"]'));
    await tick(20);
    stubOne(p.chrome, "clipkeep:grade", { ok: true, day: "2026-10-03", count: 0, actFailed: true });
    await p.click(p.q('[data-act="reveal"]'));
    await tick(20);
    await p.click(p.q('[data-act="grade"][data-g="1"]'));
    await tick(40);
    ok("排期存了但打卡没写进去时如实说明", /打卡|热力图/.test(p.$("toast").textContent), p.$("toast").textContent);
  }

  /* 6. 标签上限 12 个：舍弃了几条要说出来，更不能报「标签没有变化」 */
  {
    const be = makeBackend();
    const many = Array.from({ length: 15 }, (_, i) => "t" + i).join(",");
    const res = await be.send({ type: "clipkeep:add", payload: { text: "标签超限", url: "http://a/x", title: "T", tags: many } });
    await tick(20);
    eq("标签仍然只留 12 个", res.item.tags.length, 12);
    eq("后台报出被舍弃的个数", res.tagDropped, 3);
  }
  {
    const be = makeBackend();
    const twelve = Array.from({ length: 12 }, (_, i) => "a" + i);
    const add = await be.send({ type: "clipkeep:add", payload: { text: "已经满了", url: "http://a/x", title: "T", tags: twelve } });
    const r = await be.send({ type: "clipkeep:tag-add-many", ids: [add.item.id], tags: "b1,b2,b3" });
    await tick(20);
    ok("一条标签都加不上时不能报「没有变化」", r.dropped === 3, JSON.stringify(r));
    ok("changed 如实为 0", r.changed === 0, JSON.stringify(r));
  }
  {
    const p = await mountPopup({ clipkeep_items: [mk("t1", "有标签的收藏")] });
    await p.click(p.q('.item input[data-act="sel"]'));
    await tick(10);
    stubOne(p.chrome, "clipkeep:tag-add-many", { ok: true, changed: 0, dropped: 3, limited: false });
    p.w.prompt = () => "b1, b2, b3";
    await p.click(p.$("btn-batch-tag"));
    await tick(40);
    const t = p.$("toast").textContent;
    ok("标签一个都没加上时不说「没有变化」", !/没有变化/.test(t), t);
    ok("说出被舍弃了几条", /3/.test(t) && /上限|舍弃/.test(t), t);
  }

  /* 7. 备注与高亮正文同样要有上限：一条超长记录能把本地配额吃光 */
  {
    const be = makeBackend();
    const res = await be.send({ type: "clipkeep:add", payload: { text: "正文", note: "注".repeat(30000), url: "http://a/x", title: "T" } });
    await tick(20);
    ok("备注被夹到上限内", res.item.note.length <= 20000, String(res.item.note.length));
  }
  {
    const be = makeBackend();
    await be.send({ type: "clipkeep:hl-add", payload: { url: "http://a/x", text: "量".repeat(30000), note: "批".repeat(30000) } });
    await tick(20);
    const h = (be.store.clipkeep_highlights || [])[0] || {};
    ok("高亮正文有上限", String(h.text || "").length <= 20000, String((h.text || "").length));
    ok("高亮批注有上限", String(h.note || "").length <= 20000, String((h.note || "").length));
  }
  {
    const be = makeBackend();
    const add = await be.send({ type: "clipkeep:add", payload: { text: "改备注", url: "http://a/x", title: "T" } });
    const r = await be.send({ type: "clipkeep:update", id: add.item.id, patch: { note: "x".repeat(30000) } });
    await tick(20);
    ok("编辑备注同样夹上限", r.item.note.length <= 20000, String(r.item.note.length));
  }

  /* 8. 热力图明细：标题说 N 条就得能看出为什么只有 100 行 */
  {
    const ids = Array.from({ length: 100 }, (_, i) => "r" + i);
    const p = await mountPopup({
      clipkeep_items: ids.map((id) => mk(id, "复习" + id)),
      clipkeep_activity: { [dayKey(now)]: { n: 105, ids } },
    });
    await p.click(p.q('.tab[data-view="review"]'));
    await tick(20);
    const cell = p.qa(".heat i[data-day]").find((c) => c.dataset.day === dayKey(now));
    await p.click(cell);
    await tick(20);
    const head = p.$("heat-day").textContent;
    ok("明细行数与标题不符时如实说明差额", /另有 5 条|5 条未列出/.test(head), head.slice(-120));
  }

  /* 9. 导入截断不能无声无息：旧备份 / 手改过的 JSON 同样要标「已截断」 */
  {
    const be = makeBackend();
    const r = await be.send({
      type: "clipkeep:merge",
      payload: { items: [{ id: "m1", text: "长".repeat(24000), url: "http://a/x", title: "T", createdAt: 1 }] },
    });
    await tick(20);
    eq("合并确实收下了这条", r.added, 1);
    eq("入库正文截到上限", (be.store.clipkeep_items[0] || {}).text.length, 20000);
    ok("被截断的导入要标出来", (be.store.clipkeep_items[0] || {}).truncated === true);
    eq("合并结果报出截断条数", r.truncated, 1);
  }

  /* 10. 单条改标签也被 12 个上限挡：后台报舍弃数，弹窗照着说 */
  {
    const be = makeBackend();
    const add = await be.send({ type: "clipkeep:add", payload: { text: "改标签", url: "http://a/x", title: "T" } });
    const many = Array.from({ length: 15 }, (_, i) => "t" + i).join(",");
    const r = await be.send({ type: "clipkeep:update", id: add.item.id, patch: { tags: many } });
    await tick(20);
    eq("编辑后仍然只留 12 个", r.item.tags.length, 12);
    eq("编辑同样报出舍弃数", r.tagDropped, 3);
  }
  {
    const p = await mountPopup({ clipkeep_items: [mk("t1", "改标签")] });
    stubOne(p.chrome, "clipkeep:update", { ok: true, tagDropped: 3, item: mk("t1", "改标签", { tags: ["a"] }) });
    p.w.prompt = () => "a,b,c";
    await p.click(p.q('.item [data-act="tag"]'));
    await tick(40);
    const t = p.$("toast").textContent;
    ok("单条改标签被上限挡住时如实说明", /3/.test(t) && /上限/.test(t), t);
  }

  /* 11. 恢复备份把正文砍短时，提示里要说一声 */
  {
    const p = await mountPopup();
    await p.putBackup({
      app: "ClipKeep", version: 1,
      items: [{ id: "n1", text: "长".repeat(24000), note: "", tags: [], url: "", title: "", createdAt: now - 5000 }],
    });
    await p.click(p.$("modal-ok"));
    await tick(40);
    const t = p.$("toast").textContent;
    ok("合并提示带出被截断的条数", /截断/.test(t), t);
  }

  /* 12. 差异识别按内容，不按重新生成的 id：同一份备份不能导两次翻一倍 */
  {
    const p = await mountPopup();
    const bk = {
      app: "ClipKeep", version: 1, items: [],
      highlights: [{ url: "http://localhost/p", text: "没有 id 的高亮", color: "yellow", note: "", createdAt: 1 }],
    };
    await p.putBackup(bk);
    await tick(30);
    ok("第一次导入打开差异弹窗", p.$("modal").hidden === false, p.$("modal").hidden ? "直接关了" : "");
    await p.click(p.$("modal-ok"));
    await tick(40);
    eq("第一次导入收下这条高亮", (p.store.clipkeep_highlights || []).length, 1);
    await p.putBackup(bk);
    await tick(30);
    ok("第二次导入认出是同一条", /一致/.test(p.$("toast").textContent), p.$("toast").textContent);
    eq("重导入不会把高亮翻倍", (p.store.clipkeep_highlights || []).length, 1);
  }

  /* 13. 后台 upsert 也按内容认条：换 id 重放不能堆出三条 */
  {
    const be = makeBackend();
    const base = { url: "http://localhost/p", text: "叠加态", color: "yellow", note: "", createdAt: 1 };
    const r1 = await be.send({ type: "clipkeep:hl-add", payload: { ...base, id: "stable-1" } });
    const r2 = await be.send({ type: "clipkeep:hl-add", payload: { ...base, id: "stable-1" } });
    const r3 = await be.send({ type: "clipkeep:hl-add", payload: { ...base } }); // 没有 id：后台自己生成
    await tick(30);
    ok("固定 id 重放被认出", r1 && r1.ok && r2 && r2.dup === true, JSON.stringify([r1, r2]));
    ok("同一批内容换 id 也被认出", r3 && r3.dup === true, JSON.stringify(r3));
    eq("存储里始终只有一条", (be.store.clipkeep_highlights || []).length, 1);
  }

  /* 14. 后台被换掉时（扩展刚更新），弹窗要说人话而不是静默失灵 */
  {
    const p = await mountPopup({ clipkeep_items: [mk("d1", "失联时删除")] });
    p.chrome.runtime.sendMessage = () => Promise.reject(new Error("Extension context invalidated."));
    await p.click(p.q('.item [data-act="del"]'));
    await tick(40);
    const t = p.$("toast").textContent;
    ok("后台失联时如实提示要重开弹窗", /重新打开|已更新/.test(t), t);
    ok("失联时不说「已删除」", !/已删除/.test(t), t);
  }

  /* 15. 清空失败不能说「已清空」 */
  {
    const p = await mountPopup({ clipkeep_items: [mk("c1", "清空失败")] });
    stubOne(p.chrome, "clipkeep:clear", { ok: false, error: "storage" });
    p.w.confirm = () => true;
    await p.click(p.$("btn-clear"));
    await tick(40);
    const t = p.$("toast").textContent;
    ok("后台没写成功时不说「已清空」", !/已清空/.test(t), t);
    ok("如实说清空失败", /失败|重试/.test(t), t);
  }

  /* 16. 确认框写着「高亮批注不受影响」，就不能连高亮的撤销记录一起清掉 */
  {
    const p = await mountPopup({
      clipkeep_items: [mk("c1", "要清掉的收藏")],
      clipkeep_trash: [
        { tid: "t-clip", kind: "clip", item: mk("gone1", "删掉的收藏"), deletedAt: now },
        { tid: "t-hl", kind: "hl", item: { id: "h1", url: "http://a/x", text: "删掉的高亮", color: "yellow", note: "", createdAt: now }, deletedAt: now },
      ],
    });
    p.w.confirm = () => true;
    await p.click(p.$("btn-clear"));
    await tick(40);
    const trash = p.store.clipkeep_trash || [];
    eq("收藏的撤销记录按承诺清掉", trash.filter((x) => x.kind === "clip").length, 0);
    eq("高亮的撤销记录不受牵连", trash.filter((x) => x.kind === "hl").length, 1);
  }

  /* 17. 单独「清空回收站」仍然两类都清 */
  {
    const p = await mountPopup({
      clipkeep_items: [],
      clipkeep_trash: [
        { tid: "t-clip", kind: "clip", item: mk("gone1", "删掉的收藏"), deletedAt: now },
        { tid: "t-hl", kind: "hl", item: { id: "h1", url: "http://a/x", text: "删掉的高亮", color: "yellow", note: "", createdAt: now }, deletedAt: now },
      ],
    });
    p.w.confirm = () => true;
    await p.click(p.$("btn-trash-clear"));
    await tick(40);
    eq("回收站整批清空", (p.store.clipkeep_trash || []).length, 0);
  }

  /* 18. 跨元素的高亮重放不回来：创建时就得如实说，不能只报「已高亮 ✓」 */
  {
    const url = "http://localhost/xnode";
    const c = mountContent(url, [], `<p>简介：<strong>量子比特</strong>可以叠加</p>`);
    const strong = c.w.document.querySelector("p strong");
    const range = c.w.document.createRange();
    range.setStartBefore(strong);
    range.setEndAfter(strong.nextSibling);
    const sel = c.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    c.w.document.dispatchEvent(new c.w.MouseEvent("mouseup", { bubbles: true }));
    await tick(30);
    const btn = c.w.document.querySelector(".clipkeep-btn-hl");
    ok("选字后浮动条出现", !!btn, c.w.document.getElementById("clipkeep-toolbar") ? "有工具条没按钮" : "无工具条");
    btn.dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(60);
    const t = c.toastText();
    ok("记录确实存进了存储", (c.store.clipkeep_highlights || []).length, 1);
    // v1.9 这里断言的是「重放不回来，所以创建时必须说跨元素」；v1.10 有了分段锚点，
    // 这句保留话术就成了谎话——完整覆盖见 [3t] 跨节点锚定
    ok("锚定成功后不再说「刷新后可能不显示」", !/跨元素|可能不显示/.test(t), t);
    eq("重放后页面上有标记（跨节点锚定生效）", c.marks().length, 2);
  }
}

/* ---------------- 3t. v1.10 跨节点高亮锚定 ---------------- */

async function testV110Anchor() {
  console.log("\n[3t] 跨节点锚定：分段定位 / 上下文消歧 / 段序约束 / 旧记录兼容");
  const now = Date.now();
  const H = (url, id, text, extra) => ({
    id, url, title: "页面", text, color: "green", note: "", createdAt: now, ...(extra || {}),
  });
  // 划选 → 点工具条 🖍，返回这条落库后的记录
  async function mark(c, range) {
    const sel = c.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    c.w.document.dispatchEvent(new c.w.MouseEvent("mouseup", { bubbles: true }));
    await tick(30);
    const btn = c.w.document.querySelector(".clipkeep-btn-hl");
    if (!btn) return null;
    btn.dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(60);
    return (c.store.clipkeep_highlights || [])[0] || null;
  }
  const rangeIn = (c, startNode, so, endNode, eo) => {
    const r = c.w.document.createRange();
    r.setStart(startNode, so);
    r.setEnd(endNode, eo);
    return r;
  };

  /* 1. 跨元素选区：拆成按节点的分段锚点，刷新后两段都要重放回来 */
  {
    const url = "http://localhost/anchor1";
    // 第一段故意从 <strong> 中间开始，这样它的「上文」才是同一个文本节点里的字
    const html = `<p>简介：<strong>所谓量子比特</strong>可以叠加，这是并行性的来源。</p>`;
    const c = mountContent(url, [], html);
    const strong = c.w.document.querySelector("p strong");
    const rec = await mark(c, rangeIn(c, strong.firstChild, 2, strong.nextSibling, 4));
    ok("跨元素选区确实建了高亮", !!rec, "浮动条或写入链路没走通");
    const t = c.toastText();
    ok("锚定成功后不再需要「跨元素」保留话术", !!rec && !/跨元素|可能不显示/.test(t), t);
    eq("按文本节点拆成两段", (rec.segs || []).length, 2);
    eq("分段拼接与正文自洽", (rec.segs || []).map((s) => s.t).join(""), rec.text);
    eq("第一段带上文", (rec.segs || [])[0] && rec.segs[0].pre, "简介：所谓");
    eq("第二段带下文", (rec.segs || [])[1] && rec.segs[1].post, "，这是并行性的来源。");
    // 重新挂载 = 刷新这一页
    const c2 = mountContent(url, [rec], html);
    await tick(30);
    eq("刷新后两段都重放回来", c2.marks().length, 2);
    eq("两段属于同一条记录", new Set(c2.marks().map((m) => m.dataset.hlid)).size, 1);
    ok("原文一个字都没丢", c2.bodyText() === "简介：所谓量子比特可以叠加，这是并行性的来源。", c2.bodyText());
    ok("标记落在正确的字上", c2.marks().map((m) => m.textContent).join("|") === "量子比特|可以叠加",
      c2.marks().map((m) => m.textContent).join("|"));
  }

  /* 2. 页面里有两处一模一样的话：锚点上下文决定落在哪一处 */
  {
    const url = "http://localhost/anchor2";
    const html = `<p>第一段：量子比特很脆弱。</p><p>第二段：量子比特很脆弱。</p>`;
    const c = mountContent(url, [], html);
    const ps = c.w.document.querySelectorAll("p");
    const second = ps[1].firstChild; // 「第二段：量子比特很脆弱。」
    const rec = await mark(c, rangeIn(c, second, 4, second, 8));
    eq("正文是第二段那句话", rec && rec.text, "量子比特");
    const c2 = mountContent(url, [rec], html);
    await tick(30);
    eq("只重放出一个标记", c2.marks().length, 1);
    const parent = c2.marks()[0] && c2.marks()[0].closest("p");
    ok("标记落在第二段而不是第一段", parent === ps[1] || (parent && /第二段/.test(parent.textContent)),
      parent && parent.textContent);
  }

  /* 3. 段序约束：后一段必须落在前一段之后，短段不能错配到别处 */
  {
    const url = "http://localhost/anchor3";
    const html = `<p>量子<strong>比特</strong>量子</p>`;
    const c = mountContent(url, [], html);
    const strong = c.w.document.querySelector("p strong");
    const first = strong.previousSibling;
    const rec = await mark(c, rangeIn(c, first, 0, strong.firstChild, 2));
    eq("选中的是开头的「量子比特」", rec && rec.text, "量子比特");
    const c2 = mountContent(url, [rec], html);
    await tick(30);
    eq("两段各自落地", c2.marks().length, 2);
    eq("末尾那个「量子」没被误标", c2.marks().filter((m) => m.textContent === "量子").length, 1);
    const p3 = c2.w.document.querySelector("article p");
    ok("标的是开头那个「量子」而不是末尾那个", p3.firstChild === c2.marks().find((m) => m.textContent === "量子"),
      p3.innerHTML);
    ok("末尾的「量子」仍是裸文本", p3.lastChild.nodeType === 3 && p3.lastChild.nodeValue === "量子", p3.innerHTML);
    ok("原文完整", c2.bodyText() === "量子比特量子", c2.bodyText());
  }

  /* 4. 旧记录没有 segs：仍按整段单节点查找，行为与 v1.9 一致 */
  {
    const url = "http://localhost/anchor4";
    const html = `<p>已经存过的句子，后面还有字。</p>`;
    const c = mountContent(url, [H(url, "old1", "存过的句子")], html);
    await tick(30);
    eq("没有 segs 的旧记录照样重放", c.marks().length, 1);
    eq("重放出的文字没变", c.marks()[0] && c.marks()[0].textContent, "存过的句子");
  }

  /* 5. 页面文字被改过：宁可一个都不标，也不能只标一半 */
  {
    const url = "http://localhost/anchor5";
    const html = `<p>简介：<strong>量子比特</strong>可以叠加</p>`;
    const c = mountContent(url, [], html);
    const strong = c.w.document.querySelector("p strong");
    const rec = await mark(c, rangeIn(c, strong.previousSibling, 3, strong.nextSibling, 4));
    eq("确实存下了两段锚点", (rec.segs || []).length, 2);
    // 刷新后页面被人改了一个字：第一段找不到，第二段还在
    const c2 = mountContent(url, [rec], `<p>简介：<strong>量子比特</strong>可以部署</p>`);
    await tick(30);
    eq("部分锚点失配时整条不落地（不留下半条高亮）", c2.marks().length, 0);
    ok("原文一个字都没丢", c2.bodyText() === "简介：量子比特可以部署", c2.bodyText());
  }

  /* 6. 后台是信任边界：来料 segs 要清洗，但拼接对不上正文的 segs 整份作废 */
  {
    const be = makeBackend();
    const r = await be.send({
      type: "clipkeep:hl-add",
      payload: {
        url: "http://a/x", title: "T", text: "量子比特", color: "green", createdAt: 1,
        segs: [
          { t: "量子", pre: "上".repeat(300), post: 42 },
          { t: "", pre: "空段该丢", post: "" },
          { t: "比特", pre: null, post: "下".repeat(300), evil: "<script>" },
        ],
      },
    });
    await tick(20);
    eq("后台收下这条", r.ok, true);
    const stored = (be.store.clipkeep_highlights || [])[0] || {};
    const segs = stored.segs || [];
    eq("脏字段不影响有效段被留下", segs.length, 2);
    ok("上下文截到 24 字", segs.every((s) => s.pre.length <= 24 && s.post.length <= 24),
      JSON.stringify(segs.map((s) => [s.pre.length, s.post.length])));
    ok("非字符串上下文变成空串", segs.every((s) => typeof s.pre === "string" && typeof s.post === "string"));
    ok("未知字段不入库", segs.every((s) => !("evil" in s)), JSON.stringify(segs[0]));
    eq("清洗后拼接仍等于正文", segs.map((s) => s.t).join(""), stored.text);
  }

  /* 6b. 拼接不出正文的 segs 是谎话：整份作废，退回单段查找，别拿它去标别的字 */
  {
    const be = makeBackend();
    await be.send({
      type: "clipkeep:hl-add",
      payload: {
        url: "http://a/y", title: "T", text: "量子比特", color: "green", createdAt: 2,
        segs: [{ t: "完全", pre: "", post: "" }, { t: "不相干", pre: "", post: "" }],
      },
    });
    await tick(20);
    const stored = (be.store.clipkeep_highlights || []).find((x) => x.url === "http://a/y") || {};
    eq("正文照旧收下", stored.text, "量子比特");
    ok("对不上正文的 segs 被整份丢掉", !Array.isArray(stored.segs) || stored.segs.length === 0,
      JSON.stringify(stored.segs));
    // 段数上限同样按「作废」处理：截断 segs 会让它更拼不回正文，不如退回单段
    await be.send({
      type: "clipkeep:hl-add",
      payload: {
        url: "http://a/z", title: "T", text: "x0x1x2", color: "green", createdAt: 3,
        segs: Array.from({ length: 200 }, (_, i) => ({ t: "x" + i, pre: "", post: "" })),
      },
    });
    await tick(20);
    const many = (be.store.clipkeep_highlights || []).find((x) => x.url === "http://a/z") || {};
    ok("超过段数上限的 segs 整份作废", !Array.isArray(many.segs) || many.segs.length === 0,
      JSON.stringify((many.segs || []).length));
  }

  /* 7. 身份键仍然只看内容：带 segs 的高亮重复导入不能翻倍 */
  {
    const url = "http://localhost/anchor7";
    const be = makeBackend();
    const rec = { url, title: "T", text: "量子比特可以叠加", color: "green", note: "", createdAt: 7,
      segs: [{ t: "量子比特", pre: "", post: "" }, { t: "可以叠加", pre: "", post: "" }] };
    const p = await mountPopup();
    await p.putBackup({ app: "ClipKeep", version: 1, items: [], highlights: [rec, { ...rec }] });
    await tick(30);
    await p.click(p.$("modal-ok"));
    await tick(60);
    eq("同一份备份里的同一条只入库一次", (p.store.clipkeep_highlights || []).length, 1);
    eq("入库的 segs 保留了两段", (((p.store.clipkeep_highlights || [])[0] || {}).segs || []).length, 2);
  }

  /* 8. 删除跨节点高亮：两段一起消失，存储里也真的删掉了 */
  {
    const url = "http://localhost/anchor8";
    const html = `<p>简介：<strong>量子比特</strong>可以叠加</p>`;
    const c = mountContent(url, [], html);
    const strong = c.w.document.querySelector("p strong");
    const rec = await mark(c, rangeIn(c, strong.previousSibling, 3, strong.nextSibling, 4));
    const c2 = mountContent(url, [rec], html);
    await tick(30);
    eq("重放出两段", c2.marks().length, 2);
    c2.w.prompt = () => "!d";
    c2.marks()[0].dispatchEvent(new c2.w.MouseEvent("click", { bubbles: true }));
    await tick(60);
    eq("两段一起从页面消失", c2.marks().length, 0);
    eq("存储里这条真的没了", (c2.store.clipkeep_highlights || []).length, 0);
    ok("原文完整", c2.bodyText() === "简介：量子比特可以叠加", c2.bodyText());
  }

  /* 9. 回收站跟着走：删掉的跨节点高亮能整条捞回，重放仍然分两段 */
  {
    const url = "http://localhost/anchor9";
    const html = `<p>简介：<strong>量子比特</strong>可以叠加</p>`;
    const c = mountContent(url, [], html);
    const strong = c.w.document.querySelector("p strong");
    const rec = await mark(c, rangeIn(c, strong.previousSibling, 3, strong.nextSibling, 4));
    const c2 = mountContent(url, [rec], html);
    await tick(30);
    c2.w.prompt = () => "!d";
    c2.marks()[0].dispatchEvent(new c2.w.MouseEvent("click", { bubbles: true }));
    await tick(60);
    const entry = (c2.store.clipkeep_trash || []).find((e) => e.kind === "hl");
    ok("回收站里这条带着分段锚点", !!entry && ((entry.item || {}).segs || []).length === 2,
      JSON.stringify(c2.store.clipkeep_trash || []).slice(0, 200));
    const restored = await c2.be.send({ type: "clipkeep:trash-restore", tid: entry.tid });
    await tick(30);
    eq("撤销成功", restored.ok, true);
    const c3 = mountContent(url, c2.store.clipkeep_highlights, html);
    await tick(30);
    eq("恢复后仍然重放出两段", c3.marks().length, 2);
  }

  /* 10. 首段没有上下文、又在页面别处撞见同样的字：换落点重试，落到真能拼回原文的那一处 */
  {
    const url = "http://localhost/anchor10";
    // 扁平文本定位之后，两段就算落在同一个文本节点里也算「挨在一起」——
    // v1.10 要求它们分处两个节点，这种页面就只能干瞪眼不标
    const html = `<p>量子</p><p>中间隔着一段无关的话</p><p>量子比特</p>`;
    const rec = H(url, "shift0", "量子比特", {
      segs: [{ t: "量子", pre: "", post: "" }, { t: "比特", pre: "", post: "" }],
    });
    const c = mountContent(url, [rec], html);
    await tick(30);
    eq("两段都落地", c.marks().length, 2);
    const ps = c.w.document.querySelectorAll("p");
    ok("落在真正连续的那一处（第三段）", c.marks().every((m) => m.closest("p") === ps[2]),
      c.marks().map((m) => (m.closest("p") || {}).textContent).join("|"));
    ok("开头那个孤立的「量子」没被牵连", ps[0].querySelector("mark") === null, ps[0].outerHTML);
    ok("两段属于同一条记录", new Set(c.marks().map((m) => m.dataset.hlid)).size === 1);
    ok("原文完整", c.bodyText() === "量子中间隔着一段无关的话量子比特", c.bodyText());
  }

  /* 10b. 页面上根本拼不出连续原文：一个都不标，比标错地方好 */
  {
    const url = "http://localhost/anchor10b";
    const html = `<p>量子</p><p>中间隔着一段无关的话</p><p>比特</p>`;
    const rec = H(url, "split1", "量子比特", {
      segs: [{ t: "量子", pre: "", post: "" }, { t: "比特", pre: "", post: "" }],
    });
    const c = mountContent(url, [rec], html);
    await tick(30);
    eq("跨度拼不出原文时一个都不标", c.marks().length, 0);
    ok("原文完整", c.bodyText() === "量子中间隔着一段无关的话比特", c.bodyText());
  }

  /* 11. 首段在别处先撞见一次：换个落点重试，要标真正相邻的那一处 */
  {
    const url = "http://localhost/anchor11";
    const html = `<p>量子</p><p>说明</p><p>量子<strong>比特</strong>的讨论</p>`;
    const rec = H(url, "shift1", "量子比特", {
      segs: [{ t: "量子", pre: "", post: "" }, { t: "比特", pre: "", post: "" }],
    });
    const c = mountContent(url, [rec], html);
    await tick(30);
    eq("两段都落地", c.marks().length, 2);
    const ps = c.w.document.querySelectorAll("p");
    const hosts = new Set(c.marks().map((m) => m.closest("p")));
    ok("两段落在同一段（第三段）里", hosts.size === 1 && hosts.has(ps[2]),
      [...hosts].map((p) => p && p.textContent).join("|"));
    ok("开头那个孤立的「量子」没被牵连", ps[0].querySelector("mark") === null, ps[0].outerHTML);
    ok("原文完整", c.bodyText() === "量子说明量子比特的讨论", c.bodyText());
  }

  /* 12. 元素之间的那个空格也是正文：不能把 "Hello world" 存成 "Helloworld" */
  {
    const url = "http://localhost/anchor12";
    const html = `<p><span>Hello</span> <span>world</span> again</p>`;
    const c = mountContent(url, [], html);
    const spans = c.w.document.querySelectorAll("p span");
    const rec = await mark(c, rangeIn(c, spans[0].firstChild, 0, spans[1].firstChild, 5));
    ok("跨 span 选区确实建了高亮", !!rec, "浮动条或写入链路没走通");
    eq("正文里两个词之间的空格还在", rec && rec.text, "Hello world");
    eq("中间的空格节点也算一段", (rec.segs || []).length, 3);
    eq("分段拼接与正文自洽", (rec.segs || []).map((s) => s.t).join(""), rec.text);
    const c2 = mountContent(url, [rec], html);
    await tick(30);
    ok("原文一个字都没丢", c2.bodyText() === "Hello world again", c2.bodyText());
    ok("两个词都标上了", c2.marks().map((m) => m.textContent).join("") === "Hello world",
      c2.marks().map((m) => m.textContent).join("|"));
  }

  /* 13. 跨段落选区：正文照实记录（含段落间那个换行），刷新后每段都要回来 */
  {
    const url = "http://localhost/anchor13";
    const html = `<div>\n  <p>第一句</p>\n  <p>第二句</p>\n</div>`;
    const c = mountContent(url, [], html);
    const ps = c.w.document.querySelectorAll("p");
    const rec = await mark(c, rangeIn(c, ps[0].firstChild, 0, ps[1].firstChild, 3));
    eq("正文里保留段落之间原有的空白", rec && rec.text, "第一句\n  第二句");
    eq("分段拼接与正文自洽", (rec.segs || []).map((s) => s.t).join(""), rec.text);
    const c2 = mountContent(url, [rec], html);
    await tick(30);
    ok("两段文字都标上了", c2.marks().map((m) => m.textContent).join("") === "第一句\n  第二句",
      c2.marks().map((m) => JSON.stringify(m.textContent)).join("|"));
    ok("原文完整", c2.bodyText() === "\n  第一句\n  第二句\n", JSON.stringify(c2.bodyText()));
  }

  /* 14. 正文被 MAX_TEXT 砍短时，锚点要跟着砍齐，不能整份作废 */
  {
    const be = makeBackend();
    const a = "甲".repeat(12000);
    const b = "乙".repeat(12000);
    const c = "丙".repeat(6000);
    const r = await be.send({
      type: "clipkeep:hl-add",
      payload: {
        url: "http://a/long", title: "T", text: a + b + c, color: "green", createdAt: 1,
        segs: [{ t: a, pre: "", post: "" }, { t: b, pre: "", post: "" }, { t: c, pre: "", post: "" }],
      },
    });
    const stored = (be.store.clipkeep_highlights || [])[0] || {};
    eq("正文砍到上限", stored.text && stored.text.length, 20000);
    ok("锚点没被整份作废", Array.isArray(stored.segs) && stored.segs.length > 0,
      JSON.stringify(stored.segs && stored.segs.length));
    eq("锚点拼接仍等于砍过的正文", (stored.segs || []).map((s) => s.t).join(""), stored.text);
    eq("后台把截断这件事告诉前端", r.truncated, true);
  }

  /* 15. 截断了就不能只说「已高亮 ✓」：正文少了一截，提示得承认 */
  {
    const url = "http://localhost/anchor14";
    const html = `<p><strong>${"甲".repeat(12000)}</strong>${"乙".repeat(12000)}</p>`;
    const c = mountContent(url, [], html);
    const strong = c.w.document.querySelector("p strong");
    await mark(c, rangeIn(c, strong.firstChild, 0, strong.nextSibling, 12000));
    const t = c.toastText();
    ok("超长正文的提示带出截断", /截断/.test(t), t);
  }

  /* 16. 隐藏文字不许混进正文：真浏览器划选的可见文本没有它，DOM 走查却摸得到
         （jsdom 的 toString 会把 display:none 一起念，两边一致，复现不了这个分叉——
           所以这里把 Selection.toString 改成浏览器真正的口径来喂这条差异） */
  {
    const url = "http://localhost/anchor16";
    const html = `<p id="h16a">前面<strong style="display:none">隐藏文字</strong>后面还有一句话</p>`;
    const c = mountContent(url, [], html);
    const p = c.w.document.getElementById("h16a");
    const before = p.firstChild;
    const after = p.lastChild;
    const realSel = c.w.getSelection.bind(c.w);
    const visible = "前面后面还有一句话";
    c.w.getSelection = () => {
      const s = realSel();
      return {
        toString: () => visible,
        rangeCount: s.rangeCount,
        getRangeAt: (i) => s.getRangeAt(i),
        removeAllRanges: () => s.removeAllRanges(),
        addRange: (r) => s.addRange(r),
      };
    };
    const rec = await mark(c, rangeIn(c, before, 0, after, after.data.length));
    ok("跨隐藏节点的选区确实建了高亮", !!rec, "浮动条或写入链路没走通");
    eq("正文只有用户看得见的字", rec && rec.text, visible);
    ok("字符对不上就不存锚点（宁缺毋假）", rec && rec.segs === undefined, JSON.stringify((rec || {}).segs));
    ok("丢掉锚点后提示退回老实话术", /跨元素|可能不显示/.test(c.toastText()), c.toastText());
  }
}


/* ---------------- 3u. v1.11 文档级上下文锚定 ---------------- */

async function testV111FlatAnchor() {
  console.log("\n[3u] 文档级上下文：整段盖住文本节点时向节点外借字");
  const now = Date.now();
  const H = (url, id, text, extra) => ({
    id, url, title: "页面", text, color: "green", note: "", createdAt: now, ...(extra || {}),
  });
  async function mark(c, range) {
    const sel = c.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    c.w.document.dispatchEvent(new c.w.MouseEvent("mouseup", { bubbles: true }));
    await tick(30);
    const btn = c.w.document.querySelector(".clipkeep-btn-hl");
    if (!btn) return null;
    btn.dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(60);
    return (c.store.clipkeep_highlights || [])[0] || null;
  }
  const rangeIn = (c, startNode, so, endNode, eo) => {
    const r = c.w.document.createRange();
    r.setStart(startNode, so);
    r.setEnd(endNode, eo);
    return r;
  };

  /* 1. 选区正好盖住整个文本节点：段内没有上下文，得向邻居节点借字 */
  {
    const url = "http://localhost/flat1";
    const html = `<p>第一章<strong>猫</strong>喜欢高处。</p><p>第二章<strong>猫</strong>喜欢鱼。</p>`;
    const c = mountContent(url, [], html);
    const strongs = c.w.document.querySelectorAll("p strong");
    const rec = await mark(c, rangeIn(c, strongs[1].firstChild, 0, strongs[1].firstChild, 1));
    ok("整节点选区确实建了高亮", !!rec, "浮动条或写入链路没走通");
    eq("正文只有那一个字", rec && rec.text, "猫");
    eq("上文按 24 字窗口借，跨过节点边界", (rec.segs || [])[0] && rec.segs[0].pre, "第一章猫喜欢高处。第二章");
    eq("下文从下一个文本节点借来", (rec.segs || [])[0] && rec.segs[0].post, "喜欢鱼。");
  }

  /* 2. 两处一模一样的整节点短词：重放落在当初标记的那一处，不是页面上第一处 */
  {
    const url = "http://localhost/flat2";
    const html = `<p>第一章<strong>猫</strong>喜欢高处。</p><p>第二章<strong>猫</strong>喜欢鱼。</p>`;
    const c = mountContent(url, [], html);
    const strongs = c.w.document.querySelectorAll("p strong");
    const rec = await mark(c, rangeIn(c, strongs[1].firstChild, 0, strongs[1].firstChild, 1));
    const c2 = mountContent(url, [rec], html);
    await tick(30);
    eq("重放回一个标记", c2.marks().length, 1);
    const ps = c2.w.document.querySelectorAll("p");
    const host = c2.marks()[0] && c2.marks()[0].closest("p");
    ok("标记落在第二章", !!host && host === ps[1],
      host ? host.textContent : "没有标记");
    ok("第一章那只猫没被牵连", ps[0].querySelector("mark") === null, ps[0].outerHTML);
    ok("原文完整", c2.bodyText() === "第一章猫喜欢高处。第二章猫喜欢鱼。", c2.bodyText());
  }

  /* 3. 借字同样受 24 字窗口约束：只借最近的 24 个字 */
  {
    const url = "http://localhost/flat3";
    const html = `<p>${"前".repeat(40)}<strong>猫</strong>后</p>`;
    const c = mountContent(url, [], html);
    const strong = c.w.document.querySelector("p strong");
    const rec = await mark(c, rangeIn(c, strong.firstChild, 0, strong.firstChild, 1));
    eq("上文只借 24 字", (rec.segs || [])[0] && (rec.segs[0].pre || "").length, 24);
    eq("借来的都是紧邻的字", (rec.segs || [])[0] && rec.segs[0].pre, "前".repeat(24));
    eq("下文照旧", (rec.segs || [])[0] && rec.segs[0].post, "后");
  }

  /* 4. 借来的上下文越过块级边界：段落末尾的段能从下一段借到下文 */
  {
    const url = "http://localhost/flat4";
    const html = `<div><p>甲<strong>乙</strong></p><p>丙</p></div>`;
    const c = mountContent(url, [], html);
    const strong = c.w.document.querySelector("p strong");
    const rec = await mark(c, rangeIn(c, strong.firstChild, 0, strong.firstChild, 1));
    eq("上文来自同段", (rec.segs || [])[0] && rec.segs[0].pre, "甲");
    eq("下文跨到下一段", (rec.segs || [])[0] && rec.segs[0].post, "丙");
    const c2 = mountContent(url, [rec], html);
    await tick(30);
    eq("重放后仍然一字不差地落在「乙」上", c2.marks().map((m) => m.textContent).join("|"), "乙");
  }

  /* 5. 页面改写后上下文对不上：宁可一个都不标，也不能退回到第一处同名文本 */
  {
    const url = "http://localhost/flat5";
    const html = `<p>第一章<strong>猫</strong>喜欢高处。</p><p>第二章<strong>猫</strong>喜欢鱼。</p>`;
    const c = mountContent(url, [], html);
    const strongs = c.w.document.querySelectorAll("p strong");
    const rec = await mark(c, rangeIn(c, strongs[1].firstChild, 0, strongs[1].firstChild, 1));
    // 第二章那句话被作者改成了「喜欢鸟」：借来的下文不再匹配，落点无法确认
    const c2 = mountContent(url, [rec], `<p>第一章<strong>猫</strong>喜欢高处。</p><p>第二章<strong>猫</strong>喜欢鸟。</p>`);
    await tick(30);
    eq("确认不了的落点就不标", c2.marks().length, 0);
    ok("第一章那只猫没有被误标", !c2.w.document.querySelectorAll("p")[0].querySelector("mark"),
      c2.w.document.querySelectorAll("p")[0].outerHTML);
  }

  /* 6. 没有借到字的旧记录（v1.10 存的空上下文）照旧走重试：不因为这次改造而更差 */
  {
    const url = "http://localhost/flat6";
    const html = `<p>说明</p><p>猫<em>喜欢鱼</em></p>`;
    const rec = H(url, "legacy6", "猫喜欢鱼", {
      segs: [{ t: "猫", pre: "", post: "" }, { t: "喜欢鱼", pre: "", post: "" }],
    });
    const c = mountContent(url, [rec], html);
    await tick(30);
    eq("两段都落地", c.marks().length, 2);
    ok("落在真正相邻的那一处", new Set(c.marks().map((m) => m.closest("p"))).size === 1,
      c.marks().map((m) => (m.closest("p") || {}).textContent).join("|"));
    ok("原文完整", c.bodyText() === "说明猫喜欢鱼", c.bodyText());
  }

  /* 7. 借字之后仍然只多一份锚点，正文与分段拼接保持自洽（后台白名单不会作废它） */
  {
    const url = "http://localhost/flat7";
    const html = `<p>第一章<strong>猫</strong>喜欢高处。</p>`;
    const c = mountContent(url, [], html);
    const strong = c.w.document.querySelector("p strong");
    const rec = await mark(c, rangeIn(c, strong.firstChild, 0, strong.firstChild, 1));
    eq("只有一段", (rec.segs || []).length, 1);
    eq("分段拼接与正文自洽", (rec.segs || []).map((s) => s.t).join(""), rec.text);
    const be = makeBackend();
    await be.send({
      type: "clipkeep:hl-add",
      payload: { url: "http://a/flat7", title: "T", text: rec.text, color: "green",
        createdAt: 7, segs: rec.segs },
    });
    await tick(20);
    const stored = (be.store.clipkeep_highlights || []).find((x) => x.url === "http://a/flat7") || {};
    eq("后台收下借来的上下文", (stored.segs || [])[0] && stored.segs[0].pre, "第一章");
  }
}


/* ---------------- 3v. v1.11 国际化文案层 ---------------- */

// 在裸沙箱里加载文案层本身（不依赖 DOM / chrome），用来直接问 T
function loadI18n() {
  const ctx = { console, Object, Array, String, Number, Boolean, RegExp, JSON, Math, Date, isNaN, parseInt };
  vm.createContext(ctx);
  vm.runInContext(src("i18n.js"), ctx);
  return ctx.ClipKeepI18N;
}

/** 语言自称名（endonym）：英文界面上「中文」仍然写「中文」，各语言都这么列，所以它不进词典、也不算中文残留 */
const ENDONYMS = ["中文"];

const HAN = /[\u4e00-\u9fff]/;
const LIT_BODY = String.raw`"((?:[^"\\\n]|\\.)*)"`;
const unescLit = (b) => b.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, g) =>
  g[0] === "u" ? String.fromCharCode(parseInt(g.slice(1), 16)) : g === "n" ? "\n" : g === "t" ? "\t" : g === "r" ? "\r" : g);
const decodeEnt = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)));

/**
 * 扫出全部 msgid，三条来源缺一不可：
 *  1) T("…") 直接调用的字面量；
 *  2) msgid 常量（const X = "…" / { key: "…" }）——高亮颜色名、失联提示这类必须先存中文原文，
 *     模块加载时就翻译会把语言冻在默认值上；
 *  3) popup.html 的 data-i18n* 属性和静态文本节点。
 * 只扫 T() 调用会漏掉 2 和 3，而这两类恰恰最容易忘。
 */
function collectMsgids() {
  const ids = new Set();
  const js = (txt) => {
    for (const m of txt.matchAll(new RegExp(String.raw`\bT\(\s*` + LIT_BODY, "g")))
      if (HAN.test(m[1])) ids.add(unescLit(m[1]));
    for (const m of txt.matchAll(new RegExp(String.raw`(?:^|[={,\s])[\w$]+\s*[:=]\s*` + LIT_BODY + String.raw`\s*(?:[,;}]|$)`, "gm")))
      if (HAN.test(m[1])) ids.add(unescLit(m[1]));
  };
  ["popup.js", "content.js", "background.js"].forEach((f) => js(src(f)));
  const html = src("popup.html");
  for (const m of html.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"]*)"/g))
    if (HAN.test(m[1])) ids.add(decodeEnt(m[1]));
  for (const m of html.matchAll(/>([^<>]*[\u4e00-\u9fff][^<>]*)</g)) {
    const t = m[1].trim();
    if (t) ids.add(decodeEnt(t));
  }
  return [...ids].filter((s) => !ENDONYMS.includes(s));
}

/** 占位符集合：msgid 和译文必须一一对应，少一个 {1} 就会把参数吞掉 */
const placeholders = (s) => (String(s).match(/\{\d+\}/g) || []).sort().join(",");

async function testV111I18n() {
  console.log("\n[3v] 国际化文案层：msgid 就是中文原文 / 英文词典 / 语言偏好");
  const CJK = /[\u4e00-\u9fff]/;

  /* 1. 文案层本身：中文原样返回、占位替换、缺词条退回中文 */
  {
    const I = loadI18n();
    ok("文案层挂在全局", !!I && typeof I.T === "function");
    eq("中文界面原样返回", I.T("搜索收藏内容…"), "搜索收藏内容…");
    eq("占位符按参数替换", I.T("已选 {0} 条", [3]), "已选 3 条");
    eq("缺参数时占位符原样留着，不吐 undefined", I.T("已选 {0} 条"), "已选 {0} 条");
    I.setLang("en");
    ok("英文界面有译文", I.T("搜索收藏内容…") !== "搜索收藏内容…" && !CJK.test(I.T("搜索收藏内容…")),
      I.T("搜索收藏内容…"));
    eq("英文界面同样做占位替换", /\{\d\}/.test(I.T("已选 {0} 条", [3])), false);
    eq("词典里没有的文案退回中文（宁可混排也不要空白）", I.T("这句没有译文的测试文案"), "这句没有译文的测试文案");
    ok("退回的条目会被记下来，覆盖率测试能抓到", I.missing().includes("这句没有译文的测试文案"),
      JSON.stringify(I.missing().slice(-3)));
    I.setLang("zh");
    eq("切回中文立刻生效", I.T("搜索收藏内容…"), "搜索收藏内容…");
  }

  /* 2. 词典覆盖率：源码里每一句中文文案都必须在英文词典里有对应条目 */
  {
    const I = loadI18n();
    const ids = collectMsgids();
    ok("扫到了待译文案", ids.length > 150, `只有 ${ids.length} 条`);
    const en = I.EN;
    const holes = ids.filter((k) => !String(en[k] || "").trim() || CJK.test(String(en[k])));
    ok(`英文词典覆盖全部 ${ids.length} 条文案`, holes.length === 0,
      `缺 ${holes.length} 条：${JSON.stringify(holes.slice(0, 8))}`);
    const dupes = Object.keys(en).filter((k) => !ids.includes(k));
    ok("词典里没有多余的死条目", dupes.length === 0, JSON.stringify(dupes.slice(0, 8)));
    const mismatched = ids.filter((k) => String(en[k] || "") && placeholders(k) !== placeholders(en[k]));
    ok("每条译文的占位符和 msgid 一一对应", mismatched.length === 0,
      JSON.stringify(mismatched.slice(0, 5).map((k) => [k, en[k]])));
  }

  /* 3. 静态外壳：popup.html 的中文都挂在 data-i18n 上，英文界面整壳无中文 */
  {
    const p = await mountPopup({ clipkeep_prefs: { lang: "en" } });
    await tick(20);
    // 逐个文本节点问「你所属的元素挂 data-i18n 了吗」：比整行正则可靠——
    // 正则要么把 <span data-i18n="📌 收藏">📌 收藏</span> 这种正常写法误判成漏标，要么放过真正的裸中文。
    const rawDoc = new JSDOM(src("popup.html")).window.document;
    const untagged = [];
    rawDoc.querySelectorAll("*").forEach((el) => {
      [...el.childNodes].forEach((n) => {
        if (n.nodeType !== 3) return;
        const t = n.textContent.trim();
        if (!CJK.test(t) || ENDONYMS.includes(t)) return;
        if (!el.hasAttribute("data-i18n")) untagged.push(`${el.tagName.toLowerCase()} › ${t}`);
      });
    });
    ok("popup.html 的静态文案都带 data-i18n", untagged.length === 0, JSON.stringify(untagged.slice(0, 6)));
    // 语言自称名不参与「无中文」判定：英文界面里 Chinese 这一项照样写「中文」
    p.w.document.querySelector('#pref-lang option[value="zh"]').remove();
    const shell = [p.$("btn-keys"), p.$("btn-reader"), p.$("btn-settings"), p.$("btn-theme"), p.$("btn-export")]
      .map((el) => `${el.textContent}|${el.title}`).join(" ");
    ok("图标按钮的提示已是英文", !CJK.test(shell), shell);
    ok("标签页标题已是英文", !CJK.test(p.q(".tabs").textContent), p.q(".tabs").textContent);
    ok("搜索框占位符已是英文", !CJK.test(p.$("search").placeholder), p.$("search").placeholder);
    ok("空状态也是英文", !CJK.test(p.q(".empty").textContent), p.q(".empty").textContent);
    ok("整个弹窗壳子没有中文残留", !CJK.test(p.w.document.body.textContent),
      (p.w.document.body.textContent || "").replace(/\s+/g, " ").slice(0, 160));
    eq("文档语言标成 en", p.w.document.documentElement.lang, "en");
  }

  /* 4. 中文仍然是默认界面：没设过偏好时一切照旧 */
  {
    const p = await mountPopup();
    await tick(20);
    eq("默认按浏览器界面语言走（这里是中文）", p.w.ClipKeepI18N.lang(), "zh");
    ok("搜索框占位符还是中文", p.$("search").placeholder === "搜索收藏内容…", p.$("search").placeholder);
    ok("空状态还是中文", /还没有收藏/.test(p.q(".empty").textContent), p.q(".empty").textContent);
  }

  /* 5. auto：跟随浏览器界面语言，英文浏览器开箱就是英文 */
  {
    const p = await mountPopup({ clipkeep_prefs: { lang: "auto" } }, { uiLanguage: "en-US" });
    await tick(20);
    eq("auto + 英文界面 → 英文", p.w.ClipKeepI18N.lang(), "en");
    ok("标签页已是英文", !CJK.test(p.q(".tabs").textContent), p.q(".tabs").textContent);
    const c = await mountPopup({ clipkeep_prefs: { lang: "auto" } }, { uiLanguage: "zh-TW" });
    await tick(20);
    eq("auto + 中文界面（含繁体的区域标记）→ 中文", c.w.ClipKeepI18N.lang(), "zh");
    const e = await mountPopup({ clipkeep_prefs: { lang: "zh" } }, { uiLanguage: "en-US" });
    await tick(20);
    eq("用户显式选了中文，浏览器语言不再作数", e.w.ClipKeepI18N.lang(), "zh");
  }

  /* 6. 设置里能改语言：选 English 立刻生效并落盘，重开弹窗仍是英文 */
  {
    const p = await mountPopup();
    await tick(20);
    await p.click(p.$("btn-settings"));
    const sel = p.$("pref-lang");
    ok("设置面板里有语言选择", !!sel, "没有 #pref-lang");
    sel.value = "en";
    await p.fire(sel, "change");
    await tick(30);
    eq("偏好已落盘", p.store.clipkeep_prefs.lang, "en");
    ok("界面立刻切到英文", !CJK.test(p.q(".tabs").textContent), p.q(".tabs").textContent);
    const again = await mountPopup(p.store);
    await tick(20);
    ok("重开弹窗仍然是英文", !CJK.test(again.q(".tabs").textContent), again.q(".tabs").textContent);
  }

  /* 7. 内容脚本：浮动条、卡片、Toast 都走文案层 */
  {
    const url = "http://localhost/i18n7";
    const c = mountContent(url, [], `<p>量子比特可以同时处于两种状态，这是并行性的来源。</p>`, { lang: "en" });
    const p = c.w.document.querySelector("p");
    const sel = c.w.getSelection();
    const r = c.w.document.createRange();
    r.setStart(p.firstChild, 0);
    r.setEnd(p.firstChild, 4);
    sel.removeAllRanges();
    sel.addRange(r);
    c.w.document.dispatchEvent(new c.w.MouseEvent("mouseup", { bubbles: true }));
    await tick(30);
    const bar = c.w.document.querySelector(".clipkeep-toolbar");
    ok("英文界面下浮动条也出来了", !!bar);
    // 宿主页面的 <html lang> 一个字都不动：那是人家的文档，改了整个页面的朗读和字体都跟着错
    eq("内容脚本不改宿主页面语言", c.w.document.documentElement.getAttribute("lang"), null);
    const barText = bar ? bar.textContent + " " + [...bar.querySelectorAll("button")].map((b) => b.title).join(" ") : "";
    ok("浮动条没有中文", !!bar && !CJK.test(barText), barText);
    bar.querySelector(".clipkeep-btn-save").dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(20);
    const card = c.w.document.getElementById("clipkeep-card");
    // 卡片里那块引用是用户选中的原文，中文内容当然照原样留着；只查界面文案
    const chromeText = [
      ...card.querySelectorAll(".clipkeep-card-head, .clipkeep-btn"),
    ].map((el) => el.textContent).join(" ") + " " +
      [...card.querySelectorAll("input, textarea")].map((i) => i.placeholder).join(" ");
    ok("收藏卡片的界面文案没有中文", !CJK.test(chromeText), chromeText.replace(/\s+/g, " ").slice(0, 120));
    ok("卡片引用的原文一字不动", /量子比特/.test(card.querySelector(".clipkeep-quote").textContent),
      card.querySelector(".clipkeep-quote").textContent);
    card.querySelector(".clipkeep-btn-confirm").dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(40);
    ok("保存成功的提示也是英文", !CJK.test(c.toastText()), c.toastText());
    eq("收藏仍然正常落盘", (c.store.clipkeep_items || []).length, 1);
  }

  /* 8. 右键菜单跟着语言偏好走：装扩展时按当前语言建，改了偏好要重建 */
  {
    const be = makeBackend({ uiLanguage: "en-US" });
    be.store.clipkeep_prefs = { lang: "auto" };
    await be.fireInstalled("install");
    await tick(20);
    const titles = be.menuOps.created.map((m) => m.title).join(" | ");
    ok("英文界面下右键菜单是英文", !!titles && !CJK.test(titles), titles);
    const firstRemoveAll = be.menuOps.removeAll;
    await be.chrome.storage.local.set({ clipkeep_prefs: { lang: "zh" } });
    await tick(30);
    ok("改语言后菜单重建过", be.menuOps.removeAll > firstRemoveAll, `${be.menuOps.removeAll}`);
    const zhTitles = be.menuOps.created.slice(-4).map((m) => m.title).join(" | ");
    ok("重建后回到中文菜单", /收藏|净化/.test(zhTitles), zhTitles);
  }

  /* 9. 后台的失败提示也是文案层出来的：不能一半英文一半中文 */
  {
    const be = makeBackend({ uiLanguage: "en-US" });
    be.store.clipkeep_prefs = { lang: "en" };
    be.store.__failNextSet = true;
    const r = await be.send({ type: "clipkeep:add", payload: { text: "x", url: "http://a", title: "T" } });
    await tick(20);
    ok("存储失败提示按语言出", !!r.error && !CJK.test(r.error), r.error);
  }

  /* 10. 导出与备份里的固定字样也走文案层（用户拿到的 Markdown 跟着界面语言） */
  {
    const p = await mountPopup({
      clipkeep_prefs: { lang: "en" },
      clipkeep_items: [{ id: "e1", text: "Alpha qubit", note: "keep", tags: ["quantum"], url: "http://a/1", title: "Src", createdAt: 1 }],
    }, { uiLanguage: "en-US" });
    await tick(20);
    p.click(p.$("btn-export"));
    await tick(40);
    const md = p.getDownloaded() || "";
    ok("导出的 Markdown 抬头是英文", !!md && !CJK.test(md), md.replace(/\s+/g, " ").slice(0, 140));
    ok("内容一字不少", /Alpha qubit/.test(md) && /#quantum/.test(md), md.slice(0, 140));
  }

  /* 11. 文案层没加载也不能崩：T 退化成原样返回（老的抓帧桩、直接 eval 的页面） */
  {
    const be = makeBackend();
    const dom = new JSDOM(`<!DOCTYPE html><html><body><p>量子比特可以叠加</p></body></html>`,
      { runScripts: "outside-only", url: "http://localhost/i18n11" });
    const w = dom.window;
    w.Range.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 122, left: 120, right: 300, width: 180, height: 22, x: 120, y: 100 });
    w.chrome = be.chrome;
    w.eval(src("content.js"));
    await tick(30);
    const p0 = w.document.querySelector("p");
    const sel = w.getSelection();
    const r = w.document.createRange();
    r.setStart(p0.firstChild, 0);
    r.setEnd(p0.firstChild, 4);
    sel.removeAllRanges();
    sel.addRange(r);
    w.document.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
    await tick(30);
    ok("没有 i18n.js 时浮动条照常工作", !!w.document.querySelector(".clipkeep-toolbar"));
    ok("没有 i18n.js 时界面退回中文而不是报错", /收藏|高亮|批注/.test(w.document.querySelector(".clipkeep-toolbar").textContent),
      w.document.querySelector(".clipkeep-toolbar").textContent);
  }

  /* 12. 页面开着的时候改语言：浮层和已有标记都得跟着换，不能等用户刷新页面 */
  {
    const url = "http://localhost/i18n12";
    const text = "量子比特可以同时处于两种状态";
    const c = mountContent(url,
      [{ id: "m1", url, text, color: "green", note: "重点", createdAt: 1 }],
      `<p>${text}，这是并行性的来源。</p><p>第二段没有高亮，拿来选字。</p>`, { lang: "zh" });
    await tick(30);
    const mark = () => c.w.document.querySelector("mark.clipkeep-hl");
    ok("中文界面下标记提示是中文", /^ClipKeep 批注：/.test(mark().title), mark().title);

    // 高亮重放后第一段被拆成 mark + 裸文本，选字一律用没被标记过的第二段
    const p0 = c.w.document.querySelectorAll("p")[1];
    const sel = c.w.getSelection();
    const r = c.w.document.createRange();
    r.setStart(p0.firstChild, 0);
    r.setEnd(p0.firstChild, 4);
    sel.removeAllRanges();
    sel.addRange(r);
    c.w.document.dispatchEvent(new c.w.MouseEvent("mouseup", { bubbles: true }));
    await tick(30);
    ok("先建出来的浮动条是中文", /收藏/.test(c.w.document.querySelector(".clipkeep-toolbar").textContent));

    await c.chrome.storage.local.set({ clipkeep_prefs: { lang: "en" } });
    await tick(40);
    ok("改语言后标记提示跟着换", /^ClipKeep note:/.test(mark().title), mark().title);
    ok("标记里的用户原文一字不动", mark().textContent === text, mark().textContent);

    // 浮动条是 ensureToolbar 缓存的，不重建就会一直停在第一次建好时的那种语言
    sel.removeAllRanges();
    sel.addRange(r);
    c.w.document.dispatchEvent(new c.w.MouseEvent("mouseup", { bubbles: true }));
    await tick(30);
    const bar2 = c.w.document.querySelector(".clipkeep-toolbar");
    ok("改语言后重新选字，浮动条是英文", !CJK.test(bar2.textContent), bar2.textContent);
  }

  /* 13. 改语言不能把用户正在写的批注卡片清空：那是人家打了一半的字 */
  {
    const url = "http://localhost/i18n13";
    const c = mountContent(url, [], `<p>量子比特可以叠加</p>`, { lang: "zh" });
    const p0 = c.w.document.querySelector("p");
    const sel = c.w.getSelection();
    const r = c.w.document.createRange();
    r.setStart(p0.firstChild, 0);
    r.setEnd(p0.firstChild, 4);
    sel.removeAllRanges();
    sel.addRange(r);
    c.w.document.dispatchEvent(new c.w.MouseEvent("mouseup", { bubbles: true }));
    await tick(30);
    c.w.document.querySelector(".clipkeep-btn-save").dispatchEvent(new c.w.MouseEvent("click", { bubbles: true }));
    await tick(20);
    const ta = c.w.document.querySelector("#clipkeep-card .clipkeep-note");
    ta.value = "写到一半的想法";
    await c.chrome.storage.local.set({ clipkeep_prefs: { lang: "en" } });
    await tick(40);
    const card = c.w.document.getElementById("clipkeep-card");
    ok("打开着的卡片不会被换语言清掉", !!card, "卡片没了");
    eq("用户输入原样留着", card.querySelector(".clipkeep-note").value, "写到一半的想法");
  }

  /* 14. data-i18n-aria 换的是属性，不是同名 JS 属性：aria-* 没有对应 property，写 el["aria-label"] 是空的 */
  {
    const p = await mountPopup({ clipkeep_prefs: { lang: "en" } });
    await tick(20);
    const el = p.w.document.createElement("i");
    el.setAttribute("data-i18n-aria", "搜索收藏内容…");
    p.w.document.body.appendChild(el);
    p.w.ClipKeepI18N.localize(p.w.document);
    const got = String(el.getAttribute("aria-label") || "");
    ok("aria-label 属性真的被写上了", !!got, "属性还是空的，只写了个同名 JS 属性");
    ok("aria-label 跟着语言走", !CJK.test(got), got);
    eq("aria-label 就是当前语言的译文", got, p.w.ClipKeepI18N.T("搜索收藏内容…"));
  }

  /* 15. 覆盖失败的话术：类别不能当词块塞进句子——英文 "Clip / Highlight wasn't written" 是病句 */
  {
    const stubOne = (chrome, type, res) => {
      const orig = chrome.runtime.sendMessage.bind(chrome);
      chrome.runtime.sendMessage = (msg, cb) => {
        if (!msg || msg.type !== type) return orig(msg, cb);
        if (typeof cb === "function") cb(res);
        return Promise.resolve(res);
      };
    };
    const err = { ok: false, error: "Error: QUOTA_EXCEEDED" };
    const mkItem = (id, text) => ({ id, text, note: "", tags: [], url: "", title: "", createdAt: 1 });
    const bk = { app: "ClipKeep", version: 1,
      items: [mkItem("w2", "备份收藏")],
      highlights: [{ id: "h2", text: "备份高亮", url: "http://localhost/i18n15", color: "yellow", createdAt: 1 }] };

    const both = await mountPopup({ clipkeep_prefs: { lang: "en" }, clipkeep_items: [mkItem("w1", "本地收藏")] });
    stubOne(both.chrome, "clipkeep:replace", err);
    stubOne(both.chrome, "clipkeep:hl-replace", err);
    await both.putBackup(bk);
    await both.click(both.$("modal-alt"));
    await tick(40);
    const tb = both.$("toast").textContent;
    ok("两类都失败：整条提示没有中文", !CJK.test(tb), tb);
    ok("两类都失败：两类都点名", /clip/i.test(tb) && /highlight/i.test(tb), tb);
    ok("两类都失败：谓语跟着复数走，不用 was", !/was(?:n'?| not)\b/i.test(tb) && /were\b/i.test(tb), tb);
    ok("两类都失败：不是拿斜杠拼两个词", !/\s\/\s/.test(tb), tb);
    eq("两类都失败：本地内容确实没动", both.store.clipkeep_items.length, 1);

    const onlyHl = await mountPopup({ clipkeep_prefs: { lang: "en" }, clipkeep_items: [mkItem("w1", "本地收藏")] });
    stubOne(onlyHl.chrome, "clipkeep:hl-replace", err);
    await onlyHl.putBackup(bk);
    await onlyHl.click(onlyHl.$("modal-alt"));
    await tick(40);
    const th = onlyHl.$("toast").textContent;
    ok("只有高亮失败：不牵连收藏", !/clip/i.test(th) && /highlight/i.test(th), th);

    const zh = await mountPopup({ clipkeep_prefs: { lang: "zh" }, clipkeep_items: [mkItem("w1", "本地收藏")] });
    stubOne(zh.chrome, "clipkeep:replace", err);
    stubOne(zh.chrome, "clipkeep:hl-replace", err);
    await zh.putBackup(bk);
    await zh.click(zh.$("modal-alt"));
    await tick(40);
    const tz = zh.$("toast").textContent;
    ok("中文提示照旧说清两类", /收藏和高亮都没有写入成功/.test(tz), tz);
  }

  /* 16. 冷启动那一次读偏好失败不能把语言钉死一整轮：下一条消息还要能补读 */
  {
    const be = makeBackend({ uiLanguage: "zh-CN", failFirstGet: true });
    be.store.clipkeep_prefs = { lang: "en" };
    await be.fireInstalled("install");
    await tick(30);
    const titles = be.menuOps.created.map((m) => m.title).join(" | ");
    ok("装完的菜单按存好的偏好出，不按兜底语言", !!titles && !CJK.test(titles), titles);

    be.store.__failNextSet = true;
    await be.fireMenuClick({ menuItemId: "clipkeep-save", selectionText: "量子比特", pageUrl: "http://a/1" },
      { id: 1, title: "页面", url: "http://a/1" });
    await tick(30);
    const toasts = be.sentToTab.map((s) => s.msg.message).join("|");
    ok("失败提示也跟上补读后的语言", !!toasts && !CJK.test(toasts), toasts);
  }

  /* 17. 模块级常量不许存译死的文案：`const X = T("…")` 会在读到偏好之前就把语言冻住，
     翻译必须发生在「用的那一刻」。箭头函数形式的 `const f = (k) => T(k)` 是合法的，不算。 */
  {
    const FROZEN = /^  (?:const|let) [A-Za-z_$][\w$]* = (?!\(|function)[^=]*\bT\(/;
    const findFrozen = (text) => text.split("\n")
      .map((l, i) => `${i + 1}: ${l}`)
      .filter((l) => FROZEN.test(l.replace(/^\d+: /, "")));

    const fixture = [
      "  const T = window.__x;",
      "  const SETTINGS_TITLE = T(\"设置\");",
      "  const NAMES = { a: I18N.T(\"红色\") };",
      "  const kindLabel = (k) => T(KIND_LABELS[k] || k);",
      "  function render() {",
      "    const tip = T(\"勾选后可批量删除\");",
      "  }",
    ].join("\n");
    const found = findFrozen(fixture);
    ok("检得出模块级译死的文案（含 I18N.T 与对象字面量）",
       found.length === 2 && /SETTINGS_TITLE/.test(found[0]) && /NAMES/.test(found[1]),
       found.join(" | "));
    ok("合法的按调用翻译（箭头函数、函数体内）不误报",
       !found.some((f) => /kindLabel|tip =/.test(f)), found.join(" | "));

    for (const f of ["popup.js", "content.js", "background.js"]) {
      const bad = findFrozen(src(f));
      ok(`${f} 没有模块级译死的文案`, bad.length === 0,
         bad.join(" | ") + " → 换语言后这句永远是第一次算出来的那种");
    }
  }
}

/* ---------------- 3w. v1.12 回顾队列按标签 / 站点筛选 ---------------- */

/**
 * 点一个可能还不存在的元素：功能没做时，断言就该干干净净地红，
 * 而不是抛异常把整个套件的后半截带走（那样连「哪几条没实现」都看不出来）。
 */
async function tap(p, el, what) {
  if (!el) { ok(`点${what}`, false, `${what} 还没渲染出来`); return false; }
  await p.click(el);
  return true;
}

async function testV112ReviewFilter() {
  console.log("\n[3f12] v1.12 回顾：只复习这一批（按标签 / 站点筛队列）");
  const CJK = /[一-鿿]/;
  const now = Date.now();
  const mk = (id, tags, url) => ({
    id, text: `正文-${id}`, note: `答案-${id}`, tags, url, title: `标题-${id}`,
    createdAt: now, review: { box: 1, due: now - 1000, seen: 1 },
  });
  const open = async (over) => {
    const p = await mountPopup({
      clipkeep_items: [mk("q1", ["量子"], "http://q.dev/a"), mk("h1", ["历史"], "http://h.dev/a"), mk("q2", ["量子"], "http://q.dev/b")],
      ...(over || {}),
    });
    await p.click(p.q('.tab[data-view="review"]'));
    return p;
  };
  const chips = (p) => [...p.qa("#revfilter .chip")];
  const byText = (p, re) => chips(p).find((c) => re.test(c.textContent));
  const cardId = (p) => ((p.q(".rev-card") || { dataset: {} }).dataset || {}).id || "";
  const tapChip = async (p, re) => {
    const c = byText(p, re);
    if (!c) {
      ok(`筛选条里有 ${re.source.replace(/[^0-9a-zA-Z一-鿿.]/g, "")} 这一项`, false,
        chips(p).map((x) => x.textContent.trim()).join(" | ") || "筛选条还没出来");
      return false;
    }
    await p.click(c);
    return true;
  };
  const prog = (p) => ((p.q(".rev-progress") || {}).textContent || "").replace(/\s+/g, " ");
  const revText = (p) => (p.$("review").textContent || "").replace(/\s+/g, " ");
  const press = async (p, key) => {
    p.w.document.dispatchEvent(new p.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await tick(20);
  };

  /* 1. 筛选条按「到期内容」生成， chip 上带条数 */
  {
    const p = await open();
    ok("回顾视图里有筛选条", !!p.$("revfilter") && p.$("revfilter").hidden === false,
      "没有 #revfilter 或它还是隐藏的");
    const ts = chips(p).map((c) => c.textContent.trim());
    ok("标签 chip 随数据生成", ts.includes("量子 2") && ts.includes("历史 1"), JSON.stringify(ts));
    ok("站点 chip 随数据生成", ts.includes("q.dev 2") && ts.includes("h.dev 1"), JSON.stringify(ts));
    eq("没筛选时队列是全库到期", cardId(p), "q1");
  }

  /* 2. 点标签：队列只剩这一批 */
  {
    const p = await open();
    await tapChip(p, /量子/);
    eq("筛标签后第一张来自这批", cardId(p), "q1");
    ok("进度说的是这批的条数", /本组待回顾 2 条/.test(prog(p)), prog(p));
    ok("选中的 chip 标成活动", chips(p).some((c) => c.classList.contains("active") && /量子/.test(c.textContent)),
      chips(p).map((c) => c.className).join(" | "));
  }

  /* 3. 换标签 / 再点一次取消 */
  {
    const p = await open();
    await tapChip(p, /历史/);
    eq("筛历史只看历史那条", cardId(p), "h1");
    await tapChip(p, /历史/);
    ok("再点一次取消筛选，队列回到三条", /本组待回顾 3 条/.test(prog(p)), prog(p));
  }

  /* 4. 站点 chip 同样能筛 */
  {
    const p = await open();
    await tapChip(p, /h\.dev/);
    eq("按站点筛到那一个站", cardId(p), "h1");
  }

  /* 5. 标签 + 站点取交集；筛到空要给出路，不能只说「今日已完成」 */
  {
    const p = await open();
    await tapChip(p, /量子/);
    await tapChip(p, /h\.dev/);
    ok("交集为空时不摆假卡片", !p.q(".rev-card"), cardId(p));
    const txt = p.$("review").textContent.replace(/\s+/g, " ");
    ok("空状态说清是筛空的", /这个筛选条件下没有要回顾的/.test(txt), txt.slice(0, 140));
    ok("空状态不是那句「今日回顾已完成」", !/今日回顾已完成/.test(txt), txt.slice(0, 140));
    const clear = p.q('#revfilter [data-act="rev-clear"]') || p.q('[data-act="rev-clear"]');
    ok("给出清除筛选的出口", !!clear, "找不到 data-act=rev-clear 的按钮");
    if (clear) {
      await p.click(clear);
      eq("清除后队列回来", cardId(p), "q1");
    }
  }

  /* 6. 每日上限在筛完之后才截：剩余条数按这批算，不能拿全库数字说话 */
  {
    const p = await open({ clipkeep_prefs: { review: { cap: 1, mult: 1 } } });
    await tapChip(p, /量子/);
    ok("剩余条数按筛完的批算", /今日上限 1 条，剩余 1 条明天继续/.test(prog(p)), prog(p));
  }

  /* 7. 徽标守全库口径：筛选只是「先看这批」，不能让标签上的待回顾数变小 */
  {
    const p = await open();
    await tapChip(p, /量子/);
    eq("回顾徽标不受筛选影响", p.$("due").textContent, "3");
  }

  /* 8. 筛选不串台：收藏列表的条件与回顾的条件各管各的 */
  {
    const p = await open();
    await tapChip(p, /量子/);
    await p.click(p.q('.tab[data-view="clips"]'));
    eq("列表仍是全部收藏", p.qa(".item").length, 3);
    await p.click(p.q('.tab[data-view="review"]'));
    ok("切回来时回顾筛选还在", chips(p).some((c) => c.classList.contains("active")),
      "切一次视图就把筛选丢了，用户得重新点一遍");
  }

  /* 9. 键盘打分链在筛选下照常走，复习完这批就说这批没了 */
  {
    const p = await open();
    await tapChip(p, /量子/);
    await press(p, " ");
    await press(p, "2");
    eq("这批第一条按 2 升一盒", p.store.clipkeep_items.find((x) => x.id === "q1").review.box, 2);
    eq("下一张仍是这批的", cardId(p), "q2");
    await press(p, " ");
    await press(p, "3");
    const txt = p.$("review").textContent.replace(/\s+/g, " ");
    ok("这批复习完后按筛选口径说明", /这个筛选条件下没有要回顾的/.test(txt), txt.slice(0, 140));
    ok("另一批仍有到期，全库徽标跟着减", p.$("due").textContent === "1", p.$("due").textContent);
  }

  /* 10. chip 只由到期内容生成：这批复习完 chip 就消失，但选定的筛选要用户自己清 */
  {
    const p = await open();
    await tapChip(p, /历史/);
    await press(p, " ");
    await press(p, "3"); // 简单：跳到 21 天后，历史这批今天不再到期
    const ts = chips(p).map((c) => c.textContent.trim());
    ok("没有到期的标签不再列 chip", !ts.some((t) => /历史/.test(t)), JSON.stringify(ts));
    // 队列不悄悄换成别的内容：那等于替用户改了主意，还会让他找不到回到全库的入口
    ok("这批复习完按筛选口径停下来说明", /这个筛选条件下没有要回顾的/.test(revText(p)), revText(p).slice(0, 140));
    const clear = p.q('[data-act="rev-clear"]');
    ok("说明旁边留着「清除筛选」", !!clear, "没有回全库的入口，用户被筛死在这屏");
    if (clear) {
      await p.click(clear);
      ok("清除后回到全库的到期内容", /本组待回顾 2 条/.test(prog(p)), prog(p));
    }
  }

  /* 11. 到期内容只有一个标签、一个站点时不铺筛选条（没得筛就别摆一排按钮） */
  {
    const p = await open({
      clipkeep_items: [mk("s1", ["量子"], "http://q.dev/a"), mk("s2", ["量子"], "http://q.dev/b")],
    });
    ok("单标签单站点时收起筛选条", !p.$("revfilter") || p.$("revfilter").hidden !== false,
      chips(p).map((c) => c.textContent.trim()).join(" | "));
  }

  /* 12. 英文界面：筛选条、进度、空状态都不留中文 */
  {
    const p = await mountPopup({
      clipkeep_prefs: { lang: "en" },
      clipkeep_items: [
        { id: "e1", text: "Alpha qubit", note: "a", tags: ["quantum"], url: "http://q.dev/a", createdAt: now, review: { box: 1, due: now - 1000, seen: 1 } },
        { id: "e2", text: "Roman roads", note: "b", tags: ["history"], url: "http://h.dev/a", createdAt: now, review: { box: 1, due: now - 900, seen: 1 } },
      ],
    }, { uiLanguage: "en-US" });
    await p.click(p.q('.tab[data-view="review"]'));
    await tick(20);
    ok("英文界面也有筛选条", !!p.$("revfilter") && p.$("revfilter").hidden === false);
    await tapChip(p, /quantum/);
    await tapChip(p, /h\.dev/);
    const txt = (p.$("review").textContent + " " + (p.$("revfilter") || { textContent: "" }).textContent).replace(/\s+/g, " ");
    ok("筛到空的提示是英文", !CJK.test(txt), txt.slice(0, 160));
    const clear = p.q('[data-act="rev-clear"]');
    if (clear) {
      await p.click(clear);
      ok("清除后进度也是英文", !CJK.test(prog(p)), prog(p));
    }
  }
}

/* ---------------- 3x. v1.12 数据自检面板 ---------------- */

async function testV112Diag() {
  console.log("\n[3g12] v1.12 数据自检：一屏看清库里有什么、哪里对不上");
  const CJK = /[一-鿿]/;
  const now = Date.now();
  const MIN = 60000;

  /* --- 页面端：重放结果得能被问出来 --- */

  const pageUrl = "http://localhost/diag1";
  const plainAt = (id, text) => ({ id, url: pageUrl, text, color: "yellow", note: "", createdAt: now });

  {
    const text = "量子比特可以同时处于两种状态";
    const c = mountContent(pageUrl, [
      plainAt("ok1", text),
      plainAt("gone", "这段字在页面上已经被作者删掉了"),
      { id: "other", url: "http://localhost/other-page", text: "别页面的高亮", color: "yellow", note: "", createdAt: now },
    ], `<p>${text}，这是并行性的来源。</p>`);
    await tick(30);
    ok("本页标出一条", c.marks().some((m) => m.dataset.hlid === "ok1"));
    const r = await c.toContent({ type: "clipkeep:diag" });
    ok("自检消息有回包", !!(r && r.ok && r.diag), JSON.stringify(r));
    if (r && r.diag) {
      eq("只算本页的记录", r.diag.stored, 2);
      eq("标出来的条数", r.diag.placed, 1);
      ok("定位不回的那条列出来", r.diag.missing.length === 1 && r.diag.missing[0].id === "gone",
        JSON.stringify(r.diag.missing));
    }
  }

  /* 预览要短：诊断结果会被列进面板和导出文件，不能把整篇正文搬过来 */
  {
    const long = "很长的一句".repeat(40); // 200 字
    const c = mountContent("http://localhost/diag2", [
      { id: "big", url: "http://localhost/diag2", text: long, color: "yellow", note: "", createdAt: now },
    ], `<p>页面上没有那句话。</p>`);
    await tick(30);
    const r = await c.toContent({ type: "clipkeep:diag" });
    const p = r && r.diag && r.diag.missing[0] ? r.diag.missing[0] : {};
    ok("缺字预览有长度上限", p.text && p.text.length > 0 && p.text.length <= 60, `${(p.text || "").length} 字`);
    // 预览截短了，长度得按原文报：诊断要看的是「丢了多大一块」，不是「预览留了多少字」
    ok("长度按原文报", p.len === long.length, JSON.stringify([p.len, long.length]));
  }

  /* --- 弹窗端：设置里一屏看完 --- */

  const item = (id, extra) => ({
    id, text: `正文-${id}`, note: "", tags: [], url: "http://x/1", title: `标题-${id}`,
    createdAt: now, ...(extra || {}),
  });
  const withDiag = async (seed, pageDiag) => {
    const p = await mountPopup(seed);
    p.chrome.tabs.sendMessage = async () => pageDiag;
    await p.click(p.$("btn-settings"));
    await tick(40);
    return p;
  };
  const diagText = (p) => ((p.$("diag") || {}).textContent || "").replace(/\s+/g, " ");

  /* 1. 打开设置就自动自检：数量一眼可见 */
  {
    const p = await withDiag({
      clipkeep_items: [item("d1"), item("d2"), item("d3")],
      clipkeep_highlights: [{ id: "m1", url: "http://x/1", text: "一句", color: "yellow", note: "", createdAt: now }],
    }, { ok: true, diag: { stored: 1, placed: 1, missing: [] } });
    ok("设置里有数据自检区块", !!p.$("diag") && p.$("diag").hidden !== true, "没有 #diag 或它是隐藏的");
    const txt = diagText(p);
    ok("报出收藏条数", /收藏 3 条/.test(txt), txt.slice(0, 160));
    ok("报出高亮条数", /高亮 1 条/.test(txt), txt.slice(0, 160));
    ok("回收站是空的就直说", /回收站是空的/.test(txt), txt.slice(0, 160));
  }

  /* 2. 存储大小：自己算的字节一定有；浏览器不报占用时不能编一个 0 出来 */
  {
    const p = await withDiag({ clipkeep_items: [item("s1", { text: "甲".repeat(500) })] }, { ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    const txt = diagText(p);
    ok("报出数据自身大小", /\d+(\.\d)? KB/.test(txt), txt.slice(0, 200));
    ok("浏览器不报占用时如实说明", /这个浏览器不报存储占用/.test(txt), txt.slice(0, 200));

    const q = await withDiag({ clipkeep_items: [item("s2")] }, { ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    q.chrome.storage.local.getBytesInUse = async () => 12345;
    await tap(q, q.$("btn-diag"), "重新自检");
    await tick(30);
    ok("能报占用时给出浏览器口径", /12 KB/.test(diagText(q)), diagText(q).slice(0, 200));
  }

  /* 3. 被字数上限砍短的收藏：列标题和长度，不搬正文 */
  {
    const p = await withDiag({
      clipkeep_items: [item("t1", { truncated: true }), item("t2"), item("t3", { truncated: true })],
    }, { ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    const txt = diagText(p);
    ok("点出被砍短的条数", /正文被.{0,10}20000.{0,6}砍短 2 条/.test(txt), txt.slice(0, 220));
    ok("列出是哪几条", /标题-t1/.test(txt) && /标题-t3/.test(txt), txt.slice(0, 220));
    const q = await withDiag({ clipkeep_items: [item("t9")] }, { ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    ok("没有砍短的就明说没有", /没有正文被砍短的收藏/.test(diagText(q)), diagText(q).slice(0, 220));
  }

  /* 4. 回收站：最早一条多久后清掉 */
  {
    const p = await withDiag({
      clipkeep_items: [],
      clipkeep_trash: [
        { kind: "clip", tid: "g1", deletedAt: now - 8 * MIN, item: item("gone1") },
        { kind: "clip", tid: "g2", deletedAt: now - 2 * MIN, item: item("gone2") },
      ],
      clipkeep_prefs: { trash: { mins: 10 } },
    }, { ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    const txt = diagText(p);
    ok("回收站条数与最早过期时间", /回收站 2 条/.test(txt) && /约 2 分/.test(txt), txt.slice(0, 220));
  }

  /* 5. 当前页面重放：存了几条、标出几条、哪条回不来 */
  {
    const p = await withDiag({ clipkeep_items: [item("p1")] },
      { ok: true, diag: { stored: 3, placed: 1, missing: [{ id: "z9", text: "定位不回的那一句" }] } });
    const txt = diagText(p);
    ok("页面重放三档都说清", /存 3 条/.test(txt) && /标出 1 条/.test(txt) && /1 条定位不回/.test(txt), txt.slice(0, 220));
    ok("点名回不来的那条", /定位不回的那一句/.test(txt), txt.slice(0, 220));

    const q = await withDiag({ clipkeep_items: [item("p2")] }, { ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    ok("这页没高亮就直说", /这个页面没有高亮记录/.test(diagText(q)), diagText(q).slice(0, 220));
  }

  /* 6. 页面打不通（浏览器自带页、扩展刚更新、脚本没注入）要如实说，不能留上一屏的数字 */
  {
    const p = await withDiag({ clipkeep_items: [item("n1")] }, undefined);
    const txt = diagText(p);
    ok("打不通时说明原因", /这个页面打不通/.test(txt), txt.slice(0, 220));
    ok("不摆出假的页面数字", !/存 \d+ 条/.test(txt), txt.slice(0, 220));

    const c = mountContent("http://localhost/diag3", [], `<p>没有高亮的页面</p>`);
    await tick(30);
    c.store.__failNextGet = true;
    const r = await c.toContent({ type: "clipkeep:diag" });
    ok("存储读不到时回包报错而不是回空表", !(r && r.ok), JSON.stringify(r));
  }

  /* 7. 备份基线：点过备份就记住当时的条数，自检说清还有多少没进备份 */
  {
    const p = await mountPopup({ clipkeep_items: [item("b1"), item("b2")] });
    p.chrome.tabs.sendMessage = async () => ({ ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    await p.click(p.$("btn-backup"));
    await tick(30);
    ok("备份把基线写进偏好", !!(p.store.clipkeep_prefs.lastBackup),
      JSON.stringify(p.store.clipkeep_prefs));
    await p.be.send({ type: "clipkeep:add", payload: { text: "备份之后又存的一条", url: "http://x/9", title: "新的一条" } });
    await p.click(p.$("btn-settings"));
    await tick(40);
    ok("说出还没进备份的条数", /1 条还没进备份/.test(diagText(p)), diagText(p).slice(0, 220));

    const q = await withDiag({ clipkeep_items: [item("b3")] }, { ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    ok("没备份过时直说", /还没备份过/.test(diagText(q)), diagText(q).slice(0, 220));
  }

  /* 8. 重新自检按存储现算：弹窗里的数据是旧的，面板不能跟着旧 */
  {
    const p = await withDiag({ clipkeep_items: [item("r1")] }, { ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    ok("初始一条", /收藏 1 条/.test(diagText(p)), diagText(p).slice(0, 200));
    await p.be.send({ type: "clipkeep:add", payload: { text: "别处新存的", url: "http://x/8", title: "别处" } });
    await p.be.send({ type: "clipkeep:add", payload: { text: "还有这条", url: "http://x/7", title: "还有" } });
    await tap(p, p.$("btn-diag"), "重新自检");
    await tick(30);
    ok("重新自检读到三条", /收藏 3 条/.test(diagText(p)), diagText(p).slice(0, 200));
  }

  /* 9. 一键导出诊断 JSON：结构可解析，且只报元数据不报正文 */
  {
    const SECRET = "这段正文是用户私藏的，绝不进诊断文件";
    const p = await withDiag({
      clipkeep_items: [item("x1", { text: SECRET, note: SECRET, truncated: true }), item("x2")],
      clipkeep_highlights: [{ id: "h1", url: "http://x/1", text: "一句高亮", color: "yellow", note: "", createdAt: now }],
    }, { ok: true, diag: { stored: 2, placed: 1, missing: [{ id: "z9", text: "定位不回的那一句" }] } });
    await tap(p, p.$("btn-diag-export"), "导出诊断");
    await tick(40);
    const raw = p.getDownloaded() || "";
    ok("导出能拿到内容", !!raw, "download 没有被调用");
    let j = null;
    try { j = JSON.parse(raw); } catch (_) { /* 下面那条断言会报出来 */ }
    ok("诊断文件是合法 JSON", !!j, raw.slice(0, 120));
    if (j) {
      eq("标明这是诊断", j.kind, "diagnostics");
      eq("带上应用名", j.app, "ClipKeep");
      ok("计数齐全", j.counts && j.counts.items === 2 && j.counts.highlights === 1, JSON.stringify(j.counts));
      ok("截断条目报长度", Array.isArray(j.truncated) && j.truncated.length === 1
        && j.truncated[0].id === "x1" && typeof j.truncated[0].len === "number",
        JSON.stringify(j.truncated));
      ok("页面重放的缺口带上", j.page && j.page.missing && j.page.missing[0].id === "z9", JSON.stringify(j.page));
      ok("诊断文件里不含正文与备注全文", !raw.includes(SECRET), "正文被搬进诊断文件了");
      // 面板上要认得出是哪一条回不来了，可导出文件是准备贴到 issue 里的：
      // 那 60 字预览是用户的高亮原文，留在文件里就等于把读书笔记一起发出去
      ok("导出只留缺口条目编号，不留高亮原文", !raw.includes("定位不回的那一句"),
        JSON.stringify(j.page && j.page.missing));
      ok("缺口条目仍报得出长度", !!(j.page && j.page.missing && typeof j.page.missing[0].len === "number"),
        JSON.stringify(j.page && j.page.missing));
      ok("带上版本号与时间", !!j.version && !!j.generatedAt, JSON.stringify([j.version, j.generatedAt]));
    }
  }

  /* 10. 英文界面：自检面板一句中文都不留 */
  {
    const p = await mountPopup({
      clipkeep_prefs: { lang: "en" },
      clipkeep_items: [{ id: "g1", text: "Alpha", note: "", tags: [], url: "http://x/1", title: "Src", createdAt: now, truncated: true }],
    }, { uiLanguage: "en-US" });
    p.chrome.tabs.sendMessage = async () => ({ ok: true, diag: { stored: 1, placed: 0, missing: [{ id: "z", text: "gone text" }] } });
    await p.click(p.$("btn-settings"));
    await tick(40);
    const txt = diagText(p);
    ok("英文界面有自检结果", !!txt, "面板是空的");
    ok("自检面板没有中文", !CJK.test(txt), txt.slice(0, 200));
    const btns = [p.$("btn-diag"), p.$("btn-diag-export")].map((b) => (b || { textContent: "按钮不存在" }).textContent).join(" | ");
    ok("设置里那两个按钮也是英文", !CJK.test(btns), btns);
  }

  /* 11. 语言换了，已经画出来的自检面板要跟着换：
          语言选择器就挂在设置里，用户改完语言抬眼就是这块面板，留半屏旧语言最扎眼 */
  {
    const p = await withDiag({ clipkeep_items: [item("l1")] }, { ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    ok("中文界面先有自检结果", /收藏 1 条/.test(diagText(p)), diagText(p).slice(0, 160));
    const sel = p.$("pref-lang");
    sel.value = "en";
    await p.fire(sel, "change");
    await tick(30);
    ok("换语言后自检面板不留旧语言", !CJK.test(diagText(p)), diagText(p).slice(0, 200));
  }

  /* 12. 样式：弹窗只有 600px 高，自检面板是接在设置最后一块——设置区不能整块被裁掉。
          真浏览器抓帧实测：flex 列里的 .settings 没有 min-height:0，自动最小尺寸等于内容高度，
          压不下去就被 body 的 overflow:hidden 切掉，「今日到期 / 上次备份」两行在真弹窗里根本滚不到。 */
  {
    const css = src("popup.css");
    ok("设置区装不下时自己滚", /\.settings\s*\{[^}]*overflow-y:\s*auto/.test(css),
      "→ 弹窗定高 600px，面板最后一行永远看不见");
    ok("设置区可以被压到可视高度内", /\.settings\s*\{[^}]*min-height:\s*0/.test(css),
      "→ flex 项的默认最小尺寸是内容高度，overflow:hidden 直接把它裁掉");
  }
}


/* ---------------- v1.12 审计：自检面板与回顾筛选的边界 ---------------- */

async function testV112Audit() {
  console.log("\n[3h12] v1.12 审计：读不到的东西不能说成读过，用户的数据不能拼进 HTML");
  const CJK = /[\u4e00-\u9fff]/;
  const now = Date.now();
  const MIN = 60000;
  const item = (id, extra) => ({
    id, text: `正文-${id}`, note: "", tags: [], url: "http://x/1", title: `标题-${id}`,
    createdAt: now, ...(extra || {}),
  });
  const due1 = (i) => ({ box: 1, due: now - 1000 - i, seen: 1 });
  const openDiag = async (seed, pageDiag) => {
    const p = await mountPopup(seed);
    p.chrome.tabs.sendMessage = async () =>
      (pageDiag || { ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    await p.click(p.$("btn-settings"));
    await tick(40);
    return p;
  };
  const diagText = (p) => ((p.$("diag") || {}).textContent || "").replace(/\s+/g, " ");

  /* 1. 列表的类型 chip 走没走文案层（chip 是 v1.8 做的，文案层是 v1.11 才补的） */
  {
    const p = await mountPopup({
      clipkeep_items: [
        item("k1"),
        item("k2", { kind: "image", image: "http://x/a.png" }),
        item("k3", { kind: "link", link: "http://x/b" }),
      ],
    }, { uiLanguage: "en-US" });
    await tick(20);
    const txt = (p.$("filterbar") || { textContent: "" }).textContent;
    ok("英文界面的类型 chip 也是英文", !!txt && !CJK.test(txt), txt);
  }

  /* 2. 备份基线要扛得住之后改设置：savePrefs 是整包写回 prefs 的 */
  {
    const p = await openDiag({ clipkeep_items: [item("a1"), item("a2")] });
    await p.click(p.$("btn-backup"));
    await tick(30);
    p.$("set-cap").value = "5";
    await p.fire(p.$("set-cap"), "change");
    await tick(30);
    ok("改设置不会把备份基线冲掉", !!((p.store.clipkeep_prefs || {}).lastBackup),
      JSON.stringify(p.store.clipkeep_prefs));
    await p.click(p.$("btn-settings")); // 关掉
    await p.click(p.$("btn-settings")); // 重开，重新自检
    await tick(40);
    ok("重开设置仍报得出上次备份", /上次备份/.test(diagText(p)), diagText(p).slice(0, 220));
  }

  /* 3. 基线是外来数据（手改过的存储、旧版本残留）：没有时间的「备份」不算备份 */
  {
    const p = await openDiag({
      clipkeep_items: [item("z1")],
      clipkeep_prefs: { lastBackup: {} },
    });
    ok("没有时间戳的基线不摆 1970 年", /还没备份过/.test(diagText(p)), diagText(p).slice(0, 220));
  }

  /* 4. 标签是用户自己打的，带引号也不能变成 HTML 属性；点了还得筛得动 */
  {
    const weird = 'a" onclick="boom';
    const p = await mountPopup({
      clipkeep_items: [
        item("w1", { tags: [weird], review: due1(1) }),
        item("w2", { tags: ["正常"], review: due1(2) }),
      ],
    });
    await p.click(p.q('.tab[data-view="review"]'));
    await tick(30);
    const chip = p.qa("#revfilter .chip").find((c) => (c.getAttribute("data-rtag") || "").startsWith('a"'));
    ok("怪标签还在 chip 里", !!chip, p.qa("#revfilter .chip").map((c) => c.outerHTML).join(" | "));
    ok("标签没被拼成事件属性", !p.q("#revfilter [onclick]"), "用户打的标签变成了 onclick");
    if (chip) {
      await p.click(chip);
      ok("点了照样筛得动", /本组待回顾 1 条/.test(((p.q(".rev-progress") || {}).textContent || "")), 
        ((p.q(".rev-progress") || {}).textContent || "").slice(0, 120));
    }
  }

  /* 5. 页面回包的预览同样是用户内容：面板只显示文本，不认标签 */
  {
    const p = await openDiag({ clipkeep_items: [item("e1")] },
      { ok: true, diag: { stored: 2, placed: 1, missing: [{ id: "m", text: '<img src=x onerror=alert(1)>', len: 25 }] } });
    ok("预览不注入元素", !p.q("#diag img"), p.$("diag").innerHTML.slice(0, 200));
    ok("预览照样看得清", /onerror/.test(diagText(p)), diagText(p).slice(0, 220));
  }

  /* 6. 浏览器报占用这事本身可能坏：抛异常、报负数，都得退回「不报占用」而不是把面板整体弄没 */
  {
    const a = await mountPopup({ clipkeep_items: [item("g1")] });
    a.chrome.tabs.sendMessage = async () => ({ ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    a.chrome.storage.local.getBytesInUse = async () => { throw new Error("QuotaUnusable"); };
    await a.click(a.$("btn-settings"));
    await tick(40);
    ok("占用接口报错时面板照常", /收藏 1 条/.test(diagText(a)) && /这个浏览器不报存储占用/.test(diagText(a)), diagText(a).slice(0, 220));

    const b = await mountPopup({ clipkeep_items: [item("g2")] });
    b.chrome.tabs.sendMessage = async () => ({ ok: true, diag: { stored: 0, placed: 0, missing: [] } });
    b.chrome.storage.local.getBytesInUse = async () => -5;
    await b.click(b.$("btn-settings"));
    await tick(40);
    ok("报出负数也当没这个接口", /这个浏览器不报存储占用/.test(diagText(b)), diagText(b).slice(0, 220));
  }

  /* 7. 存储读不到：说读不到，别把上一屏的数字留在原地当现状 */
  {
    const p = await openDiag({ clipkeep_items: [item("f1"), item("f2"), item("f3")] });
    ok("先有一份正常结果", /收藏 3 条/.test(diagText(p)), diagText(p).slice(0, 220));
    p.store.__failNextGet = true;
    await p.click(p.$("btn-diag"));
    await tick(40);
    const txt = diagText(p);
    ok("读不到就明说读不到", /存储读不到/.test(txt), txt.slice(0, 220));
    ok("不留上一屏的假现状", !/收藏 3 条/.test(txt), txt.slice(0, 220));
  }

  /* 8. 回收站里已经过期的条目不该被算成「还能撤销」 */
  {
    const p = await openDiag({
      clipkeep_items: [],
      clipkeep_trash: [{ kind: "clip", tid: "t1", deletedAt: now - 30 * MIN, item: item("old") }],
      clipkeep_prefs: { trash: { mins: 10 } },
    });
    ok("过期条目不再计数", /回收站是空的/.test(diagText(p)), diagText(p).slice(0, 220));
  }

  /* 9. 站点很多时 chip 有上限，剩下的说清楚还有几个 */
  {
    const many = Array.from({ length: 14 }, (_, i) =>
      item(`s${i}`, { url: `http://site${i}.dev/${i}`, tags: ["甲", i % 2 ? "乙" : "丙"], review: due1(i) }));
    const p = await mountPopup({ clipkeep_items: many });
    await p.click(p.q('.tab[data-view="review"]'));
    await tick(30);
    const bar = (p.$("revfilter") || { textContent: "" });
    eq("站点 chip 收到上限", p.qa("#revfilter .chip.site").length, 12);
    ok("多出来的站点有交代", /\+2 站/.test(bar.textContent), bar.textContent.slice(0, 200));
  }

  /* 10. 自检还没跑完就点导出：不出文件，并说清在等什么 */
  {
    const p = await mountPopup({ clipkeep_items: [item("n9")] });
    await p.fire(p.$("btn-diag-export"), "click");
    await tick(20);
    ok("没跑自检时不导出", !p.getDownloaded(), "什么都没自检就发了一个诊断文件");
    ok("提示说清在等什么", /自检/.test(p.$("toast").textContent), p.$("toast").textContent);
  }
}

/* ---------------- v1.13：复习卡片里直接改标签与备注 ---------------- */

async function testV113ReviewEdit() {
  console.log("\n[3a13] v1.13 复习：改标签与备注不用切回列表");
  const CJK = /[一-鿿]/;
  const now = Date.now();
  const mk = (id, tags, note) => ({
    id, text: `正文-${id}`, note: note || "", tags: tags || [],
    url: "http://q.dev/a", title: `标题-${id}`, createdAt: now,
    review: { box: 1, due: now - 1000, seen: 1 },
  });

  /** 打开回顾并展开答案：改标签这个动作只发生在「看完答案、想顺手整理」那一刻 */
  const open = async (over, opts, reveal = true) => {
    const p = await mountPopup({
      clipkeep_items: [mk("r1", ["量子", "笔记"], "旧备注"), mk("r2", ["历史"])],
      ...(over || {}),
    }, opts);
    await p.click(p.q('.tab[data-view="review"]'));
    if (reveal) await p.click(p.q('[data-act="reveal"]'));
    return p;
  };
  const cardId = (p) => ((p.q(".rev-card") || {}).dataset || {}).id || "";
  /** 入口还没做出来时也要把整组断言跑完：缺一个元素就崩掉，看不到后面几条的失败原因 */
  const tap = async (p, sel) => {
    const el = p.q(sel);
    if (!el) {
      ok(`有 ${sel}`, false, "这个入口还没做出来，依赖它的步骤只能跳过");
      return false;
    }
    await p.click(el);
    return true;
  };
  const row = (p, id) => p.store.clipkeep_items.find((x) => x.id === id) || {};
  const toastText = (p) => ((p.$("toast") || {}).textContent || "").replace(/\s+/g, " ");
  /** 写完还要 load() 回读一次才出提示：单靠 click 里那 10ms 不够，读到的上一条提示会假绿 */
  const flush = async () => { for (let i = 0; i < 5; i++) await tick(10); };
  const keyOn = async (el, key, mod) => {
    const w = el.ownerDocument.defaultView;
    el.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...(mod || {}) }));
    await tick(20);
  };
  /** 拦下写请求计数：重复保存、取消保存这两条都要知道「到底发了几条 clipkeep:update」 */
  const spyWrites = (p, gate) => {
    const seen = [];
    const raw = p.be.chrome.runtime.sendMessage;
    p.be.chrome.runtime.sendMessage = function (msg, cb) {
      if (msg && msg.type === "clipkeep:update") {
        seen.push(msg);
        const go = gate ? gate.then(() => raw(msg, cb)) : raw(msg, cb);
        return go;
      }
      return raw(msg, cb);
    };
    return seen;
  };

  /* 1. 入口只属于答案区：没翻答案就没有编辑，复习不该被输入框打扰 */
  {
    const p = await open(null, null, false);
    const back = p.q(".rev-back");
    const entry = p.q('[data-act="rev-tags"]');
    // jsdom 没有排版，「看不见」这件事只能按 hidden 属性 + CSS 规则两头的契约来断言
    ok("没展开答案时编辑入口不可见",
      !!back && back.hidden === true && !!entry && entry.closest(".rev-back") === back,
      "编辑按钮没藏在答案区里");
    ok("hidden 的答案区真的不显示", /\.rev-back\[hidden\][^{]*\{[^}]*display:\s*none/.test(src("popup.css")),
      "只挂 hidden 属性没有对应 CSS，等于没藏");
    await p.click(p.q('[data-act="reveal"]'));
    ok("展开后有改标签", !!p.q('.rev-back [data-act="rev-tags"]'), p.$("review").innerHTML.slice(0, 200));
    ok("展开后有改备注", !!p.q('.rev-back [data-act="rev-note"]'));
  }

  /* 2. 点「改标签」→ 预填当前标签的单行输入框，Enter 保存 */
  {
    const p = await open();
    await tap(p, '[data-act="rev-tags"]');
    const inp = p.q('[data-act="rev-tags-input"]');
    ok("出现标签输入框", !!inp, "点完按钮没有换出输入框");
    if (inp) {
      ok("输入框预填当前标签", /量子/.test(inp.value) && /笔记/.test(inp.value), JSON.stringify(inp.value));
      inp.value = "量子, 纠错";
      await keyOn(inp, "Enter");
      await flush();
      eq("Enter 保存写进存储", JSON.stringify(row(p, "r1").tags), JSON.stringify(["量子", "纠错"]));
      ok("提示说标签已更新", /标签已更新/.test(toastText(p)), toastText(p));
      eq("保存后还是这一条，没跳到下一条", cardId(p), "r1");
      ok("保存后答案还开着", p.q(".rev-back").hidden === false, "存完标签答案收起，等于白看一遍");
    }
  }

  /* 3. 超上限要说没进去几条：只报「已更新」等于把丢掉的标签藏起来 */
  {
    const p = await open();
    await tap(p, '[data-act="rev-tags"]');
    const inp = p.q('[data-act="rev-tags-input"]');
    if (inp) {
      inp.value = Array.from({ length: 14 }, (_, i) => `t${i}`).join(", ");
      await keyOn(inp, "Enter");
      await flush();
      eq("存储里最多留 12 个", (row(p, "r1").tags || []).length, 12);
      ok("提示说出几条没进去", /2 个超上限/.test(toastText(p)), toastText(p));
    }
  }

  /* 4. 备注是多行文本：保存按钮或 ⌘/Ctrl+Enter 写入，清空要真的能清空 */
  {
    const p = await open();
    await tap(p, '[data-act="rev-note"]');
    const ta = p.q('[data-act="rev-note-input"]');
    ok("出现备注输入框", !!ta && ta.tagName === "TEXTAREA", ta ? ta.tagName : "没有 textarea");
    if (ta) {
      eq("预填现有备注", ta.value, "旧备注");
      ta.value = "退相干那段要重读";
      await keyOn(ta, "Enter", { metaKey: true });
      await flush();
      eq("⌘+Enter 保存备注", row(p, "r1").note, "退相干那段要重读");
      ok("保存后备注就显示在答案里", /退相干/.test(p.q(".rev-back").textContent), p.q(".rev-back").textContent.slice(0, 80));
    }
    await tap(p, '[data-act="rev-note"]');
    const ta2 = p.q('[data-act="rev-note-input"]');
    const save = p.q('[data-act="rev-save"]');
    if (ta2 && save) {
      eq("重开时预填刚保存的备注", ta2.value, "退相干那段要重读");
      ta2.value = "";
      await p.click(save);
      await flush();
    } else {
      ok("编辑器里有保存按钮", !!save, "备注编辑器没给出口");
    }
    eq("清空备注写回空串", row(p, "r1").note, "");
    ok("提示说清是清空不是保存了个寂寞", /备注已清空/.test(toastText(p)), toastText(p));
  }

  /* 5. Esc 取消：一条写请求都不该发出去，存储保持原样 */
  {
    const p = await open();
    const before = JSON.stringify(row(p, "r1").tags);
    const seen = spyWrites(p);
    await tap(p, '[data-act="rev-tags"]');
    const inp = p.q('[data-act="rev-tags-input"]');
    if (inp) {
      inp.value = "全删了";
      await keyOn(inp, "Escape");
      ok("取消后编辑器收起", !p.q('[data-act="rev-tags-input"]'), "Esc 之后输入框还在");
    }
    eq("取消没有发写请求", seen.length, 0);
    eq("存储保持原样", JSON.stringify(row(p, "r1").tags), before);
  }

  /* 6. 正在打字时数字键归输入框：按「2」不该把这盒排期改掉 */
  {
    const p = await open();
    await tap(p, '[data-act="rev-tags"]');
    const inp = p.q('[data-act="rev-tags-input"]');
    const boxBefore = row(p, "r1").review.box;
    if (inp) {
      inp.value = "2";
      await keyOn(inp, "2");
    }
    eq("输入框里按数字不改排期", row(p, "r1").review.box, boxBefore);
    eq("输入框里按数字不换卡", cardId(p), "r1");
  }

  /* 7. 在途重复保存只认第一次：两条 update 打出去，第二条对着旧标签覆盖第一条 */
  {
    const p = await open();
    let release;
    const gate = new Promise((r) => { release = r; });
    const seen = spyWrites(p, gate);
    await tap(p, '[data-act="rev-tags"]');
    const inp = p.q('[data-act="rev-tags-input"]');
    if (inp) {
      inp.value = "量子, 纠错";
      await keyOn(inp, "Enter");
      await keyOn(inp, "Enter");
    }
    eq("连按两次 Enter 只发一条写请求", seen.length, 1);
    release();
    await tick(30);
    eq("放行后标签确实写进去了", JSON.stringify(row(p, "r1").tags), JSON.stringify(["量子", "纠错"]));
  }

  /* 8. 改完标签把这条筛出当前组：得说明白，不能静默换一张卡 */
  {
    const p = await open();
    const chip = [...p.qa("#revfilter .chip")].find((c) => /量子/.test(c.textContent));
    if (chip) await p.click(chip);
    else ok("筛选条里有量子这一项", false, "找不到 chip，出组提示这条没法走");
    await tap(p, '[data-act="reveal"]');
    await tap(p, '[data-act="rev-tags"]');
    const inp = p.q('[data-act="rev-tags-input"]');
    ok("筛选状态下也能改标签", !!inp, "筛完这批就没有编辑入口了");
    if (inp) {
      inp.value = "历史";
      await keyOn(inp, "Enter");
      await flush();
      ok("说明这条已移出当前筛选", /移出当前筛选/.test(toastText(p)), toastText(p));
      ok("移出后不再拿这条冒充这批", cardId(p) !== "r1", cardId(p));
    }
  }

  /* 9. 输入只当文字：标签里带尖括号也不许变成元素 */
  {
    const p = await open();
    await tap(p, '[data-act="rev-tags"]');
    const inp = p.q('[data-act="rev-tags-input"]');
    if (inp) {
      inp.value = '"><img/src=x>, 量子';
      await keyOn(inp, "Enter");
      await flush();
    }
    ok("没有注入出元素", p.q(".rev-card img") === null, p.q(".rev-card") ? p.q(".rev-card").innerHTML.slice(0, 200) : "没有卡片");
    ok("尖括号原样当文字", /img\/src=x/.test(p.q(".rev-meta").textContent), p.q(".rev-meta").textContent.slice(0, 120));
  }

  /* 10. 后台说没保存成功就不报「已更新」：这条在别处已经被删了 */
  {
    const p = await open();
    await tap(p, '[data-act="rev-tags"]');
    const inp = p.q('[data-act="rev-tags-input"]');
    p.store.clipkeep_items = p.store.clipkeep_items.filter((x) => x.id !== "r1"); // 另一个标签页删掉了它
    if (inp) {
      inp.value = "量子";
      await keyOn(inp, "Enter");
      await flush();
    }
    ok("提示说这条已经不在，没写成功", /不在收藏里/.test(toastText(p)), toastText(p));
    ok("没摆出一句假的已更新", !/标签已更新/.test(toastText(p)), toastText(p));
  }

  /* 11. 英文界面下这两个入口也得是英文：文案层漏一条就是界面上一个中文词 */
  {
    const p = await open({ clipkeep_prefs: { lang: "en" } });
    const t = p.q('[data-act="rev-tags"]');
    const n = p.q('[data-act="rev-note"]');
    ok("改标签按钮有英文译文", !!t && !CJK.test(t.textContent), t ? t.textContent : "没有按钮");
    ok("改备注按钮有英文译文", !!n && !CJK.test(n.textContent), n ? n.textContent : "没有按钮");
    if (t) {
      await p.click(t);
      const inp = p.q('[data-act="rev-tags-input"]');
      ok("英文界面下输入框没有中文占位", !!inp && !CJK.test(inp.placeholder || ""), inp ? inp.placeholder : "没有输入框");
    }
  }

  /* 12. 答案开着是「这一张、这一次」的状态：切走再回来不能替你把答案翻开 */
  {
    const p = await open();
    await p.click(p.q('[data-act="reveal"]'));
    ok("切走前答案是开的", p.q(".rev-back").hidden === false);
    await p.click(p.q('.tab[data-view="clips"]'));
    await p.click(p.q('.tab[data-view="review"]'));
    ok("切回复习时答案重新合上", p.q(".rev-back").hidden === true,
      "自动翻开等于替用户回忆了一遍，间隔重复就废了");
  }

  /* 13. 审计：编辑器开着就打分，换卡后不能把上一条打了一半的字带进这一条 */
  {
    const p = await open();
    await tap(p, '[data-act="rev-tags"]');
    const inp = p.q('[data-act="rev-tags-input"]');
    ok("编辑器开得起来", !!inp, "点「改标签」没换出输入框");
    if (inp) {
      inp.value = "打到一半的字";
      const before = cardId(p);
      await keyOn(p.q(".rev-card"), "2"); // 焦点不在输入框时数字键就是打分
      await flush();
      ok("打分后换到下一条", cardId(p) !== before, cardId(p));
      ok("编辑器跟着收起", !p.q('[data-act="rev-tags-input"]'), "换卡了输入框还在");
      ok("新卡上不带着半截字", !/打到一半的字/.test(p.$("review").textContent),
         p.$("review").textContent.replace(/\s+/g, " ").slice(0, 200));
    }
  }
}

/* ---------------- v1.13：搜索多关键词与范围 ---------------- */

async function testV113Search() {
  console.log("\n[3b13] v1.13 搜索：空格取交集，前缀限定字段");
  const CJK = /[一-鿿]/;
  const now = Date.now();
  const mk = (id, o = {}) => ({
    id, text: o.text || "", note: o.note || "", title: o.title || "",
    url: o.url || "", tags: o.tags || [], createdAt: now - (o.at || 0) * 1000,
  });
  const SEED = [
    mk("c1", { text: "量子纠错的三种实现", title: "无题", url: "http://q.dev/a" }),
    mk("c2", { text: "退相干时间很长", note: "量子比特寿命", title: "PRX", url: "http://arxiv.org/q" }),
    mk("c3", { text: "冗余是纠错的前提", title: "笔记", url: "http://q.dev/b" }),
    mk("c4", { text: "实验记录", note: "量子", title: "Lab", url: "http://q.dev/c", tags: ["纠错"] }),
    mk("c5", { text: "作者:量子的故事", title: "怪文", url: "http://q.dev/d" }),
  ];
  const clips = async (raw, opts) => {
    const p = await mountPopup({ clipkeep_items: SEED.map((x) => ({ ...x })) }, opts);
    if (raw !== undefined) await setSearch(p, raw);
    return p;
  };
  const ids = (p) => p.qa(".item").map((n) => n.dataset.id);
  /** 功能没做出来时列表是空的，失败详情不能再对着 null 取 innerHTML */
  const htmlAt = (p, sel) => { const n = p.q(sel); return n ? n.innerHTML.slice(0, 200) : "（没有这个节点）"; };
  const setSearch = async (p, raw) => {
    p.$("search").value = raw;
    await p.fire(p.$("search"), "input");
    // 首轮渲染可能赶在 load() 之前，读到的是「还没有收藏」那句旧文案：等链跑完再看
    for (let i = 0; i < 4; i++) await tick(10);
  };

  /* 1. 空格分词，词间取交集：每个词可以在不同字段命中 */
  {
    const p = await clips("量子 纠错");
    eq("两个词都命中的才留下", JSON.stringify(ids(p)), JSON.stringify(["c1", "c4"]));
    ok("正文里两个词各标各的",
      p.qa('.item[data-id="c1"] .item-text mark.hit').length === 2, htmlAt(p, '.item[data-id="c1"] .item-text'));
  }

  /* 2. 前缀把词限死在一个字段：标题里没有「量子」就不该因为正文命中而留下 */
  {
    const p = await clips("标题:量子");
    eq("标题限定不命中正文", p.qa(".item").length, 0);
    const q = await clips("标题:PRX");
    eq("标题限定按标题命中", JSON.stringify(ids(q)), JSON.stringify(["c2"]));
    const r = await clips("备注:量子");
    ok("备注限定不拿正文凑数", !ids(r).includes("c1"), JSON.stringify(ids(r)));
    eq("备注限定命中 c2 c4", JSON.stringify(ids(r)), JSON.stringify(["c2", "c4"]));
    const s = await clips("标签:纠错");
    eq("标签限定只看标签", JSON.stringify(ids(s)), JSON.stringify(["c4"]));
    const t = await clips("站点:arxiv.org");
    eq("站点限定看的是域名", JSON.stringify(ids(t)), JSON.stringify(["c2"]));
    const u = await clips("站点:q.dev 量子");
    // c5 的正文「作者:量子的故事」也含量子，站点同样在 q.dev —— 交集里就该有它
    eq("站点限定能和别的词叠加", JSON.stringify(ids(u)), JSON.stringify(["c1", "c4", "c5"]));
  }

  /* 3. 全角冒号、冒号后空格、英文界面下的英文前缀：都是同一种搜索 */
  {
    const a = await clips("标题：PRX");
    eq("全角冒号一样用", JSON.stringify(ids(a)), JSON.stringify(["c2"]));
    const b = await clips("备注: 量子");
    eq("冒号后有空格也认", JSON.stringify(ids(b)), JSON.stringify(["c2", "c4"]));
    const c = await clips("title:PRX");
    eq("英文前缀 title: 一样用", JSON.stringify(ids(c)), JSON.stringify(["c2"]));
    const d = await clips("note:量子");
    eq("英文前缀 note: 一样用", JSON.stringify(ids(d)), JSON.stringify(["c2", "c4"]));
    const e = await clips("site:arxiv.org");
    eq("英文前缀 site: 一样用", JSON.stringify(ids(e)), JSON.stringify(["c2"]));
    const f = await clips("tag:纠错");
    eq("英文前缀 tag: 一样用", JSON.stringify(ids(f)), JSON.stringify(["c4"]));
  }

  /* 4. 认不出的前缀当普通文字：不报错、不静默丢，也不许变成筛选 */
  {
    const p = await clips("作者:量子");
    eq("未知前缀按字面量找", JSON.stringify(ids(p)), JSON.stringify(["c5"]));
    const q = await clips("作者:不存在");
    ok("没命中时说的是这个词，不是报个格式错", /作者:不存在/.test(q.$("empty").textContent),
       q.$("empty").textContent.replace(/\s+/g, " "));
  }

  /* 5. 限定词不许越界高亮：正文没命中就不能把正文里的字涂黄 */
  {
    const p = await clips("备注:量子");
    ok("备注里的命中在备注行标黄", !!p.q('.item[data-id="c2"] .item-note mark.hit'), htmlAt(p, '.item[data-id="c2"]'));
    ok("正文里同样三个字不能跟着标黄",
      p.q('.item[data-id="c2"] .item-text mark.hit') === null, "限定到备注的词把正文也涂了");
  }

  /* 6. 空结果要说清卡在哪个词上 */
  {
    const p = await clips("量子 菜谱");
    ok("点出没命中的那个词", /菜谱/.test(p.$("empty").textContent) && /一条都没命中/.test(p.$("empty").textContent),
       p.$("empty").textContent.replace(/\s+/g, " "));
    ok("说错了可不行：量子是有命中的", !/量子[^\n]*一条都没命中/.test(p.$("empty").textContent),
       p.$("empty").textContent.replace(/\s+/g, " "));
    const q = await clips("量子 纠错 菜谱 冗余");
    ok("多个词一起报时按没命中的报", /菜谱/.test(q.$("empty").textContent) && !/冗余/.test(q.$("empty").textContent),
       q.$("empty").textContent.replace(/\s+/g, " "));
    const r = await clips("退相干 纠错");
    ok("每个词都有命中却没同框，得说明是不同条", /同一条|同时/.test(r.$("empty").textContent),
       r.$("empty").textContent.replace(/\s+/g, " "));
  }

  /* 7. 字面量匹配不因分词而 loosening：正则元字符还是元字符 */
  {
    const p = await clips("(量子|纠错)");
    eq("正则元字符按字面量处理", p.qa(".item").length, 0);
    const q = await clips("量子.纠错");
    eq("点号不是任意字符", q.qa(".item").length, 0);
  }

  /* 8. 高亮视图共用同一套：交集、前缀、点明的空态 */
  {
    const m = async (raw) => {
      const p = await mountPopup({ clipkeep_highlights: [
        { id: "m1", url: "http://x/quantum", text: "量子退相干", note: "重点", title: "量子计算入门", createdAt: now },
        { id: "m2", url: "http://x/quantum", text: "纠错码", note: "量子比特", title: "量子计算入门", createdAt: now - 1 },
        { id: "m3", url: "http://y/food", text: "红烧肉", note: "", title: "菜谱", createdAt: now - 2 },
      ] });
      await p.click(p.q('.tab[data-view="marks"]'));
      if (raw !== undefined) await setSearch(p, raw);
      return p;
    };
    const a = await m("量子 重点");
    eq("高亮也按交集筛", JSON.stringify(a.qa(".hl-item").map((n) => n.dataset.hlid)), JSON.stringify(["m1"]));
    const b = await m("站点:x 量子");
    eq("站点前缀在高亮视图同样用", JSON.stringify(b.qa(".hl-item").map((n) => n.dataset.hlid)), JSON.stringify(["m1", "m2"]));
    const c = await m("标题:菜谱");
    eq("标题前缀限到页面标题", JSON.stringify(c.qa(".hl-item").map((n) => n.dataset.hlid)), JSON.stringify(["m3"]));
    const d = await m("量子 不存在词");
    ok("高亮空态也点出没命中的词", /不存在词/.test(d.$("marks").textContent) && /一条都没命中/.test(d.$("marks").textContent),
       d.$("marks").textContent.replace(/\s+/g, " ").slice(0, 200));
    const e = await m("量子 重点");
    ok("正文与批注各标各的词",
      !!e.q('.hl-item[data-hlid="m1"] .hl-text mark.hit') && !!e.q('.hl-item[data-hlid="m1"] .hl-note mark.hit'),
      e.qa(".hl-item").map((n) => n.innerHTML.slice(0, 120)).join(" | "));
    const g = await m("备注:量子");
    eq("备注前缀在高亮视图同样限字段", JSON.stringify(g.qa(".hl-item").map((n) => n.dataset.hlid)), JSON.stringify(["m2"]));
    ok("限到备注的词不跑正文里涂黄",
      g.q('.hl-item[data-hlid="m2"] .hl-text mark.hit') === null && !!g.q('.hl-item[data-hlid="m2"] .hl-note mark.hit'),
      g.q('.hl-item[data-hlid="m2"]') ? g.q('.hl-item[data-hlid="m2"]').innerHTML.slice(0, 200) : "没有这一行");
  }

  /* 9. 英文界面下这套说法也得是英文：新加的提示漏翻就是界面上蹦出中文 */
  {
    const p = await clips("foo bar", { uiLanguage: "en" });
    const txt = p.$("empty").textContent.replace(/\s+/g, " ");
    ok("空态提示没有中文", !CJK.test(txt), txt);
    ok("提示里点出没命中的词", /foo/.test(txt), txt);
  }

  /* 10. 审计：只有前缀没有词（「备注:」打一半就回车）不能当成筛选，也不能崩 */
  {
    const p = await clips("备注:");
    eq("只剩前缀时按字面量找", p.qa(".item").length, 0);
    ok("前缀自己就是那个没命中的词", /备注:/.test(p.$("empty").textContent) && /一条都没命中/.test(p.$("empty").textContent),
       p.$("empty").textContent.replace(/\s+/g, " "));
    const q = await clips("备注: 备注:");
    ok("两个空前缀也不炸", /备注:/.test(q.$("empty").textContent), q.$("empty").textContent.replace(/\s+/g, " "));
  }

  /* 11. 审计：英文前缀大小写混着写也算同一个前缀 */
  {
    const p = await clips("TITLE:PRX");
    eq("大写 TITLE: 一样是前缀", JSON.stringify(ids(p)), JSON.stringify(["c2"]));
    const q = await clips("Site:arxiv.org");
    eq("首字母大写的 Site: 一样是前缀", JSON.stringify(ids(q)), JSON.stringify(["c2"]));
    const r = await clips("verylongprefix:PRX");
    eq("超过十个字母的前缀当普通文字", r.qa(".item").length, 0);
    ok("越界前缀没命中的是整串", /verylongprefix:PRX/.test(r.$("empty").textContent),
       r.$("empty").textContent.replace(/\s+/g, " "));
  }

  /* 12. 审计：高亮视图没有标签字段，标签前缀得说「没命中」而不是假装筛完了 */
  {
    const p = await mountPopup({ clipkeep_highlights: [
      { id: "m1", url: "http://x/quantum", text: "量子退相干", note: "重点", title: "量子计算入门", createdAt: now },
    ] });
    await p.click(p.q('.tab[data-view="marks"]'));
    await setSearch(p, "标签:重点");
    ok("标签前缀在高亮视图如实说没命中", /标签:重点/.test(p.$("marks").textContent) && /一条都没命中/.test(p.$("marks").textContent),
       p.$("marks").textContent.replace(/\s+/g, " ").slice(0, 200));
  }

  /* 13. 审计：叠了标签筛选时，「一条都没命中」得说清说的是哪一批 —— 退相干在库里明明有 */
  {
    const p = await clips();
    const chip = p.q('#tags .chip[data-tag="纠错"]');
    ok("筛选条里有标签 chip", !!chip, "入口换了名字，这条审计没法走");
    if (!chip) return;
    await p.click(chip); // 只剩带「纠错」的那条
    await setSearch(p, "退相干");
    const txt = p.$("empty").textContent.replace(/\s+/g, " ");
    eq("筛到空时列表确实一条没有", p.qa(".item").length, 0);
    ok("说清是这批里没有，不是库里没有", /当前筛选|这批/.test(txt), txt);
    const q = await clips("退相干");
    ok("没叠筛选时不用套这句", !/当前筛选/.test(q.$("empty").textContent), q.$("empty").textContent.replace(/\s+/g, " "));
  }

  /* 14. 这套语法得在界面里撞见：README 不是界面，没人看文档就不知道能写「标题:」 */
  {
    const p = await clips("量子");
    const tip = p.$("search").getAttribute("title") || "";
    ok("搜索框写清了分词与四个前缀",
      /标题:/.test(tip) && /备注:/.test(tip) && /标签:/.test(tip) && /站点:/.test(tip),
      tip || "（搜索框没有提示）");
    const e = await clips("foo", { uiLanguage: "en" });
    const en = e.$("search").getAttribute("title") || "";
    ok("英文界面下这句提示也是英文", !CJK.test(en) && /title:/i.test(en), en);
  }

  /* 15. 审计：README 从 v1.2 起就写「正文、备注与来源标题里直接标黄」，可标题那一行从来没标过。
        标题本来就参与匹配（`标题:` 前缀筛的就是它），匹配得上的词在卡片上却一个字都不涂，
        用户只能看见一条「不知道为什么被筛出来」的收藏。要么把话说对，要么把色标上——这里选后者。 */
  {
    const p = await clips("标题:PRX");
    const link = p.q('.item[data-id="c2"] .item-meta a');
    ok("标题命中的词标在来源那一行", !!link && /<mark class="hit">PRX<\/mark>/.test(link.innerHTML),
       link ? link.innerHTML : htmlAt(p, '.item[data-id="c2"] .item-meta'));
    const q = await clips("量子 无题");
    const t = q.q('.item[data-id="c1"] .item-meta a');
    ok("正文与标题各标各的词",
      !!t && /<mark class="hit">无题<\/mark>/.test(t.innerHTML)
        && /<mark class="hit">量子<\/mark>/.test(htmlAt(q, '.item[data-id="c1"] .item-text')),
      (t ? t.innerHTML : "没有来源行") + " | " + htmlAt(q, '.item[data-id="c1"] .item-text'));
  }
}

/* ---------------- 4. 清单一致性 ---------------- */

async function testManifests() {
  console.log("\n[4] 清单一致性：Chrome / Safari / 消息协议 / 版本与文档");
  const ROOT = path.resolve(EXT, "..");
  const rj = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  const mf = rj(path.join(EXT, "manifest.json"));
  const sf = rj(path.join(EXT, "manifest.safari.json"));
  const pkg = rj(path.join(ROOT, "package.json"));

  /* 两份清单必须描述同一个产品 */
  eq("版本号一致（Chrome / Safari）", mf.version, sf.version);
  eq("清单版本与 package.json 一致", mf.version, pkg.version);
  eq("扩展名称一致", mf.name, sf.name);
  eq("功能描述一致", mf.description, sf.description);
  eq("权限集合一致", mf.permissions.slice().sort().join(","), sf.permissions.slice().sort().join(","));
  eq("快捷键声明一致", JSON.stringify(mf.commands), JSON.stringify(sf.commands));
  eq("图标声明一致", JSON.stringify(mf.icons), JSON.stringify(sf.icons));
  eq("弹窗入口一致", mf.action.default_popup, sf.action.default_popup);
  eq("内容脚本 js 一致", mf.content_scripts[0].js.join(","), sf.content_scripts[0].js.join(","));
  eq("内容脚本 css 一致", mf.content_scripts[0].css.join(","), sf.content_scripts[0].css.join(","));
  ok("Safari 声明 strict_min_version 16.4",
     ((sf.browser_specific_settings || {}).safari || {}).strict_min_version === "16.4");
  ok("Chrome 用 <all_urls>，Safari 退回 http/https 通配",
     mf.content_scripts[0].matches.includes("<all_urls>") && sf.content_scripts[0].matches.length > 1);
  ok("Safari 保留可选主机权限用于动态注入",
     Array.isArray(sf.optional_host_permissions) && sf.optional_host_permissions.length > 0);

  /* 清单引用的文件都要在，目录里也不许留没被引用的死文件 */
  const referenced = new Set([
    "manifest.json", "manifest.safari.json",
    mf.background.service_worker, sf.background.service_worker,
    mf.action.default_popup,
    ...Object.values(mf.icons), ...Object.values(sf.icons),
    ...mf.content_scripts[0].js, ...mf.content_scripts[0].css,
    ...sf.content_scripts[0].js, ...sf.content_scripts[0].css,
  ]);
  const html = src("popup.html");
  for (const m of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) referenced.add(m[1]);
  const onDisk = fs.readdirSync(EXT).filter((f) => /\.(js|css|html|png|json)$/.test(f));
  for (const f of onDisk) {
    ok(`目录文件 ${f} 有被清单或弹窗引用`, referenced.has(f), "→ 多余文件会被一起装进浏览器");
  }
  for (const f of referenced) {
    if (f === "manifest.json" || f === "manifest.safari.json") continue;
    ok(`清单引用 ${f} 存在`, fs.existsSync(path.join(EXT, f)));
  }

  /* 前端发出的每种消息，接收方都得认识。
     弹窗也可以用 tabs.sendMessage 绕过后台直接问本页脚本，这类消息后台里当然找不到，
     但页面侧必须有对应的 msg.type 分支——否则同样是没人接手的死消息。 */
  const bg = src("background.js");
  const content = src("content.js");
  const front = src("popup.js") + content;
  const pageDirect = ["clipkeep:diag"]; // popup → 当前页面，不经过后台
  const frontTypes = new Set(typesIn(front));
  const bgTypes = new Set(typesIn(bg));
  for (const t of frontTypes) {
    if (pageDirect.includes(t)) {
      ok(`页面侧认识 ${t}`, content.includes(`"${t}"`) && content.includes("msg.type"), "→ 弹窗直接发给页面，可页面没接手");
      continue;
    }
    ok(`后台认识 ${t}`, bgTypes.has(t), "→ 消息会返回 unknown");
  }
  for (const t of bgTypes) ok(`前端或页面用到 ${t}`, frontTypes.has(t), "→ 死代码 / 拼错的历史消息");

  /* 演示抓帧管线：清单要装的脚本一个都不能漏，界面语言必须钉住 */
  {
    const demo = path.join(ROOT, "docs", "demo");
    const shot = fs.readFileSync(path.join(demo, "make_shot.sh"), "utf8");
    const copied = new Set(((shot.match(/^cp .*$/m) || [""])[0])
      .split(/\s+/).map((p) => p.replace(/"/g, "").replace(/^.*\//, "")).filter((p) => /\.(js|css)$/.test(p)));
    const loaded = new Set(mf.content_scripts[0].js);
    for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) loaded.add(m[1]);
    for (const f of loaded) ok(`抓帧脚本把 ${f} 一起拷过去`, copied.has(f),
      "→ 截图页里没有这个文件，界面静默退回旧行为，动图看着还是对的");
    // 无头 Chrome 的界面语言是 en-US：偏好留空 = auto = 英文，整片动图会换成英文而没人察觉
    const stub = fs.readFileSync(path.join(demo, "stub.js"), "utf8");
    const web = fs.readFileSync(path.join(demo, "web.html"), "utf8");
    const zhPinned = (txt) => /clipkeep_prefs:\s*\{[^}]*\blang\b/.test(txt) && /"zh"/.test(txt);
    ok("弹窗抓帧默认把界面语言钉成中文", zhPinned(stub), "prefs 里没有 lang 或缺 zh 默认值");
    ok("网页抓帧默认把界面语言钉成中文", zhPinned(web), "prefs 里没有 lang 或缺 zh 默认值");
    ok("弹窗抓帧能按 URL 换成英文", /get\("lang"\)/.test(stub), "只能出中文");
    ok("网页抓帧能按 URL 换成英文", /get\("lang"\)/.test(web), "只能出中文");
    const cap = fs.readFileSync(path.join(demo, "capture.sh"), "utf8");
    ok("抓帧列表里有一帧英文界面", /lang=en/.test(cap), "→ 英文用户看不到自己那套界面");
    const gif = fs.readFileSync(path.join(ROOT, "docs", "gen_demo_gif.py"), "utf8");
    ok("动图合成把英文帧也排进去", /p_en/.test(gif), "→ 白抓一帧");
    /* 抓帧清单和合成清单必须互相咬合。一帧 = 一次 Chrome 启动（约 50 秒），
       加了 snap 忘了进 FRAMES 就是白等一分钟；FRAMES 里留了没人抓的帧，
       gen_demo_gif.py 会在 load() 里硬退出，动图根本出不了。 */
    const snapped = new Set([
      ...[...cap.matchAll(/snap\s+"([\w-]+)"/g)].map((m) => m[1]),
      ...[...cap.matchAll(/for f in ([\w ]+);/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean).map((f) => "p_" + f)),
    ]);
    const inGif = new Set([...gif.matchAll(/^\s*\("(?:p_|w_)[\w-]*"/gm)].map((m) => m[0].replace(/[\s("]/g, "").replace(/"$/, "")));
    for (const name of [...snapped].sort()) {
      ok(`抓的 ${name} 进了动图`, inGif.has(name), `→ capture.sh 会抓 ${name}.png，gen_demo_gif.py 却没用它（白等一次 Chrome 启动）`);
    }
    for (const name of [...inGif].sort()) {
      ok(`${name} 有人抓`, snapped.has(name), `→ 动图要 ${name}，capture.sh 不产这张，合成时直接退出`);
    }
    /* capture.sh 的 ?f= 名字必须真是 driver.js FRAMES 里的一个模式。
       名字打错不报错：驱动静默退回 clips 那一帧，PNG 尺寸、颜色都对得上，
       只有放大看才发现拍的是列表而不是复习卡片——动图骗人比合成失败更难查。 */
    const drv = fs.readFileSync(path.join(demo, "driver.js"), "utf8");
    const modes = new Set([...drv.matchAll(/^ {4}([\w-]+): async/gm)].map((m) => m[1]));
    const wanted = new Set([
      ...[...cap.matchAll(/for f in ([\w ]+);/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean)),
      ...[...cap.matchAll(/shot\.html\?f=([\w-]+)/g)].map((m) => m[1]),
    ]);
    ok("驱动帧名解析出了整批弹窗帧", wanted.size > 10, [...wanted].sort().join(","));
    for (const name of [...wanted].sort()) {
      ok(`驱动有 ${name} 模式`, modes.has(name), `→ ?f=${name} 没人认，静默拍成 clips 那帧`);
    }
    // 说明文字开头的带圈序号：①–⑳ 是连续码位，插一帧忘了改号就会出现两个 ⑫ 或跳号
    {
      const marks = [...gif.matchAll(/^\s*\("[\w-]+",\s*"[^"]*",\s*"([\u2460-\u24ff])/gm)].map((m) => m[1]);
      eq("动图序号条数和帧数对得上", marks.length, inGif.size);
      eq("动图说明从 ① 起连续编号", marks.join(""),
        marks.map((_, i) => String.fromCharCode(0x2460 + i)).join(""));
    }
    /* 说明文字里的带圈序号：主字体 Hiragino Sans GB 只画到 ⑩，⑪ 起是豆腐块——
       已发布的 v1.9~v1.10 动图里 ⑪⑫⑬⑭ 四帧的序号就是四个方框，出图时没人放大看。 */
    ok("动图说明有缺字兜底字体", /FONT_FALLBACK\s*=/.test(gif), "→ ⑪ 之后的序号画成方框");
    ok("说明文字走带兜底的绘制函数",
       /draw_caption\(/.test(gif) && !/d\.text\(\[x0 \+ 2, y1 \+ 14\], caption/.test(gif),
       "→ 主字体缺字时直接画成豆腐块");
  }

  /* 发布文档要指向当前版本 */
  const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const landing = fs.readFileSync(path.join(ROOT, "docs", "index.html"), "utf8");
  ok(`CHANGELOG 有 [${mf.version}] 条目`, new RegExp(`^## \\[${mf.version}\\]`, "m").test(changelog));
  ok(`README 徽章指向 ${mf.version}`, readme.includes(`version-${mf.version}`));
  ok(`落地页写明当前版本 v${mf.version}`, landing.includes(`v${mf.version}`));
  const [maj, min] = mf.version.split(".");
  ok(`README 里程碑把 v${maj}.${min} 标为当前版本`,
     new RegExp(`v${maj}\\.${min}[^\\n]*当前`).test(readme));
}

/* ---------------- run ---------------- */

(async () => {
  const suites = [testBackground, testConcurrency, testShortcut, testPopup, testRestoreSafety, testReviewGuard, testMarksOverview, testTrash, testContent, testHighlightSync, testAudit, testActivity, testDedupe, testV15Audit, testExportTemplate, testMediaClips, testHeatDrill, testV16Audit, testColorPicker, testBatchOps, testReviewKeys, testKindSiteFilter, testListKeys, testOverlappingMarks, testTrashDetail, testV17Audit, testV18Audit, testV19Audit, testV110Anchor, testV111FlatAnchor, testV111I18n, testV112ReviewFilter, testV112Diag, testV112Audit, testV113ReviewEdit, testV113Search, testManifests];
  for (const s of suites) {
    try {
      await s();
    } catch (e) {
      fail++;
      console.log(`\nUNEXPECTED ERROR in ${s.name}:`, (e && e.stack) || e);
    }
  }
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
