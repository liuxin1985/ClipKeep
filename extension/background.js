/**
 * ClipKeep - background service worker (Manifest V3)
 * 兼容 Chrome / Edge / Safari 16.4+。
 * 负责：注册右键菜单、跨浏览器 API 适配、消息路由、本地存储读写。
 */

// 跨浏览器 API 适配层：Safari 暴露 browser.*，Chrome/Edge 暴露 chrome.*
const API = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;

const STORAGE_KEY = "clipkeep_items";
const PREFS_KEY = "clipkeep_prefs";

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

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalizeTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,，\s]+/);
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
}

async function addItem(payload) {
  const text = (payload.text || "").trim();
  if (!text) return { ok: false, error: "empty" };
  const item = {
    id: makeId(),
    text,
    note: (payload.note || "").trim(),
    tags: normalizeTags(payload.tags),
    url: payload.url || "",
    title: payload.title || "",
    createdAt: Date.now(),
  };
  const items = await readItems();
  items.unshift(item);
  await writeItems(items);
  return { ok: true, item, count: items.length };
}

async function deleteItem(id) {
  let items = await readItems();
  items = items.filter((it) => it.id !== id);
  await writeItems(items);
  return { ok: true, count: items.length };
}

async function updateItem(id, patch) {
  const items = await readItems();
  const idx = items.findIndex((it) => it.id === id);
  if (idx === -1) return { ok: false, error: "not_found" };
  if (patch.tags !== undefined) patch.tags = normalizeTags(patch.tags);
  items[idx] = { ...items[idx], ...patch, id };
  await writeItems(items);
  return { ok: true, item: items[idx] };
}

async function clearAll() {
  await writeItems([]);
  return { ok: true };
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
  });
}

if (API.runtime && API.runtime.onInstalled) {
  API.runtime.onInstalled.addListener(() => {
    buildMenus();
  });
}
// service worker 重启后菜单可能丢失，顶层再注册一次以保证幂等
buildMenus();

if (API.contextMenus && API.contextMenus.onClicked) {
  API.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || tab.id === undefined) return;
    if (info.menuItemId === "clipkeep-save" && info.selectionText) {
      const res = await addItem({
        text: info.selectionText,
        url: info.pageUrl || tab.url || "",
        title: tab.title || "",
      });
      notifyTab(tab.id, { type: "clipkeep:toast", message: res.ok ? "已收藏 ✓" : "内容为空" });
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
