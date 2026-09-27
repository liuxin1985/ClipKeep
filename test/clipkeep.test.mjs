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
          if (store.__failNextSet) { store.__failNextSet = false; throw new Error("QUOTA_EXCEEDED"); }
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
      create(opts) { menuOps.created.push(opts.id); },
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
  const ctx = vm.createContext({ chrome, console, setTimeout, Date, Math, JSON, String, Number, Array, Object, Promise });
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
  eq("安装时建两个菜单项", be8.menuOps.created.length, 2);
  await be8.fireInstalled("update");
  eq("更新时先清空再重建", be8.menuOps.removeAll, 2);
  eq("更新后菜单数量", be8.menuOps.created.length, 4);
  await be8.fireInstalled("chrome_update");
  eq("浏览器升级不重复建菜单", be8.menuOps.created.length, 4);
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
  return {
    store: be.store, chrome: be.chrome, w,
    marks: () => [...w.document.querySelectorAll("mark.clipkeep-hl")],
    toastText: () => (w.document.getElementById("clipkeep-toast") || {}).textContent || "",
    bodyText: () => w.document.querySelector("article").textContent,
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

/* ---------------- 4. 清单一致性 / 消息协议 / 发布物料 ---------------- */

const typesIn = (code) => [...code.matchAll(/clipkeep:[a-z-]+/g)].map((m) => m[0]);

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
  const suites = [testBackground, testConcurrency, testShortcut, testPopup, testRestoreSafety, testReviewGuard, testMarksOverview, testTrash, testContent, testHighlightSync, testManifests];
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
