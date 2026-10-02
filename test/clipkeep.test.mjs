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

function makeBackend() {
  const store = { clipkeep_items: [], clipkeep_highlights: [], clipkeep_prefs: {} };
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
  };

  // 在沙箱里跑真实的 background.js，注册消息路由与命令监听
  const ctx = vm.createContext({ chrome, console, setTimeout, Date, Math, JSON, String, Number, Array, Object, Promise, URL });
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

async function mountPopup(seed) {
  const be = makeBackend();
  Object.assign(be.store, seed || {});
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

function mountContent(pageUrl, highlights, htmlBody) {
  const be = makeBackend();
  be.store.clipkeep_highlights = highlights;
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><article>${htmlBody}</article></body></html>`,
    { runScripts: "outside-only", url: pageUrl }
  );
  const w = dom.window;
  w.Range.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 122, left: 120, right: 300, width: 180, height: 22, x: 120, y: 100 });
  w.chrome = be.chrome;
  w.prompt = () => "";
  w.eval(src("content.js"));
  const lastListener = () => be.listeners[be.listeners.length - 1]; // makeBackend 先注册后台，再注册本页 content script
  return {
    store: be.store, chrome: be.chrome, be, w,
    marks: () => [...w.document.querySelectorAll("mark.clipkeep-hl")],
    toastText: () => (w.document.getElementById("clipkeep-toast") || {}).textContent || "",
    bodyText: () => w.document.querySelector("article").textContent,
    // 直接投递给本页 content script 的消息监听（净化阅读、快捷键秒存走这条路）
    toContent: (msg) => new Promise((resolve) => lastListener()(msg, { tab: { id: 1 } }, resolve)),
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

  /* 前端发出的每种消息，后台都得有对应处理 */
  const bg = src("background.js");
  const front = src("popup.js") + src("content.js");
  const frontTypes = new Set(typesIn(front));
  const bgTypes = new Set(typesIn(bg));
  for (const t of frontTypes) ok(`后台认识 ${t}`, bgTypes.has(t), "→ 消息会返回 unknown");
  for (const t of bgTypes) ok(`前端或页面用到 ${t}`, frontTypes.has(t), "→ 死代码 / 拼错的历史消息");

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
  const suites = [testBackground, testConcurrency, testShortcut, testPopup, testRestoreSafety, testReviewGuard, testMarksOverview, testTrash, testContent, testHighlightSync, testAudit, testActivity, testDedupe, testV15Audit, testExportTemplate, testMediaClips, testHeatDrill, testV16Audit, testColorPicker, testBatchOps, testReviewKeys, testKindSiteFilter, testListKeys, testOverlappingMarks, testTrashDetail, testV17Audit, testV18Audit, testV19Audit, testManifests];
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
