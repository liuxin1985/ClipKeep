/**
 * ClipKeep - background service worker (Manifest V3)
 * 兼容 Chrome / Edge / Safari 16.4+。
 * 负责：注册右键菜单、跨浏览器 API 适配、消息路由、本地存储读写。
 */

// 跨浏览器 API 适配层：Safari 暴露 browser.*，Chrome/Edge 暴露 chrome.*
const API = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;

const STORAGE_KEY = "clipkeep_items";
const HL_KEY = "clipkeep_highlights";
const TRASH_KEY = "clipkeep_trash";
const PREFS_KEY = "clipkeep_prefs";
const MAX_TEXT = 20000; // 单次收藏的文本上限，避免一次粘贴撑爆本地存储
const TRASH_TTL = 10 * 60 * 1000; // 回收站保留 10 分钟
const HL_COLORS = ["yellow", "green", "pink", "blue"];
const SAFE_ID = /^[\w-]{1,64}$/; // 外部数据的 id 只允许安全字符，避免拼进 HTML 时越出属性

/* ---------------- 存储读写 ---------------- */

async function readList(key) {
  const obj = await API.storage.local.get(key);
  const list = obj[key];
  return Array.isArray(list) ? list : [];
}

/**
 * 读改写串行化。
 * 每个操作都是「读全量 → 改 → 写全量」，两个标签页同时收藏时，
 * 后一个若读到前一个尚未落盘的快照，就会把对方刚存的数据整条覆盖掉。
 * 这里把所有变更排进同一条 promise 链，保证每次读到的都是最新状态。
 * 链内的步骤可以直接读写其它 key（见 pushTrash），但绝不能再调用 mutate* ，否则会自锁。
 */
let writeChain = Promise.resolve();

function chainStep(key, fn) {
  const step = async () => {
    const list = await readList(key);
    const out = (await fn(list)) || {};
    const next = out.list || out.items || list; // 两种写法都接受，clearAll 会传空数组
    if (out.write) await API.storage.local.set({ [key]: next });
    return out.result;
  };
  const result = writeChain.then(step, step); // 上一次失败不能卡死后续操作
  writeChain = result.then(noop, noop);
  return result;
}

const mutate = (fn) => chainStep(STORAGE_KEY, fn);
const mutateHl = (fn) => chainStep(HL_KEY, fn);
const mutateTrash = (fn) => chainStep(TRASH_KEY, fn);

function noop() {}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------- 回收站（删除可撤销） ---------------- */

function pruneTrash(trash) {
  const now = Date.now();
  return trash.filter((t) => t && t.item && now - (Number(t.deletedAt) || 0) <= TRASH_TTL);
}

/** 把删除的内容放进回收站；调用方已处于写链中，这里直接读写 */
async function pushTrash(entries) {
  const trash = await readList(TRASH_KEY);
  await API.storage.local.set({ [TRASH_KEY]: pruneTrash(entries.concat(trash)) });
}

function trashEntry(kind, item) {
  return { tid: makeId(), kind, item, deletedAt: Date.now() };
}

/** 还原一条回收记录到它自己的 key（同在写链内，直接读写） */
async function restoreEntry(entry) {
  const key = entry.kind === "hl" ? HL_KEY : STORAGE_KEY;
  const list = await readList(key);
  if (list.some((x) => x && x.id === entry.item.id)) return { ok: true, exists: true };
  if (entry.kind === "hl") list.push(entry.item);
  else {
    list.unshift(entry.item);
    list.sort((a, b) => ((b && b.createdAt) || 0) - ((a && a.createdAt) || 0));
  }
  await API.storage.local.set({ [key]: list });
  return { ok: true };
}

function normalizeTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,，\s]+/);
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
}

function addItem(payload) {
  const raw = ((payload && payload.text) || "").trim();
  if (!raw) return Promise.resolve({ ok: false, error: "empty" });
  const item = {
    id: makeId(),
    text: raw.slice(0, MAX_TEXT),
    note: ((payload && payload.note) || "").trim(),
    tags: normalizeTags(payload && payload.tags),
    url: (payload && payload.url) || "",
    title: (payload && payload.title) || "",
    createdAt: Date.now(),
  };
  if (raw.length > MAX_TEXT) item.truncated = true;
  return mutate((items) => {
    items.unshift(item);
    return { write: true, items, result: { ok: true, item, count: items.length } };
  });
}

function deleteItem(id) {
  return mutate(async (items) => {
    const idx = items.findIndex((it) => it.id === id);
    if (idx === -1) return { result: { ok: true, count: items.length } };
    const entry = trashEntry("clip", items[idx]);
    items.splice(idx, 1);
    await pushTrash([entry]); // 删除进回收站，10 分钟内可撤销
    return { write: true, items, result: { ok: true, count: items.length, trashed: true, tid: entry.tid } };
  });
}

function updateItem(id, patch) {
  return mutate((items) => {
    const idx = items.findIndex((it) => it.id === id);
    if (idx === -1) return { result: { ok: false, error: "not_found" } };
    const p = { ...(patch || {}) }; // 不改调用方传进来的对象
    if (p.tags !== undefined) p.tags = normalizeTags(p.tags);
    if (p.text !== undefined) {
      const t = String(p.text).trim();
      if (!t) return { result: { ok: false, error: "empty" } };
      p.text = t.slice(0, MAX_TEXT);
    }
    items[idx] = { ...items[idx], ...p, id };
    return { write: true, items, result: { ok: true, item: items[idx] } };
  });
}

function clearAll() {
  return mutate(() => ({ write: true, items: [], result: { ok: true } }));
}

/* ---------------- 高亮 / 批注（统一由后台串行写） ---------------- */

/** 只认白名单字段；缺 id 或 id 非法时重新生成 */
function cleanHighlight(payload) {
  const p = payload || {};
  const text = String(p.text || "").trim();
  const url = String(p.url || "");
  if (!text || !url) return null;
  const rawId = String(p.id === undefined || p.id === null ? "" : p.id);
  return {
    id: SAFE_ID.test(rawId) ? rawId : makeId(),
    url,
    title: String(p.title || ""),
    text,
    note: String(p.note || ""),
    color: HL_COLORS.indexOf(p.color) >= 0 ? p.color : "yellow",
    createdAt: Number(p.createdAt) || Date.now(),
  };
}

function addHighlight(payload) {
  const hl = cleanHighlight(payload);
  if (!hl) return Promise.resolve({ ok: false, error: "invalid" });
  return mutateHl((list) => {
    if (list.some((x) => x && x.id === hl.id)) {
      return { result: { ok: true, id: hl.id, dup: true, count: list.length } };
    }
    list.push(hl);
    return { write: true, list, result: { ok: true, id: hl.id, count: list.length } };
  });
}

function updateHighlight(id, patch) {
  const p = patch || {};
  const allowed = {};
  if (p.note !== undefined) allowed.note = String(p.note);
  if (p.color !== undefined && HL_COLORS.indexOf(p.color) >= 0) allowed.color = p.color;
  if (p.title !== undefined) allowed.title = String(p.title);
  if (!Object.keys(allowed).length) return Promise.resolve({ ok: false, error: "empty" });
  return mutateHl((list) => {
    const idx = list.findIndex((x) => x && x.id === id);
    if (idx === -1) return { result: { ok: false, error: "not_found" } };
    list[idx] = { ...list[idx], ...allowed };
    return { write: true, list, result: { ok: true, item: list[idx] } };
  });
}

function deleteHighlight(id) {
  return mutateHl(async (list) => {
    const idx = list.findIndex((x) => x && x.id === id);
    if (idx === -1) return { result: { ok: true, count: list.length } };
    const entry = trashEntry("hl", list[idx]);
    list.splice(idx, 1);
    await pushTrash([entry]);
    return { write: true, list, result: { ok: true, count: list.length, trashed: true, tid: entry.tid } };
  });
}

/* ---------------- 回收站 ---------------- */

function trashList() {
  return mutateTrash((trash) => {
    const next = pruneTrash(trash);
    return { write: next.length !== trash.length, list: next, result: { ok: true, items: next } };
  });
}

function trashRestore(tid) {
  return mutateTrash(async (trash) => {
    const idx = trash.findIndex((t) => t && t.tid === tid);
    if (idx === -1) return { result: { ok: false, error: "not_found" } };
    const entry = trash[idx];
    trash.splice(idx, 1);
    const res = await restoreEntry(entry);
    if (!res.ok) return { result: { ok: false, error: "restore_failed" } };
    return { write: true, list: trash, result: { ok: true, kind: entry.kind, exists: !!res.exists } };
  });
}

function trashClear() {
  return mutateTrash(() => ({ write: true, list: [], result: { ok: true } }));
}

/**
 * 标签操作：重命名 / 合并（to 已存在时即合并去重）/ 删除（to 传空串）
 */
function tagOp(payload) {
  const from = String((payload && payload.from) || "").trim();
  const to = String((payload && payload.to) || "").trim();
  if (!from) return Promise.resolve({ ok: false, error: "empty" });
  if (from === to) return Promise.resolve({ ok: true, changed: 0, noop: true });
  return mutate((items) => {
    let changed = 0;
    const next = items.map((it) => {
      const tags = Array.isArray(it.tags) ? it.tags : [];
      if (!tags.includes(from)) return it;
      const rest = tags.filter((t) => t !== from);
      changed++;
      return { ...it, tags: to ? normalizeTags(rest.concat(to)) : rest };
    });
    return { write: changed > 0, items: next, result: { ok: true, changed } };
  });
}

/**
 * 「覆盖本地」只能覆盖弹窗看到的那份快照：快照读完之后别处新增的记录
 * 没出现在差异提示里，回写时必须留下，否则又是一次丢失更新。
 */
function preserveSince(current, next, takenAt) {
  const t = Number(takenAt) || 0;
  if (!t) return next;
  const ids = new Set(next.map((x) => x && x.id));
  const late = current.filter((x) => x && x.id && (Number(x.createdAt) || 0) > t && !ids.has(x.id));
  return late.length ? next.concat(late) : next;
}

/** 整体替换收藏（恢复备份「覆盖本地」用），入参已在前端做过结构校验 */
function replaceAll(payload) {
  const incoming = Array.isArray(payload && payload.items) ? payload.items : null;
  if (!incoming) return Promise.resolve({ ok: false, error: "invalid" });
  return mutate((items) => {
    const next = preserveSince(items, incoming, payload && payload.takenAt)
      .slice()
      .sort((a, b) => ((b && b.createdAt) || 0) - ((a && a.createdAt) || 0));
    return { write: true, items: next, result: { ok: true, count: next.length } };
  });
}

/** 整体替换高亮 / 批注：和收藏一样走后台串行写，只覆盖快照内的内容 */
function replaceHighlights(payload) {
  const incoming = Array.isArray(payload && payload.highlights) ? payload.highlights : null;
  if (!incoming) return Promise.resolve({ ok: false, error: "invalid" });
  const clean = incoming.map(cleanHighlight).filter(Boolean);
  return mutateHl((list) => {
    const next = preserveSince(list, clean, payload && payload.takenAt);
    return { write: true, list: next, result: { ok: true, count: next.length } };
  });
}

/**
 * 按 id 合并（恢复备份「合并」用）：在 background 里现读现写。
 * 弹窗里那份快照可能是几十秒前读的，直接回写会抹掉期间新存的收藏。
 */
function mergeItems(payload) {
  const inItems = Array.isArray(payload && payload.items) ? payload.items : null;
  if (!inItems) return Promise.resolve({ ok: false, error: "invalid" });
  return mutate((items) => {
    const have = new Set(items.map((x) => x && x.id));
    const add = inItems.filter((x) => x && x.id && x.text && !have.has(x.id));
    add.forEach((x) => items.push(x));
    // 存储约定：新的在前，和列表视图一致
    items.sort((a, b) => ((b && b.createdAt) || 0) - ((a && a.createdAt) || 0));
    return {
      write: add.length > 0,
      items,
      result: { ok: true, added: add.length, count: items.length },
    };
  });
}

/* ---------------- 右键菜单 ---------------- */

function buildMenus() {
  if (!API.contextMenus) return;
  API.contextMenus.removeAll(() => {
    API.contextMenus.create({
      id: "clipkeep-save",
      title: "ClipKeep：收藏选中内容",
      contexts: ["selection"],
    });
    API.contextMenus.create({
      id: "clipkeep-reader",
      title: "ClipKeep：净化阅读本页",
      contexts: ["page"],
    });
    if (API.runtime.lastError) void API.runtime.lastError; // 读取以抑制告警
  });
}

// 菜单由浏览器持久保存，只在安装 / 扩展更新时建；
// 顶层再建一次会导致 service worker 每次唤醒都 removeAll→create，用户会在重建瞬间点不到菜单。
if (API.runtime && API.runtime.onInstalled) {
  API.runtime.onInstalled.addListener((details) => {
    const reason = (details && details.reason) || "install";
    if (reason === "install" || reason === "update") buildMenus();
  });
}

/** 把底层错误翻译成用户能看懂的话（不要把配额不足之类误报成「内容为空」） */
function saveFailMessage(err) {
  const s = String((err && err.message) || err || "");
  if (/quota|exceeded/i.test(s)) return "保存失败：本地存储已满，请先导出备份清理";
  return "保存失败，请刷新页面后重试";
}

if (API.contextMenus && API.contextMenus.onClicked) {
  API.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || tab.id === undefined) return;
    if (info.menuItemId === "clipkeep-save") {
      const text = (info.selectionText || "").trim();
      if (!text) return; // 空选区不打扰
      try {
        const res = await addItem({ text, url: info.pageUrl || tab.url || "", title: tab.title || "" });
        notifyTab(tab.id, {
          type: "clipkeep:toast",
          message: res.ok ? "已收藏 ✓" : res.error === "empty" ? "内容为空" : saveFailMessage(res),
        });
      } catch (err) {
        notifyTab(tab.id, { type: "clipkeep:toast", message: saveFailMessage(err) });
      }
    } else if (info.menuItemId === "clipkeep-reader") {
      runReader(tab);
    }
  });
}

function notifyTab(tabId, msg) {
  try {
    API.tabs.sendMessage(tabId, msg).catch(() => {});
  } catch (_) {
    /* Safari 下 sendMessage 可能同步抛错，忽略 */
  }
}

/* ---------------- 快捷键：秒存当前选区 ---------------- */

if (API.commands && API.commands.onCommand) {
  API.commands.onCommand.addListener(async (command) => {
    if (command !== "clipkeep-save-selection") return;
    let tabs = [];
    try {
      tabs = await API.tabs.query({ active: true, currentWindow: true });
    } catch (_) {
      return;
    }
    const tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) return;
    notifyTab(tab.id, { type: "clipkeep:save-selection" });
  });
}

/* ---------------- 净化阅读（优先用 content script，失败则注入） ---------------- */

async function runReader(tab) {
  try {
    await API.tabs.sendMessage(tab.id, { type: "clipkeep:reader" });
  } catch (_) {
    // content script 未注入（如受限页面），尝试动态注入
    if (API.scripting && API.scripting.executeScript) {
      try {
        await API.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"],
        });
        await API.tabs.sendMessage(tab.id, { type: "clipkeep:reader" });
      } catch (e) {
        // 无法注入的页面（chrome:// 等），忽略
      }
    }
  }
}

/* ---------------- 消息路由 ---------------- */

if (API.runtime && API.runtime.onMessage) {
  API.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case "clipkeep:add":
            sendResponse(await addItem(msg.payload));
            break;
          case "clipkeep:delete":
            sendResponse(await deleteItem(msg.id));
            break;
          case "clipkeep:update":
            sendResponse(await updateItem(msg.id, msg.patch || {}));
            break;
          case "clipkeep:clear":
            sendResponse(await clearAll());
            break;
          case "clipkeep:tag-op":
            sendResponse(await tagOp(msg.payload || msg));
            break;
          case "clipkeep:replace":
            sendResponse(await replaceAll(msg.payload));
            break;
          case "clipkeep:hl-replace":
            sendResponse(await replaceHighlights(msg.payload));
            break;
          case "clipkeep:merge":
            sendResponse(await mergeItems(msg.payload));
            break;
          case "clipkeep:hl-add":
            sendResponse(await addHighlight(msg.payload));
            break;
          case "clipkeep:hl-update":
            sendResponse(await updateHighlight(msg.id, msg.patch || {}));
            break;
          case "clipkeep:hl-delete":
            sendResponse(await deleteHighlight(msg.id));
            break;
          case "clipkeep:trash-list":
            sendResponse(await trashList());
            break;
          case "clipkeep:trash-restore":
            sendResponse(await trashRestore(msg.tid));
            break;
          case "clipkeep:trash-clear":
            sendResponse(await trashClear());
            break;
          case "clipkeep:reader":
            if (sender.tab) runReader(sender.tab);
            sendResponse({ ok: true });
            break;
          default:
            sendResponse({ ok: false, error: "unknown" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // 异步响应
  });
}
