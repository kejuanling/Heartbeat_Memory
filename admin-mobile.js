
// ============================================================================
// 心跳唤醒管理台 · 移动端逻辑（admin-mobile.html 的配套 JS）
// 三件套分工：admin-mobile.html 结构 / admin-mobile.css 样式 / 本文件逻辑，
// 由 server.js 每请求读取下发（no-store），改完推送即生效、无需重启。
// 结构约定：
//   1. 业务状态统一放 AppState（压缩/记忆域），其他全局仅限 UI 基础设施。
//   2. 写操作统一走 apiRequest()（自动 CSRF、错误提示、busy 禁用）。
//   3. 渲染类函数只负责“状态 -> DOM”，相同 HTML 由 reconcileCcList 短路。
//   4. 用户输入渲染一律经 escHtml/escHtml2/escJsStr 转义，禁止直接拼接。
// 主要模块：初始化(initApp) / 心跳 / 环境变量 / 网易云 / 记忆池 / 压缩预览 /
//           上下文替换 / 提示词 / 工具集 / 服务管理 / 日志面板 / 设置。
// ============================================================================

 // API 基址：兼容 nginx 反代前缀（/heartbeat/admin）与直连（/admin）
 const ADMIN_API = location.pathname.indexOf('/heartbeat/admin/') === 0 ? '/heartbeat/admin' : '/admin';
 // 会话选择器：null = 跟随聊天页 localStorage.han_current_session；否则使用管理员在下拉框里选定的会话
 let ADMIN_SESSION = null;
 // URL 带 session=xxx（如聊天页压缩弹窗「去管理台压缩页」跳转）时自动选中该会话，效果同手动在下拉里选一次并记住
 try{
   const _urlSid = new URLSearchParams(location.search).get('session');
   if(_urlSid){ ADMIN_SESSION = _urlSid; localStorage.setItem('han_admin_session', _urlSid); }
 }catch(e){}

// 读取 cookie（供 CSRF token 使用）
function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// 登录过期时自动跳转到登录页（记住登录状态下一般不会触发）；同时给 /admin* 请求自动带 CSRF token
(function () {
  const _fetch = window.fetch;
  function isAdminUrl(u) { return u.indexOf('/admin') === 0 || u.indexOf('/heartbeat/admin') === 0; }
  let inflight = 0;
  let loadingTimer = null;
  function setLoading(on) {
    const el = document.getElementById('globalLoading');
    if (el) el.classList.toggle('show', !!on);
  }
  function beginLoad() {
    inflight++;
    if (loadingTimer) clearTimeout(loadingTimer);
    loadingTimer = setTimeout(function () { if (inflight > 0) setLoading(true); }, 180);
  }
  function endLoad() {
    inflight--;
    if (inflight < 0) inflight = 0;
    if (inflight === 0) {
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
      setLoading(false);
    }
  }
  window.fetch = function (input, init) {
    init = init || {};
    let url = typeof input === 'string' ? input : ((input && input.url) || '');
    // 压缩/替换接口自动带上当前会话（聊天与管理台同源，可读 localStorage.han_current_session）
    if (url.indexOf('/context-compaction') >= 0 || url.indexOf('/context-replacements') >= 0) {
      try {
        const sid = currentAdminSession();   // 统一入口，兜底口径与选择器一致
        if (url.indexOf('session_id=') < 0) {
          const sep = url.indexOf('?') >= 0 ? '&' : '?';
          url = url + sep + 'session_id=' + encodeURIComponent(sid);
          if (typeof input === 'string') input = url;
        }
      } catch (e) {}
    }
    const admin = isAdminUrl(url);
    if (admin) {
      const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers || {});
      const token = getCookie('admin_csrf');
      if (token) headers.set('X-CSRF-Token', token);
      init.headers = headers;
      beginLoad();
    }
    const p = _fetch(input, init).then(function (r) {
      if (r.status === 401) {
        location.href = ADMIN_API + '/mobile/login';
      }
      return r;
    });
    return admin ? p.finally(endLoad) : p;
  };
})();

// 统一 API 请求封装：自动 JSON、集中错误提示、可选 busy 按钮禁用
/**
 * 统一 API 请求封装：自动 JSON、集中错误提示、可选 busy 按钮禁用。
 * 401 自动跳登录页，403 提示 CSRF 校验失败。
 * @param {string} method HTTP 方法
 * @param {string} url 请求地址
 * @param {Object|null} body 请求体（自动 JSON.stringify）
 * @param {Object} [opts] 选项：{ busy: 保存按钮元素, throwError: 失败时抛异常 }
 * @returns {Promise<{ok:boolean,status:number,data:Object,error?:string}>}
 */
async function apiRequest(method, url, body, opts) {
  opts = opts || {};
  const btn = opts.busy || null;
  if (btn) btn.disabled = true;
  try {
    const headers = { 'Accept': 'application/json' };
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    const r = await fetch(url, { method: method, headers: headers, body: (body !== undefined && body !== null) ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      const msg = (data && (data.error || data.message)) || ('HTTP ' + r.status);
      if (r.status === 401) { location.href = ADMIN_API + '/mobile/login'; }
      else if (r.status === 403) { toast('请求被拒绝（CSRF 校验失败），请刷新页面后重试'); }
      if (opts.throwError) throw new Error(msg);
      return { ok: false, status: r.status, data: data, error: msg };
    }
    return { ok: true, status: r.status, data: data };
  } catch (err) {
    toast('网络错误: ' + ((err && err.message) || '未知'));
    return { ok: false, status: 0, data: null, error: (err && err.message) || String(err) };
  } finally {
    if (btn) btn.disabled = false;
  }
}
 // 全局拦截：任何表单提交/默认按钮行为都不允许触发整页刷新
document.addEventListener('submit',function(e){e.preventDefault();},true);
 let configData = null;
 // ============ AppState：压缩/记忆业务状态集中管理 ============
 const AppState = {
  compactionPlan: null,            // 压缩预览原始数据
  ccPreviewLoadedAt: 0,            // 预览加载时间戳（15s TTL 去重）
  compactionCutPoints: [],         // 当前生效的切分点
  ccExpanded: new Set(),           // 已展开的压缩块 index
  ccFresh: new Set(),              // 新生成的块（首次渲染需展开动画）
  ccSummaryOpen: new Set(),        // 已展开的摘要面板
  ccDraft: {},                     // 摘要编辑草稿
  ccHistoryOpen: new Set(),        // 已展开的摘要历史
  ccMsgBySig: {},                  // 块消息按签名缓存
  ccGapMsgByKey: {},               // 未覆盖区消息缓存
  ccGapTimeByKey: {},              // 未覆盖区时间范围缓存
  ccGapCollapsed: new Set(),       // 已折叠的未覆盖区 gkey
  ccGapCollapsedInit: false,       // 未覆盖区折叠初值是否已按数据初始化
  ccGapPageOffset: {},             // 未覆盖区分页偏移
  ccGapHasMore: {},                // 未覆盖区是否还有下一页
  ccGapLoadingKey: null,           // 正在加载消息的 gkey
  ccGapGenerating: new Set(),      // 正在生成摘要的 gkey
  ccBlockGenerating: new Set(),    // 正在重新生成摘要的块 index
  ccAiSummaryOpen: new Set(),      // 已展开的 AI 摘要面板
  ccAnimateOpen: new Set(),        // 待播放展开动画的节点 id
  ccAiEditTarget: null,            // AI 摘要编辑中的块 index
  ccMsgsHtmlCache: {},             // 各 chunk 已渲染 HTML 缓存（失效即重绘）
  ccMsgFetching: false,            // 是否正在拉取块消息
  ccMsgFetchDone: false,           // 块消息是否已拉取完成
  ccGapCutsOff: new Set(),         // 手动关闭（不再自动分块）的 gkey
  // 2026-09-13 死代码清理：ccPollTimer/stopCcPoll 已删——只有 stop 没有 start，全仓无启动方
  ccLastRenderedHtml: null,        // 最近一次渲染 HTML（重绘短路）
  ccOriginalTimer: null,           // 原文搜索防抖定时器
  ccOriginalSeq: 0,                // 原文搜索请求序号（防乱序）
  ccMultiSelectMode: false,        // 是否处于多选模式
  ccSelectedChunks: new Set(),     // 多选选中的 chunk index / gap key
  ccFilter: null,                  // 筛选: null/gap/pending/replace/replaced
   ccReparseMergeMaxChars: 8000,       // 合并解析总字数上限（可调）
  ccSwipeState: null,              // 压缩块左滑状态
  memPoolEditId: null,             // 记忆池编辑中的记忆 id（null=新增）
  memPoolSearchTimer: null,        // 记忆池搜索防抖定时器
  editingMemId: null,              // 导入/编辑中的记忆 id
  editingPinnedId: null,           // 置顶编辑中的 pinned id
  INITIAL_DATA: null,              // 初始环境数据（登录后拉取一次）
  memView: "cloud",                // 记忆视图: cloud/memory/pinned
  toolsDraft: null,                // 工具集配置草稿 { manifest, config }
  logPanelOpen: false,             // 日志面板是否打开
  unreadLogCount: 0                // 日志未读数（角标）
 };

 
 // ============ Init ============
/**
 * 应用初始化：恢复上次导航 tab、拉取初始环境数据、渲染各模块。
 * 认证失败时在 headerSub 给出提示并停止后续加载。
 */
 // ---------- 会话选择器：解耦聊天页 han_current_session，管理台可显式指定要操作哪个会话 ----------
 function currentAdminSession(){ return ADMIN_SESSION || localStorage.getItem('han_current_session') || 'default'; }
 async function initAdminSessionSelector(){
   const sel = document.getElementById('adm-session-sel');
   if(!sel) return;
   try{
     const r = await fetch('/v1/sessions', { credentials:'include' });
     let sessions = [];
     try{ const j = await r.json(); if(j && j.sessions) sessions = j.sessions; }catch(e){}
     let html = '<option value="">跟随聊天页当前会话</option>';
     for(const s of sessions){
       const cnt = (s && s.real!=null) ? s.real : (s ? (s.total||0) : 0);
       const nm = (s && s.name) || (s && s.id) || '';
       html += '<option value="'+escHtml(s.id)+'">'+escHtml(nm)+'（'+cnt+'条）</option>';
     }
     sel.innerHTML = html;
     const saved = localStorage.getItem('han_admin_session') || '';
     sel.value = saved;
     if (saved && sel.value !== saved) {
       // 已删除的会话不在选择器里：清掉残留，避免后续请求打到空会话
       try{ localStorage.removeItem('han_admin_session'); }catch(e){}
       ADMIN_SESSION = null;
     } else {
       ADMIN_SESSION = saved || null;
     }
   }catch(e){}
 }
 function onAdminSessionChange(){
   const sel = document.getElementById('adm-session-sel');
   const v = sel ? sel.value : '';
   ADMIN_SESSION = v || null;
   try{ if(v) localStorage.setItem('han_admin_session', v); else localStorage.removeItem('han_admin_session'); }catch(e){}
   // 必须复位块消息缓存：ccMsgFetchDone 不复位的话，新会话的块原文会永远停在"消息加载中"
   try{ if(typeof resetCcMsgCache==='function') resetCcMsgCache(); }catch(e){}
   try{ loadCompactionPreview(); }catch(e){}
 }

 async function initApp(){
   initCollapsibleCards();
   // 恢复上次停留的导航 tab（刷新后不再回到心跳页）
   try{
     let savedTab = localStorage.getItem('adminTab');
     try{ const qp=new URLSearchParams(location.search); const t=qp.get('tab'); if(t) savedTab=t; }catch(e){}
     if(savedTab && ['status','config','memory','compaction','prompts'].indexOf(savedTab)>=0 && savedTab!=='status'){
       switchTab(savedTab);
     }
   }catch(e){}
   try{
     const r = await fetch(ADMIN_API + '/env');
     if(r.ok) { AppState.INITIAL_DATA = await r.json(); }
     else {
       document.getElementById('headerSub').textContent = '认证失败，请刷新页面';
       return;
     }
   }catch(e){
     document.getElementById('headerSub').textContent = '加载失败: '+e.message;
     return;
   }
   renderHeartbeat();
   renderEnv();
   renderNetease();
   initAdminSessionSelector();
 }

 // ---------- 留纸一览（2026-09-12）：AI 留的纸（故事/梦/创作），只读+删除 ----------

  // ---------- 摘要生成日志（悬浮球 + 弹窗，可拖动） ----------
 let lastLogId = null;
 let logPollTimer = null;
 let fabDragging = false;
 let fabStartX = 0, fabStartY = 0;
 let fabOrigX = 0, fabOrigY = 0;
 let fabMoved = false;

 function initLogFab(){
   const fab = document.getElementById('logFab');
   if(!fab) return;
   fab.addEventListener('keydown',function(e){
     if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleLogPanel(); }
   });
   try {
     const saved = JSON.parse(localStorage.getItem('logFabPos') || '{}');
     // 2026-09-27 位置恢复边界钳制：换窗口/设备后保存的位置可能越出当前视口（悬浮球“消失”），
     // 越界自动拉回屏幕内（4px 边距；窄视口下钳到 4px 保证可见），无位置记录仍走默认右下角。
     const vw = window.innerWidth, vh = window.innerHeight;
     const fw = fab.offsetWidth || 50, fh = fab.offsetHeight || 50;
     let rx = saved.x, ry = saved.y;
     if(rx !== undefined) rx = Math.max(4, Math.min(vw - fw - 4, rx));
     if(ry !== undefined) ry = Math.max(4, Math.min(vh - fh - 4, ry));
     if(rx !== undefined) fab.style.left = rx + 'px';
     if(ry !== undefined) fab.style.top = ry + 'px';
     if(rx !== undefined || ry !== undefined){
       fab.style.right = 'auto';
       fab.style.bottom = 'auto';
     }
   } catch(e){}
   function onDown(e){
     fabDragging = true;
     fabMoved = false;
     const pt = e.touches ? e.touches[0] : e;
     fabStartX = pt.clientX;
     fabStartY = pt.clientY;
     const rect = fab.getBoundingClientRect();
     fabOrigX = rect.left;
     fabOrigY = rect.top;
     fab.style.right = 'auto';
     fab.style.bottom = 'auto';
     e.preventDefault();
   }
   function onMove(e){
     if(!fabDragging) return;
     const pt = e.touches ? e.touches[0] : e;
     const dx = pt.clientX - fabStartX;
     const dy = pt.clientY - fabStartY;
     if(Math.abs(dx) > 3 || Math.abs(dy) > 3) fabMoved = true;
     let nx = fabOrigX + dx;
     let ny = fabOrigY + dy;
     const maxX = window.innerWidth - fab.offsetWidth - 4;
     const maxY = window.innerHeight - fab.offsetHeight - 4;
     nx = Math.max(4, Math.min(maxX, nx));
     ny = Math.max(4, Math.min(maxY, ny));
     fab.style.left = nx + 'px';
     fab.style.top = ny + 'px';
     positionLogPanel(nx, ny);
     e.preventDefault();
   }
   function onUp(e){
     if(!fabDragging) return;
     fabDragging = false;
     try {
       const rect = fab.getBoundingClientRect();
       localStorage.setItem('logFabPos', JSON.stringify({ x: rect.left, y: rect.top }));
     } catch(e){}
     if(!fabMoved) toggleLogPanel();
     e.preventDefault();
   }
   fab.addEventListener('mousedown', onDown);
   document.addEventListener('mousemove', onMove);
   document.addEventListener('mouseup', onUp);
   fab.addEventListener('touchstart', onDown, {passive:false});
   document.addEventListener('touchmove', onMove, {passive:false});
   document.addEventListener('touchend', onUp, {passive:false});
 }

 function positionLogPanel(fabX, fabY){
   const panel = document.getElementById('logPanel');
   const fab = document.getElementById('logFab');
   if(!panel || !fab) return;
   const fabW = fab.offsetWidth;
   const fabH = fab.offsetHeight;
   const panelW = Math.min(360, window.innerWidth - 40);
   let px = fabX - panelW + fabW;
   let py = fabY - 300 - 10;
   if(px < 10) px = 10;
   if(py < 10) py = fabY + fabH + 10;
   panel.style.left = px + 'px';
   panel.style.top = py + 'px';
   panel.style.right = 'auto';
   panel.style.bottom = 'auto';
 }

 function toggleLogPanel(){
   const panel = document.getElementById('logPanel');
   const fab = document.getElementById('logFab');
   if(!panel || !fab) return;
   AppState.logPanelOpen = !AppState.logPanelOpen;
   if(AppState.logPanelOpen){
     const rect = fab.getBoundingClientRect();
     positionLogPanel(rect.left, rect.top);
     panel.classList.add('show');
     AppState.unreadLogCount = 0;
     updateLogBadge();
     loadCompactionLogs();
     startLogPolling();
   } else {
     panel.classList.remove('show');
     // 2026-09-30 V9d：轮询已常驻（3s 单定时器），关面板不再停表——原双轮询时代 5s 保底已并入
   }
 }

 function closeLogPanel(){
   const panel = document.getElementById('logPanel');
   if(panel) panel.classList.remove('show');
   AppState.logPanelOpen = false;
 }

 function updateLogBadge(){
   const badge = document.getElementById('logFabBadge');
   if(!badge) return;
   if(AppState.unreadLogCount > 0){
     badge.classList.add('show');
     badge.textContent = AppState.unreadLogCount > 99 ? '99+' : AppState.unreadLogCount;
   } else {
     badge.classList.remove('show');
   }
 }

 function formatLogTime(iso){
   try {
     const d = new Date(iso);
     const pad = n => String(n).padStart(2, '0');
     return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
   } catch(e) { return ''; }
 }

 function renderLogs(logs){
   const body = document.getElementById('logPanelBody');
   if(!body) return;
   if(!logs || logs.length === 0){
     body.innerHTML = '<div class="log-panel-empty">暂无生成记录</div>';
     return;
   }
   body.innerHTML = logs.map(function(l){
     const statusText = l.status === 'success' ? '成功' : (l.status === 'error' ? '失败' : (l.status === 'skipped' ? '跳过' : '进行中'));
     return '<div class="log-item ' + (l.status || 'pending') + '">' +
       '<div class="log-item-head">' +
         '<span class="log-item-label">' + (l.label || '未知操作') + '</span>' +
         '<span class="log-item-status">' + statusText + '</span>' +
       '</div>' +
       '<div class="log-item-msg">' + String(l.message || '').replace(/</g,'&lt;').replace(/\n/g,'<br>') + '</div>' +
       '<div class="log-item-time">' + formatLogTime(l.time) + '</div>' +
     '</div>';
   }).join('');
 }

 // —— 生成中状态恢复（0926）：解析/生成摘要是服务端同步任务，页面被杀或重进后前端 fetch 已丢，
 // 但服务端仍在跑、操作日志会翻状态。挂在既有轮询上（不新增定时器）：最新生成类日志为 pending 时
 // 消息栏显示「后台生成中」，翻成 success/error 后把结果写回一次。
 // 只写空栏或本机制自己的文案（⏳ 开头），绝不覆盖其他操作的提示。——
 var GEN_ACTIONS = { reparse: 1, gap: 1, block: 1 };
 var trackedGenId = null;
 // 2026-09-28：生成完成且当前不在压缩页（切走 tab 或浏览器后台）→ Bark 推送。
 // 判定：页面后台或激活 tab 不是 compaction 都算"不在压缩页"。
 function isCompactionActive(){
   if(document.hidden) return false;
   const t = document.querySelector('.tab-content.active');
   return !!(t && t.id === 'tab-compaction');
 }
 function barkGenDone(top){
   if(!top) return;
   const _t = (top.label || '生成任务') + (top.status === 'success' ? '完成' : '失败') + (top.message ? ('：' + top.message) : '');
   try{
     fetch('/v1/notify/reply-done',{
       method:'POST',
       headers:{'Content-Type':'application/json','X-CSRF-Token':getCookie('admin_csrf')},
       body:JSON.stringify({preview:String(_t).replace(/[#*`>\n]/g,' ').trim().slice(0,200),session_id:'default'})
     }).catch(function(){});
   }catch(e){}
 }
 function syncGenStateFromLogs(logs){
   const msg = document.getElementById('compaction-msg');
   if(!msg || !logs || !logs.length) return;
   let top = null;
   for(let i = 0; i < logs.length; i++){
     if(GEN_ACTIONS[logs[i].action]){ top = logs[i]; break; }
   }
   if(!top) return;
   if(top.status === 'pending'){
     trackedGenId = top.id;
     if(msg.textContent === '' || msg.textContent.charAt(0) === '⏳'){
       msg.textContent = '⏳ ' + (top.label || '生成任务') + '：后台生成中，切走不影响；完成后此处和日志面板会更新';
     }
   } else if(trackedGenId && top.id === trackedGenId){
     trackedGenId = null;
     if(msg.textContent.charAt(0) === '⏳'){
       msg.textContent = (top.label || '生成任务') + '：' + (top.message || '已结束');
     }
     // 2026-09-28：生成结束（成功/失败都推）且不在压缩页 → Bark 推送
     if(!isCompactionActive()) barkGenDone(top);
   }
 }

 async function loadCompactionLogs(){
   try {
     const r = await fetch(ADMIN_API + '/context-compaction/logs');
     const d = await r.json();
     if(d && d.logs){
       renderLogs(d.logs);
       syncGenStateFromLogs(d.logs);
       if(d.logs.length > 0 && d.logs[0].id !== lastLogId){
         if(lastLogId && !AppState.logPanelOpen){
           AppState.unreadLogCount++;
           updateLogBadge();
         }
         lastLogId = d.logs[0].id;
       }
     }
   } catch(e) { /* ignore */ }
 }

 function startLogPolling(){
   if(logPollTimer) return;
   logPollTimer = setInterval(loadCompactionLogs, 3000);
 }

 function stopLogPolling(){
   if(logPollTimer){
     clearInterval(logPollTimer);
     logPollTimer = null;
   }
 }

 function clearCompactionLogs(){
   // 服务端没有删除接口，「清空」实际改为标记已读：对齐最新日志并清零角标，
   // 否则 3 秒轮询立刻把列表"复活"，按钮具有误导性
   fetch(ADMIN_API + '/context-compaction/logs').then(r=>r.json()).then(function(d){
     if(d && d.logs && d.logs.length > 0){ lastLogId = d.logs[0].id; }
     AppState.unreadLogCount = 0;
     updateLogBadge();
     toast('已全部标为已读');
   }).catch(function(){ toast('操作失败，请重试'); });
 }

 document.addEventListener('DOMContentLoaded', function(){
   initLogFab();
   loadCompactionLogs();
   startLogPolling();
   // 2026-09-27 悬浮球仅压缩页显示：初始按当前激活 tab 设置（initApp 恢复 tab 也可能已切到 compaction）
   const fab0=document.getElementById('logFab');
   if(fab0){
     const curTab=document.querySelector('.tab-content.active');
     fab0.style.display=(curTab && curTab.id==='tab-compaction')?'':'none';
   }
 });

 // 2026-09-30 V9d 双轮询合并：原 5s 的 checkUnreadLogs 与 3s 的 loadCompactionLogs 打同一接口
 // /context-compaction/logs，且其全部效果（未读自增+syncGenStateFromLogs）已被 3s 路径覆盖——
 // 删除 5s 轮询，请求减半行为等价；DOMContentLoaded 改为常驻启动 3s 轮询（原 5s 在此常驻、3s 仅面板开时启）。

 // 页面切到后台/切回时暂停或恢复后台轮询，避免隐藏页持续请求
 document.addEventListener('visibilitychange', function(){
   if(document.hidden){
     stopLogPolling();
   }else{
     startLogPolling();
     let cur=''; try{ cur=localStorage.getItem('adminTab')||''; }catch(e){}
   }
 });


function toast(msg){
   const el=document.getElementById('toast');
   if(!el) return;
   el.textContent=msg;el.classList.add('show');
   setTimeout(()=>el.classList.remove('show'),2200);
 }
 
 function openModal(id){
   const el=document.getElementById(id);
   if(!el) return;
   el.classList.add('show');
   el.setAttribute('role','dialog');
   el.setAttribute('aria-modal','true');
   const first=el.querySelector('input,select,textarea');
   if(first) setTimeout(function(){ first.focus(); },60);
 }
 function closeModal(id){const el=document.getElementById(id);if(el)el.classList.remove('show')}
 
 // ============ Heartbeat ============
 function renderHeartbeat(){
   const d=AppState.INITIAL_DATA;
   const wk=d.wake||{};
   const we=d.weather||{};
   document.getElementById('st-uptime').textContent=formatUptime(d.uptime);
   document.getElementById('st-wake').textContent=d.wakeStatus;
   document.getElementById('st-api-url').textContent=d.apiUrl||'-';
   document.getElementById('st-model').textContent=d.model||'-';
   document.getElementById('st-gateway-key').textContent=d.gatewayKey?'已配置':'未配置';
   document.getElementById('st-icon').textContent=d.icon||'-';
   document.getElementById('wake-day-after').textContent=wk.dayWakeAfter+' 分钟';
   document.getElementById('wake-night-after').textContent=wk.nightWakeAfter+' 分钟';
   document.getElementById('wake-day-check').textContent=wk.dayCheckInterval+' 分钟';
   document.getElementById('wake-night-check').textContent=wk.nightCheckInterval+' 分钟';
   document.getElementById('wake-hours').textContent=wk.dayStartHour+':00 - '+wk.dayEndHour+':00';
   document.getElementById('weather-enabled').textContent=we.enabled==='true'?'已启用':'已禁用';
   document.getElementById('weather-location').textContent=we.locationName||'-';
   document.getElementById('weather-coords').textContent=(we.lat||'-')+', '+(we.lon||'-');
   document.getElementById('weather-units').textContent=we.units||'-';
 }
 
 function formatUptime(s){
   const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);const m=Math.floor((s%3600)/60);
   let r='';if(d>0)r+=d+'天';if(h>0)r+=h+'小时';r+=m+'分钟';return r;
 }
 
 function renderEnv(){
   const keys=['TARGET_API_URL','TARGET_API_KEY','MODEL_NAME','BARK_KEY','GATEWAY_API_KEY','CUSTOM_ICON_URL','ALLOW_PUBLIC_API','PUSH_PROVIDER','USER_DISPLAY_NAME','AI_DISPLAY_NAME','WEATHER_ENABLED','WEATHER_LOCATION_NAME','WEATHER_LAT','WEATHER_LON','DIARY_ENABLED','DIARY_DIR','PORT'];
   const SECRET_KEYS=new Set(['TARGET_API_KEY','BARK_KEY','GATEWAY_API_KEY']);
   document.getElementById('env-list').innerHTML=keys.map(k=>{
     const v=AppState.INITIAL_DATA.env[k]||'';
     let display;
     if(SECRET_KEYS.has(k)){
       display=AppState.INITIAL_DATA.env[k+'_SET']?'<span style="color:var(--accent)">已设置</span>':'<span style="color:var(--text3)">未设置</span>';
     }else if(v==='true'||v==='false'){
       display=v==='true'?'<span style="color:var(--accent)">开启</span>':'<span style="color:var(--text3)">关闭</span>';
     }else{
       const raw=v.length>40?v.slice(0,40)+'...':(v||'');
       display=escapeHtml(raw)||'<span style="color:var(--text3)">未设置</span>';
     }
     return '<div class="env-row"><span class="env-key">'+k+'</span><span class="env-val">'+display+'</span></div>';
   }).join('');
 }
 
 function openEnvEditor(){
   const keys=['TARGET_API_URL','TARGET_API_KEY','GATEWAY_API_KEY','MODEL_NAME','BARK_KEY','CUSTOM_ICON_URL','DAY_WAKE_AFTER_MINUTES','NIGHT_WAKE_AFTER_MINUTES','DAY_CHECK_INTERVAL_MINUTES','NIGHT_CHECK_INTERVAL_MINUTES','WAKE_DAY_START_HOUR','WAKE_DAY_END_HOUR','WEATHER_ENABLED','WEATHER_LOCATION_NAME','WEATHER_LAT','WEATHER_LON','WEATHER_UNITS','ALLOW_PUBLIC_API','PUSH_PROVIDER','USER_DISPLAY_NAME','AI_DISPLAY_NAME','DIARY_ENABLED'];
   const SECRET_KEYS=new Set(['TARGET_API_KEY','BARK_KEY','GATEWAY_API_KEY']);
   document.getElementById('env-editor-fields').innerHTML=keys.map(k=>{
     const v=AppState.INITIAL_DATA.env[k]||'';
     if(k==='ALLOW_PUBLIC_API'){
       return '<div class="form-group"><label>ALLOW_PUBLIC_API <span style="color:var(--text3);font-size:11px">公网 /v1 开关</span></label><select id="env-'+k+'"><option value="true"'+(v==='true'?' selected':'')+'>开启（需 GATEWAY_API_KEY）</option><option value="false"'+(v!=='true'?' selected':'')+'>关闭（仅内网）</option></select></div>';
     }
     if(k==='PUSH_PROVIDER'){
       return '<div class="form-group"><label>PUSH_PROVIDER <span style="color:var(--text3);font-size:11px">推送渠道</span></label><select id="env-'+k+'"><option value="bark"'+(v==='bark'||!v?' selected':'')+'>bark</option></select></div>';
     }
     const ph=SECRET_KEYS.has(k)?' placeholder="'+(AppState.INITIAL_DATA.env[k+'_SET']?'已设置，留空不修改':'未设置，留空保存')+'"':'';
     return '<div class="form-group"><label>'+k+'</label><input type="text" id="env-'+k+'" value="'+escapeHtml(v)+'"'+ph+'></div>';
   }).join('');
   openModal('envModal');
 }
 
 async function saveEnv(){
   const keyMap={'TARGET_API_URL':'target_url','TARGET_API_KEY':'target_key','GATEWAY_API_KEY':'gateway_api_key','MODEL_NAME':'model_name','BARK_KEY':'bark_key','CUSTOM_ICON_URL':'custom_icon','DAY_WAKE_AFTER_MINUTES':'day_wake_after','NIGHT_WAKE_AFTER_MINUTES':'night_wake_after','DAY_CHECK_INTERVAL_MINUTES':'day_check_interval','NIGHT_CHECK_INTERVAL_MINUTES':'night_check_interval','WAKE_DAY_START_HOUR':'wake_day_start_hour','WAKE_DAY_END_HOUR':'wake_day_end_hour','WEATHER_ENABLED':'weather_enabled','WEATHER_LOCATION_NAME':'weather_location_name','WEATHER_LAT':'weather_lat','WEATHER_LON':'weather_lon','WEATHER_UNITS':'weather_units','ALLOW_PUBLIC_API':'all_public_api','PUSH_PROVIDER':'push_provider','USER_DISPLAY_NAME':'user_display_name','AI_DISPLAY_NAME':'ai_display_name','DIARY_ENABLED':'diary_enabled'};
   const body={};
   Object.keys(keyMap).forEach(k=>{const el=document.getElementById('env-'+k);if(el)body[keyMap[k]]=el.value;});
   try{
     const r=await apiRequest('POST', ADMIN_API + '/save', body, {busy:document.getElementById('env-save-btn')});
     if(!r.ok) return;
     const j=r.data||{};
     if(j.success){toast('已保存，已热生效');closeModal('envModal');fetch(ADMIN_API+'/env').then(r=>r.json()).then(d=>{AppState.INITIAL_DATA=d;renderEnv();}).catch(()=>{});}
     else toast('保存失败: '+j.error);
   }catch(e){toast('网络错误: '+e.message)}
 }
 
 function renderNetease(){
   const el=document.getElementById('netease-status');
   el.innerHTML='<div class="empty">加载中…</div>';
   fetch(ADMIN_API + '/netease').then(r=>r.json()).then(j=>{
     if(!j.success){el.innerHTML='<div class="empty">加载失败</div>';return}
     const n=j.netease;
     let rows='';
     rows+='<div class="env-row"><span class="env-key">会话</span><span class="env-val">'+(n.sessionSet?'<span style="color:var(--accent)">已设置</span>':'<span style="color:var(--text3)">未设置</span>')+'</span></div>';
     if(n.sessionUpdatedAt)rows+='<div class="env-row"><span class="env-key">更新时间</span><span class="env-val">'+escapeHtml(n.sessionUpdatedAt)+'</span></div>';
     rows+='<div class="env-row"><span class="env-key">服务地址</span><span class="env-val">'+escapeHtml(n.host||'0.0.0.0')+':'+escapeHtml(n.port||'3303')+'</span></div>';
     if(n.account&&n.account.nickname){
       rows+='<div class="env-row"><span class="env-key">当前账号</span><span class="env-val">'+escapeHtml(n.account.nickname)+' <span style="color:var(--accent);font-size:11px">已登录</span></span></div>';
     }else if(n.sessionSet){
       rows+='<div class="env-row"><span class="env-key">登录状态</span><span class="env-val"><span style="color:#c0392b">会话已失效，请更新</span></span></div>';
     }
     el.innerHTML=rows;
   }).catch(e=>{el.innerHTML='<div class="empty">加载失败: '+e.message+'</div>'});
 }
 
 function openNeteaseEditor(){
   document.getElementById('netease-music-u').value='';
   document.getElementById('netease-csrf').value='';
   openModal('neteaseModal');
 }
 
 async function saveNetease(){
   const musicU=document.getElementById('netease-music-u').value.trim();
   const csrf=document.getElementById('netease-csrf').value.trim();
   if(!musicU&&!csrf){toast('请至少填写 MUSIC_U');return}
   try{
     const r=await apiRequest('POST', ADMIN_API + '/netease/save', {music_u:musicU,csrf}, {busy:document.getElementById('netease-save-btn')});
     if(!r.ok) return;
     const j=r.data||{};
     if(j.success){
       toast(j.account&&j.account.nickname?('已保存，当前账号: '+j.account.nickname):'已保存');
       closeModal('neteaseModal');
       renderNetease();
     }else toast('保存失败: '+j.error);
   }catch(e){toast('网络错误: '+e.message)}
 }
 
 // ============ 视觉模型 ============
 
 
 
 
 
 
 
 
 
 
 
 
 
 

  // ============ 记忆流水线·判定提示词（2026-09-19） ============
  async function loadJudgePrompt(){
    const msg=document.getElementById('judge-prompt-msg');
    try{
      const r=await fetch(ADMIN_API + '/memory-judge/prompt');
      const c=await r.json();
      if(c.error) throw new Error(c.error);
      const t=document.getElementById('judge-prompt-template');
      if(t) t.value=c.template||'';
      if(msg) msg.textContent=c.custom_set?'当前为自定义版本；「恢复内置默认」可回退。':'当前为内置默认。';
    }catch(e){ if(msg) msg.textContent='读取判定提示词失败: '+e.message; }
  }
  async function saveJudgePrompt(){
    const msg=document.getElementById('judge-prompt-msg');
    const t=document.getElementById('judge-prompt-template').value;
    try{
      const r=await fetch(ADMIN_API + '/memory-judge/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({template:t})});
      const j=await r.json();
      if(j.error) throw new Error(j.error);
      if(msg) msg.textContent='已保存，下一次记忆入库判定即生效。';
      toast('判定提示词已保存');
    }catch(e){ if(msg) msg.textContent='保存失败: '+e.message; }
  }
  async function resetJudgePrompt(){
    if(!confirm('恢复内置默认判定提示词？'))return;
    const msg=document.getElementById('judge-prompt-msg');
    try{
      const r=await fetch(ADMIN_API + '/memory-judge/prompt',{method:'DELETE'});
      const j=await r.json();
      if(j.error) throw new Error(j.error);
      await loadJudgePrompt();
      toast('已恢复内置默认');
    }catch(e){ if(msg) msg.textContent='恢复失败: '+e.message; }
  }
  // ============ 记忆蒸馏·抽取提示词（1002 记忆改造 §8 3.4） ============
  async function loadDistillPrompt(){
    const msg=document.getElementById('distill-prompt-msg');
    try{
      const r=await fetch(ADMIN_API + '/memory-distill/prompt');
      const c=await r.json();
      if(c.error) throw new Error(c.error);
      const s=document.getElementById('distill-sys-prompt'); if(s) s.value=c.distill_system_prompt||c.default_distill_system_prompt||'';
      const u=document.getElementById('distill-user-prompt'); if(u) u.value=c.distill_user_prompt||c.default_distill_user_prompt||'';
      if(msg) msg.textContent=c.custom_set?'当前为自定义版本；「恢复内置默认」可回退。':'当前为内置默认（自定义为空）。';
    }catch(e){ if(msg) msg.textContent='读取蒸馏提示词失败: '+e.message; }
  }
  async function saveDistillPrompt(){
    const msg=document.getElementById('distill-prompt-msg');
    const s=document.getElementById('distill-sys-prompt').value;
    const u=document.getElementById('distill-user-prompt').value;
    try{
      const r=await fetch(ADMIN_API+'/memory-distill/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({distill_system_prompt:s.trim(),distill_user_prompt:u.trim()})});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='保存失败: '+d.error; toast('保存失败: '+d.error); return; }
      if(msg) msg.textContent='已保存，下一次蒸馏（定时或手动）即生效。';
      toast('蒸馏提示词已保存');
    }catch(e){ if(msg) msg.textContent='保存失败: '+e.message; }
  }
  async function resetDistillPrompt(){
    if(!confirm('恢复内置默认蒸馏提示词？自定义内容会被清空。'))return;
    const msg=document.getElementById('distill-prompt-msg');
    try{
      const r=await fetch(ADMIN_API+'/memory-distill/prompt',{method:'DELETE'});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='恢复失败: '+d.error; return; }
      await loadDistillPrompt();
      toast('已恢复内置默认');
    }catch(e){ if(msg) msg.textContent='恢复失败: '+e.message; }
  }
  // ============ 两块总结·提示词（1002 记忆改造 §8 6.5：两块各一套 system/user，留空回落内置默认） ============
  async function loadSummaryPrompt(){
    const m1=document.getElementById('summary-prompt-msg');
    const m2=document.getElementById('summary-prompt-msg2');
    try{
      const r=await fetch(ADMIN_API+'/memory-summary/prompt');
      const c=await r.json();
      if(c.error) throw new Error(c.error);
      const set=function(id,v,dv){ const el=document.getElementById(id); if(el) el.value=(v!=null&&v!=='')?v:(dv||''); };
      set('ci-sys-prompt',c.core_identity_system_prompt,c.default_core_identity_system_prompt);
      set('ci-user-prompt',c.core_identity_user_prompt,c.default_core_identity_user_prompt);
      set('und-sys-prompt',c.understanding_system_prompt,c.default_understanding_system_prompt);
      set('und-user-prompt',c.understanding_user_prompt,c.default_understanding_user_prompt);
      const tip=c.custom_set?'当前为自定义版本；「恢复内置默认」可回退。':'当前为内置默认（自定义为空）。';
      if(m1) m1.textContent=tip;
      if(m2) m2.textContent=tip;
    }catch(e){
      if(m1) m1.textContent='读取两块提示词失败: '+e.message;
      if(m2) m2.textContent='';
    }
  }
  async function saveSummaryPrompt(){
    const m1=document.getElementById('summary-prompt-msg');
    const m2=document.getElementById('summary-prompt-msg2');
    const g=function(id){ const el=document.getElementById(id); return el?el.value:''; };
    const payload={
      core_identity_system_prompt:g('ci-sys-prompt').trim(),
      core_identity_user_prompt:g('ci-user-prompt').trim(),
      understanding_system_prompt:g('und-sys-prompt').trim(),
      understanding_user_prompt:g('und-user-prompt').trim()
    };
    try{
      const r=await fetch(ADMIN_API+'/memory-summary/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await r.json();
      if(d.error){ if(m1) m1.textContent='保存失败: '+d.error; toast('保存失败: '+d.error); return; }
      let tip='已保存，下一次生成（定时或手动）即生效。';
      if(d.warnings&&d.warnings.length) tip='⚠ '+d.warnings.join(' ')+'（其余已保存）';
      if(m1) m1.textContent=tip;
      if(m2) m2.textContent=tip;
      toast('两块提示词已保存');
    }catch(e){ if(m1) m1.textContent='保存失败: '+e.message; }
  }
  async function resetSummaryPrompt(){
    if(!confirm('恢复内置默认的两块总结提示词？两张卡的自定义内容都会被清空。'))return;
    const m1=document.getElementById('summary-prompt-msg');
    const m2=document.getElementById('summary-prompt-msg2');
    try{
      const r=await fetch(ADMIN_API+'/memory-summary/prompt',{method:'DELETE'});
      const d=await r.json();
      if(d.error){ if(m1) m1.textContent='恢复失败: '+d.error; return; }
      await loadSummaryPrompt();
      toast('已恢复内置默认');
    }catch(e){ if(m1) m1.textContent='恢复失败: '+e.message; }
  }
  // ============ 记忆与唤醒参数 ============
  // 跨窗口注入参数（日记条数，V2 Earlier Days 篇数同源；0928 V1 memory_pool_config 归档后独立存储）
  async function loadCrossInjectConfig(){
    const msg=document.getElementById('cross-inject-config-msg');
    try{
      const r=await fetch(ADMIN_API + '/cross-inject/config');
      const c=await r.json();
      const el=document.getElementById('cross-inject-diary-count');
      if(el) el.value=c.cross_inject_diary_count!=null?c.cross_inject_diary_count:3;
      if(msg) msg.textContent='';
    }catch(e){ if(msg) msg.textContent='读取失败: '+e.message; }
  }
  async function saveCrossInjectConfig(){
    const msg=document.getElementById('cross-inject-config-msg');
    if(msg) msg.textContent='保存中...';
    const v=Math.max(1, Number(document.getElementById('cross-inject-diary-count').value)||3);
    try{
      const r=await fetch(ADMIN_API+'/cross-inject/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cross_inject_diary_count:v})});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='保存失败: '+d.error; toast('保存失败: '+d.error); return; }
      if(msg) msg.textContent='已保存：Earlier Days 注入 '+d.cross_inject_diary_count+' 篇日记，下次请求生效。';
      toast('跨窗口注入日记条数已保存');
    }catch(e){ if(msg) msg.textContent='保存失败: '+e.message; toast('保存失败: '+e.message); }
  }
  async function loadReparsePrompt(){
    const msg=document.getElementById('reparse-prompt-msg');
    try{
      const r=await fetch(ADMIN_API + '/reparse/config');
      const c=await r.json();
      const s=document.getElementById('reparse-sys-prompt'); if(s) s.value=c.reparse_system_prompt||c.default_reparse_system_prompt||'';
      const u=document.getElementById('reparse-user-prompt'); if(u) u.value=c.reparse_user_prompt||c.default_reparse_user_prompt||'';
      if(msg) msg.textContent='已载入内置默认提示词；可修改保存覆盖，或点“恢复内置默认”。';
    }catch(e){ if(msg) msg.textContent='读取提示词失败: '+e.message; }
  }
  async function saveReparsePrompt(){
    const msg=document.getElementById('reparse-prompt-msg');
    const s=document.getElementById('reparse-sys-prompt').value;
    const u=document.getElementById('reparse-user-prompt').value;
    try{
      const r=await fetch(ADMIN_API+'/reparse/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reparse_system_prompt:s.trim(),reparse_user_prompt:u.trim()})});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='保存失败: '+d.error; return; }
      if(msg) msg.textContent='已保存，下次解析入库/再解析生效。';
      toast('解析提示词已保存');
    }catch(e){ if(msg) msg.textContent='保存失败: '+e.message; }
  }
  async function resetReparsePrompt(){
    const s=document.getElementById('reparse-sys-prompt');
    const u=document.getElementById('reparse-user-prompt');
    const _c=await (await fetch(ADMIN_API + '/reparse/config')).json() || {};
    if(s) s.value=_c.default_reparse_system_prompt||'';
    if(u) u.value=_c.default_reparse_user_prompt||'';
    try{
      const r=await fetch(ADMIN_API+'/reparse/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reparse_system_prompt:'',reparse_user_prompt:''})});
      const d=await r.json();
      if(d.error){ toast('恢复失败: '+d.error); return; }
      toast('已恢复内置默认提示词');
      const m=document.getElementById('reparse-prompt-msg'); if(m) m.textContent='已恢复内置默认';
    }catch(e){ toast('网络错误: '+e.message); }
  }


function escapeHtml(s){
   return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]});
 }
 // 2026-09-30 V10 转义收敛：escHtml/escHtml2 改为 escapeHtml 别名——三者本就重复实现
 // （escapeHtml≡escHtml2 五字符全转；escHtml 原少转引号，并入全转版后 HTML 文本/属性场景显示等价且更安全）。
 // 全部调用点已核：无「转义后再截断/比对」模式，合并零行为差异。
 function escJsStr(v){
   return String(v==null?'':v)
     .replace(/&/g,'&amp;')
     .replace(/"/g,'&quot;')
     .replace(/</g,'&lt;')
     .replace(/>/g,'&gt;')
     .replace(/\\/g,'\\\\')
     .replace(/'/g,"\\'");
 }

 // 2026-09-12 日记按会话分开保存：分组渲染需要会话名（token→名称），异步加载后补渲染一次
 const ADM_SESSION_NAMES = {};
 async function loadDiarySessionNames(){
   try{
     const r=await fetch('/v1/sessions',{credentials:'include'});
     const j=await r.json();
     for(const s of ((j&&j.sessions)||[])){ if(s&&s.id) ADM_SESSION_NAMES[s.id]=s.name||''; }
   }catch(e){}
 }

 
 
 
 
 
 async function restartService(){
   if(!confirm('确认重启服务？服务将短暂中断。'))return;
   try{
     const r=await fetch(ADMIN_API + '/restart',{method:'POST',headers:{'Content-Type':'application/json'}});
     const j=await r.json();
     toast(j.output||'重启指令已发送');
   }catch(e){toast('网络错误')}
 }
 
 // ============ Tab 5: 上下文压缩 ============

 const CC_GAP_PAGE = 200;
 
 const escHtml = escapeHtml; // V10 收敛：原三字符版已删，统一走五字符全转
 
 function skeletonHtml(lines){
   let h='<div class="skeleton">';
   for(let i=0;i<lines;i++){h+='<div class="sk-line" style="width:'+(90-i*8)+'%"></div>';}
   return h+'</div>';
 }
 
 function fmtCcNum(n){n=Number(n)||0;if(n>=10000)return (n/10000).toFixed(1).replace(/\.0$/,'')+'万';return String(n);}
 
 function scheduleCcOriginalSearch(){
   clearTimeout(AppState.ccOriginalTimer);
   AppState.ccOriginalTimer = setTimeout(ccOriginalSearch, 300);
 }
 async function ccOriginalSearch(){
   const el = document.getElementById('cc-original-search');
   const box = document.getElementById('cc-original-results');
   const info = document.getElementById('cc-original-search-info');
   const q = el ? el.value.trim() : '';
   if(!box) return;
   if(!q){ box.innerHTML=''; if(info) info.textContent=''; return; }
   const seq = ++AppState.ccOriginalSeq;
   box.innerHTML = skeletonHtml(3);
   if(info) info.textContent='搜索中…';
   try{
     const r = await fetch(ADMIN_API + '/context-compaction/search?q=' + encodeURIComponent(q) + '&limit=50');
     const j = await r.json();
     if(seq !== AppState.ccOriginalSeq) return;
     if(!j.ok){ box.innerHTML='<div class="empty">' + escapeHtml(j.error||'搜索失败') + '</div>'; if(info) info.textContent=''; return; }
     if(info) info.textContent='共命中 ' + j.total + ' 条（显示前 ' + j.results.length + ' 条）';
     if(!j.results.length){ box.innerHTML='<div class="empty">没有命中「'+escapeHtml(q)+'」的原文</div>'; return; }
     box.innerHTML = j.results.map(function(x){
       const chunk = x.chunk;
       let chunkTag = '';
       if(chunk){
         chunkTag = '<span class="mem-tag" style="background:'+(chunk.source==='manual'?'#8e44ad':'#2980b9')+';color:#fff">块 #'+chunk.chunkIndex+'</span>'
           + (chunk.summary ? '<span class="cc-orig-sum" title="'+escapeHtml(chunk.summary)+'">'+escapeHtml(chunk.summary)+'</span>' : '');
       }
      return '<div class="cc-orig-item">' +
         '<div class="cc-orig-meta">' +
         '<span class="mem-tag">第 '+x.index+' 条</span>' +
         '<span class="mem-tag">'+escapeHtml(x.role||'')+'</span>' +
         '<span class="mem-time">'+escapeHtml(x.time||'')+'</span>' +
         chunkTag +
         '<button class="cc-msg-mark'+(x.marked?' on':'')+'" data-key="'+x.key+'" style="margin-left:auto" onclick="event.stopPropagation();toggleCcOrigMark(this)" title="标星：压缩后以原句保留，不被摘要覆盖" aria-pressed="'+(x.marked?'true':'false')+'" aria-label="标星此消息">'+(x.marked?'★':'☆')+'</button>' +
         '</div>' +
         '<div class="cc-orig-content">'+escapeHtml(x.content)+'</div>' +
         '</div>';
     }).join('');
   }catch(err){
     if(seq === AppState.ccOriginalSeq) box.innerHTML='<div class="empty">搜索失败: '+escapeHtml(err.message)+'</div>';
     if(info) info.textContent='';
   }
 }
/**
 * 原文搜索结果标星/取消标星：成功后同步按钮 aria-pressed 状态。
 * @param {HTMLElement} btn 标星按钮
 */

 function toggleCcOrigMark(btn){
   if(!btn) return;
   const key = btn.getAttribute('data-key');
   const next = !(btn.classList.contains('on'));
   fetch(ADMIN_API + '/context-compaction/mark',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({key:key, marked:next})
   }).then(function(r){return r.json()}).then(function(d){
     if(d && d.error){ alert('标记失败: '+d.error); return; }
     btn.classList.toggle('on', next);
     btn.textContent = next ? '★' : '☆';
     btn.setAttribute('aria-pressed', next ? 'true' : 'false');
   }).catch(function(e){ alert('标记失败: '+e.message); });
 }

 // 已标星消息卡片：加载列表

 // 取消标星（卡片内）


  // 编辑标星消息正文（管理台"已标星消息"）

 let ccPreviewInflight=false;
let ccPreviewDirty=false;
let ccPreviewSeq=0;
function setCcSyncing(on){
  const s=document.getElementById('cc-syncing');
  if(s) s.style.display=on?'inline-flex':'none';
}
/**
 * 拉取压缩预览数据并渲染；带 15 秒 TTL 去重（AppState.ccPreviewLoadedAt）。
 * 数据就绪后写入 AppState.compactionPlan 并调用 renderCompaction。
 */
function loadCompactionPreview(){
  if(ccPreviewInflight){ ccPreviewDirty=true; return Promise.resolve(); }
  ccPreviewInflight=true;
  ccPreviewDirty=false;
  const seq=++ccPreviewSeq;
  const el=document.getElementById('compaction-chunks');
  const sum=document.getElementById('compaction-summary');
  const msg=document.getElementById('compaction-msg');
  const savedY=(window.pageYOffset!==undefined)?window.pageYOffset:(document.documentElement.scrollTop||0);
  const savedInner={};
  ((AppState.compactionPlan&&AppState.compactionPlan.chunks)||[]).forEach(function(c){
    const box=document.getElementById('cc-msg-scroll-'+c.index);
    if(box) savedInner[c.index]=box.scrollTop;
  });
  setCcSyncing(true);
  if(el && !el.innerHTML.trim()) el.innerHTML='<div class="cc-loading"><span class="cc-spin"></span> 计算中…</div>';
  if(sum) sum.textContent='';
  if(msg) msg.textContent='正在刷新压缩预览…';
  return fetch(ADMIN_API + '/context-compaction/preview').then(function(r){return r.json()}).then(function(d){
    if(seq!==ccPreviewSeq) return;
    if(!d || d.error || d.ok===false){
      const em=(d&&(d.error||d.message))||'预览返回异常';
      if(msg) msg.textContent='加载失败: '+em;
      if(el && (!el.innerHTML.trim() || el.querySelector('.cc-loading'))) el.innerHTML='<div class="empty">加载失败: '+escHtml(em)+'</div>';
      return;
    }
    AppState.compactionPlan=d;
    AppState.ccPreviewLoadedAt=Date.now();
    if(!AppState.ccGapCollapsedInit){AppState.ccGapCollapsedInit=true;Array.prototype.forEach.call((d.uncovered&&d.uncovered.gaps)||[],function(g){AppState.ccGapCollapsed.add((g.startIdx||0)+'-'+(g.endIdx||0));});}
    renderCompaction(savedY, savedInner);
    renderCompactionConfig();
    updateCcStatusBar(d);
    if(msg) msg.textContent='';
  }).catch(function(e){
    if(seq!==ccPreviewSeq) return;
    if(el && !el.innerHTML.trim()) el.innerHTML='<div class="empty">加载失败: '+e.message+'</div>';
    if(msg) msg.textContent='加载失败: '+e.message;
  }).finally(function(){
    if(seq===ccPreviewSeq){ ccPreviewInflight=false; }
    setCcSyncing(false);
    if(AppState.ccMultiSelectMode){ updateMultiSelectBar(); }
    if(!ccPreviewInflight && ccPreviewDirty){ ccPreviewDirty=false; loadCompactionPreview(); }
  });
}

/**
 * 压缩预览子构建函数：纯 HTML 生成，便于 renderCompaction 聚焦“状态 -> DOM”编排。
 */

/**
 * 把压缩块（手动/AI）与未覆盖区合并成一条流，按消息位置排序并应用筛选。
 * @param {Object} d 压缩预览数据
 * @returns {Array} 筛选后的合并项列表
 */
function ccBuildMergedItems(d){
  const ccList=(d.chunks||[]);
  const gaps=(d.uncovered&&d.uncovered.gaps&&d.uncovered.gaps.length)?d.uncovered.gaps:[];
  const merged=[];
  ccList.forEach(function(c){
    const isAi=!!c.aiRep;
    if(!isAi && typeof c.blockStart!=='number') return; // 忽略任何遗留的自动块
    const st=((typeof c.blockStart==='number'&&c.blockStart>=0)?c.blockStart+1:((c.firstIdx>=0?c.firstIdx:0)+1));
    merged.push({type:'block', chunk:c, isAi:isAi, start:st});
  });
  gaps.forEach(function(g){
    merged.push({type:'gap', gap:g, start:g.startIdx});
  });
  merged.sort(function(a,b){return a.start-b.start;});
  return applyCcFilter(merged, d);
}

/**
 * 顶部摘要统计条 HTML（摘要后字数 / 条数 / 块数 / 缓存数 / 原始字数）。
 * @param {Object} d 压缩预览数据
 * @param {Object} t 汇总统计（d.totals）
 * @returns {string}
 */
function ccBuildSummaryStatsHtml(d, t){
  return '<div class="cc-stats">'
    +'<span class="cc-mini-main"><span class="l">实际约</span><b>'+fmtCcNum(t.estCompressedChars||0)+'</b><span class="unit">字</span></span>'
    +'<span class="cc-mini-item"><b>'+d.totalCompressible+'</b><i>条</i></span>'
    +'<span class="cc-mini-item'+(t.chunkCount?'':' zero')+'"><b>'+(t.chunkCount||0)+'</b><i>块</i></span>'
    +'<span class="cc-mini-item'+(t.cachedCount?'':' zero')+'"><b>'+(t.cachedCount||0)+'</b><i>缓存</i></span>'
    +'<span class="cc-mini-item"><b>'+fmtCcNum(t.totalChars||0)+'</b><i>字</i></span>'
    +'<span class="cc-mini-item" title="未覆盖对话积压的 token 估算（触发容量提醒的口径）"><b>'+fmtCcNum(t.estUncoveredTokens||0)+'</b><i>积压tok</i></span>'
    +'<span class="cc-mini-item'+(t.estTotalTokens?'':' zero')+'" title="实际发送 token 估算 = 未覆盖积压 + 摘要块 + 标星原句 + 图片 + 置顶记忆（永久上下文）。估算口径：中文≈1字/token、英文≈4字符/token、图片每张约1000。"><b>'+fmtCcNum(t.estTotalTokens||0)+'</b><i>总tok</i></span>'
    +((t.hiddenCount>0||t.manualHiddenCount>0)?'<span class="cc-mini-item zero"><b>'+((t.hiddenCount||0)+(t.manualHiddenCount||0))+'</b><i>隐藏</i></span>':'')
    +'</div>'
    +(t.hiddenCount>0?'<div class="cc-hidden-tip">最早 <b>'+(t.hiddenCount||0)+'</b> 块已隐藏、未进入上下文（活跃块上限 '+(t.maxActiveBlocks||'?')+'，手动+AI 合计保留最近 N 个）；如需保留信息，建议将块解析入池。</div>':'')
    ;
}

/**
 * 渲染压缩预览：把压缩块（手动/AI）与未覆盖区按消息位置合并成一条流。
 * 重绘前先保存页面/内部滚动位置与已展开面板，拼完 HTML 后通过
 * reconcileCcList 短路相同结果，再恢复滚动与展开动画。
 * @param {number|undefined} savedY 重绘前捕获的页面滚动位置
 * @param {Object|undefined} savedInner 各消息列表滚动位置缓存
 */
  function renderCompaction(savedY, savedInner){
   const el=document.getElementById('compaction-chunks');
   const sum=document.getElementById('compaction-summary');
   if(el){ el.classList.toggle('cc-multi-select', AppState.ccMultiSelectMode); }
   if(!el) return;
   const d=AppState.compactionPlan;
   if(!d){ el.innerHTML='<div class="empty">暂无数据</div>'; return; }
    const t=d.totals||{};
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent='';
   const pageScrollY=(savedY!==undefined)?savedY:((window.pageYOffset!==undefined)?window.pageYOffset:(document.documentElement.scrollTop||0));
   const innerScrolls=savedInner||{};
   if(!savedInner){
     (d.chunks||[]).forEach(function(c){
       const box=document.getElementById('cc-msg-scroll-'+c.index);
       if(box) innerScrolls[c.index]=box.scrollTop;
     });
   }
   const prevOpenCol={};
   document.querySelectorAll('.cc-collapse.open').forEach(function(w){ prevOpenCol[w.id]=true; });
   let html='';
   // 块（手动/AI）与未覆盖区合并成一条流，按消息位置穿插显示
   const filtered = ccBuildMergedItems(d);
   let blockOrdinal=-1;
   filtered.forEach(function(it){
     if(it.type==='gap'){
       const g=it.gap;
       const gkey=(g.startIdx||0)+'-'+(g.endIdx||0);
       const gt=AppState.ccGapTimeByKey[gkey]||{};
       const gtime=((g.startTime||gt.startTime)?'（'+(g.startTime||gt.startTime)+' ~ '+(g.endTime||gt.endTime)+'）':'');
       html+='<div class="cc-uncovered" data-gkey="'+gkey+'">'
         + (AppState.ccMultiSelectMode?'<input type="checkbox" class="cc-chk" '+(AppState.ccSelectedChunks.has('gap-'+gkey)?'checked':'')+' onclick="event.stopPropagation();toggleCcChunkSelect(\'gap\',\''+gkey+'\')" title="选中此未覆盖区">':'')+'<div class="cc-uncovered-head cc-uncovered-head-click" onclick="toggleCcGapCollapse('+g.startIdx+','+g.endIdx+')">'
         +'<span class="cc-uncovered-arrow">'+(AppState.ccGapCollapsed.has(gkey)?'▸':'▾')+'</span>'
         +'<span class="cc-uncovered-dot"></span>'
         +'<span class="cc-uncovered-title">未覆盖</span>'
         +'<span class="cc-uncovered-meta">第 '+g.startIdx+'–'+g.endIdx+' 条 · '+g.count+' 条'+gtime+'</span>'
         +'</div>'
         +(AppState.ccGapCollapsed.has(gkey)?'':renderCcGapMessages(g))
         +'<div class="cc-uncovered-actions">'
         +'<button class="cc-btn secondary" onclick="autoSplitGap('+g.startIdx+','+g.endIdx+')">自动分块</button>'
         +'<button class="cc-btn soft" onclick="generateGapSummary('+g.startIdx+','+g.endIdx+')"'+(AppState.ccGapGenerating.has(gkey)?' disabled':'')+'>'+(AppState.ccGapGenerating.has(gkey)?'生成中…':'生成摘要')+'</button>'
         +'<input type="text" id="cc-add-range-'+g.startIdx+'-'+g.endIdx+'" placeholder="如 '+g.startIdx+'-'+g.endIdx+'" oninput="ccRangeWarn(this,'+g.startIdx+','+g.endIdx+')">'
         +'<button class="cc-btn secondary" onclick="addBlockByRange('+g.startIdx+','+g.endIdx+')">切分</button>'
         +'</div>'
         +'</div>';
       return;
     }
     const c=it.chunk;
     const isAi=it.isAi;
     let start,end,count;
     let blockIndex=-1;
     if(isAi){
       start=(typeof c.blockStart==='number'&&c.blockStart>=0)?c.blockStart+1:((c.firstIdx>=0?c.firstIdx:0)+1);
       end=(typeof c.blockEnd==='number'&&c.blockEnd>=0)?c.blockEnd+1:((c.lastIdx>=0?c.lastIdx:start-1)+1);
       count=c.count||Math.max(0,end-start+1);
     }else{
       blockOrdinal++;
       // 优先服务端 manualRecordsSorted()（按会话过滤）给出的 blockIndex，与服务端 blocks 路由同源；
       // 本地计数只是老预览无该字段时的兜底，自己数会在跨会话/块被锚点过滤时错位
       blockIndex=(typeof c.blockIndex==='number')?c.blockIndex:blockOrdinal;
       start=c.blockStart+1;
       end=c.blockEnd+1;
       count=end-start+1;
     }
     const expanded=AppState.ccExpanded.has(c.index);
     const enabled = c.enabled!==false;
     const hidden = !!c.hidden;
     const manualHidden = !!c.manualHidden;
     const timeLabel = isAi
       ? (c.range_label||'')
       : ((c.startTime||'?')+' ~ '+(c.endTime||'?'));
     html+='<div class="cc-chunk-swipe" data-cid="'+c.index+'">'
       +'<div class="card cc-chunk'+(c.cached?'':' pending')+(hidden?' cc-chunk-hidden':'')+'">'
       + (AppState.ccMultiSelectMode&&!hidden?'<input type="checkbox" class="cc-chk" '+(AppState.ccSelectedChunks.has(c.index)?'checked':'')+' onclick="event.stopPropagation();toggleCcChunkSelect(\'chunk\','+c.index+')" title="选中此块">':'')+'<div class="cc-chunk-head"'+(hidden?'':' onclick="toggleCcExpand('+c.index+')"')+'>'
       +(!hidden&&c.cached?'<span class="cc-chunk-arrow">'+(expanded?'▾':'▸')+'</span>':'')
       +'<span class="cc-chunk-title '+(isAi?'ai':'manual')+'">块 #'+c.index+'</span>'
       +(hidden
         ? '<span class="cc-badge off">'+(manualHidden?'已隐藏·手动':'已隐藏')+'</span>'
         : '<span class="cc-badge '+(c.parsed?'parsed':(isAi?(enabled?'done':'off'):(c.cached?(enabled?'done':'warn'):'todo')))+'">'+(c.parsed?'已解析':(isAi?(enabled?'已替换':'已停用'):(c.cached?(enabled?'已替换':'待替换'):'待生成')))+'</span>')
       +'<span class="cc-chunk-stat">'+count+' 条 · '+fmtCcNum(c.chars)+' 字</span>'
       +(hidden
         ? (manualHidden
            ? '<button class="cc-btn cc-head-toggle" onclick="event.stopPropagation();unhideBlock('+c.index+','+blockIndex+','+(isAi?1:0)+',\''+(c.id||'')+'\')" title="取消手动隐藏，块恢复参与上下文">取消隐藏</button>'
            : '')
         : '<button class="cc-btn cc-head-toggle'+(enabled?' on':'')+(c.cached?'':' gen')+'" onclick="event.stopPropagation();'+(c.cached?'toggleCcReplace('+c.index+','+blockIndex+','+(isAi?1:0)+',\''+(c.id||'')+'\')':'regenerateBlockSummary('+c.index+','+blockIndex+',\''+(c.id||'')+'\')')+'"'+((!c.cached&&AppState.ccBlockGenerating.has(c.index))?' disabled':'')+'>'+(c.cached?(enabled?'取消替换':'替换'):(AppState.ccBlockGenerating.has(c.index)?'生成中…':'✦ 生成摘要'))+'</button>')
       +'</div>'
       +(hidden?'':
       '<div class="cc-meta">第 '+start+'~'+end+' 条 · '+escHtml(timeLabel)+'</div>'
       +'<div class="cc-preview">'+escHtml(c.head||'')+'</div>'
         +(!isAi ? '<div id="cc-addman-'+c.index+'"></div>' : '')
 +(!isAi
         ? '<div class="cc-boundary">'
           +'<input class="cc-num" type="number" min="1" max="'+d.totalCompressible+'" value="'+start+'" title="开头" oninput="ccNumLiveCheck(this,'+d.totalCompressible+')" onchange="updateCompactionBoundary(\''+(c.id||'')+'\',0,this.value)" onblur="clampCcInput(this,\''+(c.id||'')+'\',0,'+d.totalCompressible+')">'
           +'<span class="cc-boundary-arrow">→</span>'
           +'<input class="cc-num" type="number" min="1" max="'+d.totalCompressible+'" value="'+end+'" title="结尾" oninput="ccNumLiveCheck(this,'+d.totalCompressible+')" onchange="updateCompactionBoundary(\''+(c.id||'')+'\',1,this.value)" onblur="clampCcInput(this,\''+(c.id||'')+'\',1,'+d.totalCompressible+')">'
           +'</div>'
         : '<div class="cc-boundary">'
          +'<input class="cc-num" type="number" min="1" max="'+d.totalCompressible+'" value="'+(((typeof c.blockStart==='number'?c.blockStart:0)+1))+'" title="开头" oninput="ccNumLiveCheck(this,'+d.totalCompressible+')" onchange="updateAiBoundary('+c.index+',0,this.value)" onblur="clampAiCcInput(this,'+c.index+',0,'+d.totalCompressible+')">'
           +'<span class="cc-boundary-arrow">→</span>'
          +'<input class="cc-num" type="number" min="1" max="'+d.totalCompressible+'" value="'+(((typeof c.blockEnd==='number'?c.blockEnd:0)+1))+'" title="结尾" oninput="ccNumLiveCheck(this,'+d.totalCompressible+')" onchange="updateAiBoundary('+c.index+',1,this.value)" onblur="clampAiCcInput(this,'+c.index+',1,'+d.totalCompressible+')">'
          +'</div>')
       +(expanded?renderCcMessagesLazy(c):'')+(!isAi&&!c.cached&&expanded?'<div class="cc-manual-entry" style="padding:8px 0 4px;border-bottom:1px solid var(--border);margin-bottom:6px"><button class="cc-btn secondary" onclick="event.stopPropagation();openCcAddManual('+c.index+','+blockIndex+')" style="font-size:11px">＋ 手动填写摘要</button></div>':'')
       +(isAi
         ? '<div class="cc-ai-summary-wrap">'
           +'<div class="cc-sum-toggle-row">'
           +'<div class="cc-summary-toggle" onclick="toggleCcAiSummary('+c.index+')">'+(AppState.ccAiSummaryOpen.has(c.index)?'▾ 收起摘要':'▸ 查看摘要')+'</div>'
           +'<button class="cc-sum-toggle-btn" onclick="event.stopPropagation();regenerateAiBlockSummary(\''+c.repId+'\','+c.index+')"'+(AppState.ccBlockGenerating.has(c.index)?' disabled':'')+'>'+(AppState.ccBlockGenerating.has(c.index)?'生成中…':'✦ 重新生成摘要')+'</button>'
           +'</div>'
           +'<div id="cc-collapse-ai-'+c.index+'" class="cc-collapse'+(AppState.ccAiSummaryOpen.has(c.index)&&(prevOpenCol['cc-collapse-ai-'+c.index]||!AppState.ccAnimateOpen.has('cc-collapse-ai-'+c.index))?' open':'')+'"><div class="cc-collapse-inner">'+renderCcAiSummary(c)+'</div></div>'
           +'</div>'
         : '')
       +(!isAi&&c.cached&&c.summary
         ? '<div class="cc-ai-summary-wrap">'
           +'<div class="cc-sum-toggle-row">'
           +'<div class="cc-summary-toggle" onclick="toggleCcSummary('+c.index+')">'+(AppState.ccSummaryOpen.has(c.index)?'▾ 收起摘要':'▸ 查看摘要')+(c.history&&c.history.length?'（共 '+(c.history.length+1)+' 版）':'')+'</div>'
           +'<button class="cc-sum-toggle-btn" onclick="event.stopPropagation();regenerateBlockSummary('+c.index+','+blockIndex+',\''+(c.id||'')+'\')"'+(AppState.ccBlockGenerating.has(c.index)?' disabled':'')+'>'+(AppState.ccBlockGenerating.has(c.index)?'生成中…':'✦ 重新生成摘要')+'</button>'
           +'</div>'
           +'<div id="cc-collapse-sum-'+c.index+'" class="cc-collapse'+(AppState.ccSummaryOpen.has(c.index)&&(prevOpenCol['cc-collapse-sum-'+c.index]||!AppState.ccAnimateOpen.has('cc-collapse-sum-'+c.index))?' open':'')+'"><div class="cc-collapse-inner">'+renderCcSummaryEditor(c, blockIndex)+renderCcHistory(c)+'</div></div>'
           +'</div>'
         : ''))
       +'</div>'
       +(hidden?'':'<div class="cc-swipe-del"><button class="cc-swipe-del-btn" onclick="removeSingleBlock('+c.index+','+blockIndex+','+(isAi?1:0)+',\''+(c.id||'')+'\')">移除</button><button class="cc-swipe-del-btn cc-swipe-del-btn-hide" onclick="hideSingleBlock('+c.index+','+blockIndex+','+(isAi?1:0)+',\''+(c.id||'')+'\')">隐藏</button><button class="cc-swipe-del-btn cc-swipe-del-btn-parse" onclick="reparseSingleBlock('+c.index+')">解析</button></div>')
       +'</div>';
   });
 
   if(sum){ sum.innerHTML=ccBuildSummaryStatsHtml(d, t); }
    reconcileCcList(el, html);
    ccArmAllGapAutoLoad();
    if(window.scrollTo){
     requestAnimationFrame(function(){ window.scrollTo(0,pageScrollY); });
   }
   (d.chunks||[]).forEach(function(c){
     const box=document.getElementById('cc-msg-scroll-'+c.index);
     if(box && innerScrolls[c.index]!==undefined) box.scrollTop=innerScrolls[c.index];
   });
   if(AppState.ccAnimateOpen.size){
     requestAnimationFrame(function(){
       AppState.ccAnimateOpen.forEach(function(id){
         const w=document.getElementById(id);
         if(w) w.classList.add('open');
       });
       AppState.ccAnimateOpen.clear();
     });
   }
   const expandAllBtn=document.getElementById('cc-expandall-btn');
   if(expandAllBtn && d.chunks && d.chunks.length){
     const allOpen=d.chunks.every(function(c){return AppState.ccExpanded.has(c.index);});
     expandAllBtn.textContent=allOpen?'全部收起':'全部展开';
   }
   const rstBtn=document.getElementById('cc-reset-btn');
   if(rstBtn) rstBtn.disabled=d.compactCount<=0||!d.cutPointsActive;
   const cfgTip=document.getElementById('compaction-cfg-tip');
   if(cfgTip){
     cfgTip.innerHTML=(d.cutPointConfig&&d.cutPointConfig.configCount>1)
       ? '当前窗口边界配置：'+escHtml(d.cutPointConfig.id||'-')+'（命中 '+d.cutPointConfig.matched+'/'+t.chunkCount+' 块 · 共 '+d.cutPointConfig.configCount+' 套）'
       : '';
   }
 }
 
function ccNodeKey(n){
  if(!n||!n.getAttribute) return null;
  const cid=n.getAttribute('data-cid');
  if(cid!==null&&cid!=='') return 'c'+cid;
  const gk=n.getAttribute('data-gkey');
  if(gk!==null&&gk!=='') return 'g'+gk;
  return null;
}
/**
 * 把渲染结果写回 DOM；与上次 HTML 完全相同则直接短路，
 * 避免无谓的整块 innerHTML 替换（重绘优化关键路径）。
 * @param {HTMLElement} el 目标容器
 * @param {string} html 新渲染的 HTML
 */
function reconcileCcList(el, html){
  if(!el) return;
  if(AppState.ccLastRenderedHtml === html) return;
  // 2026-09-21 审查 R28：缓存必须在 DOM 真更新后才置——原实现先置缓存再判焦点早退，
  // 用户正在输入框时本次 DOM 不更新，但缓存已置新值，后续同 HTML 被短路跳过，
  // 压缩块的替换/隐藏/生成中徽标在界面上永久停在旧值
  const ae=document.activeElement;
  if(ae && el.contains(ae) && /^(TEXTAREA|INPUT)$/.test(ae.tagName)) return;
  AppState.ccLastRenderedHtml = html;
  const tmp=document.createElement('div');
  tmp.innerHTML=html;
  const newKids=Array.prototype.slice.call(tmp.children);
  const oldKids=Array.prototype.slice.call(el.children);
  const oldByKey={};
  oldKids.forEach(function(n){ const k=ccNodeKey(n); if(k) oldByKey[k]=n; });
  const newKeys={};
  newKids.forEach(function(n){ const k=ccNodeKey(n); if(k) newKeys[k]=true; });
  for(let i=0;i<newKids.length;i++){
    const node=newKids[i]; const k=ccNodeKey(node);
    if(k && oldByKey[k]){
      const old=oldByKey[k];
      if(old.outerHTML!==node.outerHTML) old.replaceWith(node);
    }else{
      let ref=null;
      for(let j=i+1;j<newKids.length;j++){
        const rk=ccNodeKey(newKids[j]);
        if(rk && oldByKey[rk] && oldByKey[rk].isConnected){ ref=oldByKey[rk]; break; }
      }
      if(ref) ref.parentNode.insertBefore(node, ref); else el.appendChild(node);
    }
  }
  Array.prototype.forEach.call(Array.prototype.slice.call(el.children), function(n){
    const k=ccNodeKey(n);
    if(!k || !newKeys[k]) n.remove();
  });
}
function updateCcStatusBar(d){
  d=d||AppState.compactionPlan;
  const el=document.getElementById('cc-status-chips');
  if(!el||!d) return;
  const chunks=(d.chunks||[]);
  const gaps=(d.uncovered&&d.uncovered.gaps)||[];
  let pending=0,toReplace=0,replaced=0;
  chunks.forEach(function(c){
    const isAi=!!c.aiRep;
    const enabled=c.enabled!==false;
    if(isAi){ if(enabled) replaced++; }
    else if(c.cached){ if(enabled) replaced++; else toReplace++; }
    else { pending++; }
  });
  el.innerHTML=
    '<span class="cc-chip '+(gaps.length?'active':'muted')+'" onclick="toggleCcFilter(\'gap\')"'+(AppState.ccFilter==='gap'?' data-filter="gap"':'')+'><i class="cc-dot"></i>未覆盖 <b>'+gaps.length+'</b> 区</span>'
    +'<span class="cc-chip '+(pending?'done':'muted')+'" onclick="toggleCcFilter(\'pending\')"'+(AppState.ccFilter==='pending'?' data-filter="pending"':'')+'><i class="cc-dot"></i>待生成 <b>'+pending+'</b></span>'
    +'<span class="cc-chip '+(toReplace?'warn':'muted')+'" onclick="toggleCcFilter(\'replace\')"'+(AppState.ccFilter==='replace'?' data-filter="replace"':'')+'><i class="cc-dot"></i>待替换 <b>'+toReplace+'</b></span>'
    +'<span class="cc-chip '+(replaced?'done':'muted')+'" onclick="toggleCcFilter(\'replaced\')"'+(AppState.ccFilter==='replaced'?' data-filter="replaced"':'')+'><i class="cc-dot"></i>已替换 <b>'+replaced+'</b></span>';
  const genBtn=document.getElementById('cc-gen-all-btn');
  if(genBtn) genBtn.disabled=gaps.length===0 || AppState.ccGapGenerating.size>0;
  const repBtn=document.getElementById('cc-replace-all-btn');
  if(repBtn) repBtn.disabled=toReplace===0 || AppState.ccBlockGenerating.size>0;
  const rpBtn=document.getElementById('cc-reparse-btn');
  if(rpBtn) rpBtn.disabled=replaced===0;
}

 // ===== 多选模式 =====
 function toggleCcMultiSelect(){
   AppState.ccMultiSelectMode = !AppState.ccMultiSelectMode;
   AppState.ccSelectedChunks.clear();
   if(AppState.ccMultiSelectMode){ loadCcReparseMaxChars(); }
   const btn = document.getElementById('cc-multiselect-btn');
   const bar = document.getElementById('cc-multi-bar');
   if(btn) btn.classList.toggle('primary', AppState.ccMultiSelectMode);
   if(btn) btn.textContent = AppState.ccMultiSelectMode ? '取消多选' : '多选';
   if(bar) bar.classList.toggle('show', AppState.ccMultiSelectMode);
   renderCompaction();
   updateMultiSelectBar();
 }

 function toggleCcChunkSelect(type, key){
   const selKey = type === 'gap' ? 'gap-' + key : key;
   if(AppState.ccSelectedChunks.has(selKey)){
     AppState.ccSelectedChunks.delete(selKey);
   }else{
     if(type === 'chunk'){
       const d = AppState.compactionPlan;
       const chunks = d ? (d.chunks || []) : [];
       const c = chunks.find(function(x){ return x.index === key; });
       let cur = 0;
       AppState.ccSelectedChunks.forEach(function(k){
         if(String(k).startsWith('gap-')) return;
         const idx = Number(k);
         const cc = chunks.find(function(x){ return x.index === idx; });
         if(cc) cur += (Number(cc.chars) || 0);
       });
       const limit = Number(AppState.ccReparseMergeMaxChars || 8000);
       if(c && (cur + (Number(c.chars) || 0)) > limit){
         toast('选中块总字数已达上限（'+fmtCcNum(limit)+' 字），不能再选了');
         return;
       }
     }
     AppState.ccSelectedChunks.add(selKey);
   }
   renderCompaction();
   updateMultiSelectBar();
 }

  async function loadCcReparseMaxChars(){
    try{
      const r=await fetch(ADMIN_API + '/reparse/config');
      const c=await r.json();
      AppState.ccReparseMergeMaxChars = (c && c.reparse_merge_max_chars!=null) ? Number(c.reparse_merge_max_chars) : 8000;
    }catch(e){ /* 读取失败用默认值 */ }
  }

 function toggleSelectAllCc(){
   const d = AppState.compactionPlan;
   if(!d) return;
   // 全选范围 = 当前状态筛选下的可见项（未筛选时 = 全部）
   const visible = ccBuildMergedItems(d);
   const keys = visible.map(function(it){
     return it.type === 'gap'
       ? 'gap-' + (it.gap.startIdx||0) + '-' + (it.gap.endIdx||0)
       : it.chunk.index;
   });
   const visibleSelected = keys.filter(function(k){ return AppState.ccSelectedChunks.has(k); }).length;
   if(keys.length > 0 && visibleSelected >= keys.length){
     // 当前筛选下已全选 → 只取消可见项
     keys.forEach(function(k){ AppState.ccSelectedChunks.delete(k); });
   }else{
     AppState.ccSelectedChunks.clear();
     keys.forEach(function(k){ AppState.ccSelectedChunks.add(k); });
   }
   renderCompaction();
   updateMultiSelectBar();
 }

 function updateMultiSelectBar(){
   const bar = document.getElementById('cc-multi-bar');
   const countEl = document.getElementById('cc-multi-count');
   const selectAllEl = document.getElementById('cc-multi-select-all');
   const genBtn = document.getElementById('cc-multi-gen-btn');
   const replaceBtn = document.getElementById('cc-multi-replace-btn');
   const reparseBtn = document.getElementById('cc-multi-reparse-btn');
   const exportBtn = document.getElementById('cc-multi-export-btn');
   const sumExportBtn = document.getElementById('cc-multi-sumexport-btn');
   const removeBtn = document.getElementById('cc-multi-remove-btn');
   if(!bar) return;
   const d = AppState.compactionPlan;
   const chunks = d ? (d.chunks || []) : [];
   // 全选勾选状态以「当前筛选下的可见项」为准：全部可见项都选中才打勾
   const visible = d ? ccBuildMergedItems(d) : [];
   const visibleCount = visible.length;
   const visibleSelected = visible.filter(function(it){
     const k = it.type === 'gap'
       ? 'gap-' + (it.gap.startIdx||0) + '-' + (it.gap.endIdx||0)
       : it.chunk.index;
     return AppState.ccSelectedChunks.has(k);
   }).length;
   if(countEl) countEl.textContent = '已选 ' + AppState.ccSelectedChunks.size + ' 项';
   if(selectAllEl) selectAllEl.checked = visibleCount > 0 && visibleSelected >= visibleCount;
   // 统计选中的块中各状态数量
   let canGenerate = 0, canReplace = 0, canReparse = 0, canExport = 0, canExportSum = 0, canRemove = 0;
   AppState.ccSelectedChunks.forEach(function(key){
     if(String(key).startsWith('gap-')){
       canGenerate++; // 未覆盖区可以生成摘要
       // 未覆盖区本身不能移除，不计入 canRemove（否则按钮可点但 batchRemoveBlocks 会跳过，数量对不上）
     }else{
       const idx = Number(key);
       const c = chunks.find(function(x){ return x.index === idx; });
       if(c){
         canExport++;
         canRemove++;
         if(!c.cached) canGenerate++; // 未生成的可以生成
         if(c.cached) canReplace++; // 已生成摘要的块都可执行替换/取消替换转换
         if(c.enabled !== false) canReparse++; // 已替换的可以解析入池
         if(c.enabled === true && c.summary) canExportSum++; // 已替换生效且有摘要 → 可导出摘要
       }
     }
   });
   if(genBtn) genBtn.disabled = canGenerate === 0;
   if(replaceBtn) replaceBtn.disabled = canReplace === 0;
   if(reparseBtn) reparseBtn.disabled = canReparse === 0;
   if(exportBtn) exportBtn.disabled = canExport === 0;
   if(sumExportBtn) sumExportBtn.disabled = canExportSum === 0;
   if(removeBtn) removeBtn.disabled = canRemove === 0;
 }

 // ===== 状态筛选 =====
 function toggleCcFilter(type){
   if(AppState.ccFilter === type){
     AppState.ccFilter = null; // 再点一次取消筛选
   }else{
     AppState.ccFilter = type;
   }
   renderCompaction();
   updateCcStatusBar();
 }

 // 应用筛选到 merged 列表
 function applyCcFilter(list, d){
   if(!AppState.ccFilter) return list;
   const chunks = d.chunks || [];
   return list.filter(function(it){
     if(AppState.ccFilter === 'gap'){
       return it.type === 'gap';
     }
     if(it.type === 'gap') return false;
     const c = it.chunk;
     const enabled = c.enabled !== false;
     if(AppState.ccFilter === 'pending'){
       return !c.cached; // 待生成
     }
     if(AppState.ccFilter === 'replace'){
       return c.cached && !enabled; // 待替换
     }
     if(AppState.ccFilter === 'replaced'){
       return c.cached && enabled; // 已替换
     }
     return true;
   });
 }

 // 批量生成摘要
/**
 * 批量生成摘要：对选中的块/未覆盖区逐个调用生成接口，
 * 期间禁用按钮并展示进度，结束后刷新预览。
 */
 async function batchGenerateSummaries(){
   if(!AppState.ccSelectedChunks.size) return;
   const d = AppState.compactionPlan;
   if(!d) return;
   const chunks = d.chunks || [];
   const gaps = (d.uncovered && d.uncovered.gaps) || [];
   const genBtn = document.getElementById('cc-multi-gen-btn');
   const barBtns = document.querySelectorAll('#cc-multi-bar .cc-btn');
   // 收集需要生成的：未生成摘要的块 + 未覆盖区
   const todo = [];
   AppState.ccSelectedChunks.forEach(function(key){
     if(String(key).startsWith('gap-')){
       const gkey = String(key).replace('gap-', '');
       const parts = gkey.split('-');
       const g = gaps.find(function(x){ return (x.startIdx||0) === Number(parts[0]) && (x.endIdx||0) === Number(parts[1]); });
       if(g) todo.push({type: 'gap', start: g.startIdx, end: g.endIdx, label: '未覆盖区 ' + g.startIdx + '–' + g.endIdx + ' 条'});
     }else{
       const idx = Number(key);
       const c = chunks.find(function(x){ return x.index === idx; });
       if(c){
         if(c.aiRep){
           todo.push({type: 'ai', repId: c.repId, idx: idx, label: '块 #' + idx});
         }else{
           todo.push({type: 'block', id: c.id||'', blockIndex: (typeof c.blockIndex==='number')?c.blockIndex:-1, idx: idx, label: '块 #' + idx});
         }
       }
     }
   });
   if(!todo.length){ toast('没有可生成摘要的项'); return; }
   if(!confirm('为选中的 ' + todo.length + ' 项生成摘要？可能耗时较长。')) return;
   // 进入loading状态
   const origText = genBtn ? genBtn.textContent : '';
   if(genBtn){ genBtn.disabled = true; genBtn.textContent = '生成中…'; }
   barBtns.forEach(function(b){ if(b.id !== 'cc-multi-gen-btn') b.disabled = true; });
   const msg = document.getElementById('compaction-msg');
   let done = 0;
   for(let i = 0; i < todo.length; i++){
     const item = todo[i];
     if(msg) msg.textContent = '正在生成 ' + item.label + ' 摘要（' + (i+1) + '/' + todo.length + '）…';
     try{
       let url, body;
       if(item.type === 'gap'){
         url = ADMIN_API + '/context-compaction/generate';
         body = JSON.stringify({action: 'gap', start: item.start, end: item.end});
       }else if(item.type === 'ai'){
         url = ADMIN_API + '/context-compaction/generate';
         body = JSON.stringify({repId: item.repId});
       }else{
         url = ADMIN_API + '/context-compaction/generate';
         body = JSON.stringify({action: 'block', id: item.id, blockIndex: item.blockIndex});
       }
       const r = await fetch(url, {
         method: 'POST', headers: {'Content-Type': 'application/json'}, body: body
       });
       const j = await r.json();
       if(j.error) throw new Error(j.error);
       if(j.ok === false) throw new Error(j.message || '生成失败');
       done++;
     }catch(e){
       console.error('生成失败:', item.label, e);
       toast(item.label + ' 生成失败：' + e.message);
       if(msg) msg.textContent = '已生成 ' + done + '/' + todo.length + '，' + item.label + ' 失败：' + e.message;
       break;
     }
     // 2026-10-01：批量生成每块间隔 30s，避免连续打上游模型
     if(i < todo.length - 1){
       if(msg) msg.textContent = '已生成 ' + (i+1) + '/' + todo.length + '，休息 30 秒…';
       await new Promise(function(r){ setTimeout(r, 30000); });
     }
   }
   resetCcMsgCache();
   await loadCompactionPreview();
   // 恢复按钮
   if(genBtn){ genBtn.textContent = origText || '生成摘要'; }
   updateMultiSelectBar();
   if(done === todo.length && done > 0){
     toast('✓ 已生成 ' + done + ' 个摘要');
     if(msg) msg.textContent = '✓ 已生成 ' + done + ' 个摘要';
   }else if(done > 0){
     if(msg) msg.textContent = '部分完成：' + done + '/' + todo.length + ' 个生成成功';
   }
 }

 // 批量替换
 async function batchReplaceBlocks(){
   if(!AppState.ccSelectedChunks.size) return;
   const d = AppState.compactionPlan;
   if(!d) return;
   const chunks = d.chunks || [];
   // 收集选中块：未替换→替换，已替换→取消替换
   const todo = [];
   AppState.ccSelectedChunks.forEach(function(key){
     if(String(key).startsWith('gap-')) return; // 未覆盖区不能替换
     const idx = Number(key);
     const c = chunks.find(function(x){ return x.index === idx; });
       if(c && c.cached){
         if(c.aiRep){
           todo.push({type: 'ai', repId: c.repId, idx: idx, label: '块 #' + idx});
         }else{
           todo.push({type: 'manual', id: c.id||'', blockIndex: (typeof c.blockIndex==='number')?c.blockIndex:-1, idx: idx, label: '块 #' + idx});
         }
       }
   });
   if(!todo.length){ toast('没有可转换的块'); return; }
   if(!confirm('将选中的 ' + todo.length + ' 个块按当前状态执行替换/取消替换？')) return;
   const msg = document.getElementById('compaction-msg');
   let done = 0;
   for(let i = 0; i < todo.length; i++){
     const item = todo[i];
     if(msg) msg.textContent = '正在替换 ' + item.label + '（第 ' + (i+1) + '/' + todo.length + '）…';
     try{
       let url, body;
       if(item.type === 'ai'){
         url = ADMIN_API + '/context-replacements/toggle';
         const c0 = chunks.find(function(x){ return x.index === item.idx; });
         body = JSON.stringify({id: item.repId, enabled: !(c0 && c0.enabled === true)});
       }else{
         url = ADMIN_API + '/context-compaction/blocks';
         const c0 = chunks.find(function(x){ return x.index === item.idx; });
         body = JSON.stringify({action: 'toggle', id: item.id, blockIndex: item.blockIndex, enabled: !(c0 && c0.enabled === true)});
       }
       const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: body});
       const j = await r.json();
       if(j.error || j.ok === false) throw new Error(j.message || j.error || '替换失败');
       done++;
     }catch(e){
       if(msg) msg.textContent = item.label + ' 替换失败：' + e.message;
       toast('替换失败：' + e.message);
       break;
     }
   }
   resetCcMsgCache();
   await loadCompactionPreview();
   if(msg) msg.textContent = '已完成 ' + done + '/' + todo.length + ' 块状态转换。';
   updateMultiSelectBar();
 }

 // 批量解析入池
 async function batchReparseToPool(){
   if(!AppState.ccSelectedChunks.size) return;
   const d = AppState.compactionPlan;
   if(!d) return;
   const chunks = d.chunks || [];
   // 收集已替换的块
   const selectedIds = [];
   AppState.ccSelectedChunks.forEach(function(key){
     if(String(key).startsWith('gap-')) return;
     const idx = Number(key);
     const c = chunks.find(function(x){ return x.index === idx; });
     if(c && c.enabled !== false) selectedIds.push(c.id);
   });
   if(!selectedIds.length){ toast('没有已替换的块可解析'); return; }
   const isMerge = selectedIds.length > 1;
   if(!confirm(isMerge
     ? '将选中的 ' + selectedIds.length + ' 个块的「时间线原文」交给 AI 提取记忆候选，全部进 review 队列人工把关？'
     : '将选中的 1 个块的「时间线原文」交给 AI 提取记忆候选，进 review 队列人工把关？')) return;
   const msg = document.getElementById('compaction-msg');
   if(msg) msg.textContent = '正在解析时间线原文并提取记忆候选…';
   try{
     const r = await fetch(ADMIN_API + '/memory-pool/reparse', {
       method: 'POST', headers: {'Content-Type': 'application/json'},
       body: JSON.stringify({chunkIds: selectedIds, merge: isMerge})
     });
     const j = await r.json();
     if(j.error) throw new Error(j.error);
     const s = '已解析 ' + j.processed + ' 块 -> 候选 ' + j.reviewed + ' 条进 review 队列 / 门卫拒 ' + j.rejected + ' / 失败 ' + j.failed + (j.degraded ? ' / ' + j.degraded + ' 块原文缺失退用摘要' : '') + '。请在记忆 review 页人工裁决。';
     if(msg) msg.textContent = s;
     toast(s);
   }catch(e){
     if(msg) msg.textContent = '解析失败: ' + e.message;
     toast('解析失败: ' + e.message);
   }
   updateMultiSelectBar();
 }

  // 左滑单块「解析」（0918）：该压缩块覆盖区间的时间线原文 → LLM 提候选 → review 队列人工裁决
  async function reparseSingleBlock(cid){
    const d = AppState.compactionPlan;
    if(!d) return;
    const c = (d.chunks || []).find(function(x){ return x.index === cid; });
    if(!c || c.enabled === false){ toast('该块未替换，无法解析'); return; }
    if(!confirm('将该块的「时间线原文」交给 AI 提取记忆候选，进 review 队列人工把关？')) return;
    const msg = document.getElementById('compaction-msg');
    if(msg) msg.textContent = '正在解析时间线原文并提取记忆候选…';
    try{
      const r = await fetch(ADMIN_API + '/memory-pool/reparse', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chunkIds: [c.id]})
      });
      const j = await r.json();
      if(j.error) throw new Error(j.error);
      const s2 = '已解析 1 块 -> 候选 ' + j.reviewed + ' 条进 review 队列 / 门卫拒 ' + j.rejected + ' / 失败 ' + j.failed + (j.degraded ? '（原文缺失退用摘要）' : '') + '。请在记忆 review 页人工裁决。';
      if(msg) msg.textContent = s2;
      toast(s2);
    }catch(e){
      if(msg) msg.textContent = '解析失败: ' + e.message;
      toast('解析失败: ' + e.message);
    }
  }

  // 左滑「隐藏」按钮（0918 补回独立隐藏入口，替代原入池时附带隐藏）：摘要与原文都不再发 AI，可「取消隐藏」恢复
  async function hideSingleBlock(cid, blockIndex, isAi){
    const d = AppState.compactionPlan;
    if(!d) return;
    const c = (d.chunks || []).find(function(x){ return x.index === cid; });
    if(!c || c.enabled === false){ toast('该块未替换，无需隐藏'); return; }
    try{
      await ccSetBlockHidden(c, blockIndex, isAi, true);
      toast('块 #' + cid + ' 已隐藏（不再进入上下文）');
      loadCompactionPreview();
    }catch(e){
      toast('隐藏失败: ' + e.message);
    }
  }

  // 设置/取消块的手动隐藏（AI 块走 context-replacements/toggle 带 hidden；手工块走 blocks 的 hide 动作，按记录 id 精确命中）
  async function ccSetBlockHidden(c, blockIndex, isAi, hidden){
    const url = isAi
      ? ADMIN_API + '/context-replacements/toggle'
      : ADMIN_API + '/context-compaction/blocks';
    const body = isAi
      ? {id: c.repId, hidden: hidden}
      : {action: 'hide', id: (c.id||''), blockIndex: blockIndex, hidden: hidden};
    const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    const j = await r.json();
    if(j.error) throw new Error(j.error);
    if(j.ok === false) throw new Error(j.message || '操作未完成');
    return j;
  }

  // 取消手动隐藏（块头部「取消隐藏」按钮）
  async function unhideBlock(cid, blockIndex, isAi){
    const d = AppState.compactionPlan;
    if(!d) return;
    const c = (d.chunks || []).find(function(x){ return x.index === cid; });
    if(!c) return;
    const msg = document.getElementById('compaction-msg');
    try{
      await ccSetBlockHidden(c, blockIndex, isAi, false);
      if(msg) msg.textContent = '块 #' + cid + ' 已取消隐藏，恢复参与上下文。';
      toast('块 #' + cid + ' 已取消隐藏');
      loadCompactionPreview();
    }catch(e){
      if(msg) msg.textContent = '取消隐藏失败: ' + e.message;
      toast('取消隐藏失败: ' + e.message);
    }
  }

 // 批量导出
 function batchExportBlocks(){
   if(!AppState.ccSelectedChunks.size) return;
   const d = AppState.compactionPlan;
   if(!d) return;
   const chunks = d.chunks || [];
   // 收集选中的块
   const selected = [];
   AppState.ccSelectedChunks.forEach(function(key){
     if(String(key).startsWith('gap-')) return;
     const idx = Number(key);
     const c = chunks.find(function(x){ return x.index === idx; });
     if(c) selected.push(c);
   });
   if(!selected.length){ toast('没有可导出的块'); return; }
   // 检查是否都加载了原文
   let needLoad = [];
   selected.forEach(function(c){
     const msgs = c.msgs || AppState.ccMsgBySig[c.signature] || [];
     if(!msgs.length) needLoad.push(c);
   });
   if(needLoad.length){
     toast('有 ' + needLoad.length + ' 个块尚未加载原文，请先展开它们再导出');
     return;
   }
   if(!confirm('导出选中的 ' + selected.length + ' 个块的原文？')) return;
   let allTxt = '';
   selected.sort(function(a, b){ return a.index - b.index; });
   selected.forEach(function(c){
     const msgs = c.msgs || AppState.ccMsgBySig[c.signature] || [];
     const baseNum = (typeof c.blockStart === 'number' && c.blockStart >= 0) ? c.blockStart : ((typeof c.firstIdx === 'number' && c.firstIdx >= 0) ? c.firstIdx : null);
     allTxt += '块 #' + c.index + (c.range_label ? (' ' + c.range_label) : '') + '\n';
     if(c.first_id && c.last_id) allTxt += '边界: ' + c.first_id + '..' + c.last_id + '\n';
     allTxt += '========================================\n\n';
     msgs.forEach(function(m, i){
       const role = m.role === 'user' ? '她' : '我';
       const num = (m && ('num' in m)) ? ((typeof m.num === 'number' && m.num >= 0) ? ('# ' + (m.num + 1) + ' ') : '') : (baseNum === null ? '' : ('# ' + (baseNum + i + 1) + ' '));
       const t = m.time ? (' [' + m.time + ']') : '';
       allTxt += num + role + t + '：' + (m.content || '') + '\n\n';
     });
     allTxt += '\n\n';
   });
   const blob = new Blob([allTxt], {type: 'text/plain;charset=utf-8'});
   const url = URL.createObjectURL(blob);
   const a = document.createElement('a');
   a.href = url; a.download = 'selected_blocks_' + selected.length + '.txt';
   document.body.appendChild(a); a.click();
   setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 60);
 }
 // 批量导出摘要（2026-09-27 用户拍板：范围=选中块中已替换生效的、内容=仅摘要文本）
 function batchExportSummaries(){
   if(!AppState.ccSelectedChunks.size) return;
   const d = AppState.compactionPlan;
   if(!d) return;
   const chunks = d.chunks || [];
   const selected = [];
   AppState.ccSelectedChunks.forEach(function(key){
     if(String(key).startsWith('gap-')) return;
     const idx = Number(key);
     const c = chunks.find(function(x){ return x.index === idx; });
     if(c && c.enabled === true && c.summary) selected.push(c);
   });
   if(!selected.length){ toast('选中的块中没有已替换生效的摘要'); return; }
   if(!confirm('导出选中的 ' + selected.length + ' 个已替换块的摘要？')) return;
   let allTxt = '';
   selected.sort(function(a, b){ return a.index - b.index; });
   selected.forEach(function(c){
     allTxt += '块 #' + c.index + (c.range_label ? (' ' + c.range_label) : '') + '\n';
     if(c.first_id && c.last_id) allTxt += '边界: ' + c.first_id + '..' + c.last_id + '\n';
     allTxt += '========================================\n';
     allTxt += (c.summary || '').trim() + '\n\n';
   });
   const blob = new Blob([allTxt], {type: 'text/plain;charset=utf-8'});
   const url = URL.createObjectURL(blob);
   const a = document.createElement('a');
   a.href = url; a.download = 'selected_summaries_' + selected.length + '.txt';
   document.body.appendChild(a); a.click();
   setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 60);
 }

 // ==================== 批量导入手写摘要（2026-09-27） ====================
 // 格式：每段以「边界: 首消息id..尾消息id」（推荐，与导出格式对称）/[首id..尾id]/「块 #N」/[a:b] 开头，
 // 正文接其后可多行，段间空行分隔；匹配到块后按记录 id 批量写入（后端归档历史+置 enabled=false=待替换）
 let ccImportMatched = [];  // [{entry, chunk}]
 let ccImportFailed = [];   // [{entry}]
 function openCcImportPanel(){
   ccImportMatched = [];
   ccImportFailed = [];
   const ta = document.getElementById('cc-import-ta');
   if(ta) ta.value = '';
   const pv = document.getElementById('cc-import-preview');
   if(pv) pv.innerHTML = '';
   const btn = document.getElementById('cc-import-do-btn');
   if(btn) btn.disabled = true;
   openModal('ccImportModal');
 }
 function resetCcImportState(){ ccImportMatched = []; ccImportFailed = []; }
 function parseCcImportText(text){
   const lines = String(text||'').split(/\r?\n/);
   const entries = [];
   let cur = null;
   lines.forEach(function(line, i){
     const t = line.trim();
     if(!t){ if(cur && cur.summary) cur.summary += '\n'; return; }
     const mBlock = t.match(/^块\s*#\s*(\d+)\b/);
     const mBound = t.match(/^边界:\s*(\S+?)\.\.(\S+)/) || t.match(/^\[(\S+?)\.\.(\S+)\]/);
     const mRange = t.match(/^\[(\d+):(\d+)\]/);
     if(mBlock){ cur = { line: i+1, blockNo: Number(mBlock[1]), startId: null, endId: null, rangeStart: null, rangeEnd: null, summary: t.slice(mBlock[0].length).trim() }; entries.push(cur); return; }
     if(mBound){ cur = { line: i+1, blockNo: null, startId: mBound[1], endId: mBound[2], rangeStart: null, rangeEnd: null, summary: t.slice(mBound[0].length).trim() }; entries.push(cur); return; }
     if(mRange){ cur = { line: i+1, blockNo: null, startId: null, endId: null, rangeStart: Number(mRange[1]), rangeEnd: Number(mRange[2]), summary: t.slice(mRange[0].length).trim() }; entries.push(cur); return; }
     if(cur){ cur.summary = (cur.summary ? cur.summary + '\n' : '') + t; }
   });
   return entries.filter(function(e){ return e.summary && e.summary.trim(); });
 }
 function matchCcImportEntry(entry){
   const chunks = (AppState.compactionPlan && AppState.compactionPlan.chunks) || [];
   if(entry.blockNo !== null && entry.blockNo !== undefined){
     const c = chunks.find(function(x){ return x.index === entry.blockNo; });
     return c || null;
   }
   if(entry.startId && entry.endId){
     const c = chunks.find(function(x){ return x.first_id === entry.startId && x.last_id === entry.endId; });
     return c || null;
   }
   if(entry.rangeStart !== null && entry.rangeEnd !== null){
     const c = chunks.find(function(x){ return (x.blockStart + 1) === entry.rangeStart && (x.blockEnd + 1) === entry.rangeEnd; });
     return c || null;
   }
   return null;
 }
 function entryTag(e){
   if(e.blockNo !== null && e.blockNo !== undefined) return '块 #' + e.blockNo;
   if(e.startId) return '边界: ' + e.startId + '..' + (e.endId||'?');
   if(e.rangeStart !== null && e.rangeStart !== undefined) return '范围: ' + e.rangeStart + '..' + (e.rangeEnd||'?');
   return '?';
 }
 function renderCcImportPreview(){
   const pv = document.getElementById('cc-import-preview');
   if(!pv) return;
   let html = '<div style="margin-bottom:6px">共解析 <b>' + (ccImportMatched.length + ccImportFailed.length) + '</b> 条：命中 <b style="color:#5c8a4e">' + ccImportMatched.length + '</b> 条，未命中 <b style="color:#c05050">' + ccImportFailed.length + '</b> 条</div>';
   ccImportMatched.forEach(function(item){
     const c = item.chunk, e = item.entry;
     const body = e.summary.length > 60 ? (e.summary.slice(0,60) + '…') : e.summary;
     html += '<div class="cc-import-item ok"><span class="cc-import-meta">' + escHtml(entryTag(e)) + ' → 块 #' + c.index + '</span><div class="cc-import-body">' + escHtml(body) + '</div></div>';
   });
   ccImportFailed.forEach(function(item){
     const e = item.entry;
     const body = e.summary.length > 40 ? (e.summary.slice(0,40) + '…') : e.summary;
     html += '<div class="cc-import-item fail"><span class="cc-import-meta">' + escHtml(entryTag(e)) + '</span><span class="cc-import-err"> 未命中（第 ' + e.line + ' 行）</span><div class="cc-import-body">' + escHtml(body) + '</div></div>';
   });
   pv.innerHTML = html;
 }
 function previewCcImport(){
   const ta = document.getElementById('cc-import-ta');
   if(!ta) return;
   const entries = parseCcImportText(ta.value);
   const pv = document.getElementById('cc-import-preview');
   if(!entries.length){
     if(pv) pv.innerHTML = '<div class="cc-import-item fail">未解析到任何条目：每段请以「边界: 首id..尾id」「[首id..尾id]」「块 #N」或「[a:b]」开头，正文接其后</div>';
     const btn = document.getElementById('cc-import-do-btn');
     if(btn) btn.disabled = true;
     return;
   }
   ccImportMatched = [];
   ccImportFailed = [];
   entries.forEach(function(entry){
     const c = matchCcImportEntry(entry);
     if(c) ccImportMatched.push({ entry: entry, chunk: c });
     else ccImportFailed.push({ entry: entry });
   });
   const btn = document.getElementById('cc-import-do-btn');
   if(btn) btn.disabled = ccImportMatched.length === 0;
   renderCcImportPreview();
 }
 async function doCcImport(){
   if(!ccImportMatched.length) return;
   const items = ccImportMatched.map(function(item){
     const c = item.chunk;
     return { id: c.id || c.repId || '', summary: item.entry.summary };
   });
   const pv = document.getElementById('cc-import-preview');
   if(pv) pv.innerHTML = '<div class="cc-import-item">正在导入 ' + items.length + ' 条…</div>';
   try{
     const r = await fetch(ADMIN_API + '/context-compaction/import-summaries', {
       method:'POST', headers:{'Content-Type':'application/json'},
       body: JSON.stringify({ items: items }), credentials:'include'
     });
     const j = await r.json();
     if(!r.ok || j.error){ if(pv) pv.innerHTML = '<div class="cc-import-item fail">导入失败：' + escHtml(j.error||'未知错误') + '</div>'; return; }
     let html = '<div style="margin-bottom:6px">导入完成：成功 <b style="color:#5c8a4e">' + j.okCount + '</b> 条，失败 <b style="color:#c05050">' + (j.failCount||0) + '</b> 条。旧摘要已自动归档历史版本，块已置为待替换。</div>';
     (j.results || []).forEach(function(res, i){
       if(res && res.ok) return;
       const item = items[i] || {};
       html += '<div class="cc-import-item fail"><span class="cc-import-meta">块 ' + escHtml(item.id||'') + '</span> <span class="cc-import-err">' + escHtml((res&&res.error)||'失败') + '</span></div>';
     });
     if(pv) pv.innerHTML = html;
     resetCcMsgCache();
     loadCompactionPreview();
     toast('批量导入完成：成功 ' + j.okCount + ' 条' + ((j.failCount||0) ? ('，失败 ' + j.failCount + ' 条') : ''));
   }catch(e){
     if(pv) pv.innerHTML = '<div class="cc-import-item fail">导入失败：' + escHtml(e.message) + '</div>';
   }
 }
 // 批量移除
 async function batchRemoveBlocks(){
   if(!AppState.ccSelectedChunks.size) return;
   const d = AppState.compactionPlan;
   if(!d) return;
   const chunks = d.chunks || [];
   // 收集可移除的块
   const todo = [];
   AppState.ccSelectedChunks.forEach(function(key){
     if(String(key).startsWith('gap-')) return; // 未覆盖区不能移除
     const idx = Number(key);
     const c = chunks.find(function(x){ return x.index === idx; });
     if(c){
       if(c.aiRep){
         todo.push({type: 'ai', repId: c.repId, idx: idx, label: '块 #' + idx});
       }else{
         // 按记录 id 精确移除：移除过程中其他块增删不再导致序号漂移误删
         todo.push({type: 'manual', id: c.id||'', idx: idx, label: '块 #' + idx});
       }
     }
   });
   if(!todo.length){ toast('没有可移除的块'); return; }
   if(!confirm('移除选中的 ' + todo.length + ' 个块？移除后内容退回未覆盖区。')) return;
   const msg = document.getElementById('compaction-msg');
   let done = 0;
   // 注意：移除会改变索引，所以从后往前移除
   todo.sort(function(a, b){ return b.idx - a.idx; });
   for(let i = 0; i < todo.length; i++){
     const item = todo[i];
     if(msg) msg.textContent = '正在移除 ' + item.label + '（第 ' + (i+1) + '/' + todo.length + '）…';
     try{
       if(item.type === 'ai'){
         const r = await fetch(ADMIN_API + '/context-replacements/undo', {
           method: 'POST', headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({id: item.repId})
         });
         const j = await r.json();
         if(j.error || j.ok === false) throw new Error(j.message || j.error || '移除失败');
       }else{
         const r = await fetch(ADMIN_API + '/context-compaction/blocks', {
           method: 'POST', headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({action: 'remove_at', id: item.id})
         });
         const j = await r.json();
         if(j.error || j.ok === false) throw new Error(j.message || j.error || '移除失败');
       }
       done++;
       if(i < todo.length - 1){
         await loadCompactionPreview();
       }
     }catch(e){
       if(msg) msg.textContent = item.label + ' 移除失败：' + e.message;
       toast('移除失败：' + e.message);
       break;
     }
   }
   AppState.ccSelectedChunks.clear();
   resetCcMsgCache();
   await loadCompactionPreview();
   if(msg) msg.textContent = '已移除 ' + done + '/' + todo.length + ' 块。';
   updateMultiSelectBar();
 }

    


// locateCcFromSearch（搜索结果跳转定位）已于 2026-09-28 删除：零引用（UI 不再生成该入口）

 // 移除单块：手动块调 blocks/remove_at，AI块调 context-replacements/undo
function removeSingleBlock(idx, blockIndex, isAi, recId){
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent='正在移除块 #'+idx+'...';
   if(isAi){
     const c=(AppState.compactionPlan.chunks||[]).find(function(x){return x.index===idx;});
     if(c && c.repId){ undoContextReplacement(c.repId); return; }
   }
   fetch(ADMIN_API + '/context-compaction/blocks',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({action:'remove_at', id: recId||'', blockIndex: blockIndex})
   }).then(function(r){return r.json()}).then(function(d){
     if(d && d.error){ if(msg) msg.textContent='移除失败: '+d.error; return; }
     if(d && d.ok===false){ if(msg) msg.textContent=(d.message||'操作未完成'); return; }
     if(msg) msg.textContent='已移除块 #'+idx+'，内容退回未覆盖区。';
     resetCcMsgCache();
     loadCompactionPreview();
   }).catch(function(e){ if(msg) msg.textContent='移除失败: '+e.message; });
 }
 
 // 切换块的替换开关（手动块和AI块统一）
 function toggleCcReplace(idx, blockIndex, isAi){
   const c=(AppState.compactionPlan.chunks||[]).find(function(x){return x.index===idx;});
   const next=!c || c.enabled===false;
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent=next?'正在启用块 #'+idx+' 替换...':'正在停用块 #'+idx+' 替换...';
   let p;
   if(isAi){
     // AI 块：调 context-replacements/toggle
     p=fetch(ADMIN_API + '/context-replacements/toggle',{
       method:'POST',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({id: c.repId, enabled: next})
     }).then(function(r){return r.json()});
   }else{
     // 手动块：调 blocks/toggle（按记录 id 精确命中）
     p=fetch(ADMIN_API + '/context-compaction/blocks',{
       method:'POST',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({action:'toggle', id: (c&&c.id)||'', blockIndex: blockIndex, enabled: next})
     }).then(function(r){return r.json()});
   }
   p.then(function(d){
     if(d && d.error){ if(msg) msg.textContent='操作失败: '+d.error; return; }
     if(d && d.ok===false){ if(msg) msg.textContent=(d.message||'操作未完成'); return; }
     if(msg) msg.textContent=next?'块 #'+idx+' 已启用替换。':'块 #'+idx+' 已停用替换（保留原文）。';
     loadCompactionPreview();
   }).catch(function(e){ if(msg) msg.textContent='操作失败: '+e.message; });
 }
 
 // 在未覆盖区按编号范围添加块
 function addBlockByRange(gstart, gend){
   const input=document.getElementById('cc-add-range-'+(gstart||0)+'-'+(gend||0));
   if(!input){
     // 兼容旧的单个输入框
     const input0=document.getElementById('cc-add-range');
     if(input0) input=input0; else return;
   }
   const val=input.value.trim();
   const m=String(val).match(/^\s*(\d+)\s*[-~至到]\s*(\d+)\s*$/);
   if(!m){
     const msg=document.getElementById('compaction-msg');
     if(msg) msg.textContent='格式不对，请输入「起始-结束」，如 51-100。';
     return;
   }
   const start=parseInt(m[1],10), end=parseInt(m[2],10);
   if(end<start){
     const msg=document.getElementById('compaction-msg');
     if(msg) msg.textContent='结束编号要 ≥ 起始编号。';
     return;
   }
   const d=AppState.compactionPlan;
   if(d && end>(d.totalCompressible||0)){
     const msg=document.getElementById('compaction-msg');
     if(msg) msg.textContent='结束编号超过消息总数（最大 '+(d.totalCompressible||0)+'）。';
     return;
   }
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent='正在添加块 '+start+'-'+end+' ...';
   fetch(ADMIN_API + '/context-compaction/blocks',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({action:'add_range', start: start, end: end})
   }).then(function(r){return r.json()}).then(function(d){
     if(d && d.error){ if(msg) msg.textContent='添加失败: '+d.error; return; }
     if(d && d.ok===false){ if(msg) msg.textContent=(d.message||'操作未完成'); return; }
     if(msg) msg.textContent='已添加块 '+start+'-'+end+'。'+(d.removedCount?('（自动合并 '+d.removedCount+' 个重叠块）'):'');
     resetCcMsgCache();
     loadCompactionPreview();
   }).catch(function(e){ if(msg) msg.textContent='添加失败: '+e.message; });
 }
 
  // 文本 → 话题 token 集：去停用词的中文字/相邻字 bigram + 英数词，供相邻消息相似度比较
 function ccGapTopicTokens(text){
  const STOP=new Set("的了我是你他它她这在在有也就说都还被把让跟和与或但而而且还再不没这那们个种些去来到上下前后时次天点会能要想觉得自己什么怎么这样那样现在然后因为所以但是如果感觉时候东西应该可以已经知道看到听到想到".split(""));
  const raw=String(text||'').replace(/<[^>]+>/g,'').toLowerCase();
  const out=new Set();
  const runs=raw.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g)||[];
  const regEn=/^[a-z0-9]+$/;
  runs.forEach(function(run){
    if(regEn.test(run)){ if(run.length>=2) out.add(run); return; }
    for(let i=0;i<run.length;i++){
      if(STOP.has(run[i])) continue;
      out.add(run[i]);
      if(i+1<run.length && !STOP.has(run[i+1])) out.add(run[i]+run[i+1]);
    }
  });
  return out;
}
// 未覆盖区内启发式找切分点：相邻消息时间空档(5分)/话题相似度低(4分)/用户开新话题(2分)，
// 总分 ≥4 即推荐为候选切点（点绿点按该条切开成两块）
function ccGapSuggestCuts(key){
  const msgs=AppState.ccGapMsgByKey[key];
  if(!msgs || msgs.length<2) return [];
  const cfgGap=(AppState.compactionPlan&&AppState.compactionPlan.config&&Number(AppState.compactionPlan.config.compaction_gap_minutes))||30;
  const gapMs=cfgGap*60*1000;
  const toks=msgs.map(function(m){ return ccGapTopicTokens(m.content); });
  const out=[];
  for(let i=0;i<msgs.length-1;i++){
    const a=msgs[i], b=msgs[i+1];
    let t0=null,t1=null;
    try{ t0=new Date(String(a.time||'').replace(' ','T')+':00+08:00'); }catch(e){}
    try{ t1=new Date(String(b.time||'').replace(' ','T')+':00+08:00'); }catch(e){}
    let score=0, reason='';
    if(t0 && t1 && !isNaN(t0.getTime()) && !isNaN(t1.getTime()) && Math.abs(t1.getTime()-t0.getTime())>=gapMs){ score+=5; reason='时间空档'; }
    let inter=0; const A=toks[i], B=toks[i+1];
    A.forEach(function(x){ if(B.has(x)) inter++; });
    const union=A.size+B.size-inter;
    const sim=union? inter/union : 0;
    if(sim<0.12){ score+=4; reason=reason?reason:'话题转折'; }
    else if(sim<0.3){ score+=2; }
    if(b.role==='user' && sim<0.35){ score+=2; reason=reason?reason:'用户发起新话题'; }
    if(score>=4){ out.push({ cut:Number(a.num), after:Number(a.num), reason:reason||'建议切分' }); }
  }
  return out;
}
async function ccDoCutRange(gStart,leftEnd,rightStart,gEnd){
  const msg=document.getElementById('compaction-msg');
  if(msg) msg.textContent='正在切分 '+gStart+'~'+gEnd+' ...';
  try{
    const r1=await fetch(ADMIN_API+'/context-compaction/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add_range',start:gStart,end:leftEnd})});
    const j1=await r1.json();
    if(j1.error||j1.ok===false) throw new Error(j1.message||j1.error||'切分失败');
    const r2=await fetch(ADMIN_API+'/context-compaction/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add_range',start:rightStart,end:gEnd})});
    const j2=await r2.json();
    if(j2.error||j2.ok===false) throw new Error(j2.message||j2.error||'切分失败');
    resetCcMsgCache();
    await loadCompactionPreview();
    if(msg) msg.textContent='已切分 '+gStart+'~'+gEnd+' 为两个块。';
  }catch(e){
    if(msg) msg.textContent='切分失败: '+e.message;
    toast('切分失败: '+e.message);
  }
}
function ccGapCutAt(key,n){
  const m=String(n==null?'':n).trim();
  const val=Math.floor(Number(m));
  const part=String(key).split('-');
  const gs=Number(part[0]), ge=Number(part[1]);
  if(!(val>=1)||!(gs>=1)||!(ge>=gs)){ toast('编号无效'); return; }
  if(val<gs || val>=ge){ toast('编号需在该未覆盖区之间（'+gs+'~'+ge+'）'); return; }
  if(!confirm('在第 '+val+' 条后切开，形成两个块？')) return;
  ccDoCutRange(gs, val, val+1, ge);
}
// ccGapCutAtInput / ccDoCutSegments / ccGapToggleCuts（切点输入框/批量切分/切点开关）
// 已于 2026-09-28 删除：零引用（UI 不再生成切点输入与开关入口）
function ccFindGap(gs, ge){
  const d=AppState.compactionPlan; if(!d||!d.uncovered||!d.uncovered.gaps) return null;
  for(let i=0;i<d.uncovered.gaps.length;i++){ const g=d.uncovered.gaps[i]; if((g.startIdx||0)===gs && (g.endIdx||0)===ge) return g; }
  return null;
}
function ccGapItemHtml(key, m, cuts, idx){
  return '<div class="cc-gap-item'+(m.marked?' marked':'')+'" id="cc-gap-item-'+key+'-'+idx+'" title="点击展开/收起">'
    +'<div class="cc-gap-item-head">'
    +'<span class="cc-gap-left">'
    +'<span class="cc-role '+(m.role==='user'?'cc-role-she':'cc-role-me')+'">'+(m.role==='user'?'她':'我')+'</span>'
    +'<span class="cc-gap-num">#'+m.num+'</span>'
    +'</span>'
    +'<span class="cc-gap-right">'
    +(m.time?'<span class="cc-gap-time">'+escHtml(m.time)+'</span>':'')
    +'</span>'
    +'</div>'
    +'<div class="cc-gap-body" onclick="toggleCcGapExpand(\''+key+'\','+idx+')">'+escHtml(m.content)+'</div>'
    +'</div>'
    +(cuts.some(function(c){return c.cut===m.num;})?'<div class="cc-gap-cut-dot" title="点击在第 '+m.num+' 条后切分（会形成两个块）" onclick="ccGapCutAt(\''+key+'\','+m.num+')"><i></i></div>':'');
}
function ccGapMoreWrapHtml(key, gs, ge){
  if(!AppState.ccGapHasMore[key]) return '';
  const g=ccFindGap(gs, ge)||{};
  const total=(g.count||''); const loaded=AppState.ccGapPageOffset[key]||((AppState.ccGapMsgByKey[key]||[]).length);
  return '<div id="cc-gap-more-wrap-'+key+'" class="cc-gap-more" style="text-align:center;padding:5px 0;font-size:10px;color:var(--text3)">上滑自动加载（已加载 '+loaded+'/'+total+'）</div>';
}
function ccArmGapAutoLoad(key, gs, ge){
  const box=document.getElementById('cc-gap-scroll-'+key);
  if(!box) return;
  if(!box._ccAutoLoad){
    box._ccAutoLoad=true;
    box.addEventListener('scroll',function(){
      if(box.scrollTop+box.clientHeight>=box.scrollHeight-240){
        if(AppState.ccGapHasMore[key] && AppState.ccGapLoadingKey!==key && !AppState.ccGapCollapsed.has(key)) loadGapPage(key,gs,ge);
      }
    },{passive:true});
  }
  const more=document.getElementById('cc-gap-more-wrap-'+key);
  if(more && !more._ccObserved && 'IntersectionObserver' in window){
    more._ccObserved=true;
    const io=new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(en.isIntersecting && AppState.ccGapHasMore[key] && AppState.ccGapLoadingKey!==key && !AppState.ccGapCollapsed.has(key)){
          io.disconnect(); more._ccObserved=false;
          loadGapPage(key,gs,ge);
        }
      });
    },{rootMargin:'160px 0px'});
    io.observe(more);
  }
}
function renderCcGapMessages(g){
  const key=(g.startIdx||0)+'-'+(g.endIdx||0);
  const msgs=AppState.ccGapMsgByKey[key];
  if(!msgs){
    loadGapPage(key, g.startIdx, g.endIdx);
    return '<div class="cc-gap-scroll"><div style="padding:14px;text-align:center;font-size:12px;color:var(--text3)">消息加载中...</div></div>';
  }
  if(!msgs.length) return '<div class="cc-gap-scroll"><div style="padding:14px;text-align:center;font-size:12px;color:var(--text3)">（该范围无可展开内容）</div></div>';
  const cuts=ccGapSuggestCuts(key);
  let html='<div class="cc-gap-scroll" id="cc-gap-scroll-'+key+'">';
  msgs.forEach(function(m,i){ html+=ccGapItemHtml(key,m,cuts,i); });
  html+='</div>';
  html+=ccGapMoreWrapHtml(key, g.startIdx, g.endIdx);
  return html;
}
// 未覆盖区消息分页加载：每页 CC_GAP_PAGE 条，滚动到底/哨兵可见时自动续拉并就地追加
function loadGapPage(key, startIdx, endIdx){
  if(AppState.ccGapLoadingKey===key) return;
  if(AppState.ccGapHasMore[key]===false) return;
  AppState.ccGapLoadingKey=key;
  const startVal=(typeof startIdx==='number'?startIdx:parseInt(startIdx,10))||0;
  const endVal=(typeof endIdx==='number'?endIdx:parseInt(endIdx,10))||0;
  const offset=AppState.ccGapPageOffset[key]||0;
  const url=ADMIN_API+'/context-compaction/range-preview?start='+startVal+'&end='+endVal+'&limit='+CC_GAP_PAGE+'&offset='+offset;
  const prevLen=(AppState.ccGapMsgByKey[key]||[]).length;
  const moreBtn=document.getElementById('cc-gap-more-'+key);
  if(moreBtn){ moreBtn.textContent='加载中…'; moreBtn.disabled=true; }
  fetch(url).then(function(r){return r.json()}).then(function(d){
    AppState.ccGapLoadingKey=null;
    const arr=(d&&d.items)||[];
    const prev=AppState.ccGapMsgByKey[key]||[];
    AppState.ccGapMsgByKey[key]=prev.concat(arr);
    AppState.ccGapPageOffset[key]=offset+arr.length;
    AppState.ccGapHasMore[key]=!!(d&&d.hasMore);
    const liveBox=document.getElementById('cc-gap-scroll-'+key);
    if(liveBox){
      const cuts=ccGapSuggestCuts(key);
      liveBox.insertAdjacentHTML('beforeend', arr.map(function(m,j){ return ccGapItemHtml(key,m,cuts,prevLen+j); }).join(''));
      const wrap=document.getElementById('cc-gap-more-wrap-'+key);
      if(wrap){ const nh=ccGapMoreWrapHtml(key, startIdx, endIdx); if(nh) wrap.outerHTML=nh; else wrap.remove(); }
      ccArmGapAutoLoad(key, startIdx, endIdx);
    }else{
      renderCompaction();
    }
  }).catch(function(){ AppState.ccGapLoadingKey=null; const wrap=document.getElementById('cc-gap-more-wrap-'+key); if(wrap){ wrap.textContent='加载失败，上滑重试'; } });
}
function toggleCcGapExpand(key, i){
  const el=document.getElementById('cc-gap-item-'+key+'-'+i);
  if(el) el.classList.toggle('expanded');
}
function ccArmAllGapAutoLoad(){
  const d=AppState.compactionPlan; if(!d||!d.uncovered||!d.uncovered.gaps) return;
  d.uncovered.gaps.forEach(function(g){
    const key=(g.startIdx||0)+'-'+(g.endIdx||0);
    if(AppState.ccGapHasMore[key]) ccArmGapAutoLoad(key, g.startIdx, g.endIdx);
  });
}

 function toggleCcGapCollapse(gs, ge){
   const key=(gs||0)+'-'+(ge||0);
   if(AppState.ccGapCollapsed.has(key)) AppState.ccGapCollapsed.delete(key); else AppState.ccGapCollapsed.add(key);
   renderCompaction();
 }
 
 function ccRangeWarn(input, gs, ge){
   const v=input.value.trim();
   const m=String(v).match(/^\s*(\d+)\s*[-~至到]\s*(\d+)\s*$/);
   let ok=true;
   const d=AppState.compactionPlan;
   const max=(d&&d.totalCompressible)||0;
   if(m){
     const a=parseInt(m[1],10), b=parseInt(m[2],10);
     ok=(a>=1 && b<=max && a<=b);
   }else if(v!==''){ ok=false; }
   input.classList.toggle('warn', !ok);
 }
 
 // 自动分块：只分这个未覆盖区，按配置的时间间隔 + 目标/最少/最多条数自然切分
 function autoSplitGap(start, end){
   const cfg=(AppState.compactionPlan&&AppState.compactionPlan.config)||{};
   const cfgGap=Number(cfg.compaction_gap_minutes)||30;
   const chunkSize=Number(cfg.compaction_chunk_size)||100;
   const chunkMin=Number(cfg.compaction_chunk_min)||40;
   const chunkMax=Number(cfg.compaction_chunk_max)||160;
   if(!confirm('按 '+cfgGap+' 分钟间隔 + 话题/说话人切换，并遵循 目标 '+chunkSize+' / 最少 '+chunkMin+' / 最多 '+chunkMax+' 条，自动分块第 '+start+'–'+end+' 条？会生成多个块，每块可再改范围/加摘要/替换。')) return;
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent='正在按 '+cfgGap+' 分钟间隔 / 目标 '+chunkSize+' 条自动分块 '+start+'-'+end+' ...';
   fetch(ADMIN_API + '/context-compaction/blocks',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({action:'split_range', start:start, end:end, gapMinutes: cfgGap, chunkSize: chunkSize, chunkMin: chunkMin, chunkMax: chunkMax})
   }).then(function(r){return r.json()}).then(function(d){
     if(d && d.error){ if(msg) msg.textContent='自动分块失败: '+d.error; return; }
     if(d && d.ok===false){ if(msg) msg.textContent=(d.message||'操作未完成'); return; }
     if(msg) msg.textContent='已自动分成 '+d.count+' 块。';
     resetCcMsgCache();
     loadCompactionPreview();
   }).catch(function(e){ if(msg) msg.textContent='自动分块失败: '+e.message; });
 }
 
  // 导出块原文 txt：优先用块内已加载的 msgs，空则提示先展开
  function exportBlockTxt(idx){
    const c=(AppState.compactionPlan&&AppState.compactionPlan.chunks||[]).find(function(x){return x.index===idx;});
    if(!c){ toast('块不存在'); return; }
    const msgs=c.msgs||AppState.ccMsgBySig[c.signature]||[];
    if(!msgs.length){ toast('该块原文尚未加载，请先展开一次再导出'); return; }
    const baseNum=(typeof c.blockStart==='number'&&c.blockStart>=0)?c.blockStart:((typeof c.firstIdx==='number'&&c.firstIdx>=0)?c.firstIdx:null);
    let txt='块 #'+c.index+(c.range_label?(' '+c.range_label):'')+'\n';
    txt+='========================================\n\n';
    msgs.forEach(function(m,i){
      const role=m.role==='user'?'她':'我';
      const num=(m&&('num' in m))?((typeof m.num==='number'&&m.num>=0)?('# '+(m.num+1)+' '):''):(baseNum===null?'':('# '+(baseNum+i+1)+' '));
      const t=m.time?(' ['+m.time+']'):'';
      txt+=num+role+t+'：'+(m.content||'')+'\n\n';
    });
    const blob=new Blob([txt],{type:'text/plain;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download='block_'+idx+'.txt';
    document.body.appendChild(a); a.click();
    setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); },60);
  }

 // 未覆盖区：一键生成摘要（新建手动块 + 调模型生成；生成后点块上的「替换」才生效）

 function generateGapSummary(start, end){
   const key=(start||0)+'-'+(end||0);
   if(AppState.ccGapGenerating.has(key)) return;
   if(!confirm('为第 '+start+'–'+end+' 条生成摘要？将新建一个手动块覆盖该范围，并调模型按压缩提示词生成摘要；生成后需点块上的「替换」才生效。')) return;
   AppState.ccGapGenerating.add(key);
   renderCompaction();
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent='正在为第 '+start+'–'+end+' 条生成摘要（约几十秒）…';
   fetch(ADMIN_API + '/context-compaction/generate',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({action:'gap', start:start, end:end})
   }).then(function(r){return r.json()}).then(function(d){
     AppState.ccGapGenerating.delete(key);
     if(d && d.error){ toast('生成失败：'+d.error); if(msg) msg.textContent='生成失败: '+d.error; renderCompaction(); return; }
     if(d && d.ok===false){ toast('生成失败：'+(d.message||'未知原因')); if(msg) msg.textContent=(d.message||'生成失败'); renderCompaction(); return; }
     if(msg) msg.textContent='已生成摘要（'+d.length+' 字），该块当前为「待替换」，点「替换」后生效。';
     resetCcMsgCache();
     loadCompactionPreview();
   }).catch(function(e){
     AppState.ccGapGenerating.delete(key);
     renderCompaction();
     toast('生成失败：'+e.message);
     if(msg) msg.textContent='生成失败: '+e.message;
   });
 }
 
 // 手动块：重新生成摘要（调模型重写，旧摘要保留进历史版本）
  // 手动块：直接新增/填写摘要（不调模型），适用于切分后尚未写摘要的块
  function openCcAddManual(idx, blockIndex){
    const w=document.getElementById('cc-addman-'+idx);
    if(!w) return;
    if(w.dataset.open==='1'){ w.innerHTML=''; w.dataset.open='0'; return; }
    w.dataset.open='1';
    const c=ccFindChunk(idx);
    const cur=((c&&c.summary)||(AppState.ccDraft[idx]||''));
    w.innerHTML='<div class="cc-sum-ta-wrap">'
      +'<textarea id="cc-edit-sel-'+idx+'" rows="6" oninput="AppState.ccDraft['+idx+']=this.value;updateCcCharCount('+idx+')" class="cc-sum-ta" placeholder="填写摘要内容（不调模型）">'+escHtml(cur)+'</textarea>'
      +'</div>'
      +'<div class="cc-sum-editor-btns">'
      +'<span class="cc-sum-count" id="cc-edit-count-'+idx+'">'+cur.length+' 字</span>'
      +'<button class="cc-btn primary" onclick="saveCcSummaryEdit('+idx+')">保存</button>'
      +'<button class="cc-btn secondary" onclick="openCcAddManual('+idx+','+blockIndex+')">收起</button>'
      +'</div>';
    const ta=document.getElementById('cc-edit-sel-'+idx);
    if(ta){ ta.focus(); }
  }

 function regenerateBlockSummary(idx, blockIndex, recId){
   if(blockIndex===undefined || blockIndex===null || blockIndex<0) return;
   if(!confirm('重新生成块 #'+idx+' 的摘要？现有摘要会保留在历史版本里。')) return;
   const msg=document.getElementById('compaction-msg');
   AppState.ccBlockGenerating.add(idx);
   renderCompaction();
   if(msg) msg.textContent='块 #'+idx+'：正在重新生成摘要（约几十秒）…';
   fetch(ADMIN_API + '/context-compaction/generate',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({action:'block', blockIndex: blockIndex, id: recId||''})
   }).then(function(r){return r.json()}).then(function(d){
     AppState.ccBlockGenerating.delete(idx);
     if(d && d.error){ toast('生成失败：'+d.error); if(msg) msg.textContent='生成失败: '+d.error; return; }
     if(d && d.ok===false){ toast('生成失败：'+(d.message||'未知原因')); if(msg) msg.textContent=(d.message||'生成失败'); return; }
     AppState.ccDraft[idx]=undefined;
     AppState.ccSummaryOpen.add(idx);
     AppState.ccAnimateOpen.add('cc-collapse-sum-'+idx);
     if(msg) msg.textContent='块 #'+idx+' 摘要已重新生成（'+d.length+' 字）。';
     resetCcMsgCache();
   }).catch(function(e){ toast('生成失败：'+e.message); if(msg) msg.textContent='生成失败: '+e.message; }).finally(function(){ loadCompactionPreview(); });
 }
 
 function regenerateAiBlockSummary(repId, idx){
   if(!repId) return;
   if(!confirm('重新生成块 #'+idx+'（AI 记忆）的摘要？现有摘要会保留在历史版本里。')) return;
   const msg=document.getElementById('compaction-msg');
   AppState.ccBlockGenerating.add(idx);
   renderCompaction();
   if(msg) msg.textContent='块 #'+idx+'：正在重新生成摘要（约几十秒）…';
   fetch(ADMIN_API + '/context-compaction/generate',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({action:'block', repId: repId})
   }).then(function(r){return r.json()}).then(function(d){
     AppState.ccBlockGenerating.delete(idx);
     if(d && d.error){ toast('生成失败：'+d.error); if(msg) msg.textContent='生成失败: '+d.error; return; }
     if(d && d.ok===false){ toast('生成失败：'+(d.message||'未知原因')); if(msg) msg.textContent=(d.message||'生成失败'); return; }
     AppState.ccAiSummaryOpen.add(idx);
     AppState.ccAnimateOpen.add('cc-collapse-ai-'+idx);
     if(msg) msg.textContent='块 #'+idx+' 摘要已重新生成（'+d.length+' 字）。';
     resetCcMsgCache();
   }).catch(function(e){ toast('生成失败：'+e.message); if(msg) msg.textContent='生成失败: '+e.message; }).finally(function(){ loadCompactionPreview(); });
 }

// AI 块：查看摘要
 function toggleCcAiSummary(idx){
   const wasOpen=AppState.ccAiSummaryOpen.has(idx);
   if(wasOpen){
     AppState.ccAiSummaryOpen.delete(idx);
     const w=document.getElementById('cc-collapse-ai-'+idx);
     if(w){
       w.classList.remove('open');
       setTimeout(function(){ renderCompaction(); },300);
       return;
     }
   }else{
     AppState.ccAiSummaryOpen.add(idx);
     AppState.ccAnimateOpen.add('cc-collapse-ai-'+idx);
   }
   renderCompaction();
 }
 
 function renderCcAiSummary(c){
   return '<div class="cc-ai-mem">'+escHtml(c.summary||'')+'</div>'
     +'<div class="cc-actions" style="border-top:none;margin-top:10px;padding-top:0">'
     +'<button class="cc-btn cc-act-edit" onclick="openCcAiEditModal('+c.index+')">编辑记忆</button>'
     +'<button class="cc-btn secondary" onclick="toggleCcAiSummary('+c.index+')">收起</button>'
      +'</div>'
      +renderCcHistory(c);
 }
 
 // AI 块：编辑 AI 写的记忆
 function openCcAiEditModal(idx){
   const c=ccFindChunk(idx);
   if(!c) return;
   AppState.ccAiEditTarget={index:idx, repId:c.repId};
   const s=(typeof c.blockStart==='number'&&c.blockStart>=0)?c.blockStart+1:((c.firstIdx>=0?c.firstIdx:0)+1);
   const e=(typeof c.blockEnd==='number'&&c.blockEnd>=0)?c.blockEnd+1:((c.lastIdx>=0?c.lastIdx:s-1)+1);
   document.getElementById('cc-ai-edit-title').textContent='编辑 AI 记忆 · 块 #'+idx;
   document.getElementById('cc-ai-edit-meta').textContent='第 '+s+'~'+e+' 条　'+c.count+' 条'+(c.range_label?'　'+(c.range_label):'');
   document.getElementById('cc-ai-edit-content').value=c.summary||'';
   openModal('ccAiEditModal');
   const ta=document.getElementById('cc-ai-edit-content');
   if(ta) setTimeout(function(){ta.focus();},50);
 }
 async function ccSaveAiEdit(){
   if(!AppState.ccAiEditTarget) return;
   const memory=document.getElementById('cc-ai-edit-content').value.trim();
   if(!memory){toast('记忆内容不能为空');return}
   try{
     const r=await fetch(ADMIN_API+'/context-replacements/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:AppState.ccAiEditTarget.repId,memory:memory}),credentials:'include'});
     const j=await r.json();
     if(!r.ok){toast(j.error||'保存失败');return}
     toast('AI 记忆已更新，下次请求生效。');
     closeModal('ccAiEditModal');
     AppState.ccAiEditTarget=null;
     resetCcMsgCache();
     loadCompactionPreview();
   }catch(e){toast('保存失败: '+e.message);}
 }
 
 // 压缩参数配置：把预览里的 config 填进表单
 function renderCompactionConfig(){
   const d=AppState.compactionPlan;
   if(!d || !d.config) return;
   const c=d.config;
   const fields={
     'cc-cfg-keep':c.compaction_keep_recent_messages,
     'cc-cfg-min':c.compaction_min_messages,
     'cc-cfg-sum-min':c.compaction_summary_min_chars,
     'cc-cfg-sum-max':c.compaction_summary_max_chars,
     'cc-cfg-gap':c.compaction_gap_minutes,
     'cc-cfg-chunk':c.compaction_chunk_size,
     'cc-cfg-chunk-min':c.compaction_chunk_min,
     'cc-cfg-chunk-max':c.compaction_chunk_max,
     'cc-cfg-max-blocks':c.compaction_max_active_blocks,
     'cc-cfg-ctx-limit':(c.compaction_context_limit_chars!==undefined?c.compaction_context_limit_chars:30000),
     'cc-cfg-alert-limit':(c.ctx_limit_alert_tokens!==undefined?c.ctx_limit_alert_tokens:0),
     'cc-cfg-protect-recent':(c.compaction_protect_recent_messages!==undefined?c.compaction_protect_recent_messages:40)
   };
   Object.keys(fields).forEach(function(id){
     const el=document.getElementById(id);
     if(el && fields[id]!==undefined) el.value=fields[id];
   });
   const cr=document.getElementById('cc-cfg-ctx-remind');
   if(cr) cr.checked=c.compaction_context_remind_enabled!==false;
 }
 
 // 保存压缩参数配置
 async function saveCompactionConfig(){
  const get=function(id){ const el=document.getElementById(id); return el?el.value:''; };
  const getC=function(id){ const el=document.getElementById(id); return el?el.checked:false; };
  let keep=Math.max(0, Math.floor(Number(get('cc-cfg-keep'))||0));
  let minMsg=Math.max(0, Math.floor(Number(get('cc-cfg-min'))||0));
  let sumMin=Math.max(0, Math.floor(Number(get('cc-cfg-sum-min'))||0));
  let sumMax=Math.max(0, Math.floor(Number(get('cc-cfg-sum-max'))||0));
  let gap=Math.max(1, Math.floor(Number(get('cc-cfg-gap'))||30));
  let chunkSize=Math.max(1, Math.floor(Number(get('cc-cfg-chunk'))||100));
  let chunkMin=Math.max(1, Math.floor(Number(get('cc-cfg-chunk-min'))||40));
  let chunkMax=Math.max(1, Math.floor(Number(get('cc-cfg-chunk-max'))||160));
  const setVal=function(id,v){ const el=document.getElementById(id); if(el) el.value=v; };
  const notes=[];
  const hint=document.getElementById('cc-config-hint');
  if(sumMin>sumMax){ sumMax=sumMin; setVal('cc-cfg-sum-max',sumMax); notes.push('摘要最少字数大于最多字数，已把“最多”调成=最少'); }
  else{ setVal('cc-cfg-sum-min',sumMin); setVal('cc-cfg-sum-max',sumMax); }
  if(chunkMin>chunkMax){ chunkMax=chunkMin; setVal('cc-cfg-chunk-max',chunkMax); notes.push('块最少条数大于最多条数，已把“最多”调成=最少'); }
  else{ setVal('cc-cfg-chunk-min',chunkMin); setVal('cc-cfg-chunk-max',chunkMax); }
  if(chunkMin>chunkSize){ notes.push('块最少条数('+chunkMin+')大于目标条数('+chunkSize+')，实际会以“最少”为准，块偏大'); }
  setVal('cc-cfg-keep',keep); setVal('cc-cfg-min',minMsg); setVal('cc-cfg-gap',gap); setVal('cc-cfg-chunk',chunkSize);
  if(hint) hint.classList.toggle('warn', notes.length>0);
  const body={
    compaction_keep_recent_messages: keep,
    compaction_min_messages: minMsg,
    compaction_summary_min_chars: sumMin,
    compaction_summary_max_chars: sumMax,
    compaction_gap_minutes: gap,
    compaction_chunk_size: chunkSize,
    compaction_chunk_min: chunkMin,
    compaction_chunk_max: chunkMax,
    compaction_max_active_blocks: Math.max(0, Math.floor(Number(get('cc-cfg-max-blocks'))||0)),
    compaction_context_limit_chars: Math.max(0, Math.floor(Number(get('cc-cfg-ctx-limit'))||0)),
    ctx_limit_alert_tokens: Math.max(0, Math.floor(Number(get('cc-cfg-alert-limit'))||0)),
    compaction_context_remind_enabled: getC('cc-cfg-ctx-remind'),
    compaction_protect_recent_messages: Math.max(0, Math.floor(Number(get('cc-cfg-protect-recent'))||0))
  };
  const msg=document.getElementById('cc-config-msg');
  if(msg) msg.textContent=(notes.length?('提示：'+notes.join('；')):'')+' 保存中...';
  try{
    const r=await fetch(ADMIN_API+'/context-compaction/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'include'});
    const j=await r.json();
    if(!r.ok){ if(msg) msg.textContent=j.error||'保存失败'; toast(j.error||'保存失败'); return; }
    // 用后端返回的最新 config 回填「与设置页/聊天页重叠」的字段，避免用本表单的过期值覆盖另一端刚保存的值
    if(j && j.config){
      const cfg=j.config;
      const setV=function(id,v){ const el=document.getElementById(id); if(el) el.value=(v!==undefined?v:''); };
      const setC=function(id,b){ const el=document.getElementById(id); if(el) el.checked=!!b; };
      if(j.config.compaction_context_limit_chars!==undefined) setV('cc-cfg-ctx-limit', j.config.compaction_context_limit_chars);
      if(j.config.ctx_limit_alert_tokens!==undefined) setV('cc-cfg-alert-limit', j.config.ctx_limit_alert_tokens);
      if(j.config.compaction_max_active_blocks!==undefined) setV('cc-cfg-max-blocks', j.config.compaction_max_active_blocks);
      setC('cc-cfg-ctx-remind', j.config.compaction_context_remind_enabled!==false);
    }
    if(msg) msg.textContent=(notes.length?('已自动修正：'+notes.join('；')+'。'):'已保存。')+' 下次预览/请求生效。';
    toast(notes.length?'压缩参数已保存（已自动修正冲突项）':'压缩参数已保存');
    resetCcMsgCache();
    loadCompactionPreview();
  }catch(e){ if(msg) msg.textContent='保存失败: '+e.message; toast('保存失败'); }
}

function ccNumLiveCheck(input, max){
   const v=Number(input.value);
   const ok=!input.value||(v>=1&&v<=Number(max));
   input.classList.toggle('warn', !ok);
 }
 
 function clampCcInput(input, i, field, max){
   const before=input.value;
   const raw=Number(input.value);
   const clamped=Math.min(Math.max(1, Math.floor(raw)||1), Number(max)||1);
   if(String(clamped)!==String(before)){
     input.value=clamped;
     const msg=document.getElementById('compaction-msg');
     if(msg){ setTimeout(function(){ msg.textContent='输入超出范围，已自动修正为第 '+clamped+' 条。'; }, 0); }
     // 只有值被修正过才补发更新：onchange 已为未修正的值发过一次，onblur 再发就是重复 POST
     updateCompactionBoundary(i, field, input.value);
   }
 }
 
 function updateCompactionBoundary(i, field, raw){
   const v=Math.max(1, Math.floor(Number(raw)||1));
   const d=AppState.compactionPlan;
   if(!d) return;
   // 按记录 id 精确找块（id 全局唯一，不受块增删导致的序号漂移影响）；找不到再按旧的手工块序号兜底
   let chunk=(d.chunks||[]).find(function(c){return !c.aiRep && c.id && String(c.id)===String(i);});
   if(!chunk){
     const ccList=(d.chunks||[]).filter(function(c){return !c.aiRep;});
     chunk=ccList[Number(i)];
   }
   if(!chunk) return;
   // 当前块的显示范围（1-based）
   let curStart, curEnd;
   if(typeof chunk.blockStart==='number'){
     curStart=chunk.blockStart+1;
     curEnd=chunk.blockEnd+1;
   }else{
     // 自动分块的纯预览块：用它的 firstIdx/lastIdx 推算当前范围
     curStart=(chunk.firstIdx>=0?chunk.firstIdx:0)+1;
     curEnd=(chunk.lastIdx>=0?chunk.lastIdx:curStart-1)+1;
   }
   let newStart=curStart, newEnd=curEnd;
   if(field===0) newStart=v; else newEnd=v;
   if(newStart>newEnd){
     const msg=document.getElementById('compaction-msg');
     if(msg) msg.textContent='开头不能大于结尾。';
     loadCompactionPreview();
     return;
   }
   if(newEnd>d.totalCompressible){ newEnd=d.totalCompressible; }
   if(newStart<1){ newStart=1; }
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent='正在'+(typeof chunk.blockStart==='number'?'更新块':'把自动分块固化为手动块')+' #'+chunk.index+' 为 '+newStart+'-'+newEnd+' ...';
   // 自动分块 → 用 add_range 固化；手动块 → 用 update_range 更新（按记录 id 精确命中）
   const payload = (typeof chunk.blockStart==='number')
     ? {action:'update_range', id: chunk.id||'', blockIndex: chunk.blockIndex, start:newStart, end:newEnd}
     : {action:'add_range', start:newStart, end:newEnd};
   fetch(ADMIN_API + '/context-compaction/blocks',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify(payload)
   }).then(function(r){return r.json()}).then(function(d){
     if(d && d.error){ if(msg) msg.textContent='操作失败: '+d.error; return; }
     if(d && d.ok===false){ if(msg) msg.textContent=(d.message||'操作未完成'); return; }
     if(msg) msg.textContent='块 #'+chunk.index+' 已保存为 '+newStart+'-'+newEnd+'。'+(d.removedCount?('（自动合并 '+d.removedCount+' 个重叠块）'):'');
     resetCcMsgCache();
     loadCompactionPreview();
   }).catch(function(e){ if(msg) msg.textContent='操作失败: '+e.message; });
 }
 
 
  function clampAiCcInput(input, index, field, max){
    const before=input.value;
    const raw=Number(input.value);
    const clamped=Math.min(Math.max(1, Math.floor(raw)||1), Number(max)||1);
    if(String(clamped)!==String(before)){
      input.value=clamped;
      const msg=document.getElementById('compaction-msg');
      if(msg){ setTimeout(function(){ msg.textContent='输入超出范围，已自动修正为第 '+clamped+' 条。'; }, 0); }
      // 只有值被修正过才补发更新：onchange 已发过一次，onblur 再发就是重复 POST
      updateAiBoundary(index, field, input.value);
    }
  }

  function updateAiBoundary(index, field, raw){
    const d=AppState.compactionPlan;
    if(!d) return;
    const chunk=(d.chunks||[]).find(function(x){ return x.index===index; });
    if(!chunk || !chunk.repId) return;
    const repId=chunk.repId;
    const v=Math.max(1, Math.floor(Number(raw)||1));
    if(!chunk) return;
    let curStart, curEnd;
    if(typeof chunk.blockStart==='number'){
      curStart=chunk.blockStart+1;
      curEnd=chunk.blockEnd+1;
    }else{
      curStart=(chunk.firstIdx>=0?chunk.firstIdx:0)+1;
      curEnd=(chunk.lastIdx>=0?chunk.lastIdx:curStart-1)+1;
    }
    let newStart=curStart, newEnd=curEnd;
    if(field===0) newStart=v; else newEnd=v;
    if(newStart>newEnd){
      const msg=document.getElementById('compaction-msg');
      if(msg) msg.textContent='开头不能大于结尾。';
      loadCompactionPreview();
      return;
    }
    if(newEnd>d.totalCompressible){ newEnd=d.totalCompressible; }
    if(newStart<1){ newStart=1; }
    const msg=document.getElementById('compaction-msg');
    if(msg) msg.textContent='正在更新 AI 块 #'+chunk.index+' 为 '+newStart+'-'+newEnd+' ...';
    fetch(ADMIN_API + '/context-compaction/blocks',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'update_ai_range', repId:repId, start:newStart, end:newEnd})
    }).then(function(r){return r.json()}).then(function(d2){
      if(d2 && d2.error){ if(msg) msg.textContent='操作失败: '+d2.error; return; }
      if(d2 && d2.ok===false){ if(msg) msg.textContent=(d2.message||'操作未完成'); return; }
      if(msg) msg.textContent='AI 块 #'+chunk.index+' 已保存为 '+newStart+'-'+newEnd+'（'+d2.count+' 条）。'+(d2.removedCount?('（自动合并 '+d2.removedCount+' 个重叠块）'):'');
      resetCcMsgCache();
      loadCompactionPreview();
    }).catch(function(e){ if(msg) msg.textContent='操作失败: '+e.message; });
  }

 function renderCcHistory(c){
   const h=c.history||[];
   if(!h.length) return '';
   const open=AppState.ccHistoryOpen.has(c.index);
   let html='<div class="cc-history">'
     +'<div class="cc-history-toggle" onclick="toggleCcHistory('+c.index+')">'+(open?'▾ 收起历史':'▸ 历史版本（'+h.length+' 份，新→旧）')+'</div>';
   if(!open) return html+'</div>';
   h.forEach(function(v){
     let t='未知时间';
     if(v.generatedAt){ try{ t=new Date(v.generatedAt).toLocaleString(); }catch(e){} }
     html+='<div class="cc-hist-item">'
       +'<div class="cc-hist-head">'
       +'<span class="cc-hist-time">'+t+(v.mode==='edited'?' · 手动编辑':(v.mode==='ai'?' · AI':(v.mode==='auto'?' · 自动':' · 手动')))+'</span>'
       +'<div class="cc-hist-btns">'
       +'<button class="cc-hist-restore" onclick="restoreCompactionSummary('+c.index+','+v.index+')">恢复此版</button>'
       +'<button class="cc-hist-del" onclick="deleteCcHistoryVersion('+c.index+','+v.index+')">删除</button>'
       +'</div>'
       +'</div>'
       +'<div class="cc-hist-body" onclick="toggleCcHistBody(this)">'+escHtml(v.summary)+'</div>'
       +'</div>';
   });
   return html+'</div>';
 }
 
 function restoreCompactionSummary(idx, hi){
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent='正在恢复块 #'+idx+' 的历史版本...';
   fetch(ADMIN_API + '/context-compaction/restore',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({chunkIndex:idx,historyIndex:hi})
   }).then(function(r){return r.json()}).then(function(d){
     if(d && d.error){ if(msg) msg.textContent='恢复失败: '+d.error; return; }
     AppState.ccDraft[idx]=undefined;
     const chunk=ccFindChunk(idx);
     if(chunk && chunk.history && chunk.history[hi]){
       const target=chunk.history[hi];
       const cur={ summary:chunk.summary, generatedAt:chunk.generatedAt, mode:chunk.mode, manual:chunk.manual };
       chunk.history=ccRenumberHistory([cur].concat(chunk.history.filter(function(h,i){return i!==hi;})));
       chunk.summary=target.summary;
       chunk.generatedAt=target.generatedAt;
       chunk.mode=target.mode;
       chunk.manual=target.manual;
       chunk.cached=true;
     }
     if(msg) msg.textContent='块 #'+idx+' 已恢复历史版本（'+d.length+' 字），下次请求生效。';
     renderCompaction();
   }).catch(function(e){
     if(msg) msg.textContent='恢复失败: '+e.message;
   });
 }
 
 function toggleCcHistory(idx){
   if(AppState.ccHistoryOpen.has(idx)) AppState.ccHistoryOpen.delete(idx); else AppState.ccHistoryOpen.add(idx);
   renderCompaction();
 }
 
 function deleteCcHistoryVersion(idx, hi){
   if(!confirm('删除这份历史版本？删除后不可恢复。')) return;
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent='正在删除块 #'+idx+' 的历史版本...';
   fetch(ADMIN_API + '/context-compaction/history/delete',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({chunkIndex:idx,historyIndex:hi})
   }).then(function(r){return r.json()}).then(function(d){
     if(d && d.error){ if(msg) msg.textContent='删除失败: '+d.error; return; }
     const chunk=ccFindChunk(idx);
     if(chunk && chunk.history){
       chunk.history=ccRenumberHistory(chunk.history.filter(function(h,i){return i!==hi;}));
     }
     if(msg) msg.textContent='已删除一份历史版本，剩余 '+d.remaining+' 份。';
     renderCompaction();
   }).catch(function(e){
     if(msg) msg.textContent='删除失败: '+e.message;
   });
 }
 
 function toggleCcHistBody(el){
   if(!el) return;
   el.classList.toggle('expanded');
 }
 
 function toggleCcSummary(idx){
   const wasOpen=AppState.ccSummaryOpen.has(idx);
   if(wasOpen){
     AppState.ccSummaryOpen.delete(idx);
     const w=document.getElementById('cc-collapse-sum-'+idx);
     if(w){
       w.classList.remove('open');
       setTimeout(function(){ renderCompaction(); },300);
       return;
     }
   }else{
     AppState.ccSummaryOpen.add(idx);
     AppState.ccAnimateOpen.add('cc-collapse-sum-'+idx);
   }
   renderCompaction();
 }
 
 function ccSummaryValue(c){
   return (AppState.ccDraft[c.index]!==undefined)?AppState.ccDraft[c.index]:c.summary;
 }
 
 function ccFindChunk(idx){
   return ((AppState.compactionPlan && AppState.compactionPlan.chunks)||[]).find(function(x){return x.index===idx;});
 }
 
 function ccRenumberHistory(h){
   return h.map(function(x,i){ return { index:i, summary:x.summary, generatedAt:x.generatedAt, mode:x.mode, manual:x.manual }; }).slice(0,8);
 }
 
 function renderCcSummaryEditor(c, blockIndex){
   const cur=ccSummaryValue(c)||'';
   return '<div class="cc-sum-ta-wrap">'
     +'<textarea id="cc-edit-sel-'+c.index+'" rows="6" oninput="AppState.ccDraft['+c.index+']=this.value;updateCcCharCount('+c.index+')" class="cc-sum-ta">'+escHtml(cur)+'</textarea>'
     +'<button class="cc-sum-zoom" onclick="openCcEditModal('+c.index+')" title="放大编辑">放大</button>'
     +'</div>'
     +'<div class="cc-sum-editor-btns">'
     +'<span class="cc-sum-count" id="cc-edit-count-'+c.index+'">'+cur.length+' 字</span>'
     +'<button class="cc-btn primary" onclick="saveCcSummaryEdit('+c.index+')">保存</button>'
     +'<button class="cc-btn secondary" onclick="revertCcSummaryDraft('+c.index+')">还原</button>'
     +'<button class="cc-btn secondary" onclick="regenerateBlockSummary('+c.index+','+blockIndex+',\''+(c.id||'')+'\')"'+(AppState.ccBlockGenerating.has(c.index)?' disabled':'')+'>'+(AppState.ccBlockGenerating.has(c.index)?'生成中…':'重新生成')+'</button>'
     +'</div>';
 }
 
 function updateCcCharCount(idx){
   const ta=document.getElementById('cc-edit-sel-'+idx);
   const cnt=document.getElementById('cc-edit-count-'+idx);
   if(ta && cnt) cnt.textContent=ta.value.length+' 字';
 }
 
 function saveCcSummaryEdit(idx){
   const ta=document.getElementById('cc-edit-sel-'+idx);
   if(!ta) return;
   saveCcSummaryText(idx, ta.value);
 }
 
 let ccEditModalIdx=null;
 function saveCcSummaryText(idx, text){
   if(!text.trim()){ toast('摘要内容不能为空'); return; }
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent='正在保存块 #'+idx+' 的摘要修改...';
   fetch(ADMIN_API + '/context-compaction/update',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({chunkIndex:idx, id:(ccFindChunk(idx)||{}).id||'', summary:text})
   }).then(function(r){return r.json()}).then(function(d){
     if(d && d.error){ if(msg) msg.textContent='保存失败: '+d.error; return; }
     AppState.ccDraft[idx]=undefined;
     AppState.ccSummaryOpen.add(idx);
     closeModal('ccEditModal');
     ccEditModalIdx=null;
     const chunk=ccFindChunk(idx);
     const wasForce=!!(chunk&&chunk.forceReplaced);
     if(chunk){
       const cur={ summary:chunk.summary, generatedAt:chunk.generatedAt, mode:chunk.mode, manual:chunk.manual };
       chunk.history=ccRenumberHistory([cur].concat(chunk.history||[]));
       chunk.summary=text;
       chunk.generatedAt=new Date().toISOString();
       chunk.mode='edited';
       chunk.manual=true;
       chunk.cached=true;
       chunk.enabled=false; // 手写保存后回到「待替换」，与批量导入口径一致，需手动点替换才生效
       if(wasForce){
         chunk.forceReplaced=false;
       }
     }
     if(msg) msg.textContent='块 #'+idx+' 摘要已保存修改（'+d.length+' 字），已变为待替换，点块上「替换」后生效。';
     renderCompaction();
   }).catch(function(e){
     if(msg) msg.textContent='保存失败: '+e.message;
   });
 }
 
 function openCcEditModal(idx){
   const inline=document.getElementById('cc-edit-sel-'+idx);
   const ta=document.getElementById('cc-edit-modal-sel');
   if(!ta) return;
   ta.value=inline ? inline.value : (((AppState.compactionPlan.chunks||[]).find(function(x){return x.index===idx;})||{}).summary||'');
   ccEditModalIdx=idx;
   openModal('ccEditModal');
   setTimeout(function(){ ta.focus(); }, 80);
 }
 
 function closeCcEditModal(){
   const idx=ccEditModalIdx;
   if(idx!==null){
     const inline=document.getElementById('cc-edit-sel-'+idx);
     const ta=document.getElementById('cc-edit-modal-sel');
     if(inline && ta){ inline.value=ta.value; AppState.ccDraft[idx]=ta.value; }
   }
   ccEditModalIdx=null;
   closeModal('ccEditModal');
 }
 
 function saveCcEditModal(){
   const ta=document.getElementById('cc-edit-modal-sel');
   if(ccEditModalIdx===null || !ta) return;
   saveCcSummaryText(ccEditModalIdx, ta.value);
 }
 
 function revertCcSummaryDraft(idx){
   AppState.ccDraft[idx]=undefined;
   renderCompaction();
 }

 function toggleCcExpand(cidx){
   if(AppState.ccExpanded.has(cidx)) AppState.ccExpanded.delete(cidx); else AppState.ccExpanded.add(cidx);
   renderCompaction();
 }
 
 function toggleCcExpandAll(){
   const d=AppState.compactionPlan;
   if(!d || !d.chunks || !d.chunks.length) return;
   const allOpen=d.chunks.every(function(c){return AppState.ccExpanded.has(c.index);});
   d.chunks.forEach(function(c){ if(allOpen) AppState.ccExpanded.delete(c.index); else AppState.ccExpanded.add(c.index); });
   if(!allOpen) ensureCcMessages();
   renderCompaction();
 }
 
 function renderCcMessagesLazy(c){
   const sig=c.signature;
   if(c.msgs) AppState.ccMsgBySig[sig]=c.msgs;
   if(AppState.ccMsgsHtmlCache[sig]) return AppState.ccMsgsHtmlCache[sig];
   const msgs=AppState.ccMsgBySig[sig];
   if(!msgs){
     ensureCcMessages();
     return '<div style="margin-top:8px;font-size:12px;color:var(--text3)">消息加载中...</div>';
   }
   AppState.ccMsgsHtmlCache[sig]=buildCcMessagesHtml(c, msgs, false); // AI 块/手工块都显示标星
   return AppState.ccMsgsHtmlCache[sig];
 }
 
 function ensureCcMessages(){
   if(AppState.ccMsgFetchDone || AppState.ccMsgFetching) return;
   AppState.ccMsgFetching=true;
   fetch(ADMIN_API + '/context-compaction/preview?includeMessages=1&excludeGapMsgs=1').then(function(r){return r.json()}).then(function(d){
     AppState.ccMsgFetching=false;
     AppState.ccMsgFetchDone=true;
     (d.chunks||[]).forEach(function(c){ if(c.msgs) AppState.ccMsgBySig[c.signature]=c.msgs; });
     (d.uncovered&&d.uncovered.gaps||[]).forEach(function(g){
       const k=(g.startIdx||0)+'-'+(g.endIdx||0);
       if(g.msgs) AppState.ccGapMsgByKey[k]=g.msgs;
       const ms=g.msgs||[];
       AppState.ccGapTimeByKey[k]={startTime:g.startTime||(ms.length?ms[0].time:''), endTime:g.endTime||(ms.length?ms[ms.length-1].time:'')};
     });
     renderCompaction();
   }).catch(function(){
     AppState.ccMsgFetching=false;
   });
 }
 
 function resetCcMsgCache(){
   AppState.ccMsgBySig={};
   AppState.ccGapMsgByKey={};
   AppState.ccGapTimeByKey={};
   AppState.ccGapPageOffset={};
   AppState.ccGapHasMore={};
   AppState.ccGapLoadingKey=null;
   AppState.ccMsgsHtmlCache={};
   AppState.ccMsgFetching=false;
   AppState.ccMsgFetchDone=false;
 }
 
 function buildCcMessagesHtml(c, msgs, noMark){
   if(!msgs.length) return '<div style="margin-top:8px;font-size:12px;color:var(--text3)">（该块无可展开内容）</div>';
   const baseNum=(typeof c.blockStart==='number'&&c.blockStart>=0)?c.blockStart:((typeof c.firstIdx==='number'&&c.firstIdx>=0)?c.firstIdx:null);
   let html='<div class="cc-msg-list" id="cc-msg-scroll-'+c.index+'">';
   msgs.forEach(function(m,i){
     const marked=!!m.marked;
     const num=(m&&('num' in m))?((typeof m.num==='number'&&m.num>=0)?(m.num+1):null):(baseNum===null?null:(baseNum+i+1));
     html+='<div class="cc-msg-item'+(marked?' marked':'')+'">'
       +'<div class="cc-msg-head">'
       +'<span class="cc-msg-left">'
       +'<span class="cc-role '+(m.role==='user'?'cc-role-she':'cc-role-me')+'">'+(m.role==='user'?'她':'我')+'</span>'
       +(num!==null?'<span class="cc-msg-num">#'+num+'</span>':'')
       +'</span>'
       +'<span class="cc-msg-right">'
       +(m.time?'<span class="cc-msg-time">'+escHtml(m.time)+'</span>':'')
       +(noMark?'':'<button class="cc-msg-mark'+(marked?' on':'')+'" onclick="toggleCcMark('+c.index+','+i+')" title="标星：压缩后以原句保留，不被摘要覆盖" aria-pressed="'+(marked?'true':'false')+'" aria-label="标星此消息">'+(marked?'★':'☆')+'</button>')
       +'</span>'
       +'</div>'
       +'<div class="cc-msg-body">'+escHtml(m.content)+'</div>'
       +'</div>';
   });
   html+='</div>';
   return html;
 }
/**
 * 压缩预览内标星/取消标星：调用 mark 接口成功后更新内存态并整块重绘。
 * @param {number} cidx 块 index
 * @param {number} i 消息在块内序号
 */
 
 function toggleCcMark(cidx, i){
   const c=(AppState.compactionPlan.chunks||[]).find(function(x){return x.index===cidx;});
   if(!c) return;
   const msgs=c.msgs||AppState.ccMsgBySig[c.signature];
   if(!msgs || !msgs[i]) return;
   const m=msgs[i];
   const next=!m.marked;
   fetch(ADMIN_API + '/context-compaction/mark',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({key:m.key, marked:next})
   }).then(function(r){return r.json()}).then(function(d){
     if(d && d.error){ alert('标记失败: '+d.error); return; }
     m.marked=next;
     if(AppState.ccMsgsHtmlCache[c.signature]) delete AppState.ccMsgsHtmlCache[c.signature];
     renderCompaction();
   }).catch(function(e){ alert('标记失败: '+e.message); });
 }
 
 // 压缩块左滑显示「移除」
 // 判断块是否处于任意展开状态（块本体 / 原文 / 摘要，只要有任一展开即禁止左滑）
 function isCcChunkExpanded(w){
   if(!w) return true;
   const cid=Number((w.getAttribute('data-cid')||'').trim());
   if(!isNaN(cid) && AppState.ccExpanded.has(cid)) return true;
   if(w.querySelector('.cc-collapse.open')) return true;
   if(w.querySelector('.cc-msg-list')) return true;
   return false;
 }
 document.addEventListener('touchstart',function(e){
   const w=e.target.closest?e.target.closest('.cc-chunk-swipe'):null;
   if(!w) return;
   // 已隐藏块不参与左滑移除（其正文/移除按钮均不渲染）
   if(w.querySelector('.cc-chunk-hidden')) return;
   // 块展开时禁止左滑（只有收起时才允许滑出“移除”按钮）
   if(isCcChunkExpanded(w)){ w.classList.remove('swiped'); return; }
   document.querySelectorAll('.cc-chunk-swipe.swiped').forEach(function(x){ if(x!==w) x.classList.remove('swiped'); });
   const t=e.touches[0];
   AppState.ccSwipeState={x:t.clientX,y:t.clientY,w:w,dx:0};
 },{passive:true});
 document.addEventListener('touchmove',function(e){
   if(!AppState.ccSwipeState) return;
   const t=e.touches[0];
   AppState.ccSwipeState.dx=t.clientX-AppState.ccSwipeState.x;
   const dy=t.clientY-AppState.ccSwipeState.y;
   // 已展开的块不再响应左滑（防误触），也不拦截纵向滚动
   if(AppState.ccSwipeState.w.classList.contains('swiped') && AppState.ccSwipeState.dx<0) return;
   if(Math.abs(AppState.ccSwipeState.dx)>Math.abs(dy)&&Math.abs(AppState.ccSwipeState.dx)>10) e.preventDefault();
 },{passive:false});
 document.addEventListener('touchend',function(){
   if(!AppState.ccSwipeState) return;
   const s=AppState.ccSwipeState; AppState.ccSwipeState=null;
   const alreadySwiped=s.w.classList.contains('swiped');
   if(alreadySwiped){
     // 已展开：只响应右滑收回，左滑不响应（防误触）
     if(s.dx>40) s.w.classList.remove('swiped');
     return;
   }
   if(s.dx<-40) s.w.classList.add('swiped');
   else if(s.dx>40) s.w.classList.remove('swiped');
 });
 
 window.addEventListener('scroll',function(){
   const b=document.getElementById('backTopBtn');
   if(!b)return;
   const y=(window.pageYOffset!==undefined)?window.pageYOffset:(document.documentElement.scrollTop||0);
   if(y>window.innerHeight*0.8)b.classList.add('show');
   else b.classList.remove('show');
 });
 function scrollToTop(){
   window.scrollTo({top:0,behavior:'smooth'});
 }
 (function(){
   const b=document.getElementById('backTopBtn');
   if(!b)return;
   b.addEventListener('keydown',function(e){
     if(e.key==='Enter'||e.key===' '){ e.preventDefault(); scrollToTop(); }
   });
 })();
 function resizeChatFrame(){
   const f=document.getElementById('chatFrame');
   const wrap=document.querySelector('#tab-chat .chat-embed-wrap');
   if(!f)return;
   // 用 JS 拿真实可用高度：窗口高度 - 底部 tab-bar
   const win=window.innerHeight || document.documentElement.clientHeight;
   const tabbar=document.querySelector('.tab-bar');
   let tabH=0;
   if(tabbar){ tabH=tabbar.offsetHeight || 68; }
   // 顶部 header 在移动端是 display:none，offsetHeight 为 0，不影响
   const h=Math.max(200, win - tabH);
   // 优先设置外层容器高度，iframe 用 CSS 100% 继承，避免二者不一致
   if(wrap){ wrap.style.height=h+'px'; }
   f.style.height='100%';
 }
 // iframe 每次 onload 后也重算高度（内容变化/横竖屏）
 window.addEventListener('orientationchange',()=>{ if(document.getElementById('tab-chat')&&document.getElementById('tab-chat').classList.contains('active')) setTimeout(resizeChatFrame,120); });
 window.addEventListener('resize',()=>{ if(document.getElementById('tab-chat')&&document.getElementById('tab-chat').classList.contains('active')) setTimeout(resizeChatFrame,120); });

 function switchTab(name){
   try{localStorage.setItem('adminTab',name)}catch(e){}
   // 2026-09-27 悬浮球（生成日志）仅压缩页显示：其他 tab 隐藏并关闭日志面板
   const fab=document.getElementById('logFab');
   if(fab) fab.style.display=(name==='compaction')?'':'none';
   if(name!=='compaction' && AppState.logPanelOpen) closeLogPanel();
   document.querySelectorAll('.tab-content').forEach(el=>el.classList.remove('active'));
   document.querySelectorAll('.tab-item').forEach(el=>el.classList.remove('active'));
   document.getElementById('tab-'+name).classList.add('active');
   document.querySelector('.tab-item[data-tab="'+name+'"]').classList.add('active');
  if(name==='memory'){ if(!window.__memPoolInited){ initMemPoolView(); window.__memPoolInited=true; } loadReviewQueue(); }
  if(name!=='config' && typeof stopBackfillWatch==='function'){ stopBackfillWatch(); }
  if(name==='compaction'){ if(!AppState.compactionPlan || !AppState.ccPreviewLoadedAt || Date.now()-AppState.ccPreviewLoadedAt>15000){ loadCompactionPreview(); } else { renderCompaction(); } if(AppState.compactionPlan) renderCompactionConfig(); }
  if(name==='prompts'){loadWakePrompt();loadContextDigestPrompt();loadCompactionPrompt();loadCtxLimitPrompt();loadReparsePrompt();loadJudgePrompt();loadDistillPrompt();loadSummaryPrompt();loadBackfillPrompt();}
  if(name==='config'){loadToolsConfig(); loadCrossInjectConfig();
    // 1003：记忆蒸馏 / 两块总结 / 老数据重跑三张设置卡已搬到本页（跨窗口注入卡片下方）。
    // 三个 load 原本挂在 initMemPoolView（只跑一次且必须先进记忆页才触发），搬走后若从配置页直接进来会加载不到 → 输入框全空。
    loadDistillConfig(); loadSummaryConfig(); loadBackfillConfig();
    // 2026-10-01 修复：压缩参数配置卡在配置 tab，但值依赖压缩预览先加载——原加载链只在压缩 tab/换会话/压缩操作后触发，
    // 直接进配置 tab（含刷新后恢复停留在配置 tab）时 preview 从未拉取，十二个输入框静默全空
    if(!AppState.compactionPlan || !AppState.ccPreviewLoadedAt || Date.now()-AppState.ccPreviewLoadedAt>15000){ loadCompactionPreview(); } else { renderCompactionConfig(); }
  }
  }
 
   function renderPushLog(d){
    const items=d.items||[];
    window.__pushItems=items;
    const st=document.getElementById('push-log-info');
    if(st) st.textContent='共 '+items.length+' 条（最新在前）';
    const el=document.getElementById('push-log-list');
    if(!el)return;
    if(!items.length){ el.innerHTML='<div class="empty">暂无推送记录（AI 推送后会记录到时间线）</div>'; return; }
    let html='';
    items.forEach(function(it){
      let t='';
      try{ if(it.at) t=new Date(String(it.at).replace(' ','T')+':00+08:00').toLocaleString('zh-CN',{hour12:false}); }catch(e){}
      const isWake=it.sent===false;
      const dotBg=isWake?'#e67e22':'#34495e';
      const sessLabel = escapeHtml(it.session_id || 'default');
      html+='<div class="push-item" data-push-pos="'+it.position+'" data-push-session="'+escapeHtml(it.session_id||'default')+'">'
        +'<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
        +'<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text2);font-weight:600"><i style="width:8px;height:8px;border-radius:50%;background:'+dotBg+';display:inline-block;flex-shrink:0"></i>'+escapeHtml(it.channel||'bark')+'</span>'
        +'<span style="display:inline-block;padding:1px 6px;font-size:10px;background:var(--bg2);color:var(--text3);border-radius:4px;flex-shrink:0">'+sessLabel+'</span>'
        +'<span style="font-size:11px;color:var(--text3);flex:1;min-width:0">'+escapeHtml(t)+'</span>'
        +'<span style="display:flex;gap:6px;flex-wrap:nowrap;flex-shrink:0">'
        +(isWake?'':'<button class="btn btn-outline" style="width:auto;flex:0 0 auto;padding:2px 8px;font-size:11px;min-height:0" onclick="openPushEdit(\''+it.position+'\')">编辑</button>')
        +'<button class="btn btn-outline push-del-btn" type="button" style="width:auto;flex:0 0 auto;padding:2px 8px;font-size:11px;min-height:0;color:#c0392b;border-color:#c0392b" onclick="deletePushEvent(\''+it.position+'\')">删除</button>'
        +'</span>'
        +'</div>'
        +'<div class="push-item-title" style="margin:8px 0 0;font-size:13px;color:var(--text2)"><b>'+escapeHtml(it.title||'')+'</b></div>'
        +'<div class="push-item-body" style="margin:0 0 4px;font-size:12px;color:var(--text2);white-space:pre-wrap;word-break:break-all">'+escapeHtml(it.body||'')+'</div>'
        +'</div>';
    });
    el.innerHTML=html;
  }
  function findPushItem(pos){ return (window.__pushItems||[]).find(function(x){ return String(x.position)===String(pos); }); }
  function deletePushEvent(pos){
    const it=findPushItem(pos);
    if(!it){ toast('未找到该记录'); return; }
    if(!confirm('确定删除这条推送？会直接从时间线移除，不可恢复。')) return;
    fetch(ADMIN_API+'/push-events/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({position:Number(pos),content:it.content,session_id:it.session_id||'default'})})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.error){ toast('删除失败: '+d.error); return; }
        const card=document.querySelector('.push-item[data-push-pos="'+String(pos)+'"]');
        if(card) card.remove();
        const items=(window.__pushItems||[]).filter(function(x){ return String(x.position)!==String(pos); });
        window.__pushItems=items;
        const st=document.getElementById('push-log-info'); if(st) st.textContent='共 '+items.length+' 条（最新在前）';
        toast('已删除');
      })
      .catch(function(e){ toast('网络错误: '+e.message); });
  }
  function openPushEdit(pos){
    const it=findPushItem(pos);
    if(!it){ toast('未找到该记录'); return; }
    window.__pushEditPos=it.position;
    const t=document.getElementById('push-edit-title'); if(t) t.value=it.title||'';
    const b=document.getElementById('push-edit-body'); if(b) b.value=it.body||'';
    const mt=document.getElementById('push-modal-title'); if(mt) mt.textContent='编辑推送';
    openModal('pushEditModal');
  }
  async function savePushEdit(){
    const pos=window.__pushEditPos;
    if(pos==null){ toast('记录不存在'); return; }
    const it=findPushItem(pos);
    if(!it){ toast('记录不存在'); return; }
    const title=document.getElementById('push-edit-title').value.trim();
    const body=document.getElementById('push-edit-body').value.trim();
    if(!body){ toast('内容不能为空'); return; }
    try{
      const r=await fetch(ADMIN_API+'/push-events/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({position:Number(pos),content:it.content,title:title,body:body,session_id:it.session_id||'default'})});
      const d=await r.json();
      if(d.error){ toast('保存失败: '+d.error); return; }
      const card=document.querySelector('.push-item[data-push-pos="'+String(pos)+'"]');
      if(card){
        const tEl=card.querySelector('.push-item-title b'); if(tEl) tEl.textContent=title;
        const bEl=card.querySelector('.push-item-body'); if(bEl) bEl.textContent=body;
      }
      const items=window.__pushItems||[];
      const idx=items.findIndex(function(x){ return String(x.position)===String(pos); });
      if(idx>=0 && d.entry){ items[idx].title=d.entry.title||title; items[idx].body=d.entry.body||body; items[idx].content=d.entry.content; }
      toast('已保存');
      closeModal('pushEditModal');
    }catch(e){ toast('网络错误: '+e.message); }
  }

 
 let logsRefreshTimer = null;
 
 
 async function loadWakePrompt(){
   const el=document.getElementById('wake-prompt-edit');
   if(!el)return;
   try{
     const r=await fetch(ADMIN_API + '/logs/wake-prompt');
     const j=await r.json();
     el.value=j.text||'';
   }catch(e){el.value='加载失败'}
 }
 
 async function saveWakePrompt(){
   const el=document.getElementById('wake-prompt-edit');
   const text=el.value;
   if(!text.trim()){toast('内容不能为空');return}
   try{
     const r=await fetch(ADMIN_API + '/logs/wake-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
     const j=await r.json();
     if(j.ok) toast('已保存，下次唤醒生效');
     else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }

 // 摘要整理提示词（context_digest 工具）
 async function loadContextDigestPrompt(){
   const el=document.getElementById('context-digest-prompt-edit');
   if(!el)return;
   try{
     const r=await fetch(ADMIN_API + '/logs/context-digest-prompt');
     const j=await r.json();
     el.value=j.text||'';
   }catch(e){el.value='加载失败'}
 }

 async function saveContextDigestPrompt(){
   const el=document.getElementById('context-digest-prompt-edit');
   const text=el.value;
   if(!text.trim()){toast('内容不能为空');return}
   try{
     const r=await fetch(ADMIN_API + '/logs/context-digest-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
     const j=await r.json();
     if(j.ok) toast('已保存，下次调用即生效');
     else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }

 async function resetContextDigestPrompt(){
   if(!confirm('确定恢复默认摘要整理提示词？自定义模板会被删除。'))return;
   try{
     const r=await fetch(ADMIN_API + '/logs/context-digest-prompt',{method:'DELETE'});
     const j=await r.json();
     if(j.ok){ toast('已恢复默认'); loadContextDigestPrompt(); }
     else toast('操作失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }
 
 
 // 压缩上下文提示词
 async function loadCompactionPrompt(){
   const se=document.getElementById('cc-prompt-system-edit');
   const pe=document.getElementById('cc-prompt-edit');
   if(!se||!pe)return;
   try{
     const r=await fetch(ADMIN_API + '/logs/compaction-prompt');
     const j=await r.json();
     se.value=j.system||'';
     pe.value=j.template||j.prompt||'';
   }catch(e){se.value='加载失败';pe.value=''}
 }
 
 async function saveCompactionPrompt(){
   const se=document.getElementById('cc-prompt-system-edit');
   const pe=document.getElementById('cc-prompt-edit');
   if(!pe.value.trim()){toast('模板不能为空');return}
   try{
     const r=await fetch(ADMIN_API + '/logs/compaction-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({system:se.value,template:pe.value})});
     const j=await r.json();
     if(j.ok) toast('已保存，生成压缩摘要时生效');
     else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }
 
 async function resetCompactionPrompt(){
   if(!confirm('恢复默认压缩上下文提示词？'))return;
   try{
     const r=await fetch(ADMIN_API + '/logs/compaction-prompt',{method:'DELETE'});
     const j=await r.json();
     if(j.ok){toast('已恢复默认');loadCompactionPrompt();}
     else toast('失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }
 
 // 容量提醒提示词（会话超上限时塞给 AI 的整条隐藏提醒；独立配置）
 async function loadCtxLimitPrompt(){
   const pe=document.getElementById('ctx-limit-prompt-edit');
   if(!pe)return;
   try{
     const r=await fetch(ADMIN_API + '/context-compaction/ctx-limit-prompt');
     const j=await r.json();
     pe.value=j.template||'';
   }catch(e){pe.value='加载失败'}
 }

 async function saveCtxLimitPrompt(){
   const pe=document.getElementById('ctx-limit-prompt-edit');
   if(!pe)return;
   if(!pe.value.trim()){toast('提示词不能为空');return}
   try{
     const r=await fetch(ADMIN_API + '/context-compaction/ctx-limit-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({template:pe.value})});
     const j=await r.json();
     if(j.ok){pe.value=j.template;toast('已保存，下次触发容量提醒即生效')}
     else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }

 async function resetCtxLimitPrompt(){
   if(!confirm('恢复默认容量提醒提示词？'))return;
   try{
     const r=await fetch(ADMIN_API + '/context-compaction/ctx-limit-prompt',{method:'DELETE'});
     const j=await r.json();
     if(j.ok){toast('已恢复默认');loadCtxLimitPrompt()}
     else toast('失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }

 // 后台页板块折叠
 function toggleCard(header){
   const card=header.closest('.card');
   if(!card)return;
   const id=card.getAttribute('data-collapse-id');
   const nowCollapsed=card.classList.contains('collapsed');
   card.classList.toggle('collapsed',!nowCollapsed);
   if(id){try{localStorage.setItem('card-collapse-'+id,nowCollapsed?'open':'collapsed')}catch(e){}}
   if(header && header.setAttribute) header.setAttribute('aria-expanded', nowCollapsed ? 'true' : 'false');
   // 展开时拉取最新（折叠→展开瞬间 nowCollapsed=true）
 }
 // 全局H2：问号图标说明弹窗（收集卡片内 .hint-body）
 function showHintCard(el){
   const card=el.closest('.card'); if(!card)return;
   const parts=Array.prototype.slice.call(card.querySelectorAll('.hint-body')).map(function(n){return n.innerHTML;});
   const titleEl=card.querySelector('.card-title span');
   document.getElementById('hintModalTitle').textContent=(titleEl?titleEl.textContent:'说明')+' · 说明';
   const body=document.getElementById('hintModalBody');
   body.innerHTML=parts.length?parts.join('<div style="border-top:1px solid var(--border);margin:8px 0"></div>'):'（无说明）';
   openModal('hintModal');
 }
 function showHintText(el,title,text){
   document.getElementById('hintModalTitle').textContent=title||'说明';
   document.getElementById('hintModalBody').textContent=text||'';
   openModal('hintModal');
 }
 
 function initCollapsibleCards(){
   document.querySelectorAll('.tab-content .card[data-collapse-id]').forEach(function(card){
     const id=card.getAttribute('data-collapse-id');
     const def=card.getAttribute('data-default')||'collapsed';
     let state=null;
     try{state=localStorage.getItem('card-collapse-'+id)}catch(e){}
     const collapsed=state? (state==='collapsed') : (def!=='open');
     card.classList.toggle('collapsed',collapsed);
     const header=card.querySelector('.card-title');
     if(header){
       header.setAttribute('role','button');
       header.setAttribute('tabindex','0');
       header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
       header.addEventListener('keydown',function(e){
         if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleCard(header); }
       });
     }
   });
 }
 
 
 async function undoContextReplacement(id){
   if(!confirm('撤销这条替换后，发送给 AI 的上下文将恢复为原始对话（源文件本来就没动）。确定撤销？'))return;
   try{
     const r=await fetch(ADMIN_API + '/context-replacements/undo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})});
     const j=await r.json();
     if(!j.ok){toast('撤销失败: '+(j.error||''));return}
     toast('已撤销');
     loadCompactionPreview();
   }catch(e){toast('网络错误')}
 }
 
 // ============ 工具集 + 服务管理 ============
 const escHtml2 = escapeHtml; // V10 收敛：原五字符重复实现已删（与 escapeHtml 逐字符等价）
 
 async function loadToolsConfig(){
   const el=document.getElementById('tools-list');
   if(!el)return;
   try{
     const r=await fetch(ADMIN_API + '/tools');
     const j=await r.json();
     if(j.error){el.innerHTML='<span class="empty">加载失败: '+escHtml2(j.error)+'</span>';return}
     AppState.toolsDraft=j;
     const tEl=document.getElementById('tools-manifest-time');
     if(tEl) tEl.textContent = j.manifest && j.manifest.generated_at ? ('清单生成于 '+j.manifest.generated_at) : '';
     if(!j.manifest){
       el.innerHTML='<div class="empty">'+escHtml2(j.note||'工具清单还没生成')+'</div>';
       return;
     }
     const disabled=new Set((j.config&&j.config.disabled)||[]);
     const descs=(j.config&&j.config.descriptions)||{};
     const schemas=(j.config&&j.config.schemas)||{};
     const tools=(j.manifest.tools||[]).slice().sort(function(a,b){return (a.enabled===b.enabled)?(a.name<b.name?-1:1):(a.enabled?-1:1)});
     let html='';
     tools.forEach(function(t){
       const on=!disabled.has(t.name);
       const descVal=descs[t.name]!==undefined?descs[t.name]:t.description;
       const overridden=descs[t.name]!==undefined;
       const schemaStr=JSON.stringify(schemas[t.name]!==undefined?schemas[t.name]:t.inputSchema,null,1);
       html+='<div class="tool-item collapsed'+(on?'':' off')+'">'
         +'<div class="tool-head-line" onclick="toggleToolItem(this)">'
         +'<span class="tool-arrow">▾</span>'
         +'<span class="tool-dot '+(on?'on':'off')+'" title="'+(on?'运行中可见':'当前已停用')+'"></span>'
         +'<b class="tool-name">'+escHtml2(t.name)+'</b>'
         +'<label class="tool-switch-wrap" onclick="event.stopPropagation()" title="启用/停用"><span class="switch tool-switch tool-switch-sm"><input type="checkbox" data-tool="'+escHtml2(t.name)+'" class="tools-enable" '+(on?'checked':'')+'><span class="slider"></span></span></label>'
         +'</div>'
         +'<div class="tool-body">'
         +'<div class="tool-field-label">说明'+(overridden?' <span style="color:#c89098">（已自定义）</span>':'')+'</div>'
         +'<textarea data-desc="'+escHtml2(t.name)+'" rows="2" class="tool-ta tool-desc-ta">'+escHtml2(descVal)+'</textarea>'
         +'<div class="tool-schema-label">参数定义（JSON，可改）<button class="tool-copy-btn" onclick="copyToolSchema(this)">复制</button></div>'
         +'<textarea data-schema="'+escHtml2(t.name)+'" rows="6" class="tool-ta tool-schema-ta">'+escHtml2(schemaStr)+'</textarea>'
         +'<div style="display:flex;justify-content:flex-end;margin-top:8px">'
         +'<button class="cc-btn primary" onclick="saveOneTool(\''+escJsStr(t.name)+'\')" style="flex:0 0 auto;padding:7px 14px;font-size:12px">保存这个工具</button>'
         +'</div>'
         +'</div>'
         +'</div>';
     });
     el.innerHTML='<div class="tool-count">共 <b>'+tools.length+'</b> 个工具</div>'+html;
     el.querySelectorAll('textarea[data-desc]').forEach(function(ta){
       const item=ta.closest('.tool-item');
       const hidden=item?item.classList.contains('collapsed'):false;
       if(hidden)item.classList.remove('collapsed');
       ta.style.height='auto';
       ta.style.height=ta.scrollHeight+'px';
       if(hidden)item.classList.add('collapsed');
       ta.addEventListener('input',function(){
         ta.style.height='auto';
         ta.style.height=ta.scrollHeight+'px';
       });
     });
   }catch(e){el.innerHTML='<span class="empty">网络错误</span>'}
 }
 
 function toggleToolItem(head){
   const item=head.closest('.tool-item');
   if(!item) return;
   item.classList.toggle('collapsed');
   if(!item.classList.contains('collapsed')){
     const ta=item.querySelector('textarea[data-desc]');
     if(ta)requestAnimationFrame(function(){
       ta.style.height='auto';
       ta.style.height=ta.scrollHeight+'px';
     });
   }
 }
 
 function copyToolSchema(btn){
   const item=btn.closest('.tool-item');
   const ta=item?item.querySelector('textarea[data-schema]'):null;
   if(!ta) return;
   btn.textContent='复制中';
   ta.focus();
   ta.select();
   ta.setSelectionRange(0,ta.value.length);
   let ok=false;
   try{ ok=document.execCommand('copy'); }catch(e){ ok=false; }
   btn.textContent=ok?'已复制':'复制失败';
   if(ta.setSelectionRange) ta.setSelectionRange(0,0);
   setTimeout(function(){ if(btn.parentNode) btn.textContent='复制'; },1600);
 }
 
  
  // 键序无关的深度相等比较（判断工具参数 JSON 是否真被修改，避免无谓覆盖）
 function jsonEq(a, b) {
   function sortKeys(o) {
     if (Array.isArray(o)) return o.map(sortKeys);
     if (o && typeof o === 'object') {
       const r = {};
       Object.keys(o).sort().forEach(function (k) { r[k] = sortKeys(o[k]); });
       return r;
     }
     return o;
   }
   return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
 }
 
 // 收集页面当前完整状态：停用列表 + 所有与源码默认不同的说明/参数覆盖
 function collectToolsState() {
   const disabled = [], descriptions = {}, schemas = {};
   const tlist = (AppState.toolsDraft && AppState.toolsDraft.manifest && AppState.toolsDraft.manifest.tools) || [];
   const cfg = (AppState.toolsDraft && AppState.toolsDraft.config) || {};
   const cfgDesc = cfg.descriptions || {};
   const cfgSchemas = cfg.schemas || {};
   tlist.forEach(function (t) {
     const cb = document.querySelector('#tools-list input.tools-enable[data-tool="' + t.name + '"]');
     if (cb && !cb.checked) disabled.push(t.name);
     const descTa = document.querySelector('#tools-list textarea[data-desc="' + t.name + '"]');
     if (descTa) {
       const val = descTa.value.trim();
       const def = (t.defaultDescription !== undefined) ? t.defaultDescription : t.description;
       if (val !== def) descriptions[t.name] = val;
       else if (cfgDesc[t.name] !== undefined) descriptions[t.name] = null; // 明确清除旧覆盖
     }
     const schemaTa = document.querySelector('#tools-list textarea[data-schema="' + t.name + '"]');
     if (schemaTa) {
       const val = schemaTa.value.trim();
       const def = (t.defaultInputSchema !== undefined) ? t.defaultInputSchema : t.inputSchema;
       if (!val) {
         if (cfgSchemas[t.name] !== undefined) schemas[t.name] = null;
         return;
       }
       try {
         const obj = JSON.parse(val);
         if (!jsonEq(obj, def)) schemas[t.name] = obj;
         else if (cfgSchemas[t.name] !== undefined) schemas[t.name] = null;
       } catch (e) { /* 由调用方统一校验提示 */ }
     }
   });
   return { disabled: disabled, descriptions: descriptions, schemas: schemas };
 }
 
 async function saveToolsConfig(scopeName) {
   if (!AppState.toolsDraft) return;
   const msg = document.getElementById('tools-msg');
   if (!msg) return;
   const label = scopeName ? '「' + scopeName + '」' : '全部改动';
   msg.textContent = '保存中...';
   try {
     // 先校验所有参数 JSON，格式不对就整次不保存
     let bad = null;
     document.querySelectorAll('#tools-list textarea[data-schema]').forEach(function (ta) {
       if (bad) return;
       const val = ta.value.trim();
       if (!val) return;
       try { JSON.parse(val); } catch (e) { bad = ta.getAttribute('data-schema'); }
     });
     if (bad) { msg.textContent = '⚠️ 工具 ' + bad + ' 的参数 JSON 格式不对，未保存'; return; }
     const state = collectToolsState();
     const r = await fetch(ADMIN_API + '/tools', {
       method: 'PUT',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(state)
     });
     const j = await r.json();
     if (j.error) { msg.textContent = '保存失败: ' + j.error; return; }
     msg.textContent = '已保存 ' + label + ' ✓（即时生效）';
     loadToolsConfig();
   } catch (e) { msg.textContent = '网络错误'; }
 }
 
 function saveOneTool(name) {
   saveToolsConfig(name);
 }
 
 async function loadServices(){
   const el=document.getElementById('services-list');
   if(!el)return;
   try{
     const r=await fetch(ADMIN_API + '/services');
     const j=await r.json();
     const list=(j&&j.services)||[];
     if(!list.length){el.innerHTML='<div class="empty">暂无服务</div>';return}
     el.innerHTML=list.map(function(s){
       const cls=s.status==='running'||s.status==='online'?'green':(s.status==='stopped'||s.status==='errored'?'red':'yellow');
       return '<div class="svc-row">'
         +'<div class="svc-left">'
         +'<span class="svc-dot '+cls+'"></span>'
         +'<div style="min-width:0;flex:1">'
         +'<div class="svc-name">'+escHtml2(s.label)+'</div>'
         +'<div class="svc-status '+cls+'">'+escHtml2(s.status)+'</div>'
         +'</div></div>'
         +'<div class="svc-actions">'
         +'<button class="svc-btn start" onclick="serviceAction(\''+escJsStr(s.name)+'\',\'start\')">启动</button>'
         +'<button class="svc-btn stop" onclick="serviceAction(\''+escJsStr(s.name)+'\',\'stop\')">停止</button>'
         +'<button class="svc-btn restart" onclick="serviceAction(\''+escJsStr(s.name)+'\',\'restart\')">重启</button>'
         +'</div></div>';
     }).join('');
   }catch(e){el.innerHTML='<span class="empty">网络错误</span>'}
 }
 
 async function serviceAction(name, action){
   if(!confirm('确认对「'+name+'」执行「'+action+'」？'))return;
   try{
     const r=await fetch(ADMIN_API + '/services/'+encodeURIComponent(name)+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'}});
     const j=await r.json();
     if(j && j.error) toast('执行失败: '+j.error);
     else if(j && j.output) toast('已'+action+' · '+(j.status||'')+': '+String(j.output).slice(0,80));
     else toast('已执行 '+action);
     loadServices();
   }catch(e){ toast('网络错误: '+e.message); }
 }

 
 let _llmCtxLoaded=false; // 是否已加载过一次(懒加载守卫)
 let _llmCtxInflight=false; // 防止并发重复请求
 let ctxLongTexts={}; // 超长消息全文暂存，点击「展开全文」时换入

 // 点击「展开全文」把超长消息全文换入（全文已转义，直接当 HTML 写入）
 function expandCtxText(key,link){
   const full=ctxLongTexts[key];
   const div=link&&link.parentNode;
   if(div&&full){ div.innerHTML=full; delete ctxLongTexts[key]; }
 }
 
 
 
 
 // ============ 记忆词云卡片 ============
 let cloudWord='';
 function switchMemView(v){
  AppState.memView=v;
  closeCloudDrawer();
  const cloud=document.getElementById('mem-cloud-wrap');
  const mempool=document.getElementById('mem-mempool-wrap');
  if(cloud)cloud.style.display=v==='cloud'?'':'none';
  if(mempool)mempool.style.display=v==='mempool'?'':'none';
  const styleBtn=function(id,active){
    const b=document.getElementById(id);
    if(b)b.classList.toggle('active',active);
  };
  styleBtn('mem-view-cloud',v==='cloud');
  styleBtn('mem-view-mempool',v==='mempool');
  if(v==='cloud')loadMemCloud();
  else if(v==='mempool')initMemPoolView();
 }
   // ============ 记忆蒸馏配置（1002 记忆改造 §8 3.1：定时开关 / 时间 / 批次 / 立即跑一次） ============
  async function loadDistillConfig(){
    const msg=document.getElementById('distill-config-msg');
    try{
      const r=await fetch(ADMIN_API+'/memory-distill/config');
      const c=await r.json();
      if(c.error){ if(msg) msg.textContent='读取失败: '+c.error; return; }
      const en=document.getElementById('distill-enabled'); if(en) en.checked=!!c.enabled;
      const tm=document.getElementById('distill-time'); if(tm) tm.value=c.time||'03:00';
      const bs=document.getElementById('distill-batch-size'); if(bs) bs.value=(c.batch_size!=null?c.batch_size:5);
      if(msg){
        if(c.last_run_at){
          const lr=c.last_run_result||{};
          let tail='';
          if(lr.error) tail='（失败：'+lr.error+'）';
          else if(lr.note) tail='（'+lr.note+'）';
          else tail='（候选 '+(lr.candidates||0)+' 条 / 进待审 '+(lr.queued||0)+' 条）';
          msg.textContent='上次运行：'+new Date(c.last_run_at).toLocaleString('zh-CN')+tail;
        } else msg.textContent='还没跑过。';
      }
    }catch(e){ if(msg) msg.textContent='读取失败: '+e.message; }
  }
  async function saveDistillConfig(){
    const msg=document.getElementById('distill-config-msg');
    if(msg) msg.textContent='保存中...';
    const en=document.getElementById('distill-enabled');
    const tm=document.getElementById('distill-time');
    const bs=document.getElementById('distill-batch-size');
    const payload={
      enabled: en?!!en.checked:false,
      time: (tm&&tm.value)||'03:00',
      batch_size: Math.max(1, Number(bs&&bs.value)||5)
    };
    if(!/^\d{1,2}:\d{2}$/.test(payload.time)){ if(msg) msg.textContent='时间格式不对（应为 HH:MM）'; toast('时间格式不对'); return; }
    try{
      const r=await fetch(ADMIN_API+'/memory-distill/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='保存失败: '+d.error; toast('保存失败: '+d.error); return; }
      if(msg) msg.textContent='已保存：'+(d.enabled?('每天 '+d.time+' 自动蒸馏，每批 '+d.batch_size+' 篇'):'自动蒸馏已关闭（仍可点「立即跑一次」手动跑')+'。';
      toast('蒸馏设置已保存');
    }catch(e){ if(msg) msg.textContent='保存失败: '+e.message; toast('保存失败: '+e.message); }
  }
  async function runDistillNow(){
    const btn=document.getElementById('distill-run-btn');
    const msg=document.getElementById('distill-config-msg');
    if(btn){ btn.disabled=true; btn.textContent='运行中…'; }
    if(msg) msg.textContent='正在跑一次蒸馏…';
    try{
      const r=await fetch(ADMIN_API+'/memory-distill/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='跑失败: '+d.error; toast('跑失败: '+d.error); }
      else{
        const tail=d.note||('候选 '+(d.candidates||0)+' 条 / 进待审 '+(d.queued||0)+' 条');
        if(msg) msg.textContent='已完成：'+tail+'（用时 '+Math.round((d.durationMs||0)/1000)+'s）';
        toast('蒸馏跑完一次');
      }
      loadDistillConfig();
    }catch(e){ if(msg) msg.textContent='跑失败: '+e.message; toast('跑失败: '+e.message); }
    finally{ if(btn){ btn.disabled=false; btn.textContent='立即跑一次'; } }
  }

  // ============ 两块总结配置（1002 记忆改造 §8 6.5：Core Identity / Long-term Understanding 缓存 + 每晚定时检查） ============
  // 取材口径：记忆池里「全部活跃」的 rule（Core Identity）与 fact（Long-term Understanding）条目，不是置顶那几条。
  const SUM_LABEL={core_identity:'Core Identity',understanding:'Long-term Understanding'};
  const SUM_MODE={full:'全量重生成',incremental:'增量更新',skipped:'记忆池没变，未动',empty:'无条目可总结',failed:'生成失败',would_generate:'待生成'};
  function renderSummaryStatus(s){
    const el=document.getElementById('summary-status');
    if(!el||!s) return;
    const L=[];
    L.push('本地时间 '+s.local_now+'（'+(s.ran_today?'今天已跑过':'今天还没跑')+'）'+(s.schedulerOn?' · 调度已挂':' · 调度未挂'));
    ['core_identity','understanding'].forEach(function(k){
      const b=s.blocks&&s.blocks[k]; if(!b) return;
      let t=SUM_LABEL[k]+'：'+b.count+' 条 → ';
      if(b.cached){
        t+=b.lines+' 行 / '+b.chars+' 字';
        if(b.mode) t+='（'+(SUM_MODE[b.mode]||b.mode)+'）';
        t+=b.fresh?'，已是最新':'，记忆池已变，待更新';
        if(b.updated_at) t+=' · 更新于 '+new Date(b.updated_at).toLocaleString('zh-CN');
      }else t+='尚无缓存（对话里回退直注原始条目）';
      if(b.error) t+=' · 上次失败：'+b.error;
      L.push(t);
    });
    el.textContent=L.join('\n');
  }
  async function loadSummaryConfig(){
    const msg=document.getElementById('summary-config-msg');
    try{
      const r=await fetch(ADMIN_API+'/memory-summary/status');
      const s=await r.json();
      if(s.error){ if(msg) msg.textContent='读取失败: '+s.error; return; }
      const en=document.getElementById('summary-enabled'); if(en) en.checked=!!s.enabled;
      const tm=document.getElementById('summary-time'); if(tm) tm.value=s.time||'03:30';
      const inc=document.getElementById('summary-incremental'); if(inc) inc.checked=!!s.incremental;
      renderSummaryStatus(s);
      if(msg){
        const lr=s.last_run_result||{};
        if(s.last_run_at){
          let tail='';
          if(lr&&lr.ok===false&&lr.error) tail='（失败：'+lr.error+'）';
          else tail='（'+(lr&&lr.blocks?lr.blocks.map(function(b){return (SUM_LABEL[b.block]||b.block)+':'+(SUM_MODE[b.mode]||b.mode);}).join('，'):'')+'）';
          msg.textContent='上次运行：'+new Date(s.last_run_at).toLocaleString('zh-CN')+tail;
        }else msg.textContent='还没跑过。';
      }
    }catch(e){ if(msg) msg.textContent='读取失败: '+e.message; }
  }
  async function saveSummaryConfig(){
    const msg=document.getElementById('summary-config-msg');
    if(msg) msg.textContent='保存中...';
    const en=document.getElementById('summary-enabled');
    const tm=document.getElementById('summary-time');
    const inc=document.getElementById('summary-incremental');
    const time=(tm&&tm.value)||'03:30';
    if(!/^\d{1,2}:\d{2}$/.test(time)){ if(msg) msg.textContent='时间格式不对（应为 HH:MM）'; toast('时间格式不对'); return; }
    const payload={enabled:en?!!en.checked:false,time:time,incremental:inc?!!inc.checked:true};
    try{
      const r=await fetch(ADMIN_API+'/memory-summary/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='保存失败: '+d.error; toast('保存失败: '+d.error); return; }
      if(msg) msg.textContent='已保存：'+(d.enabled?('每天 '+d.time+' 检查一次，记忆池没变就不动'):'自动检查已关闭（仍可手动生成）')+'。';
      toast('两块总结设置已保存');
      loadSummaryConfig();
    }catch(e){ if(msg) msg.textContent='保存失败: '+e.message; toast('保存失败: '+e.message); }
  }
  async function runSummaryNow(force){
    const btn=document.getElementById(force?'summary-force-btn':'summary-run-btn');
    const msg=document.getElementById('summary-config-msg');
    if(btn){ btn.disabled=true; btn.textContent='生成中…'; }
    if(msg) msg.textContent=force?'正在强制重生成两块（约 1–2 分钟，别关页面）…':'正在生成两块（池子没变会直接跳过）…';
    try{
      const r=await fetch(ADMIN_API+'/memory-summary/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({force:!!force})});
      const d=await r.json();
      if(d.error && d.status){ renderSummaryStatus(d.status); if(msg) msg.textContent='已有生成在跑，等它结束再看。'; }
      else if(d.error){ if(msg) msg.textContent='生成失败: '+d.error; toast('生成失败'); }
      else{
        const parts=[];
        ['core_identity','understanding'].forEach(function(k){
          const b=d.blocks&&d.blocks[k]; if(!b) return;
          let t=SUM_LABEL[k]+'：'+(SUM_MODE[b.mode]||b.mode);
          if(b.lines) t+='（'+b.lines+' 行 / '+(b.chars||0)+' 字）';
          if(b.error) t+=' · '+b.error;
          parts.push(t);
        });
        if(msg) msg.textContent='完成（'+Math.round((d.duration_ms||0)/1000)+'s）：'+parts.join('；');
        toast('两块总结已生成');
      }
    }catch(e){ if(msg) msg.textContent='生成失败: '+e.message; toast('生成失败: '+e.message); }
    finally{
      try{ await loadSummaryConfig(); }catch(_){}
      if(btn){ btn.disabled=false; btn.textContent=force?'强制重生成':'立即生成'; }
    }
  }

  // ============ 老数据重跑配置（1002 记忆改造 §8 第 5 项：逐批处理已有活跃记忆，产出一律进待审） ============
  async function loadBackfillConfig(){
    const msg=document.getElementById('bf-config-msg');
    try{
      const r=await fetch(ADMIN_API+'/memory-backfill/status');
      const s=await r.json();
      if(s.error){ if(msg) msg.textContent='读取失败: '+s.error; return; }
      const en=document.getElementById('bf-enabled'); if(en) en.checked=!!s.enabled;
      const tm=document.getElementById('bf-time'); if(tm) tm.value=s.time||'04:00';
      const bs=document.getElementById('bf-batch-size'); if(bs) bs.value=(s.batch_size!=null?s.batch_size:15);
      if(msg){
        let t='已处理 '+s.done_count+' 条 / 还剩 '+s.remaining+' 条';
        if(s.sink_suggestions) t+=' · 建议沉底 '+s.sink_suggestions+' 条待你定夺';
        if(s.last_run_at){
          const lr=s.last_run_result||{};
          t+=' \n上次运行：'+new Date(s.last_run_at).toLocaleString('zh-CN')+'（本批 '+lr.count+' 条 → 待审 '+lr.queued+' 条 / 建议沉底 '+lr.sink+' 条）';
        }else t+=' \n还没跑过。';
        if(s.last_error) t+=' \n上次失败：'+s.last_error;
        msg.textContent=t;
        // 1003-05③：进页面/重新载入时若后台正在跑（切走再回来、或手动刷新），自动接上进度轮询
        if(s.running) startBackfillWatch(msg);
      }
    }catch(e){ if(msg) msg.textContent='读取失败: '+e.message; }
  }
  async function saveBackfillConfig(){
    const msg=document.getElementById('bf-config-msg');
    if(msg) msg.textContent='保存中...';
    const en=document.getElementById('bf-enabled');
    const tm=document.getElementById('bf-time');
    const bs=document.getElementById('bf-batch-size');
    const time=(tm&&tm.value)||'04:00';
    if(!/^\d{1,2}:\d{2}$/.test(time)){ if(msg) msg.textContent='时间格式不对（应为 HH:MM）'; toast('时间格式不对'); return; }
    const payload={enabled:en?!!en.checked:false,time:time,batch_size:Math.max(1,Math.min(60,Number(bs&&bs.value)||15))};
    try{
      const r=await fetch(ADMIN_API+'/memory-backfill/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='保存失败: '+d.error; toast('保存失败: '+d.error); return; }
      if(msg) msg.textContent='已保存：'+(d.enabled?('每天 '+d.time+' 跑一批（每批 '+d.batch_size+' 条）'):'自动重跑已关闭（仍可手动跑一批）')+'。';
      toast('老数据重跑设置已保存');
      loadBackfillConfig();
    }catch(e){ if(msg) msg.textContent='保存失败: '+e.message; toast('保存失败: '+e.message); }
  }
  // 1003-05①：run 是长耗时同步接口（单批约 2-6 分钟），nginx /heartbeat/ 读超时 300s。
  // 超时后 nginx 返回自己的 HTML 错误页，原代码直接 r.json() 会抛 "Unexpected token '<'"，
  // 而后端其实已在后台跑完并推进了 done——报错误导用户重复点、白花钱。
  // 改为：先取 text 再尝试解析；解析失败按内容分流，并回查 /status 判定任务真实结果。
  async function parseRunResponse(res){
    const txt = await res.text();
    try { return { ok:true, data:JSON.parse(txt) }; }
    catch(e){
      const head=txt.slice(0,200).toLowerCase();
      const isHtml=/<!doctype|<html|<head|<title|502|504|timeout/.test(head);
      return { ok:false, html:isHtml, status:res.status, raw:txt.slice(0,120) };
    }
  }
  async function runBackfillNow(dry){
    const btn=document.getElementById(dry?'bf-dry-btn':'bf-run-btn');
    const msg=document.getElementById('bf-config-msg');
    if(btn){ btn.disabled=true; btn.textContent='跑中…'; }
    if(msg) msg.textContent=dry?'正在组装材料（不调模型）…':'正在跑一批（约 2-6 分钟，别关页面）…';
    if(!dry) startBackfillWatch(msg);
    try{
      const r=await fetch(ADMIN_API+'/memory-backfill/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dry_run:!!dry})});
      const parsed=await parseRunResponse(r);
      if(!parsed.ok){
        // 响应不是 JSON（多为 nginx 超时/网关错误页）——回查真实状态再下结论
        await reportRunUncertain(msg, r.status);
        return;
      }
      const d=parsed.data;
      if(d.error){ if(msg) msg.textContent='跑失败: '+d.error; toast('跑失败'); }
      else if(d.mode==='dry_run'){ if(msg) msg.textContent='dryRun：本批 '+d.count+' 条记忆，材料 '+d.prompt_chars+' 字（未调模型）'; }
      else{
        const parts=[];
        (d.items||[]).forEach(function(it){
          parts.push((it.action==='sink'?'沉底':'待审')+'：'+String(it.text||it.id||'').slice(0,40));
        });
        if(msg) msg.textContent='完成（'+Math.round((d.duration_ms||0)/1000)+'s）：本批 '+d.count+' 条 → 待审 '+d.queued+' 条 / 建议沉底 '+d.sink+' 条'+(parts.length?'\n'+parts.join('\n'):'');
        toast('跑完一批');
      }
    }catch(e){
      // 网络层异常（断网/连接被掐）同样不代表任务失败，走同一套回查
      await reportRunUncertain(msg, 0);
    }
    finally{
      stopBackfillWatch();
      try{ await loadBackfillConfig(); }catch(_){}
      if(btn){ btn.disabled=false; btn.textContent=dry?'试试组装（不调模型）':'立即跑一批'; }
    }
  }
  // 回查 /status 判定「请求失败但任务是否真的跑完」，并给出可执行的下一步
  async function reportRunUncertain(msg, status){
    if(msg) msg.textContent='连接中断（HTTP '+(status||'网络异常')+'），正在核对后台是否已跑完…';
    let s=null;
    try{
      const r=await fetch(ADMIN_API+'/memory-backfill/status');
      const p=await parseRunResponse(r);
      if(p.ok) s=p.data;
    }catch(_){}
    if(s){
      const runningNow = !!s.running;
      if(runningNow){
        if(msg) msg.textContent='任务仍在后台运行中，请稍等几分钟后点「重新载入」看进度——不要重复点，否则会并发跑多批。';
      }else if(s.last_run_at){
        const lr=s.last_run_result||{};
        if(msg) msg.textContent='连接中断，但后台已跑完（'+new Date(s.last_run_at).toLocaleString('zh-CN')+'）：本批 '+(lr.count||0)+' 条 → 待审 '+(lr.queued||0)+' 条 / 建议沉底 '+(lr.sink||0)+' 条\n已处理 '+s.done_count+' 条 / 还剩 '+s.remaining+' 条';
        toast('已在后台完成');
      }else{
        if(msg) msg.textContent='连接中断，且后台没有本次运行记录——任务可能未启动或已失败，可点「重新载入」看最后错误。';
      }
    }else{
      if(msg) msg.textContent='连接中断（HTTP '+(status||'网络异常')+'），且无法回查后台状态。请点「重新载入」确认进度，不要重复点。';
    }
  }
  // 1003-05③：跑批期间轮询 /status，让用户看到实时进度，而不必干等请求超时
  function startBackfillWatch(msg){
    stopBackfillWatch();
    const tick=async function(){
      try{
        const r=await fetch(ADMIN_API+'/memory-backfill/status');
        const p=await parseRunResponse(r);
        if(!p.ok) return;
        const s=p.data;
        if(msg && s.running){
          msg.textContent='后台运行中… 已处理 '+s.done_count+' 条 / 还剩 '+s.remaining+' 条（可切走，本页会继续刷新）';
        }
        if(!s.running){ stopBackfillWatch(); }
      }catch(_){}
    };
    window.__bfWatchTimer=setInterval(tick, 8000);
    tick();
  }
  function stopBackfillWatch(){
    if(window.__bfWatchTimer){ clearInterval(window.__bfWatchTimer); window.__bfWatchTimer=null; }
  }
  // ============ 老数据重跑·提示词（留空 = 回落内置默认） ============
  async function loadBackfillPrompt(){
    const m=document.getElementById('bf-prompt-msg');
    try{
      const r=await fetch(ADMIN_API+'/memory-backfill/prompt');
      const c=await r.json();
      if(c.error) throw new Error(c.error);
      const s=document.getElementById('bf-sys-prompt'); if(s) s.value=c.system_prompt||c.default_system_prompt||'';
      const u=document.getElementById('bf-user-prompt'); if(u) u.value=c.user_prompt||c.default_user_prompt||'';
      if(m) m.textContent=c.custom_set?'当前为自定义版本；「恢复内置默认」可回退。':'当前为内置默认（自定义为空）。';
    }catch(e){ if(m) m.textContent='读取重跑提示词失败: '+e.message; }
  }
  async function saveBackfillPrompt(){
    const m=document.getElementById('bf-prompt-msg');
    const g=function(id){ const el=document.getElementById(id); return el?el.value:''; };
    try{
      const r=await fetch(ADMIN_API+'/memory-backfill/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({system_prompt:g('bf-sys-prompt').trim(),user_prompt:g('bf-user-prompt').trim()})});
      const d=await r.json();
      if(d.error){ if(m) m.textContent='保存失败: '+d.error; toast('保存失败: '+d.error); return; }
      if(m) m.textContent='已保存，下一批重跑即生效。';
      toast('重跑提示词已保存');
    }catch(e){ if(m) m.textContent='保存失败: '+e.message; }
  }
  async function resetBackfillPrompt(){
    if(!confirm('恢复内置默认的老数据重跑提示词？自定义内容会被清空。'))return;
    const m=document.getElementById('bf-prompt-msg');
    try{
      const r=await fetch(ADMIN_API+'/memory-backfill/prompt',{method:'DELETE'});
      const d=await r.json();
      if(d.error){ if(m) m.textContent='恢复失败: '+d.error; return; }
      await loadBackfillPrompt();
      toast('已恢复内置默认');
    }catch(e){ if(m) m.textContent='恢复失败: '+e.message; }
  }
  // ============ 记忆池（现走 Memory V2，编辑/筛选只认 fact/rule 两类；1002-14 删 quote/milestone） ============
  // 存量兼容：0912 五类（关于她/认账/拓本/压缩摘要/对话碎片）与更早旧四类仍会出现在列表里，
  // 统一暗灰显示、由后台清洗迁移逐步消化；颜色表保留两套键。
  const MP_CAT_COLORS={fact:'#2980b9',rule:'#c0392b',quote:'#8e44ad',milestone:'#f39c12',关于她:'#2980b9',认账:'#c0392b',拓本:'#8e44ad',压缩摘要:'#7f8c8d',对话碎片:'#f39c12',关于我们:'#95a5a6',锚点:'#95a5a6',信号:'#95a5a6',对话摘要:'#95a5a6'};
  function mpCatColor(c){ return MP_CAT_COLORS[c]||'#7f8c8d'; }

  function initMemPoolView(){
    window.__memShowSunk=false;
    window.__memShowPinned=false;
    window.__memShowActive=false;
    window.__memShowReview=false;
    window.__memShowSimilar=false;
    populateMemPoolCatOptions();
    loadMemPool();
    // 1003：记忆蒸馏/两块总结/老数据重跑三张设置卡已搬去配置页，加载随之移到 switchTab 的 config 分支。
  }

  function populateMemPoolCatOptions(){
    const sel=document.getElementById('mempool-cat');
    const ed=document.getElementById('mempool-edit-cat');
    const cats=['fact','rule'];
    // 筛选与编辑统一只允许 V2 四类；旧分类存量由后台迁移处理，不再暴露为可选项。
    if(sel){ sel.innerHTML='<option value="">全部分类</option>'+cats.map(function(c){return '<option value="'+c+'">'+c+'</option>';}).join(''); }
    if(ed){ ed.innerHTML=cats.map(function(c){return '<option value="'+c+'">'+c+'</option>';}).join(''); }
  }
  function mempoolSearchInput(v){
    clearTimeout(AppState.memPoolSearchTimer);
    AppState.memPoolSearchTimer=setTimeout(loadMemPool,300);
  }
/**
 * 加载记忆池列表：按搜索词/分类/排序请求接口；保留旧列表避免高度跳动，
 * 渲染后恢复页面滚动位置。
 */
  async function loadMemPool(){
    const el=document.getElementById('mempool-list');
    if(!el)return;
    // 保留旧列表，避免清空后高度骤变导致页面跳回顶部；仅在没有任何卡片时显示加载中
    if(!el.querySelector('.mp-card')){
      if(!el.innerHTML.trim()) el.innerHTML='<div class="loading">加载中...</div>';
    }
    const q=document.getElementById('mempool-search').value;
    const cat=document.getElementById('mempool-cat').value;
    const sort=document.getElementById('mempool-sort').value;
    // 0927 下拉=视图筛选：最新/最旧=全部视图（仅排序不同）；已pin/已沉底=对应视图
    if(sort==='pinned'){ window.__memShowPinned=true; window.__memShowSunk=false; window.__memShowActive=false; window.__memShowReview=false; window.__memShowSimilar=false; }
    else if(sort==='sunk'){ window.__memShowSunk=true; window.__memShowPinned=false; window.__memShowActive=false; window.__memShowReview=false; window.__memShowSimilar=false; }
    else { window.__memShowPinned=false; window.__memShowSunk=false; window.__memShowActive=false; window.__memShowReview=false; window.__memShowSimilar=false; }
    const savedY=(window.pageYOffset!==undefined)?window.pageYOffset:(document.documentElement.scrollTop||0);
    try{
      const apiSort=(sort==='oldest')?'oldest':'recent';
      const r=await fetch(ADMIN_API + '/memory-v2/pool-view?q='+encodeURIComponent(q)+'&category='+encodeURIComponent(cat)+'&sort='+encodeURIComponent(apiSort));
      const d=await r.json();
      renderMemPool(d);
      // 重绘后恢复页面滚动位置，防止操作后视口跳动
      if(window.scrollTo){ requestAnimationFrame(function(){ window.scrollTo(0,savedY); }); }
    }catch(e){ el.innerHTML='<div class="empty">加载失败: '+e.message+'</div>'; }
  }
/**
 * 渲染记忆池列表与统计；结果缓存到 window.__memPoolData/__memPoolItems，
 * 供筛选/沉底/置顶等操作复用，避免重复请求。
 * @param {Object} d 记忆池接口返回数据
 */
  function renderMemPool(d){
    const stats=d.stats||{}, allItems=d.items||[];
    window.__memPoolData=d;
    let items;
    if(window.__memShowReview||window.__memShowSimilar) items=[];
    else if(window.__memShowPinned) items=allItems.filter(function(x){return x.pinned===true;});
    else if(window.__memShowSunk) items=allItems.filter(function(x){return x.active===false;});
    else if(window.__memShowActive) items=allItems.filter(function(x){return x.active!==false;});
    else items=allItems;
    // 0927 排序：最新(默认)=活跃优先→时间最新→沉底最后；最旧=时间升序
    const sortVal=(document.getElementById('mempool-sort')||{}).value||'recent';
    items=items.slice().sort(function(a,b){
      if(sortVal==='oldest') return String(a.updated_at||'').localeCompare(String(b.updated_at||''));
      const ra=(a.active!==false)?0:1, rb=(b.active!==false)?0:1;
      return ra-rb || String(b.updated_at||'').localeCompare(String(a.updated_at||''));
    });
    window.__memPoolItems=items;
    const st=document.getElementById('mempool-stats');
    if(st){
      st.innerHTML=''
        +'<div class="mp-stat-cards">'
        +'<div class="mp-stat-card'+(window.__memShowActive?' on':'')+'" onclick="toggleMemPoolActive()" role="button" title="只看活跃记忆；再点回到全部">'
          +'<div class="mp-stat-card-label">活跃</div><div class="mp-stat-card-num">'+stats.active+'</div>'
        +'</div>'
        +'<div class="mp-stat-card'+(window.__memShowReview?' on':'')+'" onclick="toggleMemPoolReview()" role="button" title="人工裁决解析出的记忆候选：通过入库 / 驳回">'
          +'<div class="mp-stat-card-label">待审</div><div class="mp-stat-card-num">'+(window.__reviewTotal!=null?window.__reviewTotal:'…')+'</div>'
        +'</div>'
        +'<div class="mp-stat-card'+(window.__memShowSimilar?' on':'')+'" onclick="toggleMemPoolSimilar()" role="button" title="向量相近的记忆一组一组列出，挑重复的沉底">'
          +'<div class="mp-stat-card-label">相似</div><div class="mp-stat-card-num">'+(window.__similarGroupCount!=null?window.__similarGroupCount:'…')+'</div>'
        +'</div>'
        +'</div>';
    }
    const el=document.getElementById('mempool-list');
    if(!el)return;
    const ctr=document.getElementById('mempool-controls');
    if(ctr) ctr.style.display=(window.__memShowReview||window.__memShowSimilar)?'none':'';
    el.className='mp-list';
    if(window.__memShowReview){ renderReviewItems(el); return; }
    if(window.__memShowSimilar){ renderSimilarGroups(el); return; }
    if(!items.length){ el.innerHTML='<div class="mp-empty">暂无记忆，点右上角「＋ 新增记忆」</div>'; return; }
    let html='';
    items.forEach(function(it){
      const sunk=it.active===false, pinned=it.pinned;
      const cc=mpCatColor(it.category);
      html+='<div class="mp-card'+(sunk?' sunk':'')+(pinned?' pin':'')+'" style="--mp-cat:'+cc+'">'
        +'<div class="mp-card-head">'
          +'<span class="mp-cat"><span class="mp-dot"></span>'+escapeHtml(it.category)+'</span>'
          +'<span class="mp-badges">'
            +(pinned?'<span class="mp-badge pin">PIN</span>':'')
            +(sunk?'<span class="mp-badge sunk">已沉底</span>':'')
          +'</span>'
        +'</div>'
        +'<div class="mp-body">'+escapeHtml(it.content)+'</div>'
        +'<div class="mp-meta">'
          +'<span>检索 '+(it.retrieval_count||0)+' 次</span>'
          +(typeof it._score==='number'?'<span class="mp-score">值 '+it._score+'</span>':'')
        +'</div>'
        +'<div class="mp-actions">'
          +(sunk
            ? '<button type="button" class="mp-btn ghost" onclick="reviveMemPool(\''+it.id+'\')">恢复</button>'
            : '<button type="button" class="mp-btn ghost" onclick="sinkMemPool(\''+it.id+'\')">沉底</button>')
          +(pinned
            ? '<button type="button" class="mp-btn ghost" onclick="togglePinMemPool(\''+it.id+'\',0)">取消置顶</button>'
            : '<button type="button" class="mp-btn ghost" onclick="togglePinMemPool(\''+it.id+'\',1)">置顶</button>')
          +'<button type="button" class="mp-btn ghost" onclick="editMemPool(\''+it.id+'\')">编辑</button>'
          +'<button type="button" class="mp-btn danger" onclick="deleteMemPool(\''+it.id+'\')">删除</button>'
        +'</div>'
        +'</div>';
    });
    el.innerHTML=html;
  }
  // 点「导出」先选类别（全部 / 新五类 / 旧四类），再按所选导出活跃条目
  function openMemPoolExport(){
    const sel=document.getElementById('mempool-export-cat');
    if(sel){
      const cats=['关于她','认账','拓本','压缩摘要','对话碎片'];
      const legacy=['关于我们','锚点','信号','对话摘要'];
      const exists=function(c){ return !window.__memPoolData || !window.__memPoolData.stats || (window.__memPoolData.stats.byCategory[c]||0)>0; };
      sel.innerHTML='<option value="">全部活跃记忆</option>'
        +cats.concat(legacy).map(function(c){ return '<option value="'+c+'">'+c+(legacy.indexOf(c)>=0?'（旧）':'')+(exists(c)?'':' · 空')+'</option>'; }).join('');
      sel.value='';
    }
    openModal('mempoolExportModal');
  }
  async function exportMemPool(){
    const cat=document.getElementById('mempool-export-cat')?document.getElementById('mempool-export-cat').value:'';
    const msg=document.getElementById('mempool-clean-msg');
    const catLabel=cat||'全部';
    if(msg) msg.textContent='正在导出'+catLabel+'（JSON）…';
    try{
      const r=await fetch(ADMIN_API + '/memory-v2/pool-view');
      const d=await r.json();
      const all=d.items||[];
      const rows=all.filter(function(x){return x.active!==false && (!cat || x.category===cat);});
      if(!rows.length){ toast('该类别下没有可导出的活跃记忆'); if(msg) msg.textContent=''; return; }
      // 结构对齐清洗流程：note 字段说明 + items[{n,id,category,source,active,pinned,content}]（importance 已删）
      const items=rows.map(function(e,i){
        return { n:i+1, id:e.id, category:e.category,
          source:e.source||'manual', active:e.active!==false, pinned:e.pinned===true, content:e.content||'' };
      });
      const out={ note:'记忆池导出（'+new Date().toLocaleString('zh-CN')+'，范围：'+catLabel+' 活跃条目，沉底不含）。字段：n 序号 / id 条目唯一 id / category 当前分类 / source 写入来源 / active false=已沉底 / pinned 是否置顶 / content 内容。清洗产出变更清单：[{id,op:"update"/"delete"/"merge",category?,content?,into?}]，到「导入清洗」预览后应用。',
        range:catLabel, count:items.length, items:items };
      const blob=new Blob([JSON.stringify(out,null,1)], {type:'application/json;charset=utf-8'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.download='记忆池_'+catLabel+'_'+items.length+'条_'+new Date().toISOString().slice(0,10)+'.json';
      document.body.appendChild(a); a.href=url; a.click();
      setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 60);
      closeModal('mempoolExportModal');
      if(msg) msg.textContent='已导出 '+catLabel+' '+items.length+' 条（JSON）';
    }catch(e){ toast('导出失败: '+e.message); if(msg) msg.textContent='导出失败: '+e.message; }
  }
  // ---- 批量导入记忆（JSON，2026-09-27：只进待审队列，复用 /memory-v2/entries 非 direct 通道） ----
  let memPoolBatchEntries = [];   // 有效条目 [{category, content, dup}]
  let memPoolBatchFailed = [];    // [{idx, err}]
  function openMemPoolBatchImportPanel(){
    memPoolBatchEntries = [];
    memPoolBatchFailed = [];
    const ta=document.getElementById('mempool-batch-import-ta');
    if(ta) ta.value='';
    const pv=document.getElementById('mempool-batch-import-preview');
    if(pv) pv.textContent='';
    const btn=document.getElementById('mempool-batch-import-do-btn');
    if(btn) btn.style.display='none';
    openModal('mempoolBatchImportModal');
  }
  function parseMemPoolBatchJson(raw){
    const failed=[], entries=[];
    let arr=null;
    try{ arr=JSON.parse(raw); }catch(e){ failed.push({idx:1, err:'JSON 解析失败: '+e.message, text:String(raw||'').slice(0,60)}); return {entries:entries, failed:failed}; }
    if(arr && !Array.isArray(arr) && Array.isArray(arr.items)) arr=arr.items;
    if(!Array.isArray(arr)){ failed.push({idx:1, err:'顶层必须是数组或 {items:[...]}', text:String(raw||'').slice(0,60)}); return {entries:entries, failed:failed}; }
    const okCats={fact:1, rule:1, '关于她':1, '认账':1, '拓本':1};
    arr.forEach(function(it, i){
      if(!it || typeof it!=='object'){ failed.push({idx:i+1, err:'条目不是对象', text:String(it).slice(0,40)}); return; }
      const content=String(it.content||'').trim();
      if(!content){ failed.push({idx:i+1, err:'content 为空', text:''}); return; }
      const cat=String(it.category||'').trim();
      if(cat && !okCats[cat]){ failed.push({idx:i+1, err:'category 非法（fact/rule 或 关于她/认账/拓本，可省略=自动识别）', text:content.slice(0,40)}); return; }
      entries.push({category: cat || '', content: content});
    });
    return {entries:entries, failed:failed};
  }
  async function previewMemPoolBatchImport(){
    const ta=document.getElementById('mempool-batch-import-ta');
    if(!ta) return;
    const raw=String(ta.value||'').trim();
    const pv=document.getElementById('mempool-batch-import-preview');
    if(!raw){ if(pv) pv.textContent='先粘贴要导入的 JSON'; return; }
    const parsed=parseMemPoolBatchJson(raw);
    memPoolBatchEntries=parsed.entries;
    memPoolBatchFailed=parsed.failed;
    if(!memPoolBatchEntries.length && !memPoolBatchFailed.length){ if(pv) pv.innerHTML='<div class="cc-import-item fail">没有可导入的条目</div>'; return; }
    // 去重：与已有记忆 content 完全一致
    let existingSet=null;
    try{
      const r=await fetch(ADMIN_API+'/memory-v2/pool-view');
      const d=await r.json();
      const items=d.items||[];
      existingSet=new Set(items.map(function(x){ return String(x.content||'').trim(); }));
    }catch(e){ existingSet=null; }
    let dup=0;
    memPoolBatchEntries.forEach(function(e){ if(existingSet && existingSet.has(e.content)){ e.dup=true; dup++; } });
    // 分类统计（预设）
    const catCount={};
    memPoolBatchEntries.forEach(function(e){
      const k=e.category||'自动识别';
      catCount[k]=(catCount[k]||0)+1;
    });
    let html='<div style="margin-bottom:6px">共 <b>'+(memPoolBatchEntries.length+memPoolBatchFailed.length)+'</b> 条：有效 <b style="color:#5c8a4e">'+memPoolBatchEntries.length+'</b> 条，格式失败 <b style="color:#c05050">'+memPoolBatchFailed.length+'</b> 条'+(dup?'，与已有记忆重复 <b style="color:#b57f88">'+dup+'</b> 条（将跳过）':'')+'</div>';
    html+='<div style="margin-bottom:6px">分类：'+(Object.keys(catCount).map(function(k){ return '<b>'+k+'</b> '+catCount[k]; }).join('　')||'（无）')+'</div>';
    if(memPoolBatchFailed.length){
      html+='<div class="cc-import-item fail" style="margin-bottom:4px">格式失败明细：</div>';
      memPoolBatchFailed.slice(0,8).forEach(function(f){
        html+='<div class="cc-import-item fail"><b>第 '+f.idx+' 条</b> '+(f.err||'')+'</div>';
      });
      if(memPoolBatchFailed.length>8) html+='<div class="cc-import-item fail">… 其余 '+(memPoolBatchFailed.length-8)+' 条略</div>';
    }
    if(pv) pv.innerHTML=html;
    const btn=document.getElementById('mempool-batch-import-do-btn');
    if(btn) btn.style.display=(memPoolBatchEntries.length>0)?'':'none';
  }
  async function doMemPoolBatchImport(){
    const dupCount=memPoolBatchEntries.filter(function(e){ return e.dup; }).length;
    const todo=memPoolBatchEntries.filter(function(e){ return !e.dup; });
    if(!todo.length){ toast('没有可导入的条目（全部为重复或已过滤）'); return; }
    if(!confirm('确认导入 '+todo.length+' 条到记忆待审队列？'+(dupCount?('与已有记忆重复 '+dupCount+' 条将跳过。'):'')+(memPoolBatchFailed.length?('格式失败 '+memPoolBatchFailed.length+' 条将跳过。'):''))) return;
    const btn=document.getElementById('mempool-batch-import-do-btn');
    if(btn) btn.disabled=true;
    const pv=document.getElementById('mempool-batch-import-preview');
    if(pv) pv.innerHTML='<div class="cc-import-item">正在导入 '+todo.length+' 条到待审队列…</div>';
    let ok=0, fail=0;
    const failList=[];
    for(let i=0;i<todo.length;i++){
      const e=todo[i];
      try{
        const body={content:e.content};
        if(e.category) body.category=e.category;
        const r=await apiRequest('POST', ADMIN_API+'/memory-v2/entries', body, {busy:null});
        if(!r.ok){ fail++; failList.push('「'+(e.content||'').slice(0,20)+'」: '+(r.error||'请求失败')); continue; }
        const d=r.data||{};
        if(d.error || d.action==='reject'){ fail++; failList.push('「'+(e.content||'').slice(0,20)+'」: '+(d.error||'被校验拒绝')); continue; }
        ok++;
      }catch(err){ fail++; failList.push('「'+(e.content||'').slice(0,20)+'」: '+((err&&err.message)||String(err))); }
    }
    if(pv) pv.innerHTML='<div class="cc-import-item ok">导入完成：成功进待审 <b>'+ok+'</b> 条，失败 <b>'+fail+'</b> 条'+(failList.length?('。<br>失败明细：'+failList.slice(0,5).join('；')+(failList.length>5?'；…':'')):'')+'</div>';
    if(btn){ btn.disabled=false; btn.style.display='none'; }
    loadMemPool();
    toast('批量导入完成：'+ok+' 条已进待审'+(fail?('，'+fail+' 条失败'):''));
  }
  function rerenderMemPoolView(){ if(window.__memShowReview){ loadReviewQueue(); return; } if(window.__memPoolData){ renderMemPool(window.__memPoolData); } else { loadMemPool(); } }
  // 0927 统计卡片（活跃）：开关式切换——点一下只看活跃，再点回到全部；进入时下拉同步回「最新」
  function toggleMemPoolActive(){
    window.__memShowActive=!window.__memShowActive;
    if(window.__memShowActive){ window.__memShowPinned=false; window.__memShowSunk=false; window.__memShowReview=false; window.__memShowSimilar=false; const so=document.getElementById('mempool-sort'); if(so) so.value='recent'; }
    rerenderMemPoolView();
  }
  // 待审（review 队列）：列表区切换显示记忆候选，通过入库 / 驳回
  function toggleMemPoolReview(){
    window.__memShowReview=!window.__memShowReview;
    // 每次进出待审视图都重置多选状态，避免残留勾选跨视图生效
    window.__reviewMultiSel=false;
    window.__reviewSel={};
    if(window.__memShowReview){ window.__memShowActive=false; window.__memShowPinned=false; window.__memShowSunk=false; loadReviewQueue(); return; }
    loadMemPool();
  }
  // 相似：活跃记忆按语义向量分组列出，组内挑重复的沉底
  function toggleMemPoolSimilar(){
    window.__memShowSimilar=!window.__memShowSimilar;
    if(window.__memShowSimilar){ window.__memShowActive=false; window.__memShowPinned=false; window.__memShowSunk=false; window.__memShowReview=false; loadSimilarGroups(); return; }
    loadMemPool();
  }
  async function loadSimilarGroups(){
    try{
      const th=window.__similarThresholdSel?'?th='+encodeURIComponent(window.__similarThresholdSel):'';
      const r=await fetch(ADMIN_API + '/memory-v2/similar-groups'+th);
      const d=await r.json();
      if(d.error) throw new Error(d.error);
      window.__similarGroups=d.groups||[];
      window.__similarThreshold=d.threshold;
      window.__similarGroupCount=window.__similarGroups.length;
      window.__similarError=null;
      if(window.__memShowSimilar||window.__memPoolData) renderMemPool(window.__memPoolData||{stats:{total:0,active:0,pinned:0,sunk:0},items:[]});
    }catch(e){
      window.__similarGroups=null; window.__similarError=e.message;
      if(window.__memShowSimilar) renderMemPool(window.__memPoolData||{stats:{total:0,active:0,pinned:0,sunk:0},items:[]});
      toast('相似分组加载失败: '+e.message);
    }
  }
  function similarThSelect(){
    const cur=Number(window.__similarThreshold||0.85);
    return '<select class="mp-similar-th" onchange="changeSimilarTh(this.value)">'
      +[0.9,0.85,0.8,0.75,0.7].map(function(t){return '<option value="'+t+'"'+(Math.abs(cur-t)<0.001?' selected':'')+'>'+t.toFixed(2)+'</option>';}).join('')
      +'</select>';
  }
  function changeSimilarTh(v){
    window.__similarThresholdSel=v;
    loadSimilarGroups();
  }
  function renderSimilarGroups(el){
    const g=window.__similarGroups;
    if(!g){
      el.innerHTML='<div class="mp-empty">'+(window.__similarError?('相似分组加载失败: '+escapeHtml(window.__similarError)):'正在计算向量相似…首次会嵌入全部活跃记忆，几秒钟，之后走缓存秒开')+'</div>';
      return;
    }
    if(!g.length){ el.innerHTML='<div class="mp-empty">没有发现向量相近的活跃记忆（当前阈值 '+(window.__similarThreshold||0.85)+'；池子刚清洗过没重复是正常的，想看相近话题可调低）<br>'+similarThSelect()+'</div>'; return; }
    let html='<div class="mp-similar-head">向量相近分组 · 阈值 '+similarThSelect()+' · 共 <b>'+g.length+'</b> 组，组内挑重复的沉底（沉完组自动缩小）</div>';
    g.forEach(function(gr,gi){
      html+='<div class="mp-similar-group"><div class="mp-similar-group-head">组 '+(gi+1)+' · 最高相似度 <b>'+Number(gr.max_sim).toFixed(2)+'</b> · '+gr.items.length+' 条</div>';
      gr.items.forEach(function(it){
        html+='<div class="mp-card" style="--mp-cat:'+mpCatColor(it.kind)+'">'
          +'<div class="mp-card-head">'
            +'<span class="mp-cat"><span class="mp-dot"></span>'+escapeHtml(it.kind)+'</span>'
            +'<span class="mp-badges"><span class="mp-badge">'+escapeHtml(it.subject||'')+'</span></span>'
          +'</div>'
          +'<div class="mp-body">'+escapeHtml(it.text)+'</div>'
          +'<div class="mp-meta"><span>'+escapeHtml(String(it.created_at||'').slice(0,10))+'</span></div>'
          +'<div class="mp-actions">'
            +'<button type="button" class="mp-btn ghost" onclick="sinkMemPoolSimilar(\''+it.id+'\')">沉底</button>'
            +'<button type="button" class="mp-btn ghost" onclick="editMemPoolSimilar(\''+it.id+'\')">编辑</button>'
          +'</div>'
        +'</div>';
      });
      html+='</div>';
    });
    el.innerHTML=html;
  }
  async function sinkMemPoolSimilar(id){
    if(!confirm('沉底该条记忆？沉底后不再参与检索浮现。'))return;
    try{
      const r=await fetch(ADMIN_API+'/memory-v2/entries/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'archive'})});
      const d=await r.json().catch(function(){return {};});
      if(d.error){ toast('操作失败: '+d.error); return; }
      toast('已归档'); loadSimilarGroups();
    }catch(e){ toast('操作失败: '+e.message); }
  }
  function editMemPoolSimilar(id){
    window.__reviewEditId=null;
    let it=null;
    (window.__similarGroups||[]).forEach(function(gr){ if(it)return; (gr.items||[]).forEach(function(x){ if(x.id===id)it=x; }); });
    if(!it){ toast('未找到该记忆'); return; }
    AppState.memPoolEditId=id;
    populateMemPoolCatOptions();
    const ed=document.getElementById('mempool-edit-cat');
    if(ed) ed.value=(it.kind||'fact');
    const ce=document.getElementById('mempool-edit-content');
    if(ce) ce.value=it.text||'';
    document.getElementById('mempool-modal-title').textContent='编辑记忆';
    openModal('mempoolEditModal');
  }
  // 待审编辑：打开共用弹窗，标记当前待审条目 id（saveMemPoolEdit 分流到 saveReviewEdit）
  function editReviewItem(id){
    const q=window.__reviewQueue||[];
    let it=null;
    q.forEach(function(x){ if(x.id===id) it=x; });
    if(!it){ toast('未找到该待审条目'); return; }
    window.__reviewEditId=id;
    populateMemPoolCatOptions();
    const ce=document.getElementById('mempool-edit-content');
    const ed=document.getElementById('mempool-edit-cat');
    if(ce) ce.value=(it.candidate&&it.candidate.text)||'';
    if(ed) ed.value=(it.candidate&&it.candidate.kind)||'fact';
    const tt=document.getElementById('mempool-modal-title');
    if(tt) tt.textContent='编辑待审记忆';
    openModal('mempoolEditModal');
  }
  // 保存待审编辑：POST /admin/memory-review/queue/:id/edit，保存后刷新列表
  async function saveReviewEdit(){
    const content=document.getElementById('mempool-edit-content').value.trim();
    const category=document.getElementById('mempool-edit-cat').value;
    if(!content){ toast('记忆内容不能为空'); return; }
    const id=window.__reviewEditId;
    try{
      const r=await apiRequest('POST', ADMIN_API+'/memory-review/queue/'+encodeURIComponent(id)+'/edit', {text:content, kind:category});
      if(!r.ok){ toast('保存失败: '+(r.error||('HTTP '+r.status))); return; }
      const d=r.data||{};
      if(d.error){ toast('保存失败: '+d.error); return; }
      toast('待审记忆已更新');
      window.__reviewEditId=null;
      closeModal('mempoolEditModal');
      loadReviewQueue();
    }catch(e){ toast('网络错误: '+e.message); }
  }
  async function loadReviewQueue(){
    try{
      const r=await fetch(ADMIN_API + '/memory-review/queue');
      const d=await r.json();
      if(d.error) throw new Error(d.error);
      window.__reviewQueue=d.items||[];
      window.__reviewTotal=window.__reviewQueue.length;
      if(window.__memShowReview||window.__memPoolData) renderMemPool(window.__memPoolData||{stats:{total:0,active:0,pinned:0,sunk:0},items:[]});
    }catch(e){
      if(window.__memShowReview){
        const el=document.getElementById('mempool-list');
        if(el) el.innerHTML='<div class="mp-empty">review 队列加载失败: '+escapeHtml(e.message)+'</div>';
      }
      toast('review 队列加载失败: '+e.message);
    }
  }
  function renderReviewItems(el){
    const q=window.__reviewQueue;
    if(!q){ el.innerHTML='<div class="loading">加载 review 队列...</div>'; return; }
    if(!q.length){ el.innerHTML='<div class="mp-empty">待审队列空，候选都处理完了</div>'; return; }
    const multi=!!window.__reviewMultiSel;
    const ORIGIN={promotion:'压缩块解析',manual:'手动提交',memory_tag:'AI 标签'};
    const BF_ACTION={update:'润色改写',supplement:'补充信息',merge:'合并碎片',create:'补抽新记忆',sink:'建议沉底'};
    let html='<div class="mp-review-toolbar">'
      +'<span class="mp-review-total">待审候选 <b>'+q.length+'</b> 条</span>'
      +'<button type="button" class="mp-btn'+(multi?' primary':'')+'" onclick="toggleReviewMultiSelect()">'+(multi?'取消多选':'多选')+'</button>'
    +'</div>';
    q.forEach(function(it){
      const c=it.candidate||{};
      const cc=mpCatColor(c.kind||'fact');
      const on=multi&&!!window.__reviewSel[it.id];
      html+='<div class="mp-card'+(on?' sel':'')+'"'+(multi?' data-rid="'+escapeHtml(it.id)+'" onclick="toggleReviewSel(\''+it.id+'\')"':'')+' style="--mp-cat:'+cc+'">'
        +'<div class="mp-card-head">'
          +(multi?'<input type="checkbox" class="mp-sel-chk"'+(on?' checked':'')+' onclick="event.stopPropagation();toggleReviewSel(\''+it.id+'\')">':'')
          +'<span class="mp-cat"><span class="mp-dot"></span>'+escapeHtml(c.kind||'fact')+'</span>'
          +'<span class="mp-badges"><span class="mp-badge">待审</span></span>'
        +'</div>'
        +'<div class="mp-body">'+escapeHtml(c.text||'')+'</div>'
        // 1002 第 5 项：老数据重跑的候选，改前改后同卡上下对照（②-A），并把动作与理由摆在最显眼处
        +(c.backfill?'<div class="mp-merge" style="margin:8px 0 0;padding:8px;border:1px dashed var(--text3);border-radius:8px;font-size:12px;color:var(--text3);line-height:1.7">'
          +'<div style="margin-bottom:6px"><span class="mp-badge" style="background:var(--accent);color:#fff">老数据重跑 · '+(BF_ACTION[c.backfill.action]||escapeHtml(String(c.backfill.action||'')))+'</span></div>'
          +(c.backfill.old_text?'<div><span style="color:var(--mp-cat)">改前</span>：'+escapeHtml(c.backfill.old_text)+'</div>'
            +'<div style="margin-top:4px;color:var(--accent)"><b>改后</b>：'+escapeHtml(c.text||'')+'</div>':'')
          +(c.backfill.merge_ids&&c.backfill.merge_ids.length?'<div style="margin-top:4px">由 '+c.backfill.merge_ids.length+' 条合并（'+escapeHtml(String(c.backfill.merge_ids.join('、')))+'）——通过后这 '+c.backfill.merge_ids.length+' 条自动沉底</div>':'')
          +(c.backfill.target_id?'<div style="margin-top:4px">目标条目 '+escapeHtml(String(c.backfill.target_id))+'——通过后该条自动沉底</div>':'')
          +(c.backfill.reason?'<div style="margin-top:4px">理由：'+escapeHtml(c.backfill.reason)+'</div>':'')
        +'</div>':'')
        +(it.merge&&it.merge.merged_text?'<div class="mp-merge" style="margin:8px 0 0;padding:8px;border:1px dashed var(--text3);border-radius:8px;font-size:12px;color:var(--text3);line-height:1.7">'
          +'<div><span style="color:var(--mp-cat)">既有</span>：'+escapeHtml(it.merge.from_text||'')+'</div>'
          +'<div style="margin-top:4px"><span style="color:var(--mp-cat)">候选</span>：'+escapeHtml(c.text||'')+'</div>'
          +'<div style="margin-top:4px;color:var(--accent)"><b>合并后</b>：'+escapeHtml(it.merge.merged_text||'')+'</div>'
        +'</div>':'')
        +'<div class="mp-meta">'
          +'<span>来源 '+(c.backfill?'老数据重跑':(ORIGIN[c.origin]||escapeHtml(String(c.origin||'未知'))))+'</span>'
          +(c.speaker?'<span>说话人 '+escapeHtml(c.speaker==='ai'?'谢':(c.speaker==='user'?'涵':String(c.speaker)))+'</span>':'')
          +(it.provenance&&it.provenance.msg_time?'<span>'+escapeHtml(String(it.provenance.msg_time).slice(0,16).replace('T',' '))+'</span>':'')
          +(it.created_at?'<span>'+escapeHtml(String(it.created_at).slice(0,10))+'</span>':'')
        +'</div>'
        +(multi?'':'<div class="mp-actions">'
          +'<button type="button" class="mp-btn ghost" onclick="editReviewItem(\''+it.id+'\')">编辑</button>'
          +'<button type="button" class="mp-btn ghost" onclick="approveReviewItem(\''+it.id+'\')">'+(it.merge&&it.merge.merged_text?'通过（合并入库）':(c.backfill&&(c.backfill.merge_ids||c.backfill.target_id)?'通过（旧条沉底）':'通过入库'))+'</button>'
          +'<button type="button" class="mp-btn danger" onclick="rejectReviewItem(\''+it.id+'\')">驳回</button>'
        +'</div>')
      +'</div>';
    });
    // 多选操作条：复用压缩页 cc-multi-bar 固定底栏样式，cols2 两列按钮
    html+='<div class="cc-multi-bar'+(multi?' show':'')+'" id="review-multi-bar">'
      +'<div class="cc-multi-bar-top">'
        +'<div class="cc-multi-bar-left">'
          +'<span class="cc-multi-count" id="review-multi-count">已选 '+Object.keys(window.__reviewSel||{}).length+' 条</span>'
          +'<label class="cc-multi-select-all"><input type="checkbox" id="review-multi-select-all"'+(multi&&q.length&&Object.keys(window.__reviewSel||{}).length>=q.length?' checked':'')+' onclick="toggleReviewSelectAll()">全选</label>'
        +'</div>'
      +'</div>'
      +'<div class="cc-multi-bar-actions cols2">'
        +'<button type="button" class="cc-btn primary" id="review-batch-approve" onclick="batchReviewDecide(\'approve\')">批量通过入库</button>'
        +'<button type="button" class="cc-btn danger" id="review-batch-reject" onclick="batchReviewDecide(\'reject\')">批量驳回</button>'
      +'</div>'
    +'</div>';
    el.innerHTML=html;
  }
  // 待审多选：进出多选模式（清空勾选重画）
  function toggleReviewMultiSelect(){
    window.__reviewMultiSel=!window.__reviewMultiSel;
    window.__reviewSel={};
    renderReviewItems(document.getElementById('mempool-list'));
  }
  // 勾选/取消单条：只改对应卡片 DOM，不整页重画（173 条全量重绘会闪烁跳屏）
  function toggleReviewSel(id){
    if(window.__reviewSel[id]) delete window.__reviewSel[id]; else window.__reviewSel[id]=true;
    const el=document.getElementById('mempool-list');
    if(!el) return;
    el.querySelectorAll('.mp-card[data-rid]').forEach(function(card){
      if(card.getAttribute('data-rid')!==id) return;
      const on=!!window.__reviewSel[id];
      card.classList.toggle('sel',on);
      const chk=card.querySelector('.mp-sel-chk');
      if(chk) chk.checked=on;
    });
    updateReviewMultiBar();
  }
  // 全选/全不选：以当前队列为准，逐卡同步勾选态
  function toggleReviewSelectAll(){
    const q=window.__reviewQueue||[];
    const allBox=document.getElementById('review-multi-select-all');
    const all=!!(allBox&&allBox.checked);
    window.__reviewSel={};
    if(all) q.forEach(function(it){ window.__reviewSel[it.id]=true; });
    const el=document.getElementById('mempool-list');
    if(el) el.querySelectorAll('.mp-card[data-rid]').forEach(function(card){
      const on=!!window.__reviewSel[card.getAttribute('data-rid')];
      card.classList.toggle('sel',on);
      const chk=card.querySelector('.mp-sel-chk');
      if(chk) chk.checked=on;
    });
    updateReviewMultiBar();
  }
  // 底栏计数与按钮可用态同步；批量进行中禁用双按钮防重复提交
  function updateReviewMultiBar(){
    const sel=window.__reviewSel||{};
    const n=Object.keys(sel).length;
    const cnt=document.getElementById('review-multi-count');
    if(cnt) cnt.textContent='已选 '+n+' 条';
    const all=document.getElementById('review-multi-select-all');
    if(all) all.checked=!!window.__reviewQueue&&window.__reviewQueue.length>0&&n>=window.__reviewQueue.length;
    const busy=!!window.__reviewBatchBusy;
    const ba=document.getElementById('review-batch-approve'), br=document.getElementById('review-batch-reject');
    if(ba) ba.disabled=busy||n===0;
    if(br) br.disabled=busy||n===0;
  }
  // 批量裁决：前端顺序调现有单条接口（0919 拍板），逐条计成功/失败，完成后刷新队列
  async function batchReviewDecide(decision){
    if(window.__reviewBatchBusy) return;
    const ids=Object.keys(window.__reviewSel||{});
    if(!ids.length){ toast('先勾选至少一条候选'); return; }
    const isReject=decision==='reject';
    if(!confirm(isReject
      ?'将驳回选中的 '+ids.length+' 条候选？驳回后从队列移除、不可恢复。'
      :'将通过入库选中的 '+ids.length+' 条候选？入库后可在记忆池查看。')) return;
    window.__reviewBatchBusy=true;
    updateReviewMultiBar();
    let ok=0, fail=0, sunk=0;
    for(let i=0;i<ids.length;i++){
      const cnt=document.getElementById('review-multi-count');
      if(cnt) cnt.textContent='处理中 '+(i+1)+'/'+ids.length+'…';
      try{
        const r=await fetch(ADMIN_API+'/memory-review/queue/'+encodeURIComponent(ids[i])+'/'+(isReject?'reject':'approve'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        const j=await r.json();
        if(j.error) throw new Error(j.error);
        ok++;
        if(j.backfill&&j.backfill.old) sunk+=j.backfill.old.filter(function(x){return x.superseded;}).length;
      }catch(e){ fail++; }
    }
    window.__reviewBatchBusy=false;
    window.__reviewMultiSel=false;
    window.__reviewSel={};
    toast('批量'+(isReject?'驳回':'通过入库')+'完成：成功 '+ok+' 条'+(sunk?'，旧条目沉底 '+sunk+' 条':'')+(fail?' / 失败 '+fail+' 条':''));
    loadReviewQueue();
  }
  async function approveReviewItem(id){
    try{
      const r=await fetch(ADMIN_API + '/memory-review/queue/'+encodeURIComponent(id)+'/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const j=await r.json();
      if(j.error) throw new Error(j.error);
      const bf=j.backfill;
      if(bf&&bf.old&&bf.old.length){
        const n=bf.old.filter(function(x){return x.superseded;}).length;
        toast('已通过入库，旧条目 '+n+'/'+bf.old.length+' 条已沉底'+(n<bf.old.length?'（其余已不在生效状态）':''));
      }else{
        toast('已通过入库，可在记忆池查看');
      }
    }catch(e){ toast('通过失败: '+e.message); }
    loadReviewQueue();
  }
  async function rejectReviewItem(id){
    try{
      const r=await fetch(ADMIN_API + '/memory-review/queue/'+encodeURIComponent(id)+'/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const j=await r.json();
      if(j.error) throw new Error(j.error);
      toast('已驳回');
    }catch(e){ toast('驳回失败: '+e.message); }
    loadReviewQueue();
  }
  function openMemPoolAdd(){
    AppState.memPoolEditId=null;
    populateMemPoolCatOptions();
    const ed=document.getElementById('mempool-edit-cat');
    if(ed)ed.value='fact';
    const ce=document.getElementById('mempool-edit-content');
    if(ce)ce.value='';
    document.getElementById('mempool-modal-title').textContent='新增记忆';
    openModal('mempoolEditModal');
  }
  function editMemPool(id){
    const items=window.__memPoolItems||[];
    const it=items.find(function(x){return x.id===id;});
    if(!it){ toast('未找到该记忆'); return; }
    AppState.memPoolEditId=id;
    populateMemPoolCatOptions();
    const ed=document.getElementById('mempool-edit-cat');
    if(ed){
      // 编辑下拉只有新五类：旧类条目（关于我们/锚点/信号/对话摘要）回落到「关于她」，保存时顺手归入新类
      const has=[].some.call(ed.options,function(o){return o.value===it.category;});
      ed.value=has?(it.category||'fact'):'fact';
      if(!has) toast('「'+it.category+'」是旧分类名，保存时会归入对应新分类，可先在下拉里选对');
    }
    const ce=document.getElementById('mempool-edit-content');
    if(ce)ce.value=it.content||'';
    document.getElementById('mempool-modal-title').textContent='编辑记忆';
    openModal('mempoolEditModal');
  }
  async function saveMemPoolEdit(){
    if(window.__reviewEditId){ return saveReviewEdit(); }
    const content=document.getElementById('mempool-edit-content').value.trim();
    const category=document.getElementById('mempool-edit-cat').value;
    if(!content){ toast('记忆内容不能为空'); return; }
    const url=AppState.memPoolEditId ? (ADMIN_API + '/memory-v2/entries/'+AppState.memPoolEditId) : (ADMIN_API + '/memory-v2/entries');
    try{
      const r=await apiRequest(AppState.memPoolEditId?'PUT':'POST', url, {content:content, category:category, direct:true}, {busy:document.getElementById('mp-save-btn')});
      if(!r.ok){ toast('保存失败: '+(r.error||('HTTP '+r.status))); return; }
      const d=r.data||{};
      if(d.error){ toast('保存失败: '+d.error); return; }
      toast(AppState.memPoolEditId?'记忆已更新':'记忆已新增');
      closeModal('mempoolEditModal');
      if(window.__memShowSimilar){ loadSimilarGroups(); } else { loadMemPool(); }
    }catch(e){ toast('网络错误: '+e.message); }
  }
  async function sinkMemPool(id){
    if(!confirm('沉底该条记忆？沉底后不再参与检索浮现。'))return;
    try{
      const r=await fetch(ADMIN_API+'/memory-v2/entries/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'archive'})});
      const d=await r.json().catch(function(){return {};});
      if(d.error){ toast('操作失败: '+d.error); return; }
      toast('已归档'); loadMemPool();
    }catch(e){ toast('操作失败: '+e.message); }
  }
  async function reviveMemPool(id){
    try{
      const r=await fetch(ADMIN_API+'/memory-v2/entries/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'revive'})});
      const dv=await r.json().catch(function(){return {};});
      if(dv.error){ toast('操作失败: '+dv.error); return; }
      toast('已恢复'); loadMemPool();
    }catch(e){ toast('操作失败: '+e.message); }
  }
  async function togglePinMemPool(id, v){
    try{
      const r=await fetch(ADMIN_API+'/memory-v2/entries/'+id+'/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned:!!v})});
      const d=await r.json();
      if(d.error){ toast('置顶失败: '+d.error); return; }
      toast(v?'已置顶（常驻上下文）':'已取消置顶'); loadMemPool();
    }catch(e){ toast('网络错误: '+e.message); }
  }
  async function deleteMemPool(id){
    if(!confirm('彻底删除该条记忆？此操作不可恢复（沉底/归档才是可恢复的）。'))return;
    try{
      const r=await fetch(ADMIN_API+'/memory-v2/entries/'+id+'/delete',{method:'POST'});
      const d=await r.json();
      if(d.error){ toast('删除失败: '+d.error); return; }
      toast('已彻底删除'); loadMemPool();
    }catch(e){ toast('操作失败: '+e.message); }
  }
 // 词云加载与画布渲染（loadMemCloud / renderWordCloud / selectCloudWord）
 async function loadMemCloud(){
   const el=document.getElementById('mem-cloud');
   if(!el)return;
   el.innerHTML=skeletonHtml(6);
   try{
     const r=await fetch(ADMIN_API + '/context-compaction/keywords?limit=80');
     const j=await r.json();
     renderWordCloud(el,j.keywords||[]);
   }catch(e){el.innerHTML='<div class="empty">加载失败: '+e.message+'</div>'}
 }
 function renderWordCloud(el,words){
   el.innerHTML='';
   if(!words.length){el.innerHTML='<div class="empty">暂无上下文可统计</div>';return}
   const max=words[0].weight||1;
   const pad=18;
   const W=Math.max(300,(el.clientWidth||320)-pad*2), H=Math.max(360,Math.min(540,Math.round(W*0.55)));
   const pickColor=function(ratio){
     if(ratio>=0.72)return '#6a4848';
     if(ratio>=0.45)return '#a5827f';
     if(ratio>=0.22)return '#c3a8a4';
     return '#cdbeb9';
   };
   // 自动缩放字号：按预估占用面积，超出画布 80% 就整体缩小，保证都能放下
   const est=words.reduce(function(s,k){
     const ratio=k.weight/max, size=13+26*ratio;
     return s+(k.word.length*size*0.92+12)*(size+10);
   },0);
   const avail=(W-10)*(H-10)*0.8;
   const scaleF=Math.min(1,Math.sqrt(avail/Math.max(1,est)));
   const canvas=document.createElement('canvas');
   canvas.width=W*2; canvas.height=H*2;
   canvas.style.width=W+'px'; canvas.style.height=H+'px';
   canvas.style.display='block'; canvas.style.margin='0 auto';
   canvas.title='点击词查看相关对话';
   el.appendChild(canvas);
   const ctx=canvas.getContext('2d');
   ctx.scale(2,2);
   // 网格占用：已放置的词占住格子，新词检测候选位置是否冲突
   const CELL=4, cols=Math.ceil(W/CELL), rows=Math.ceil(H/CELL);
   const grid=new Uint8Array(cols*rows);
   function cellFree(x,y,bw,bh){
     const x0=Math.max(0,Math.floor((x-bw/2)/CELL)), x1=Math.min(cols-1,Math.floor((x+bw/2)/CELL));
     const y0=Math.max(0,Math.floor((y-bh/2)/CELL)), y1=Math.min(rows-1,Math.floor((y+bh/2)/CELL));
     for(let cy=y0;cy<=y1;cy++)for(let cx=x0;cx<=x1;cx++){if(grid[cy*cols+cx])return false}
     return true;
   }
   function markCells(x,y,bw,bh){
     const x0=Math.max(0,Math.floor((x-bw/2)/CELL)), x1=Math.min(cols-1,Math.floor((x+bw/2)/CELL));
     const y0=Math.max(0,Math.floor((y-bh/2)/CELL)), y1=Math.min(rows-1,Math.floor((y+bh/2)/CELL));
     for(let cy=y0;cy<=y1;cy++)for(let cx=x0;cx<=x1;cx++)grid[cy*cols+cx]=1;
   }
   const placed=[];
   const R=Math.hypot(W,H)/2;
   const fontFamily='"YouYuan","幼圆","Yuanti SC","STYuanti","圆体-简",sans-serif';
   words.forEach(function(k,i){
     const ratio=k.weight/max;
     let done=false;
     // 由内向外逐环扫描；放不下就缩小字号再试
     for(const scl of [1,0.85,0.7]){
       const size=Math.max(11,Math.round((13+26*ratio)*scaleF*scl));
       const w=k.word.length*size*0.92;
       const bw=w+12, bh=size+10;
       let found=false,px=0,py=0;
       for(let rad=8;rad<R&&!found;rad+=2){
         const arc=Math.max(1,Math.round(rad*2*Math.PI/5));
         for(let a=0;a<arc&&!found;a++){
           const theta=(a/arc)*Math.PI*2+(rad%7)*0.17;
           const x=W/2+rad*Math.cos(theta);
           const y=H/2+rad*Math.sin(theta);
           if(x-bw/2>=8&&x+bw/2<=W-8&&y-bh/2>=8&&y+bh/2<=H-8){
             if(cellFree(x,y,bw,bh)){found=true;px=x;py=y}
           }
         }
       }
       if(found){
         placed.push({word:k.word,x:px,y:py,bw:bw,bh:bh,size:size,color:pickColor(ratio),alpha:0.62+0.38*ratio,hoverColor:(ratio>=0.72?'#5a3a3a':'#6a4848')});
         markCells(px,py,bw,bh);
         done=true;
         break;
       }
     }
     if(!done)return;
   });
   let hoverIdx=-1;
   const draw=function(hover){
     ctx.clearRect(0,0,W,H);
     placed.forEach(function(p,idx){
       const s=hover===idx?Math.round(p.size*1.14):p.size;
       ctx.font=s+'px '+fontFamily;
       ctx.textAlign='center'; ctx.textBaseline='middle';
       ctx.globalAlpha=p.alpha;
       ctx.fillStyle=(hover===idx?p.hoverColor:p.color);
       ctx.fillText(p.word,p.x,p.y);
       ctx.globalAlpha=1;
     });
   };
   draw(-1);
   canvas.addEventListener('mousemove',function(e){
     const rect=canvas.getBoundingClientRect();
     const x=e.clientX-rect.left, y=e.clientY-rect.top;
     let hit=-1;
     for(let k2=0;k2<placed.length;k2++){
       const p=placed[k2];
       if(x>=p.x-p.bw/2&&x<=p.x+p.bw/2&&y>=p.y-p.bh/2&&y<=p.y+p.bh/2){hit=k2;break;}
     }
     if(hit!==hoverIdx){hoverIdx=hit;draw(hit);}
     canvas.style.cursor=hit>=0?'pointer':'default';
   });
   canvas.addEventListener('mouseleave',function(){
     if(hoverIdx!==-1){hoverIdx=-1;draw(-1);}
     canvas.style.cursor='default';
   });
   canvas.addEventListener('click',function(e){
     const rect=canvas.getBoundingClientRect();
     const x=e.clientX-rect.left, y=e.clientY-rect.top;
     for(const p of placed){
       if(x>=p.x-p.bw/2&&x<=p.x+p.bw/2&&y>=p.y-p.bh/2&&y<=p.y+p.bh/2){
         selectCloudWord(p.word);
         return;
       }
     }
   });
 }
 
 function fmtCcClock(iso){
   if(!iso)return '';
   try{return new Date(iso).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}catch(e){return iso;}
 }
 async function selectCloudWord(word){
   const drawer=document.getElementById('cloudDrawer');
   const title=document.getElementById('cloudDrawerTitle');
   const el=document.getElementById('cloud-results');
   if(!el)return;
   if(drawer)drawer.classList.add('open');
   if(title)title.textContent='关键词「'+word+'」相关对话';
   el.innerHTML='<div class="loading">检索「'+word+'」...</div>';
   try{
     const r=await fetch(ADMIN_API+'/context/keywords/related?word='+encodeURIComponent(word));
     const j=await r.json();
     const segs=j.segments||[];
     if(!segs.length){el.innerHTML='<div class="similar-empty">没有找到相关对话</div>';return}
     el.innerHTML='<div class="cloud-results-title">命中 '+j.total+' 条消息 · '+segs.length+' 段对话</div>'+
       segs.map(function(s){
         const range=(s.startTime||s.endTime)?fmtCcClock(s.startTime)+' ~ '+fmtCcClock(s.endTime):'';
         return '<div class="cloud-res-item">'+
           '<div class="cloud-res-meta"><div class="cloud-res-left"><span class="cloud-res-time">'+escapeHtml(range)+'</span></div>'+
           '<span class="cloud-res-imp">命中 '+s.count+' 条</span></div>'+
           '<div class="cloud-res-content">'+escapeHtml(s.preview||'')+'</div>'+
           '</div>';
       }).join('');
   }catch(err){el.innerHTML='<div class="similar-empty">加载失败: '+escapeHtml(err.message)+'</div>'}
 }
 function closeCloudDrawer(){
   const d=document.getElementById('cloudDrawer');
   if(d)d.classList.remove('open');
 }
 
 initApp();
 
 
