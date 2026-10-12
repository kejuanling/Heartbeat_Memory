"use strict";
// memory-pool-io.js（2026-10-11 新增）：记忆池「导出 / 导入」，用来清洗记忆池。
//
// 导出：只导出 active 条目，可按 kind（fact / rule / event）过滤，输出完整的原子记忆列表。
// 导入：按 id 覆盖「可编辑字段」；没有 id 的当新增（来源标记与管理台手动新增一致）；
//       status=archived 沉底；status=active 恢复已沉底的条目；superseded 条目的状态不动。
//       id、创建时间、来源、置信度、取代关系等系统字段一律不动。
//       文件里没写的字段不改（只覆盖文件里出现的字段）。
// 预览与正式导入共用同一个 runImport：预览在「线上数据的临时副本」上完整跑一遍，不碰线上数据，
// 所以预览出来的数字就是正式导入会发生的结果。正式导入前先备份集合文件。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore, CONSTANTS } = require("../memory-v2");

const KIND_MAP = { "关于她": "fact", "认账": "rule", "拓本": "fact", fact: "fact", rule: "rule", event: "event" };
const MAX_ENTRIES = 5000;
const PREVIEW_PREFIX = "mv2-import-preview-";
const CHANGES_CAP = 40;
const FAILURES_CAP = 100;
// 导入时可覆盖的字段（text / kind / anchor 单独处理）。顺序有意义：direction 必须在 kind 之后处理
const EDIT_KEYS = ["note", "direction", "established_at", "sensitive", "triggers", "vibe", "source_session",
  "worth", "worth_reason", "volatility", "volatility_reason"];

function nullIfBlank(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function normTriggers(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) return v;
  const arr = v.map(nullIfBlank).filter(Boolean);
  return [...new Set(arr)].slice(0, CONSTANTS.TRIGGERS_MAX);
}
function normWorth(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
function sameValue(k, cur, next) {
  if (k === "sensitive") return !!cur === !!next;
  if (k === "triggers") return JSON.stringify(normTriggers(cur)) === JSON.stringify(normTriggers(next));
  if (k === "worth") return normWorth(cur) === normWorth(next);
  return nullIfBlank(cur) === nullIfBlank(next);
}
function short(s) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 40) + "…" : t;
}

// ---------------- 导出 ----------------
function exportActive(store, category) {
  const cat = String(category || "all").trim() || "all";
  let kind = null;
  if (cat !== "all") {
    kind = KIND_MAP[cat];
    if (!kind) throw new Error("category 必须是 all / fact / rule / event");
  }
  const items = store.list({ status: "active" }).filter((e) => !kind || e.kind === kind);
  items.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return {
    format: "memory-pool-export",
    version: 1,
    exported_at: new Date().toISOString(),
    category: kind || "all",
    count: items.length,
    entries: JSON.parse(JSON.stringify(items)),
  };
}

// ---------------- 导入 ----------------
// 接受：导出文件的整体对象 {entries:[...]} / {data:{entries:[...]}} / {data:[...]}
function extractEntries(body) {
  const b = body || {};
  let arr = null;
  if (Array.isArray(b.entries)) arr = b.entries;
  else if (b.data && Array.isArray(b.data.entries)) arr = b.data.entries;
  else if (Array.isArray(b.data)) arr = b.data;
  if (!arr) throw new Error("没有找到 entries 数组（文件应是导出的 JSON，或直接是条目数组）");
  if (arr.length === 0) throw new Error("entries 为空，没有可导入的条目");
  if (arr.length > MAX_ENTRIES) throw new Error("一次最多导入 " + MAX_ENTRIES + " 条，当前 " + arr.length + " 条");
  return arr;
}

// 带回滚的字段更新：updateFields 校验到一半失败时，前面已改的字段还留在内存里，这里还原
function applyPatch(store, entry, patch) {
  const snap = JSON.parse(JSON.stringify(entry));
  const r = store.updateFields(entry.id, patch);
  if (!r.ok) {
    for (const k of Object.keys(entry)) delete entry[k];
    Object.assign(entry, snap);
    throw new Error(r.error);
  }
}
function applyStatus(store, id, to) {
  const r = store.updateStatus(id, to, to === "archived" ? { reason: "archived" } : {});
  if (!r.ok) throw new Error(r.error);
}

function parseStatus(item, has) {
  if (!has("status") || item.status == null || String(item.status).trim() === "") return null;
  const st = String(item.status).trim().toLowerCase();
  if (st !== "active" && st !== "archived" && st !== "superseded") throw new Error("status 非法: " + st + "（只认 active / archived）");
  return st;
}

function processOne(store, item, index, res, seen) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("条目不是对象");
  const has = (k) => Object.prototype.hasOwnProperty.call(item, k);
  const id = item.id == null ? "" : String(item.id).trim();
  if (id) {
    if (seen.has(id)) throw new Error("文件内 id 重复: " + id);
    seen.add(id);
  }
  const wantStatus = parseStatus(item, has);

  let text;
  if (has("text") || has("content")) {
    text = String(has("text") ? item.text : item.content == null ? "" : item.content).trim();
    if (!text) throw new Error("text 为空");
    if (text.length > CONSTANTS.TEXT_MAX) throw new Error("text 超长（>" + CONSTANTS.TEXT_MAX + " 字符）");
  }
  let kind;
  if (has("kind") || has("category")) {
    const raw = String(has("kind") ? item.kind : item.category).trim();
    kind = KIND_MAP[raw];
    if (!kind || !CONSTANTS.KINDS.includes(kind)) throw new Error("kind 非法: " + raw + "（允许 fact / rule / event）");
  }

  const existing = id ? store.get(id) : null;
  if (id && !existing) throw new Error("池里找不到该 id（想新增请去掉 id）");

  // ---------- 新增 ----------
  if (!existing) {
    if (text === undefined) throw new Error("新增条目必须有 text");
    if (kind === undefined) throw new Error("新增条目必须有 kind");
    if (wantStatus === "superseded") throw new Error("新增条目 status 只能是 active / archived");
    const input = { text, kind, origin: "manual", provenance: { method: "admin_form" } };
    for (const k of EDIT_KEYS) {
      if (!has(k)) continue;
      const v = item[k];
      if (v == null || (typeof v === "string" && v.trim() === "")) continue;
      input[k] = v;
    }
    const r = store.create(input);
    if (!r.ok) throw new Error(r.error);
    const newId = r.entry.id;
    const acts = ["create"];
    res.create++;
    res.by_kind[kind]++;
    if (!!(has("anchor") ? item.anchor : item.pinned)) {
      try { store.updateFields(newId, { anchor: true }); } catch (e) { /* 置顶失败不影响新增 */ }
    }
    if (wantStatus === "archived") {
      try { applyStatus(store, newId, "archived"); acts.push("archive"); res.archive++; }
      catch (e) { addFailure(res, index, newId, "已新增，但沉底失败：" + e.message); }
    }
    addChange(res, { i: index, id: newId, acts, fields: [], text: short(text) });
    return;
  }

  // ---------- 覆盖已有 ----------
  const finalKind = kind !== undefined ? kind : existing.kind;
  const patch = {};
  const fields = [];
  if (text !== undefined && text !== existing.text) { patch.text = text; fields.push("text"); }
  if (kind !== undefined && kind !== existing.kind) { patch.kind = kind; fields.push("kind"); }
  for (const k of EDIT_KEYS) {
    if (!has(k)) continue;
    if (k === "direction" && finalKind !== "rule") {
      if (nullIfBlank(item.direction) !== null) throw new Error("direction 仅 rule 可用");
      continue;
    }
    if (sameValue(k, existing[k], item[k])) continue;
    patch[k] = item[k];
    fields.push(k);
  }
  if (has("anchor") || has("pinned")) {
    const want = !!(has("anchor") ? item.anchor : item.pinned);
    if (!!existing.anchor !== want) { patch.anchor = want; fields.push("anchor"); }
  }

  // 状态：archived 沉底（仅 active 可沉）；active 恢复（仅 archived 可恢复）；superseded 的条目状态不动
  let statusOp = null;
  if (wantStatus === "archived" && existing.status === "active") statusOp = "archive";
  else if (wantStatus === "active" && existing.status === "archived") statusOp = "revive";
  else if (wantStatus === "superseded" && existing.status !== "superseded") throw new Error("不支持把条目改成 superseded");

  const acts = [];
  if (fields.length) { applyPatch(store, existing, patch); acts.push("update"); res.update++; }
  if (statusOp === "archive") { applyStatus(store, id, "archived"); acts.push("archive"); res.archive++; }
  if (statusOp === "revive") { applyStatus(store, id, "active"); acts.push("revive"); res.revive++; }
  if (!acts.length) res.unchanged++;
  else addChange(res, { i: index, id, acts, fields, text: short(text !== undefined ? text : existing.text) });
  res.by_kind[finalKind]++;
}

function addFailure(res, index, id, reason) {
  res.failed++;
  if (res.failures.length < FAILURES_CAP) res.failures.push({ i: index, id: id || null, reason });
  else res.failures_truncated = true;
}
function addChange(res, c) {
  if (res.changes.length < CHANGES_CAP) res.changes.push(c);
  else res.changes_truncated = true;
}

function runImport(store, entries) {
  if (store.readonly) throw new Error("记忆库处于只读模式（MEMORY_V2_READONLY），拒绝导入");
  const res = {
    total: entries.length, failed: 0,
    by_kind: { fact: 0, rule: 0, event: 0 },
    update: 0, create: 0, archive: 0, revive: 0, unchanged: 0,
    failures: [], changes: [],
  };
  const seen = new Set();
  entries.forEach((item, index) => {
    try {
      processOne(store, item, index, res, seen);
    } catch (e) {
      addFailure(res, index, item && typeof item === "object" ? item.id : null, e && e.message ? e.message : String(e));
    }
  });
  return res;
}

// 预览：在线上集合的临时副本上完整跑一遍（不碰线上数据）
function previewImport(realStore, entries) {
  const base = path.join(os.tmpdir(), PREVIEW_PREFIX);
  const tmp = fs.mkdtempSync(base);
  try {
    fs.mkdirSync(path.join(tmp, "data"));
    if (fs.existsSync(realStore.paths.collection)) {
      fs.copyFileSync(realStore.paths.collection, path.join(tmp, "data", "memory_v2.json"));
    }
    const scratch = createStore({ rootDir: tmp, config: {} });
    return runImport(scratch, entries);
  } finally {
    // 只删自己建的临时目录
    if (tmp.startsWith(base)) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
}

// 正式导入：先备份集合文件（校验大小一致），再执行
function applyImport(store, entries) {
  const coll = store.paths.collection;
  let backup = null;
  if (fs.existsSync(coll)) {
    backup = coll + ".bak-import-" + new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(coll, backup);
    if (fs.statSync(backup).size !== fs.statSync(coll).size) {
      throw new Error("备份校验失败（大小不一致），已中止导入，未改动任何数据");
    }
  }
  const res = runImport(store, entries);
  res.backup = backup ? path.basename(backup) : null;
  return res;
}

module.exports = { exportActive, extractEntries, runImport, previewImport, applyImport };
