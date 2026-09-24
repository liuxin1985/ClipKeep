/**
 * ClipKeep 自动化测试
 * 用 jsdom 加载仓库里真实的 background.js / popup.html + popup.js / content.js，
 * 覆盖：消息路由、Leitner 间隔重复调度、JSON 备份→清空→恢复、划词高亮重放与删除。
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
  ok(name + (good ? "" : ` (got ${a}, want ${b})`), good);
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 共享存储 + background 消息路由 ---------------- */

function makeBackend() {
  const store = { clipkeep_items: [], clipkeep_highlights: [], clipkeep_prefs: {} };
  const listeners = [];
  const hlListeners = [];

  const chrome = {
    runtime: {
      id: "test",
      onInstalled: { addListener() {} },
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
      removeAll(cb) { if (cb) cb(); },
      create() {},
      onClicked: { addListener() {} },
    },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => {}, create() {} },
    scripting: { executeScript: async () => {} },
  };

  // 在沙箱里跑真实的 background.js，注册消息路由
  const ctx = vm.createContext({ chrome, console, setTimeout, Date, Math, JSON, String, Number, Array, Object, Promise });
  vm.runInContext(src("background.js"), ctx);

  const send = async (msg) => {
    let reply;
    await listeners[0](msg, { tab: { id: 1 } }, (r) => { reply = r; });
    await tick(0);
    return reply;
  };
  return { store, chrome, send };
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
}

/* ---------------- 2. popup：间隔重复 + 备份/恢复 ---------------- */

async function testPopup() {
  console.log("\n[2] popup 回顾调度 + 备份恢复");
  const { store, chrome, send } = makeBackend();
  const DAY = 86400000;
  const now = Date.now();

  // 造数据：2 条到期、1 条未到期
  store.clipkeep_items = [
    { id: "a", text: "第一条", note: "", tags: ["算法"], url: "http://x/1", title: "页面一", createdAt: now - 3 * DAY, review: { box: 0, due: now - 10, seen: 0 } },
    { id: "b", text: "第二条", note: "备注B", tags: ["英语"], url: "http://x/2", title: "页面二", createdAt: now - 2 * DAY, review: { box: 1, due: now - 5, seen: 1 } },
    { id: "c", text: "第三条", note: "", tags: [], url: "", title: "", createdAt: now - DAY, review: { box: 3, due: now + DAY, seen: 3 } },
  ];

  let downloaded = null;
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => { if (!/createObjectURL/.test(String(e))) console.log("  jsdomError:", e.message); });
  const dom = new JSDOM(src("popup.html"), { runScripts: "outside-only", url: "chrome-extension://abc/popup.html", virtualConsole: vc });
  const w = dom.window;
  w.chrome = chrome;
  w.URL.createObjectURL = (b) => { b.text().then((t) => { downloaded = t; }); return "blob:x"; };
  w.URL.revokeObjectURL = () => {};
  w.prompt = () => "新标签";
  w.confirm = () => true;
  dom.window.eval(src("popup.js"));
  await tick(10);

  const $ = (id) => w.document.getElementById(id);
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = async (el) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await tick(10); };

  eq("计数徽标", $("count").textContent, "3");
  ok("到期徽标可见", $("due").hidden === false);
  eq("到期条数", $("due").textContent, "2");
  eq("收藏列表条目数", qa(".item").length, 3);

  // 切到回顾视图
  await click(q('.tab[data-view="review"]'));
  ok("回顾视图显示", $("view-review").hidden === false && $("view-clips").hidden === true);
  eq("优先复习最早的一条", q(".rev-card").dataset.id, "a");
  ok("进度行含记忆盒", /记忆盒 0\/5/.test(q(".rev-progress").textContent));
  ok("答案默认隐藏", q(".rev-back").hidden === true);
  ok("评分按钮默认隐藏", q(".rev-grade").hidden === true);

  await click(q('.rev-reveal'));
  ok("显示答案后面板打开", q(".rev-back").hidden === false && q(".rev-grade").hidden === false);

  const before = store.clipkeep_items.find((x) => x.id === "a").review;
  await click(q('.mini-btn.good'));
  const after = store.clipkeep_items.find((x) => x.id === "a").review;
  eq("记得 → 盒+1", after.box, before.box + 1);
  eq("seen 计数+1", after.seen, before.seen + 1);
  eq("到期时间≈1天后", after.due - Date.now(), 1 * DAY, 5000);
  ok("答完自动切到下一条", q(".rev-card").dataset.id === "b");

  await click(q('.mini-btn.again'));
  eq("忘记 → 回到盒 0", store.clipkeep_items.find((x) => x.id === "b").review.box, 0);
  ok("盒 0 立即再次到期", store.clipkeep_items.find((x) => x.id === "b").review.due <= Date.now() + 50);
  eq("仍在原条（因立即到期）", q(".rev-card").dataset.id, "b");

  await click(q('.mini-btn.easy'));
  eq("简单 → 盒+2", store.clipkeep_items.find((x) => x.id === "b").review.box, 2);

  // 全部到期项处理完 → 完成态
  await click(q('.tab[data-view="clips"]'));
  await click(q('.tab[data-view="review"]'));
  ok("无到期时显示完成态", /今日回顾已完成/.test($("review").textContent));
  ok("完成态徽标隐藏", $("due").hidden === true);

  // —— 备份 ——
  await click($("btn-backup"));
  await tick(10);
  const backup = JSON.parse(downloaded);
  eq("备份 app 标识", backup.app, "ClipKeep");
  eq("备份含 3 条收藏", backup.items.length, 3);
  ok("备份含 highlights 数组", Array.isArray(backup.highlights));
  ok("备份含时间戳", typeof backup.exportedAt === "string");

  // —— 清空后恢复 ——
  await click($("btn-clear"));
  eq("清空后本地 0 条", store.clipkeep_items.length, 0);
  const fileInput = $("file");
  const file = new w.File([JSON.stringify(backup)], "bk.json", { type: "application/json" });
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick(20);
  eq("恢复后回到 3 条", store.clipkeep_items.length, 3);
  ok("恢复保留 review 进度", store.clipkeep_items.find((x) => x.id === "b").review.box === 2);
  eq("恢复按时间倒序", store.clipkeep_items[0].id, "c");

  // 再恢复一次应幂等（不产生重复）
  fileInput.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick(20);
  eq("重复恢复不新增", store.clipkeep_items.length, 3);

  // 坏文件不炸
  const bad = new w.File(["{ not json"], "bad.json", { type: "application/json" });
  Object.defineProperty(fileInput, "files", { value: [bad], configurable: true });
  fileInput.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick(20);
  eq("坏文件被拒绝且数据完好", store.clipkeep_items.length, 3);
  ok("坏文件给出提示", /恢复失败/.test($("toast").textContent));

  // 单条导出 Markdown
  downloaded = null;
  await click(q('.tab[data-view="clips"]'));
  await click(qa('.item')[0].querySelector('[data-act="export"]'));
  await tick(10);
  ok("单条导出为 Markdown", /^# ClipKeep 收藏/.test(downloaded) && /第三条/.test(downloaded));
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
  dom.window.eval(src("content.js"));
  await tick(20);

  const marks = [...w.document.querySelectorAll("mark.clipkeep-hl")];
  eq("本页重放高亮数（跨页高亮被过滤）", marks.length, 2);
  ok("绿色高亮应用了颜色", marks.some((m) => /#c7f5c7|rgb\(199, 245, 199\)/.test(m.style.background)));
  ok("带批注的高亮有 has-note 类", marks.some((m) => m.classList.contains("has-note")));
  eq("批注写入 title", marks.find((m) => m.dataset.hlid === "h1").title, "ClipKeep 批注：重点");
  ok("高亮文本完整保留", marks.some((m) => m.textContent === "量子比特可以同时处于两种状态"));
  ok("原文其余文字未被破坏", /这是并行性的来源/.test(w.document.body.textContent));

  // 对未高亮文本建立选区 → 调用工具条 🖍
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
  const hlBtn = bar.querySelector(".clipkeep-btn-hl");
  ok("工具条含高亮按钮", !!hlBtn);
  hlBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(30);
  const stored = store.clipkeep_highlights.filter((h) => h.url === url);
  eq("新增高亮已落盘", stored.length, 4);
  eq("新高亮记录选中文本", stored[3].text, selText);
  eq("新高亮颜色为 yellow", stored[3].color, "yellow");
  ok("新高亮出现在页面", !!w.document.querySelector(`mark[data-hlid="${stored[3].id}"]`));

  // 点击已有高亮 → 删除（prompt 返回 d）
  w.prompt = () => "d";
  const target = w.document.querySelector(`mark[data-hlid="h3"]`);
  ok("存在待删除高亮", !!target);
  target.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(30);
  ok("删除后存储中消失", store.clipkeep_highlights.every((h) => h.id !== "h3"));
  ok("删除后页面节点被unwrap", !w.document.querySelector('mark[data-hlid="h3"]'));

  // 阅读层未被误创建
  ok("初始无净化阅读层", !w.document.getElementById("clipkeep-reader"));
}

/* ---------------- run ---------------- */

(async () => {
  try {
    await testBackground();
    await testPopup();
    await testContent();
  } catch (e) {
    fail++;
    console.log("\nUNEXPECTED ERROR:", e && e.stack || e);
  }
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
