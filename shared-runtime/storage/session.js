/**
 * shared-runtime/storage/session.js — SessionStore 基础实现（C0 基建）
 *
 * 边界职责：作为 currentSession 的「唯一真源」，并集中管理其 localStorage 持久化。
 *
 * 官方 API（本阶段实现）：
 *   SessionStore.getCurrentSession()      读内部状态
 *   SessionStore.setCurrentSession(sid, opts?)  更新内存 + 按 persist 写 localStorage
 *   SessionStore.bootstrap(seed)          初始化三态来源裁决
 *
 * 硬约束（本文件 import 无副作用）：
 *   - 不触发 renderAll / pushCurrentSession / startLiveEvents / applyHeader / toast / 任何业务调用
 *   - localStorage key（han_current_session）封装在读写函数内，外部不可感知
 *   - 不修改 chat.html 业务逻辑（本阶段不迁移任何 currentSession 读写点）
 *
 * 目标：后续 ES Module 迁移稳定接口；无框架依赖。
 */

/* ---------- 私有状态 ---------- */
let _currentSession = "default";
let _sessionList = [];      // 会话列表（服务器 /v1/sessions 拉取，内存态，不落 localStorage）
let _wakeLocked = [];       // 锁定唤醒会话集合（服务器同步，内存态，不落 localStorage）
let _thirdPartySid = null;  // 当前「第三方专用会话」id（内存态，不落 localStorage）

/** 持久化键 —— 封装在模块内，禁止外部感知/复用。 */
const LS_SESSION_KEY = "han_current_session";

/* ---------- 内部持久化（读/写集中于此） ---------- */
function readFromStorage() {
  try {
    const v = localStorage.getItem(LS_SESSION_KEY);
    return typeof v === "string" && v ? v : "default";
  } catch (e) {
    return "default"; // localStorage 不可用（隐私模式/配额）时回退
  }
}

function writeToStorage(sid) {
  try {
    localStorage.setItem(LS_SESSION_KEY, sid);
  } catch (e) {
    /* 静默：配额满/隐私模式与 chat.html saveMsgs/saveCfg 语义一致，不中断 */
  }
}

/**
 * 读取当前会话 id。
 * @returns {string} 内存中的 current session（初始 'default'）
 * 无副作用，不触发 UI/API/事件。
 */
export function getCurrentSession() {
  return _currentSession;
}

/**
 * 设置当前会话。
 * @param {string} sid 目标 session id
 * @param {{ persist?: boolean }} [options] persist 默认 true
 *   persist=true : 更新内存 + 写 localStorage(han_current_session)
 *   persist=false: 仅更新内存，不写 localStorage
 * @returns {string} sid（便于链式/断言）
 * 禁止副作用：不触发 renderAll / pushCurrentSession / startLiveEvents / applyHeader / toast。
 */
export function setCurrentSession(sid, options) {
  _currentSession = sid;
  const opts = options || {};
  if (opts.persist !== false) {
    writeToStorage(sid);
  }
  return sid;
}

/**
 * 初始化阶段裁决 currentSession 来源（保留三态语义）。
 * @param {{ local?: string, remote?: string, best?: string }} seed
 *   local : 仅候选，不主动持久化
 *   remote: 仅候选，不主动持久化（优先级高于 local）
 *   best  : 兜底候选（优先级最高）；是否写 localStorage 由本函数内部策略决定
 * @returns {string} 最终选取的会话 id
 *
 * 语义对齐 initChat 三段（chat.html 7606/7608/7614）：
 *   先 local(读 localStorage) → remote 覆盖 → best 兜底并落盘。
 * bootstrap 不是 setCurrentSession 的包装，不得折叠为 setter。
 */
export function bootstrap(seed) {
  const s = seed || {};
  const { local, remote, best } = s;
  let winner = "default";
  let fromBest = false; // 仅在 best 兜底命中时由内部策略决定持久化

  if (best !== undefined) {
    winner = best;
    fromBest = true;
  } else if (remote !== undefined) {
    winner = remote;
  } else if (local !== undefined) {
    winner = local;
  }

  _currentSession = winner;
  if (fromBest) {
    // 内部策略：best 是兜底结果 → 落盘（对齐 7614 内存+setItem）
    writeToStorage(winner);
  }
  return winner;
}

/* ---------- 命名空间对象（bridge 挂到 window.SessionStore） ---------- */
export const SessionStore = {
  getCurrentSession,
  setCurrentSession,
  bootstrap,
  getSessionList,
  setSessionList,
  upsertSession,
  removeSession,
  getWakeLocked,
  setWakeLocked,
  toggleWakeLocked,
  getThirdPartySid,
  setThirdPartySid,
};

/**
 * 迁移源锚点（本阶段仅登记，不做任何读写替换）：
 *   - 读点：chat.html 2412/2414/2425/2506-2532/2679-3386/3478-3580/4024/4176-4192/4382/6595-6611/7041/7125/7155/7257/7409/7611/7613/8324
 *   - 写点：4038/7013/7046/7093/7130/7384/7458/7606/7608/7614
 *   - 清缓存语义：clearLocalCache(7453-7457) 删除/重置 han_current_session
 */

/* ---------- 会话列表（sessionList，内存态） ---------- */
/**
 * 读取会话列表（返回内部数组引用；调用方可读或就地改元素属性，不得整体替换——整体替换请用 setSessionList）。
 * @returns {Array<{id:string,name?:string,total?:number,real?:number,last_time?:string|null,is_default?:boolean}>}
 */
export function getSessionList() {
  return _sessionList;
}

/**
 * 整体替换会话列表。
 * @param {Array} list 服务器 /v1/sessions 返回的 sessions 数组
 * 无副作用：不触发 renderSessionList / push* / saveMsgs。
 */
export function setSessionList(list) {
  _sessionList = Array.isArray(list) ? list : [];
}

/**
 * 按 id 插入或替换会话（存在同名则替换整个元素，否则 push 到末尾）。
 * @param {object} s 会话对象（必须含 id）
 * 无副作用。
 */
export function upsertSession(s) {
  if (!s || typeof s.id !== "string") return;
  const idx = _sessionList.findIndex((x) => x && x.id === s.id);
  if (idx >= 0) _sessionList[idx] = s;
  else _sessionList.push(s);
}

/**
 * 从列表中移除指定 id 的会话。
 * @param {string} id
 * 无副作用。
 */
export function removeSession(id) {
  _sessionList = _sessionList.filter((s) => s && s.id !== id);
}

/* ---------- 锁定唤醒集合（wakeLocked，内存态） ---------- */
/**
 * 读取锁定唤醒会话集合（返回内部数组引用，含 indexOf/splice 等原生操作；整体替换请用 setWakeLocked）。
 * @returns {string[]}
 */
export function getWakeLocked() {
  return _wakeLocked;
}

/**
 * 整体替换锁定唤醒集合。
 * @param {string[]} arr
 * 无副作用。
 */
export function setWakeLocked(arr) {
  _wakeLocked = Array.isArray(arr) ? arr : [];
}

/**
 * 切换单个会话的锁定唤醒状态。
 * @param {string} id
 * @returns {boolean} 切换后的新状态（true=已锁定）
 * 无副作用：不触发 pushWakeLocked / toast / updateSessionItem。
 */
export function toggleWakeLocked(id) {
  const idx = _wakeLocked.indexOf(id);
  if (idx >= 0) _wakeLocked.splice(idx, 1);
  else _wakeLocked.push(id);
  return idx < 0;
}

/* ---------- 第三方专用会话（thirdPartySid，内存态） ---------- */
/**
 * 读取当前「第三方专用会话」id。
 * @returns {string|null}
 */
export function getThirdPartySid() {
  return _thirdPartySid;
}

/**
 * 设置当前「第三方专用会话」id。
 * @param {string|null} id
 * 无副作用：不触发 renderSessionList。
 */
export function setThirdPartySid(id) {
  _thirdPartySid = id || null;
}