/**
 * ClipKeep - background service worker (Manifest V3)
 * 兼容 Chrome / Edge / Safari 16.4+。
 * 负责：注册右键菜单、跨浏览器 API 适配、消息路由、本地存储读写。
 */

// 跨浏览器 API 适配层：Safari 暴露 browser.*，Chrome/Edge 暴露 chrome.*
if (typeof importScripts === "function") importScripts("i18n.js"); // service worker 没有 window，靠 importScripts 拿文案层

const API = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;
// 文案层：i18n.js 没先加载时退化成「原样返回 + 占位替换」，界面宁可全是中文也不能报错
const I18N = (typeof globalThis !== "undefined" && globalThis.ClipKeepI18N) || null;
const T = I18N ? I18N.T : (s, a) => String(s).replace(/\{(\d+)\}/g, (m, i) => (a && a[i] != null ? String(a[i]) : m));


const STORAGE_KEY = "clipkeep_items";
const HL_KEY = "clipkeep_highlights";
const TRASH_KEY = "clipkeep_trash";
const PREFS_KEY = "clipkeep_prefs";
const ACTIVITY_KEY = "clipkeep_activity"; // 每天回顾了多少条，用于热力图
const MAX_TEXT = 20000; // 单次收藏的文本上限，避免一次粘贴撑爆本地存储
const TRASH_MINS = [1, 5, 10, 30, 60]; // 回收站可选保留时长（分钟）
const DEFAULT_TRASH_MINS = 10;
const ACTIVITY_DAYS = 120; // 活动记录只留最近 120 天
const ACT_IDS_MAX = 100; // 每天最多留多少条复习明细，供热力图格子下钻查看
const BATCH_MAX = 1000; // 单次批量操作最多处理多少条（弹窗全选几千条时也不会一次写爆）
const INTERVALS = 6; // 记忆盒数量，用于把外部数据的盒号夹到合法区间
const HL_COLORS = ["yellow", "green", "pink", "blue"];
const SAFE_ID = /^[\w-]{1,64}$/; // 外部数据的 id 只允许安全字符，避免拼进 HTML 时越出属性
const MEDIA_KINDS = ["image", "link"]; // 除文字外的剪藏类型；文字收藏不写 kind
const MEDIA_MAX = 2048; // 图片 / 链接地址长度上限
const HTTP_ONLY = /^https?:\/\//i; // 可剪藏的地址：javascript: / data: 一律不收

/* ---------------- 存储读写 ---------------- */

async function readList(key) {
  const obj = await API.storage.local.get(key);
  const list = obj[key];
  return Array.isArray(list) ? list : [];
}

/** 非列表数据（活动记录之类）走这个，别被 readList 的「不是数组就当空」吞掉 */
async function readRaw(key) {
  const obj = await API.storage.local.get(key);
  return obj[key];
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
    // 附属记录（回收站、打卡）排在主键之后：先写附属会出现
    // 「列表没删掉、回收站却多了一条」——弹窗照着回收站报「已删除，可撤销」，两头都对不上
    if (out.after) await out.after(out.result);
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

function trashTtlMs() {
  // 处在写链内，直接读 prefs 不会和别的步骤抢同一条 key
  return API.storage.local.get(PREFS_KEY).then((o) => {
    const mins = o && o[PREFS_KEY] && Number(o[PREFS_KEY].trash && o[PREFS_KEY].trash.mins);
    return (TRASH_MINS.indexOf(mins) >= 0 ? mins : DEFAULT_TRASH_MINS) * 60 * 1000;
  });
}

function pruneTrash(trash, ttlMs) {
  const now = Date.now();
  const ttl = ttlMs === undefined ? DEFAULT_TRASH_MINS * 60 * 1000 : ttlMs;
  return trash.filter((t) => t && t.item && now - (Number(t.deletedAt) || 0) <= ttl);
}

/** 把删除的内容放进回收站；调用方已处于写链中，这里直接读写 */
async function pushTrash(entries) {
  const [trash, ttl] = await Promise.all([readList(TRASH_KEY), trashTtlMs()]);
  await API.storage.local.set({ [TRASH_KEY]: pruneTrash(entries.concat(trash), ttl) });
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

const TAG_MAX = 12; // 单条收藏的标签上限

/**
 * 标签清洗：去重去空，并夹到 TAG_MAX 个。
 * 上限要夹（否则一条能塞几百个标签），但夹掉几条得让调用方说得出——
 * 只悄悄留 12 个的话，弹窗报「已加标签」，用户看到的却是三个没进去。
 */
function cleanTags(tags) {
  if (!tags) return { tags: [], dropped: 0 };
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,，\s]+/);
  const all = [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))];
  const keep = all.slice(0, TAG_MAX);
  return { tags: keep, dropped: all.length - keep.length };
}

function normalizeTags(tags) {
  return cleanTags(tags).tags;
}

/**
 * 可剪藏的地址：只认 http(s)，且不能超长。
 * 超长地址要么原样存、要么不收——截断成另一个能点开的地址最坏，
 * 用户会以为自己存的就是那条。
 */
function mediaUrlOk(v) {
  const url = String(v || "").trim();
  return HTTP_ONLY.test(url) && url.length <= MEDIA_MAX;
}

/**
 * 图片 / 链接收藏的目标地址。
 * 类型和地址要配对：kind 说自己是图片，地址却非法，就当普通文字收藏，
 * 否则列表里会出现一张点开没反应的「图片」。
 */
function mediaOf(raw) {
  if (!raw || MEDIA_KINDS.indexOf(raw.kind) < 0) return {};
  const url = String(raw.kind === "image" ? raw.image || "" : raw.link || "").trim();
  if (!mediaUrlOk(url)) return {};
  return raw.kind === "image" ? { kind: "image", image: url } : { kind: "link", link: url };
}

/** 图片地址的可读标签：文件名（去掉查询串与锚点），退化到站点名 */
function imageLabel(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent((u.pathname.split("/").filter(Boolean).pop() || "").trim());
    return (last || u.hostname).slice(0, 120);
  } catch (_) {
    return String(url).slice(0, 120);
  }
}

/** 链接没有可选文字时的标签：站点名 + 路径，比整条 URL 短且认得出是什么 */
function linkLabel(url) {
  try {
    const u = new URL(url);
    return (u.hostname + (u.pathname === "/" ? "" : u.pathname)).slice(0, 120) || String(url).slice(0, 120);
  } catch (_) {
    return String(url).slice(0, 120);
  }
}

/** 排期：盒号夹到合法区间，时间戳非法时视为立即到期 */
function cleanReview(r) {
  if (!r || typeof r !== "object") return undefined;
  const box = Math.max(0, Math.min(INTERVALS - 1, Math.floor(Number(r.box)) || 0));
  const due = Number(r.due);
  const seen = Math.max(0, Math.floor(Number(r.seen)) || 0);
  return { box, due: Number.isFinite(due) && due > 0 ? due : Date.now(), seen };
}

/**
 * 备份、旧版本、手改过的存储都算外部数据：入库前统一洗一遍。
 * 弹窗侧的归一化只是善意路径，后台才是最后一道关。
 */
function cleanItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = String(raw.text === undefined || raw.text === null ? "" : raw.text).trim();
  if (!text) return null;
  const rawId = String(raw.id === undefined || raw.id === null ? "" : raw.id);
  const item = {
    id: SAFE_ID.test(rawId) ? rawId : makeId(),
    text: text.slice(0, MAX_TEXT),
    note: String(raw.note === undefined || raw.note === null ? "" : raw.note).trim().slice(0, MAX_TEXT),
    tags: normalizeTags(raw.tags),
    url: String(raw.url || ""),
    title: String(raw.title || ""),
    createdAt: Number(raw.createdAt) || Date.now(),
    ...mediaOf(raw),
  };
  // 截断标记要在切片之前量：slice 之后再比长度永远是 false，
  // 一条被砍掉一半的收藏就不可能带「已截断」徽标了
  if (text.length > MAX_TEXT) item.truncated = true;
  const review = cleanReview(raw.review);
  if (review) item.review = review;
  return item;
}

/**
 * 外部传来的 id 列表：只留合法字符、去重、夹住单次数量。
 * 返回 null 表示这根本不是个列表（手改过的消息、旧版本前端），宁可整批不做。
 */
function cleanIds(ids) {
  if (!Array.isArray(ids)) return null;
  const seen = new Set();
  for (const raw of ids) {
    if (typeof raw === "string" && SAFE_ID.test(raw)) seen.add(raw);
  }
  const all = [...seen];
  const keep = all.slice(0, BATCH_MAX);
  return { ids: keep, limited: all.length > keep.length };
}

/** 同一条内容是否已经存过：类型、地址、来源、正文、备注、标签全同才算重复 */
function sameAs(a, b) {
  return (
    (a.url || "") === (b.url || "") &&
    a.text === b.text &&
    (a.note || "") === (b.note || "") &&
    (a.kind || "") === (b.kind || "") &&
    (a.image || "") === (b.image || "") &&
    (a.link || "") === (b.link || "") &&
    (a.tags || []).join("\n") === (b.tags || []).join("\n")
  );
}

function addItem(payload) {
  const raw = ((payload && payload.text) || "").trim();
  if (!raw) return Promise.resolve({ ok: false, error: "empty" });
  const ct = cleanTags(payload && payload.tags);
  const item = {
    id: makeId(),
    text: raw.slice(0, MAX_TEXT),
    note: ((payload && payload.note) || "").trim().slice(0, MAX_TEXT),
    tags: ct.tags,
    url: (payload && payload.url) || "",
    title: (payload && payload.title) || "",
    createdAt: Date.now(),
    ...mediaOf(payload || {}),
  };
  if (raw.length > MAX_TEXT) item.truncated = true;
  // 标签超上限时把舍弃条数带出去：前台要如实说「有 3 个标签没存进去」
  const dropped = ct.dropped ? { tagDropped: ct.dropped } : {};
  return mutate((items) => {
    const dup = items.find((it) => it && sameAs(it, item));
    // 划两次就把同一个句子存两遍，是这类工具最常见的误操作
    if (dup) return { result: { ok: true, dup: true, item: dup, count: items.length, ...dropped } };
    items.unshift(item);
    return { write: true, items, result: { ok: true, item, count: items.length, ...dropped } };
  });
}

function deleteItem(id) {
  return mutate(async (items) => {
    const idx = items.findIndex((it) => it.id === id);
    // 删一条已经不存在的记录不算删除成功：报 ok 的话，弹窗会跟着说「已删除，可撤销」，
    // 而回收站里根本没有东西可撤销（和 update 的 not_found 保持一致）
    if (idx === -1) return { result: { ok: false, error: "not_found" } };
    const entry = trashEntry("clip", items[idx]);
    items.splice(idx, 1);
    // 回收站排在「列表真的删掉了」之后写：反过来会留下一条列表里还在的幽灵条目，
    // 弹窗对着回收站报「已删除 1 条 · 可撤销」，明细里还能点恢复
    return {
      write: true,
      items,
      after: async (r) => { try { await pushTrash([entry]); } catch (_) { r.trashed = false; } },
      result: { ok: true, count: items.length, trashed: true, tid: entry.tid },
    };
  });
}

/** 编辑一条收藏时允许改的字段；其余（时间、截断标记、手加的未知键）一律不进存储 */
const UPDATABLE = ["text", "note", "tags", "kind", "image", "link", "review"];

function updateItem(id, patch) {
  return mutate((items) => {
    const idx = items.findIndex((it) => it.id === id);
    if (idx === -1) return { result: { ok: false, error: "not_found" } };
    const src = patch || {};
    const p = {}; // 白名单取字段：改个标签不该顺手改掉收藏时间、截断标记或塞进未知字段
    for (const k of UPDATABLE) if (src[k] !== undefined) p[k] = src[k];
    let tagDropped = 0;
    if (p.tags !== undefined) {
      const ct = cleanTags(p.tags);
      p.tags = ct.tags;
      tagDropped = ct.dropped; // 夹掉的条数只带在结果里，不进存储
    }
    if (p.note !== undefined) p.note = String(p.note).trim().slice(0, MAX_TEXT); // 备注和正文一样要夹：一条超长备注能把配额吃光
    if (p.review !== undefined) {
      const rv = cleanReview(p.review); // 排期由后台复盘一遍，盒号/时间越界就夹回来
      if (rv) p.review = rv;
      else delete p.review;
    }
    // 类型与地址要配对校验：改一条收藏不能塞进 javascript: 地址，
    // 也不能只写 kind:"text" 就把原来的图片地址留在身上
    const touchMedia = p.kind !== undefined || p.image !== undefined || p.link !== undefined;
    const media = touchMedia ? mediaOf(p) : null;
    if (touchMedia) { delete p.kind; delete p.image; delete p.link; }
    if (p.text !== undefined) {
      const t = String(p.text).trim();
      if (!t) return { result: { ok: false, error: "empty" } };
      p.text = t.slice(0, MAX_TEXT);
    }
    items[idx] = { ...items[idx], ...p, id };
    if (touchMedia) {
      delete items[idx].kind; delete items[idx].image; delete items[idx].link;
      Object.assign(items[idx], media);
    }
    return {
      write: true,
      items,
      result: { ok: true, item: items[idx], ...(tagDropped ? { tagDropped } : {}) },
    };
  });
}

/**
 * 批量删除：整批在同一条写链的一步里删掉，且共用一个撤销号（tid）。
 * 分开 tid 的话用户点一次「撤销」只回来一条，剩下的照样算丢了。
 */
function deleteMany(ids) {
  const q = cleanIds(ids);
  if (!q) return Promise.resolve({ ok: false, error: "invalid" });
  return mutate(async (items) => {
    const want = new Set(q.ids);
    const hit = items.filter((it) => it && want.has(it.id));
    if (!hit.length) return { result: { ok: true, removed: 0, count: items.length, limited: q.limited } };
    const tid = makeId();
    const next = items.filter((it) => it && !want.has(it.id));
    return {
      write: true,
      items: next,
      // 整批的回收站同样排在列表之后：列表没删成，一条都不该进回收站
      after: async (r) => {
        try { await pushTrash(hit.map((it) => ({ ...trashEntry("clip", it), tid }))); } // 整批一个撤销号
        catch (_) { r.trashed = false; }
      },
      result: { ok: true, removed: hit.length, count: next.length, trashed: true, tid, limited: q.limited },
    };
  });
}

/** 批量追加标签：合并去重，一条都没选中就不写存储 */
function tagAddMany(ids, tags) {
  const q = cleanIds(ids);
  const add = normalizeTags(tags);
  if (!q || !add.length) return Promise.resolve({ ok: false, error: "invalid" });
  return mutate((items) => {
    const want = new Set(q.ids);
    let changed = 0;
    let dropped = 0; // 合并后超过 12 个被舍弃的标签条数
    const next = items.map((it) => {
      if (!it || !want.has(it.id)) return it;
      const merged = cleanTags((it.tags || []).concat(add));
      dropped += merged.dropped;
      if (merged.tags.join("\n") === (it.tags || []).join("\n")) return it;
      changed++;
      return { ...it, tags: merged.tags };
    });
    // changed 为 0 但 dropped 不为 0：一个标签都没加上，全被上限挡在外面，
    // 这时候报「标签没有变化」等于告诉用户「本来就有」
    return {
      write: changed > 0,
      items: next,
      result: { ok: true, changed, dropped, limited: q.limited },
    };
  });
}

function clearAll() {
  return mutate(() => ({ write: true, items: [], result: { ok: true } }));
}

/* ---------------- 回顾打分 + 打卡活动 ---------------- */

/** 本地日期键，形如 2026-09-27 */
function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 排期必须由后台说了算的字段：盒号/到期时间得是有限数，否则视为非法请求 */
function validReview(r) {
  return (
    r && typeof r === "object" &&
    Number.isFinite(Number(r.box)) && Number(r.box) >= 0 &&
    Number.isFinite(Number(r.due)) && Number(r.due) > 0
  );
}

/**
 * 活动记录有两种历史格式：v1.5 及以前是当天条数的数字，v1.6 起是 { n, ids }。
 * 读的时候都归一化，老数据不用迁移，也不会被当成非法记录清掉。
 */
function activityOf(v) {
  if (typeof v === "number" && Number.isFinite(v)) return { n: Math.max(0, Math.floor(v)), ids: [] };
  if (v && typeof v === "object") {
    const n = Number(v.n);
    return {
      n: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0,
      ids: Array.isArray(v.ids) ? v.ids.map(String).filter((x) => SAFE_ID.test(x)).slice(-ACT_IDS_MAX) : [],
    };
  }
  return { n: 0, ids: [] };
}

/**
 * 打分：更新排期 + 记一次当日回顾活动。
 * 两件事在同一条写链的一步里完成，不会出现「分数存了、热力图没加」的半更新。
 */
function gradeItem(id, review) {
  if (!validReview(review)) return Promise.resolve({ ok: false, error: "invalid" });
  return mutate(async (items) => {
    const idx = items.findIndex((it) => it && it.id === id);
    if (idx === -1) return { result: { ok: false, error: "not_found" } };
    items[idx] = { ...items[idx], review: cleanReview(review) };
    const day = dayKey(Date.now());
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cutoff = today.getTime() - ACTIVITY_DAYS * 86400000;
    const activity = await readRaw(ACTIVITY_KEY); // 活动记录是按日期的对象，不是列表
    const log = (activity && typeof activity === "object" && !Array.isArray(activity)) ? activity : {};
    for (const k of Object.keys(log)) {
      const t = Date.parse(k);
      if (!Number.isFinite(t) || t < cutoff || activityOf(log[k]).n <= 0) delete log[k];
    }
    const prev = activityOf(log[day]);
    // 明细只留最近 ACT_IDS_MAX 条：够回看当天复习了什么，长期跑也不会无限膨胀
    const ids = prev.ids.includes(id) ? prev.ids : prev.ids.concat(id).slice(-ACT_IDS_MAX);
    log[day] = { n: prev.n + 1, ids };
    // 打卡记录排在排期写成功之后：先写活动的话，存储一满就变成
    // 「分数没存进、热力图却替没发生的复习记了功」，重试三次今天就是 4 条
    return {
      write: true,
      items,
      after: async (r) => {
        try { await API.storage.local.set({ [ACTIVITY_KEY]: log }); }
        catch (_) { r.actFailed = true; r.count = 0; }
      },
      result: { ok: true, day, count: log[day].n },
    };
  });
}

/* ---------------- 高亮 / 批注（统一由后台串行写） ---------------- */

/** 锚点上下文长度与分段数上限：再多就不是「定位」而是把整页存下来了 */
const SEG_CTX = 24;
const SEG_MAX = 64;

/**
 * 分段锚点清洗。每段 { t, pre, post } 全为字符串，且各段拼接必须正好等于正文——
 * 对不上就整份作废（退回单段整词查找），因为拿一份和正文不符的 segs 去标别的字，
 * 比标不回来坏得多：用户看到高亮落在错的地方，还会以为是自己记错了。
 * 正文被 MAX_TEXT 砍短时按同一把尺子砍段：末段裁到上限、多余的段丢掉，
 * 不然「砍过的正文」和「没砍的 segs」永远对不上，锚点会被自己制造的截断作废。
 */
function cleanSegs(segs, text) {
  if (!Array.isArray(segs) || !segs.length || segs.length > SEG_MAX) return null;
  const out = [];
  let used = 0;
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    const raw = String(s.t === undefined || s.t === null ? "" : s.t);
    if (!raw) continue;
    const room = text.length - used;
    if (room <= 0) break; // 正文已经拼满，后面多出来的段是备份里没截干净的尾巴
    const t = raw.length > room ? raw.slice(0, room) : raw;
    out.push({
      t,
      pre: String(s.pre === undefined || s.pre === null ? "" : s.pre).slice(-SEG_CTX),
      post: String(s.post === undefined || s.post === null ? "" : s.post).slice(0, SEG_CTX),
    });
    used += t.length;
  }
  // 拼不回正文（哪怕只是长度对上）就整份作废：拿一份指鹿为马的 segs 去标字，
  // 比标不回来坏得多
  if (!out.length || out.map((x) => x.t).join("") !== text) return null;
  return out;
}

function cleanHighlight(payload) {
  const p = payload || {};
  const text = String(p.text || "").trim();
  const url = String(p.url || "");
  if (!text || !url) return null;
  const rawId = String(p.id === undefined || p.id === null ? "" : p.id);
  const safeText = text.slice(0, MAX_TEXT);
  const segs = cleanSegs(p.segs, safeText);
  return {
    id: SAFE_ID.test(rawId) ? rawId : makeId(),
    url,
    title: String(p.title || ""),
    text: safeText,
    note: String(p.note || "").trim().slice(0, MAX_TEXT),
    color: HL_COLORS.indexOf(p.color) >= 0 ? p.color : "yellow",
    createdAt: Number(p.createdAt) || Date.now(),
    // 砍过就要留痕：前端据此把「已高亮 ✓」改成承认少存了一截，不能让用户以为整段都存下了
    ...(text.length > safeText.length ? { truncated: true } : {}),
    ...(segs ? { segs } : {}),
  };
}

/**
 * 同一条高亮的身份：地址 + 正文 + 落点时间。
 * id 不能只认——备份里的非法 id 会被换成新的，同一内容换个 id 再送一次
 * 就不是「新的一条」，否则重复导入会把高亮越堆越多。
 */
const hlKeyOf = (h) => `${h.url}|${h.text}|${h.createdAt}`;

function addHighlight(payload) {
  const hl = cleanHighlight(payload);
  if (!hl) return Promise.resolve({ ok: false, error: "invalid" });
  // 上限值一并回给前端：那句「正文太长」要说得出到底多长，前端不该自己抄一份常数
  const tell = (rec) => (rec && rec.truncated ? { truncated: true, limit: MAX_TEXT } : {});
  return mutateHl((list) => {
    const hit = list.find((x) => x && (x.id === hl.id || hlKeyOf(x) === hlKeyOf(hl)));
    if (hit) {
      // 报已有那条的 id：前端拿这个 id 去撤销 / 改色才对得上
      return { result: { ok: true, id: hit.id, dup: true, count: list.length, ...tell(hit) } };
    }
    list.push(hl);
    return { write: true, list, result: { ok: true, id: hl.id, count: list.length, ...tell(hl) } };
  });
}

function updateHighlight(id, patch) {
  const p = patch || {};
  const allowed = {};
  if (p.note !== undefined) allowed.note = String(p.note).trim().slice(0, MAX_TEXT);
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
    if (idx === -1) return { result: { ok: false, error: "not_found" } };
    const entry = trashEntry("hl", list[idx]);
    list.splice(idx, 1);
    // 和收藏删除同一条规矩：高亮真的从列表里掉了，才轮到回收站收下它
    return {
      write: true,
      list,
      after: async (r) => { try { await pushTrash([entry]); } catch (_) { r.trashed = false; } },
      result: { ok: true, count: list.length, trashed: true, tid: entry.tid },
    };
  });
}

/* ---------------- 回收站 ---------------- */

function trashList() {
  return mutateTrash(async (trash) => {
    const next = pruneTrash(trash, await trashTtlMs());
    return { write: next.length !== trash.length, list: next, result: { ok: true, items: next } };
  });
}

/**
 * 撤销一次删除。批量删除的多条记录共用同一个 tid，所以这里按 tid 成批还原：
 * 点一次「撤销」只捞回一条的话，用户看到的还是「撤销了却少了几条」。
 */
function trashRestore(tid) {
  return mutateTrash(async (trash) => {
    const next = pruneTrash(trash, await trashTtlMs()); // 过期先清掉：和逐条恢复同口径，弹窗开着不动也不能让过期的复活
    const hit = next.filter((t) => t && t.tid === tid);
    if (!hit.length) {
      return { write: next.length !== trash.length, list: next, result: { ok: false, error: "not_found" } };
    }
    let existed = 0;
    for (const entry of hit) {
      const res = await restoreEntry(entry);
      if (!res || !res.ok) return { result: { ok: false, error: "restore_failed" } };
      if (res.exists) existed++; // 撞了 id 的那几条没真的回来，计数里要刨掉
    }
    const rest = next.filter((t) => !(t && t.tid === tid));
    return { write: true, list: rest, result: { ok: true, kind: hit[0].kind, restored: hit.length - existed, existed } };
  });
}

/**
 * 清空回收站。带 kind 时只清这一类：「清空全部收藏」的承诺是高亮批注不受影响，
 * 连高亮的撤销记录一起抹掉就等于当面毁约。
 */
function trashClear(kind) {
  return mutateTrash((list) => {
    const next = kind ? list.filter((e) => e && e.kind !== kind) : [];
    return { write: true, list: next, result: { ok: true, cleared: list.length - next.length } };
  });
}

/**
 * 逐条恢复：回收站明细里点某一行的「恢复」。
 * 按 tid 的整批撤销会把同一次删除的全都捞回来，只想恢复其中一条时做不到；
 * 这里只认 (kind, id) 最近的那条记录（回收站是新→旧排的，findIndex 即最近），
 * 捞完剩下的继续留在回收站里，还能再点或整批撤销。
 * 撞 id（内容已经回到列表）时不重复插入，但那条记录要一并清掉——
 * 留在明细里就是一行点不动的死条目。
 */
function trashRestoreOne(payload) {
  const kind = payload && payload.kind;
  const id = String((payload && payload.id) || "");
  if ((kind !== "clip" && kind !== "hl") || !SAFE_ID.test(id)) {
    return Promise.resolve({ ok: false, error: "invalid" });
  }
  return mutateTrash(async (trash) => {
    const next = pruneTrash(trash, await trashTtlMs()); // 过期的一律先清掉，过期的东西不该还能恢复
    const idx = next.findIndex((t) => t && t.kind === kind && t.item && t.item.id === id);
    if (idx === -1) {
      return { write: next.length !== trash.length, list: next, result: { ok: false, error: "not_found" } };
    }
    const entry = next[idx];
    const res = await restoreEntry(entry);
    if (!res || !res.ok) return { write: true, list: next, result: { ok: false, error: "restore_failed" } };
    const rest = next.slice();
    rest.splice(idx, 1);
    return {
      write: true,
      list: rest,
      result: { ok: true, kind, id, restored: res.exists ? 0 : 1, existed: res.exists ? 1 : 0 },
    };
  });
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

/** 整体替换收藏（恢复备份「覆盖本地」用）：后台再洗一遍，不依赖前端自觉 */
function replaceAll(payload) {
  const incoming = Array.isArray(payload && payload.items) ? payload.items : null;
  if (!incoming) return Promise.resolve({ ok: false, error: "invalid" });
  const clean = dedupeById(incoming.map(cleanItem).filter(Boolean));
  return mutate((items) => {
    const next = preserveSince(items, clean, payload && payload.takenAt)
      .slice()
      .sort((a, b) => ((b && b.createdAt) || 0) - ((a && a.createdAt) || 0));
    return { write: true, items: next, result: { ok: true, count: next.length, truncated: countTruncated(clean) } };
  });
}

/** 这批里有多少条正文被砍过（cleanItem 会打 truncated 标记） */
function countTruncated(list) {
  return (list || []).filter((x) => x && x.truncated).length;
}

/** 同一份备份里也可能自带重复 id，留下先出现的那条 */
function dedupeById(list) {
  const seen = new Set();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** 整体替换高亮 / 批注：和收藏一样走后台串行写，只覆盖快照内的内容 */
function replaceHighlights(payload) {
  const incoming = Array.isArray(payload && payload.highlights) ? payload.highlights : null;
  if (!incoming) return Promise.resolve({ ok: false, error: "invalid" });
  const clean = dedupeById(incoming.map(cleanHighlight).filter(Boolean));
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
  const clean = dedupeById(inItems.map(cleanItem).filter(Boolean));
  return mutate((items) => {
    const have = new Set(items.map((x) => x && x.id));
    const add = clean.filter((x) => !have.has(x.id));
    add.forEach((x) => items.push(x));
    // 存储约定：新的在前，和列表视图一致
    items.sort((a, b) => ((b && b.createdAt) || 0) - ((a && a.createdAt) || 0));
    return {
      write: add.length > 0,
      items,
      // 截断条数要报出来：备份里超过上限的正文是悄悄砍短的，
      // 恢复完只说「已恢复 N 条」，用户会以为备份原样回来了
      result: { ok: true, added: add.length, count: items.length, truncated: countTruncated(add) },
    };
  });
}

/* ---------------- 界面语言 ---------------- */

let langReady = null;

/**
 * 读一次偏好并把语言定下来，返回「这次到底读着没有」。
 */
function readLangOnce() {
  return (async () => {
    if (!I18N) return true;
    let p = "auto";
    try {
      const o = await API.storage.local.get(PREFS_KEY);
      const prefs = o && o[PREFS_KEY];
      if (prefs && ["auto", "zh", "en"].indexOf(prefs.lang) >= 0) p = prefs.lang;
    } catch (_) {
      I18N.setLang(p); // 读不到就按浏览器界面语言，先有个能用的
      return false;
    }
    I18N.setLang(p);
    return true;
  })();
}

/**
 * 服务 worker 每次醒来先定一次语言：菜单和 toast 都从文案层出，语言定晚了就赶不上这班车。
 * 成功读过就把这条 promise 缓存下来，免得每条消息都去读一遍存储。
 * 读失败不算结论：那次只是「这一回没读着」，用户存的偏好还在。把它钉死，英文用户装完
 * 扩展后菜单会一直是浏览器语言，而且要跟浏览器抢那一次——装扩展的事件可能比读取还早落地。
 * 所以拿到失败结果的人会再读一次（最多补一次，避免存储真坏了时无限重试）。
 */
function ensureLang(noRetry) {
  if (!langReady) langReady = readLangOnce();
  const mine = langReady;
  if (noRetry) return mine;
  return mine.then((ok) => {
    if (ok) return true;
    if (langReady === mine) langReady = null;
    return ensureLang(true);
  });
}
ensureLang();

/* ---------------- 右键菜单 ---------------- */

function buildMenus() {
  if (!API.contextMenus) return;
  API.contextMenus.removeAll(() => {
    API.contextMenus.create({
      id: "clipkeep-save",
      title: T("ClipKeep：收藏选中内容"),
      contexts: ["selection"],
    });
    API.contextMenus.create({
      id: "clipkeep-save-image",
      title: T("ClipKeep：收藏这张图片"),
      contexts: ["image"],
    });
    API.contextMenus.create({
      id: "clipkeep-save-link",
      title: T("ClipKeep：收藏这个链接"),
      contexts: ["link"],
    });
    API.contextMenus.create({
      id: "clipkeep-reader",
      title: T("ClipKeep：净化阅读本页"),
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
    // 菜单文案由浏览器持久保存，建的时候就定死了：先定语言再建，英文用户不该装完还是中文菜单
    if (reason === "install" || reason === "update") ensureLang().then(buildMenus);
  });
}

// 语言偏好是弹窗里改的，后台得跟着重建菜单；其它偏好变化不动菜单，别让用户点不到
if (API.storage && API.storage.onChanged) {
  API.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !I18N || !changes[PREFS_KEY]) return;
    const next = (changes[PREFS_KEY].newValue || {}).lang;
    const before = I18N.lang();
    I18N.setLang(["auto", "zh", "en"].indexOf(next) >= 0 ? next : "auto");
    if (I18N.lang() !== before) buildMenus();
  });
}

/** 把底层错误翻译成用户能看懂的话（不要把配额不足之类误报成「内容为空」） */
function saveFailMessage(err) {
  const s = String((err && err.message) || err || "");
  if (/quota|exceeded/i.test(s)) return T("保存失败：本地存储已满，请先导出备份清理");
  return T("保存失败，请刷新页面后重试");
}

/** 把一次收藏请求落盘，并把结果作为 toast 回给页面 */
async function saveClip(tab, payload) {
  try {
    await ensureLang(); // 冷启动第一条提示可能赶在语言定下来之前，等一次不值得省
    const res = await addItem(payload);
    notifyTab(tab.id, {
      type: "clipkeep:toast",
      message: res.ok
        ? res.dup ? T("这条已经在收藏里了")
          // 超长只存了前半部分，提示要说出来，否则用户以为剪到了全文
          : res.item && res.item.truncated ? T("已收藏 ✓（超过 {0} 字，已截断）", [MAX_TEXT])
          : T("已收藏 ✓")
        : res.error === "empty" ? T("内容为空") : saveFailMessage(res),
    });
  } catch (err) {
    notifyTab(tab.id, { type: "clipkeep:toast", message: saveFailMessage(err) });
  }
}

if (API.contextMenus && API.contextMenus.onClicked) {
  API.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || tab.id === undefined) return;
    if (info.menuItemId === "clipkeep-save") {
      const text = (info.selectionText || "").trim();
      if (!text) return; // 空选区不打扰
      await saveClip(tab, { text, url: info.pageUrl || tab.url || "", title: tab.title || "" });
    } else if (info.menuItemId === "clipkeep-save-image" || info.menuItemId === "clipkeep-save-link") {
      const isImage = info.menuItemId === "clipkeep-save-image";
      const url = isImage ? info.srcUrl : info.linkUrl;
      // 地址要在入库前判协议和长度：伪协议在菜单里点得到，但绝不能变成可点的链接，
      // 超长地址也不能悄悄截成另一个地址
      if (!mediaUrlOk(url)) {
        notifyTab(tab.id, { type: "clipkeep:toast", message: T("这个地址无法收藏（不是 http(s) 或过长）") });
        return;
      }
      const label = isImage ? imageLabel(url) : (info.selectionText || "").trim() || linkLabel(url);
      await saveClip(tab, {
        kind: isImage ? "image" : "link",
        [isImage ? "image" : "link"]: url,
        text: label || T("未命名"),
        url: info.pageUrl || tab.url || "",
        title: tab.title || "",
      });
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
          case "clipkeep:delete-many":
            sendResponse(await deleteMany(msg.ids));
            break;
          case "clipkeep:tag-add-many":
            sendResponse(await tagAddMany(msg.ids, msg.tags));
            break;
          case "clipkeep:update":
            sendResponse(await updateItem(msg.id, msg.patch || {}));
            break;
          case "clipkeep:grade":
            sendResponse(await gradeItem(msg.id, msg.review));
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
          case "clipkeep:trash-restore-one":
            sendResponse(await trashRestoreOne(msg.payload));
            break;
          case "clipkeep:trash-clear":
            sendResponse(await trashClear(msg.kind));
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
