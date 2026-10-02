'use strict';
// 记忆蒸馏调度器（2026-10-02 记忆系统改造 §8 第 3 项：后台蒸馏管线）
// 数据：data/memory_distill_config.json { enabled, time, batch_size, last_run_at, last_run_result }
//       data/memory_distill_state.json  { done:{relPath:iso}, lastBatch:[], lastBatchAt, batches, lastSummary }
// 调度：每 30s 对表一次，跨过设定时刻（且当天没跑过）即触发；进程重启有 30 分钟补跑宽限窗。
// 手动：runNow() 不受 enabled 约束（开关关着也能手动跑一次）。
// 单飞：running 标志，同一时刻只允许一个蒸馏在跑。
// 选材：diary/ 下全部 .md（含根目录散篇与各会话子目录），排除 smoke-* 测试会话；★ 留纸 papers/ 不参与。
// 进度：state.done 记录已蒸馏的日记，一次触发跑一批（batch_size 篇），增量追赶、不重复喂。
// 施工进度：3.1 配置+调度+UI；3.2 分批器（本版）；3.3 预取/工具；3.4 抽取 LLM；3.5 取证；3.6 落待审。

const fs = require("fs-extra");
const path = require("path");
const timeUtils = require("../time_utils");

const DEFAULT_CONFIG = {
  enabled: false,
  time: "03:00",
  batch_size: 5,
  last_run_at: null,
  last_run_result: null,
};

const CHECK_MS = 30000;          // 对表间隔
const CATCHUP_WINDOW_MS = 30 * 60 * 1000; // 重启补跑宽限窗：该时刻过去 30 分钟内重启才补跑
const EXCLUDE_SESSION_PREFIX = ["smoke-"]; // 测试会话不蒸馏

function pad2(n) { return String(n).padStart ? String(n).padStart(2, "0") : (Number(n) < 10 ? "0" + n : String(n)); }

function normalizeTime(raw) {
  const s = String(raw == null ? "" : raw).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return DEFAULT_CONFIG.time;
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return pad2(h) + ":" + pad2(mi);
}

function normalizeBatch(raw) {
  const n = Number(raw);
  if (!isFinite(n)) return DEFAULT_CONFIG.batch_size;
  return Math.min(20, Math.max(1, Math.round(n)));
}

// 日记文件名 → 排序键：日期 + 时间（无时间补 000000），保证跨会话按时间线混排
function sortKeyOf(relPath) {
  const base = String(path.basename(relPath) || "");
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[_-](\d{2})(\d{2})(?:(\d{2}))?)?/.exec(base);
  if (!m) return "9999-99-99_000000_" + relPath;
  const date = m[1] + "-" + m[2] + "-" + m[3];
  const time = (m[4] || "00") + (m[5] || "00") + (m[6] || "00");
  return date + "_" + time + "_" + relPath;
}

function dateKeyOf(relPath) {
  const base = String(path.basename(relPath) || "");
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(base);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
}

module.exports = function createMemoryDistill(deps) {
  const opts = deps || {};
  const baseDir = opts.baseDir || path.resolve(__dirname, "..");
  const diaryDir = opts.diaryDir || path.join(baseDir, "diary");
  const CFG_FILE = path.join(baseDir, "data", "memory_distill_config.json");
  const STATE_FILE = path.join(baseDir, "data", "memory_distill_state.json");
  const TZ = timeUtils.resolveTimeZone();
  const addLog = typeof opts.addCompactionLog === "function" ? opts.addCompactionLog : null;
  const persistLog = typeof opts.persistCompactionLogs === "function" ? opts.persistCompactionLogs : null;

  const state = {
    timer: null,
    running: false,
    startedAt: null,
    lastTrigger: null,   // manual | schedule | catchup
    lastError: null,
    runs: 0,
  };

  function logErr(msg) { console.error("[memory-distill] " + msg); }
  function logInfo(msg) { console.log("[memory-distill] " + msg); }

  function noteLog(action, label, status, message) {
    if (!addLog) return null;
    try {
      const entry = addLog({ action: action, label: label, status: status, message: message });
      if (persistLog) { try { persistLog(); } catch (e) {} }
      return entry || null;
    } catch (e) { return null; }
  }

  function readJsonSafe(file, fallback) {
    try {
      const raw = fs.readJsonSync(file);
      return raw && typeof raw === "object" ? raw : (fallback || {});
    } catch (e) { return fallback || {}; }
  }

  // ---------------- 配置 ----------------
  function readConfig() {
    const c = readJsonSafe(CFG_FILE, {});
    return {
      enabled: !!c.enabled,
      time: normalizeTime(c.time),
      batch_size: normalizeBatch(c.batch_size),
      last_run_at: c.last_run_at || null,
      last_run_result: c.last_run_result || null,
    };
  }

  function saveConfig(patch) {
    const cur = readJsonSafe(CFG_FILE, {});
    const next = Object.assign({}, cur);
    const p = patch || {};
    if (p.enabled !== undefined) next.enabled = !!p.enabled;
    if (p.time !== undefined) next.time = normalizeTime(p.time);
    if (p.batch_size !== undefined) next.batch_size = normalizeBatch(p.batch_size);
    if (p.last_run_at !== undefined) next.last_run_at = p.last_run_at;
    if (p.last_run_result !== undefined) next.last_run_result = p.last_run_result;
    try { fs.writeJsonSync(CFG_FILE, next, { spaces: 2 }); } catch (e) { throw e; }
    return readConfig();
  }

  // ---------------- 进度 state ----------------
  function readState() {
    const s = readJsonSafe(STATE_FILE, {});
    return {
      done: (s.done && typeof s.done === "object") ? s.done : {},
      lastBatch: Array.isArray(s.lastBatch) ? s.lastBatch : [],
      lastBatchAt: s.lastBatchAt || null,
      batches: Number(s.batches) || 0,
      lastSummary: s.lastSummary || "",
      candidates: Number(s.candidates) || 0,
      queued: Number(s.queued) || 0,
    };
  }

  function writeState(next) {
    try { fs.writeJsonSync(STATE_FILE, next, { spaces: 2 }); } catch (e) { throw e; }
    return next;
  }

  // ---------------- 选材：日记清单 ----------------
  function listDiaries() {
    const out = [];
    if (!fs.existsSync(diaryDir)) return out;
    const walk = function (absDir, session) {
      let ents = [];
      try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of ents) {
        const abs = path.join(absDir, ent.name);
        if (ent.isDirectory()) {
          if (EXCLUDE_SESSION_PREFIX.some(function (p) { return ent.name.indexOf(p) === 0; })) continue;
          walk(abs, ent.name);
        } else if (ent.isFile() && /\.md$/i.test(ent.name)) {
          const rel = path.relative(diaryDir, abs).split(path.sep).join("/");
          let chars = 0;
          try { chars = String(fs.readFileSync(abs, "utf-8") || "").length; } catch (e) {}
          out.push({
            relPath: rel,
            absPath: abs,
            session: session || "_root",
            date: dateKeyOf(ent.name),
            chars: chars,
            sortKey: sortKeyOf(rel),
          });
        }
      }
    };
    walk(diaryDir, "");
    out.sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : (a.sortKey > b.sortKey ? 1 : 0); });
    return out;
  }

  /**
   * 选一批：已蒸馏（state.done）的跳过，按时间升序取 batch_size 篇。
   * dryRun=true 时不写盘，只算不记（测试/预览用）。
   */
  function planBatch(batchSize, dryRun) {
    const all = listDiaries();
    const st = readState();
    const pending = all.filter(function (d) { return !st.done[d.relPath]; });
    const n = Math.min(batchSize, pending.length);
    const picked = pending.slice(0, n).map(function (d) {
      return { relPath: d.relPath, session: d.session, date: d.date, chars: d.chars };
    });
    const plan = {
      picked: picked,
      pickedCount: picked.length,
      total: all.length,
      doneCount: all.length - pending.length,
      pending: pending.length,
      remaining: pending.length - picked.length,
      chars: picked.reduce(function (s, d) { return s + (d.chars || 0); }, 0),
      batchIndex: st.batches + (picked.length ? 1 : 0),
      batchesTotal: Math.ceil(all.length / Math.max(1, batchSize)),
    };
    if (picked.length && !dryRun) {
      const doneNext = Object.assign({}, st.done);
      const at = new Date().toISOString();
      picked.forEach(function (d) { doneNext[d.relPath] = at; });
      writeState(Object.assign({}, st, {
        done: doneNext,
        lastBatch: picked.map(function (d) { return d.relPath; }),
        lastBatchAt: at,
        batches: st.batches + 1,
      }));
    }
    return plan;
  }

  function nowIso() { return new Date().toISOString(); }
  function nowLocal() { return timeUtils.formatDateTimeInTimeZone(new Date(), TZ); }

  function parts() { return timeUtils.getDatePartsInTimeZone(new Date(), TZ); }

  function todayKey() {
    const p = parts();
    return p.year + "-" + pad2(p.month) + "-" + pad2(p.day);
  }

  function runDateKey(cfg) {
    const s = cfg && cfg.last_run_at ? String(cfg.last_run_at) : "";
    if (!s) return "";
    // last_run_at 存 ISO（UTC）；按本地时区换算成日期，避免 03:00 跑完被算成"昨天"
    const d = new Date(s);
    if (isNaN(d.getTime())) return "";
    const p = timeUtils.getDatePartsInTimeZone(d, TZ);
    return p.year + "-" + pad2(p.month) + "-" + pad2(p.day);
  }

  // 今天设定时刻的 Date（本地时区）
  function dueToday(cfg) {
    const p = parts();
    const t = normalizeTime(cfg.time).split(":");
    return timeUtils.zonedWallTimeToDate({
      year: p.year, month: p.month, day: p.day,
      hour: Number(t[0]), minute: Number(t[1]), second: 0,
    }, TZ);
  }

  /**
   * 跑一次蒸馏（一批）。
   * 3.2：选材分批已接入（进度写 state，dryRun 可空跑）；3.3 起原文预取 / 3.4 抽取 / 3.5 取证 / 3.6 落待审陆续接入。
   */
  async function runOnce(reason, runOpts) {
    if (state.running) {
      return { ok: false, error: "已有蒸馏在跑，请等它结束", startedAt: state.startedAt };
    }
    const ro = runOpts || {};
    const dryRun = !!ro.dryRun;
    const cfg = readConfig();
    state.running = true;
    state.startedAt = nowIso();
    state.lastTrigger = String(reason || "manual");
    state.lastError = null;
    const label = "记忆蒸馏（" + (reason === "schedule" ? "定时" : reason === "catchup" ? "重启补跑" : "手动") + "）";
    const logEntry = noteLog("distill", label, "pending", "开始跑：批次大小 " + cfg.batch_size + "（3.2 分批器已接入）");
    const t0 = Date.now();
    try {
      const plan = planBatch(cfg.batch_size, dryRun);
      // TODO 3.3：预取命中原文（context_search）与日记打包
      // TODO 3.4：LLM 抽取候选原子记忆（含 kind + subject 判定）
      // TODO 3.5：取证（证据来自日记的必须回原文确认）
      // TODO 3.6：走 admission judge 去重后落待审队列
      const result = {
        ok: true,
        reason: state.lastTrigger,
        dryRun: dryRun,
        startedAt: state.startedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - t0,
        batchSize: cfg.batch_size,
        batches: plan.pickedCount ? 1 : 0,
        picked: plan.pickedCount,
        pickedChars: plan.chars,
        total: plan.total,
        doneCount: plan.doneCount,
        remaining: plan.remaining,
        batchIndex: plan.batchIndex,
        batchesTotal: plan.batchesTotal,
        candidates: 0,
        queued: 0,
        stage: "3.2-batcher",
        files: plan.picked.map(function (d) { return d.relPath; }),
        note: plan.pickedCount
          ? ("本批选材 " + plan.pickedCount + " 篇日记（" + plan.chars + " 字符），剩 " + plan.remaining + " 篇待蒸馏；抽取/取证尚未接入（3.3 起）")
          : "没有待蒸馏的新日记（全部 " + plan.total + " 篇已处理）",
      };
      saveConfig({ last_run_at: result.finishedAt, last_run_result: result });
      state.runs += 1;
      if (logEntry && logEntry.id) noteLog("distill", label, "success", "完成：" + result.note);
      logInfo("跑完一次（" + state.lastTrigger + "）：" + result.note);
      return result;
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      state.lastError = msg;
      const result = { ok: false, reason: state.lastTrigger, startedAt: state.startedAt, finishedAt: nowIso(), error: msg };
      try { saveConfig({ last_run_at: result.finishedAt, last_run_result: result }); } catch (e) {}
      if (logEntry && logEntry.id) noteLog("distill", label, "error", "失败：" + msg);
      logErr("蒸馏失败：" + msg);
      return result;
    } finally {
      state.running = false;
      state.startedAt = null;
    }
  }

  function tick() {
    try {
      const cfg = readConfig();
      if (!cfg.enabled) return;
      if (state.running) return;
      if (runDateKey(cfg) === todayKey()) return;   // 今天跑过了
      const due = dueToday(cfg);
      const now = Date.now();
      if (now >= due.getTime()) runOnce("schedule").catch(function (e) { logErr("定时触发异常：" + (e && e.message || e)); });
    } catch (e) {
      logErr("对表异常：" + (e && e.message || e));
    }
  }

  // 重启补跑：该时刻已过但在 30 分钟宽限窗内、且今天没跑过 → 补一次（防重启恰好跨过触发点导致整天漏跑）
  function catchupIfMissed() {
    try {
      const cfg = readConfig();
      if (!cfg.enabled) return;
      if (runDateKey(cfg) === todayKey()) return;
      const due = dueToday(cfg);
      const delta = Date.now() - due.getTime();
      if (delta > 0 && delta <= CATCHUP_WINDOW_MS) {
        logInfo("检测到今天 " + cfg.time + " 的蒸馏在重启窗口内被错过，补跑一次");
        runOnce("catchup").catch(function (e) { logErr("补跑异常：" + (e && e.message || e)); });
      }
    } catch (e) {
      logErr("补跑检查异常：" + (e && e.message || e));
    }
  }

  function start() {
    if (state.timer) return { started: false, note: "已在运行" };
    state.timer = setInterval(tick, CHECK_MS);
    if (state.timer.unref) state.timer.unref();
    const cfg = readConfig();
    const all = listDiaries();
    logInfo("调度已启动：enabled=" + cfg.enabled + " time=" + cfg.time + " batch=" + cfg.batch_size +
      "（时区 " + TZ + "，本地现在 " + nowLocal() + "）日记总数 " + all.length);
    catchupIfMissed();
    return { started: true, config: cfg, diaries: all.length };
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    return { stopped: true };
  }

  function status() {
    const cfg = readConfig();
    const st = readState();
    const all = listDiaries();
    const pending = all.filter(function (d) { return !st.done[d.relPath]; });
    return {
      running: state.running,
      startedAt: state.startedAt,
      lastTrigger: state.lastTrigger,
      lastError: state.lastError,
      runs: state.runs,
      schedulerOn: !!state.timer,
      checkMs: CHECK_MS,
      timezone: TZ,
      nowLocal: nowLocal(),
      today: todayKey(),
      ranToday: runDateKey(cfg) === todayKey(),
      progress: {
        total: all.length,
        done: all.length - pending.length,
        pending: pending.length,
        batches: st.batches,
        lastBatchAt: st.lastBatchAt,
        lastBatch: st.lastBatch,
      },
      config: cfg,
    };
  }

  return {
    configPath: CFG_FILE,
    statePath: STATE_FILE,
    readConfig: readConfig,
    saveConfig: saveConfig,
    readState: readState,
    listDiaries: listDiaries,
    planBatch: planBatch,
    runNow: function (reason, runOpts) { return runOnce(reason || "manual", runOpts); },
    start: start,
    stop: stop,
    status: status,
    _state: state,
  };
};
