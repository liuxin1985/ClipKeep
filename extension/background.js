/**
 * ClipKeep - background service worker (Manifest V3)
 * 兼容 Chrome / Edge / Safari 16.4+。
 * 负责：注册右键菜单、跨浏览器 API 适配、消息路由、本地存储读写。
 */

// 跨浏览器 API 适配层：Safari 暴露 browser.*，Chrome/Edge 暴露 chrome.*
const API = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;

const STORAGE_KEY = "clipkeep_items";
const PREFS_KEY = "clipkeep_prefs";
const MAX_TEXT = 20000; // 单次收藏的文本上限，避免一次粘贴撑爆本地存储

/* ---------------- 存储读写 ---------------- */

async function readItems() {
  const obj = await API.storage.local.get(STORAGE_KEY);
  const items = obj[STORAGE_KEY];
  return Array.isArray(items) ? items : [];
}

async function writeItems(items) {
  await API.storage.local.set({ [STORAGE_KEY]: items });
  return items.length;
}

/**
 * 读改写串行化。
 * 每个操作都是「读全量 → 改 → 写全量」，两个标签页同时收藏时，
 * 后一个若读到前一个尚未落盘的快照，就会把对方刚存的数据整条覆盖掉。
 * 这里把所有变更排进同一条 promise 链，保证每次读到的都是最新状态。
 */
let writeChain = Promise.resolve();

function mutate(fn) {
  const step = async () => {
    const items = await readItems();
    const out = (await fn(items)) || {};
    if (out.write) await writeItems(out.items || items);
    return out.result;
  };
  const result = writeChain.then(step, step); // 上一次失败不能卡死后续操作
  writeChain = result.then(noop, noop);
  return result;
}

function noop() {}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
  return mutate((items) => {
    const next = items.filter((it) => it.id !== id);
    return { write: next.length !== items.length, items: next, result: { ok: true, count: next.length } };
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

/** 整体替换存储（恢复备份「覆盖本地」用），入参已在前端做过结构校验 */
function replaceAll(payload) {
  const items = Array.isArray(payload && payload.items) ? payload.items : null;
  if (!items) return Promise.resolve({ ok: false, error: "invalid" });
  return mutate(() => ({ write: true, items, result: { ok: true, count: items.length } }));
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
          case "clipkeep:merge":
            sendResponse(await mergeItems(msg.payload));
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
