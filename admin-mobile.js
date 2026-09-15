
// ============================================================================
// 心跳唤醒管理台 · 移动端（admin-mobile.html）
// 单文件模板：样式 / 结构 / 逻辑集中在同一文件，由 server.js 每请求读取下发。
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
  visionModels: [],                // 视觉模型列表
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
   try{ if(typeof loadReplaceLog==='function') loadReplaceLog(); }catch(e){}
 }

 async function initApp(){
   initCollapsibleCards();
   // 恢复上次停留的导航 tab（刷新后不再回到心跳页）
   try{
     let savedTab = localStorage.getItem('adminTab');
     try{ const qp=new URLSearchParams(location.search); const t=qp.get('tab'); if(t) savedTab=t; }catch(e){}
     if(savedTab && ['status','config','memory','compaction','prompts','system'].indexOf(savedTab)>=0 && savedTab!=='status'){
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
   renderVisionModels();
   renderCoView();
   renderScreenshotStatus();
   loadMemoryWakeConfig();
   renderDiary();
   initAdminSessionSelector();
   // 日记分组标题需要会话名：异步加载后补渲染一次（不阻塞首屏）
   loadDiarySessionNames().then(()=>renderDiary()).catch(()=>{});
   loadPapers();
 }

 // ---------- 留纸一览（2026-09-12）：AI 留的纸（故事/梦/创作），只读+删除 ----------
 let viewingPaperPath = null;
 async function loadPapers(){
   try{
     const r=await fetch(ADMIN_API+'/papers');
     if(!r.ok){return;}
     const j=await r.json();
     AppState._papers=j.papers||[];
     renderPapers(AppState._papers);
   }catch(e){}
 }
 function renderPapers(list){
   const el=document.getElementById('papers-list');
   if(!el)return;
   if(!list.length){el.innerHTML='<div class="empty">还没有留过纸</div>';return}
   const groups=new Map();const order=[];
   for(const e of list){
     const k=e.session||'__shared__';
     if(!groups.has(k)){groups.set(k,[]);order.push(k);}
     groups.get(k).push(e);
   }
   order.sort((a,b)=>{if(a==='__shared__')return -1;if(b==='__shared__')return 1;return a<b?-1:1;});
   el.innerHTML=order.map(k=>{
     const g=groups.get(k);
     const label=k==='__shared__'?'共享（未归属窗口）':((ADM_SESSION_NAMES[k]?ADM_SESSION_NAMES[k]+' · ':'')+'窗口 '+k);
     return '<div style="margin:12px 0 6px;font-size:12px;font-weight:600;color:var(--text2);display:flex;align-items:center;gap:6px">'+escapeHtml(label)+'<em style="font-style:normal;font-weight:400;opacity:.7">'+g.length+' 张</em></div>'+g.map(e=>{
       const key=e.relPath||'';
       const title=e.title||String(e.content||'').replace(/^#.*\n/,'').replace(/^（[^）]*）\s*/,'').slice(0,40)||'(无标题)';
       return '<div class="diary-item"><div class="diary-head"><span style="cursor:pointer" onclick="viewPaper(\''+escJsStr(key)+'\')">'+escapeHtml(title)+'</span><span style="display:flex;align-items:center;gap:8px"><em>'+escapeHtml(e.time||'')+'</em><button class="diary-hide-btn" onclick="deletePaper(\''+escJsStr(key)+'\')">删除</button></span></div></div>';
     }).join('');
   }).join('');
 }
 function paperFromList(relPath){
   return (AppState._papers||[]).find(e=>e.relPath===relPath);
 }
 async function viewPaper(relPath){
   try{
     const r=await fetch(ADMIN_API+'/papers');
     const j=await r.json();
     AppState._papers=j.papers||[];
     const e=paperFromList(relPath);
     if(!e){toast('找不到这张纸');return;}
     viewingPaperPath=relPath;
     document.getElementById('paper-view-title').textContent=e.title||'留纸';
     document.getElementById('paper-view-meta').textContent=(e.time||'')+(e.session?(' · 窗口 '+e.session):'');
     document.getElementById('paper-view-content').textContent=e.content||'';
     openModal('paperViewModal');
   }catch(e){toast('加载失败: '+e.message);}
 }
 async function deletePaper(relPath){
   if(!confirm('删除这张纸（'+relPath+'）？删除后不可恢复。'))return;
   try{
     const r=await fetch(ADMIN_API+'/papers/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:relPath})});
     const j=await r.json();
     if(j.success){
       toast('已删除');
       closeModal('paperViewModal');
       loadPapers();
     }else{
       toast('删除失败: '+j.error);
     }
   }catch(e){toast('网络错误: '+e.message);}
 }
 async function deletePaperFromView(){
   if(viewingPaperPath) await deletePaper(viewingPaperPath);
 }
 
  // ---------- 摘要生成日志（悬浮球 + 弹窗，可拖动） ----------
 let lastLogId = null;
 let logPollTimer = null;
 let unreadPollTimer = null;
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
     if(saved.x !== undefined) fab.style.left = saved.x + 'px';
     if(saved.y !== undefined) fab.style.top = saved.y + 'px';
     if(saved.x !== undefined || saved.y !== undefined){
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
     stopLogPolling();
   }
 }

 function closeLogPanel(){
   const panel = document.getElementById('logPanel');
   if(panel) panel.classList.remove('show');
   AppState.logPanelOpen = false;
   stopLogPolling();
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

 async function loadCompactionLogs(){
   try {
     const r = await fetch(ADMIN_API + '/context-compaction/logs');
     const d = await r.json();
     if(d && d.logs){
       renderLogs(d.logs);
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
   startUnreadPoll();
 });

 function checkUnreadLogs(){
   if(document.hidden || AppState.logPanelOpen) return;
   fetch(ADMIN_API + '/context-compaction/logs').then(r=>r.json()).then(function(d){
     if(d && d.logs && d.logs.length > 0){
       if(lastLogId && d.logs[0].id !== lastLogId){
         AppState.unreadLogCount++;
         lastLogId = d.logs[0].id;   // 必须对齐：原来只自增不更新，角标变成"每 5 秒 +1"的轮询计数
         updateLogBadge();
       }
       if(!lastLogId) lastLogId = d.logs[0].id;
     }
   }).catch(()=>{});
 }
 function startUnreadPoll(){
   if(unreadPollTimer) return;
   unreadPollTimer = setInterval(checkUnreadLogs, 5000);
 }
 function stopUnreadPoll(){
   if(unreadPollTimer){ clearInterval(unreadPollTimer); unreadPollTimer=null; }
 }

 // 页面切到后台/切回时暂停或恢复后台轮询，避免隐藏页持续请求
 document.addEventListener('visibilitychange', function(){
   if(document.hidden){
     stopUnreadPoll();
     stopLogPolling();
     stopLogsAutoRefresh();
   }else{
     startUnreadPoll();
     if(AppState.logPanelOpen) startLogPolling();
     let cur=''; try{ cur=localStorage.getItem('adminTab')||''; }catch(e){}
     if(cur==='system') startLogsAutoRefresh();
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
   const keys=['TARGET_API_URL','TARGET_API_KEY','MODEL_NAME','BARK_KEY','GATEWAY_API_KEY','CUSTOM_ICON_URL','ALLOW_PUBLIC_API','PUSH_PROVIDER','NTFY_SERVER_URL','NTFY_TOPIC','NTFY_TOKEN','NTFY_PRIORITY','NTFY_TAGS','USER_DISPLAY_NAME','AI_DISPLAY_NAME','WEATHER_ENABLED','WEATHER_LOCATION_NAME','WEATHER_LAT','WEATHER_LON','DIARY_ENABLED','DIARY_DIR','PORT'];
   const SECRET_KEYS=new Set(['TARGET_API_KEY','BARK_KEY','GATEWAY_API_KEY','NTFY_TOKEN']);
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
   const keys=['TARGET_API_URL','TARGET_API_KEY','GATEWAY_API_KEY','MODEL_NAME','BARK_KEY','CUSTOM_ICON_URL','DAY_WAKE_AFTER_MINUTES','NIGHT_WAKE_AFTER_MINUTES','DAY_CHECK_INTERVAL_MINUTES','NIGHT_CHECK_INTERVAL_MINUTES','WAKE_DAY_START_HOUR','WAKE_DAY_END_HOUR','WEATHER_ENABLED','WEATHER_LOCATION_NAME','WEATHER_LAT','WEATHER_LON','WEATHER_UNITS','ALLOW_PUBLIC_API','PUSH_PROVIDER','NTFY_SERVER_URL','NTFY_TOPIC','NTFY_TOKEN','NTFY_PRIORITY','NTFY_TAGS','USER_DISPLAY_NAME','AI_DISPLAY_NAME','DIARY_ENABLED'];
   const SECRET_KEYS=new Set(['TARGET_API_KEY','BARK_KEY','GATEWAY_API_KEY','NTFY_TOKEN']);
   document.getElementById('env-editor-fields').innerHTML=keys.map(k=>{
     const v=AppState.INITIAL_DATA.env[k]||'';
     if(k==='ALLOW_PUBLIC_API'){
       return '<div class="form-group"><label>ALLOW_PUBLIC_API <span style="color:var(--text3);font-size:11px">公网 /v1 开关</span></label><select id="env-'+k+'"><option value="true"'+(v==='true'?' selected':'')+'>开启（需 GATEWAY_API_KEY）</option><option value="false"'+(v!=='true'?' selected':'')+'>关闭（仅内网）</option></select></div>';
     }
     if(k==='PUSH_PROVIDER'){
       return '<div class="form-group"><label>PUSH_PROVIDER <span style="color:var(--text3);font-size:11px">推送渠道</span></label><select id="env-'+k+'"><option value="bark"'+(v==='bark'||!v?' selected':'')+'>bark</option><option value="ntfy"'+(v==='ntfy'?' selected':'')+'>ntfy</option></select></div>';
     }
     const ph=SECRET_KEYS.has(k)?' placeholder="'+(AppState.INITIAL_DATA.env[k+'_SET']?'已设置，留空不修改':'未设置，留空保存')+'"':'';
     return '<div class="form-group"><label>'+k+'</label><input type="text" id="env-'+k+'" value="'+escapeHtml(v)+'"'+ph+'></div>';
   }).join('');
   openModal('envModal');
 }
 
 async function saveEnv(){
   const keyMap={'TARGET_API_URL':'target_url','TARGET_API_KEY':'target_key','GATEWAY_API_KEY':'gateway_api_key','MODEL_NAME':'model_name','BARK_KEY':'bark_key','CUSTOM_ICON_URL':'custom_icon','DAY_WAKE_AFTER_MINUTES':'day_wake_after','NIGHT_WAKE_AFTER_MINUTES':'night_wake_after','DAY_CHECK_INTERVAL_MINUTES':'day_check_interval','NIGHT_CHECK_INTERVAL_MINUTES':'night_check_interval','WAKE_DAY_START_HOUR':'wake_day_start_hour','WAKE_DAY_END_HOUR':'wake_day_end_hour','WEATHER_ENABLED':'weather_enabled','WEATHER_LOCATION_NAME':'weather_location_name','WEATHER_LAT':'weather_lat','WEATHER_LON':'weather_lon','WEATHER_UNITS':'weather_units','ALLOW_PUBLIC_API':'all_public_api','PUSH_PROVIDER':'push_provider','NTFY_SERVER_URL':'ntfy_server_url','NTFY_TOPIC':'ntfy_topic','NTFY_TOKEN':'ntfy_token','NTFY_PRIORITY':'ntfy_priority','NTFY_TAGS':'ntfy_tags','USER_DISPLAY_NAME':'user_display_name','AI_DISPLAY_NAME':'ai_display_name','DIARY_ENABLED':'diary_enabled'};
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
 
 function renderVisionModels(){
   const el=document.getElementById('vision-models-list');
   const count=document.getElementById('vision-models-count');
   if(!el)return;
   el.innerHTML='<div class="empty">加载中…</div>';
   fetch(ADMIN_API + '/vision-models').then(r=>r.json()).then(j=>{
     if(!j.success){el.innerHTML='<div class="empty">加载失败</div>';return}
     AppState.visionModels=Array.isArray(j.models)?j.models:[];
     paintVisionModels(el,count);
     renderCoView();
     renderScreenshotStatus();
   }).catch(e=>{el.innerHTML='<div class="empty">加载失败: '+escapeHtml(e.message)+'</div>'});
 }
 
 function paintVisionModels(el,count){
   if(count)count.textContent=AppState.visionModels.length+' 个';
   if(!AppState.visionModels.length){el.innerHTML='<div class="empty">还没有视觉模型，点「编辑视觉模型」添加</div>';return}
   el.innerHTML=AppState.visionModels.map(m=>{
     const ok=!!(m.api_key_set||(m.api_key&&String(m.api_key).trim()));
     return '<div class="vm-row"><span class="vm-dot" style="background:'+(ok?'#2ecc71':'#bbb')+'"></span><span class="vm-name">'+escapeHtml(m.name||'未命名')+'</span><span class="vm-model">'+escapeHtml(m.model||'')+'</span></div>';
   }).join('');
 }
 
 function openVisionModelsEditor(){
   const el=document.getElementById('vision-models-edit-list');
   if(!el)return;
   paintVisionModelsEdit(el);
   openModal('visionModelsModal');
 }
 
 function paintVisionModelsEdit(el){
   if(!AppState.visionModels.length){el.innerHTML='<div class="empty">还没有视觉模型，点「新增视觉模型」添加</div>';return}
   el.innerHTML=AppState.visionModels.map(m=>visionModelRow(m)).join('');
 }
 
 function visionModelRow(m){
   const ok=!!(m.api_key&&String(m.api_key).trim());
   return '<div class="vm-item'+(m._new?' expanded':'')+'" data-id="'+escapeHtml(m.id)+'">'
     +'<div class="vm-head" onclick="toggleVisionModel(this)">'
     +'<span class="vm-dot" style="background:'+(ok?'#2ecc71':'#bbb')+'"></span>'
     +'<span class="vm-name">'+escapeHtml(m.name||'未命名')+'</span>'
     +'<span class="vm-model">'+escapeHtml(m.model||'')+'</span>'
     +'<span class="collapse-arrow">▾</span>'
     +'</div>'
     +'<div class="vm-body">'
     +'<div class="form-group"><label>名称</label><input value="'+escapeHtml(m.name||'')+'" data-f="name"></div>'
     +'<div class="form-group"><label>API 地址</label><input value="'+escapeHtml(m.api_url||'')+'" data-f="api_url" placeholder="https://…"></div>'
     +'<div class="form-group"><label>API Key</label><input type="password" value="'+escapeHtml(m.api_key||'')+'" data-f="api_key" placeholder="留空 = 保持现有 Key（状态灯看是否已配置）"></div>'
     +'<div class="form-group"><label>模型名</label><input value="'+escapeHtml(m.model||'')+'" data-f="model" placeholder="如 glm-4v-flash"></div>'
     +'<button class="btn btn-outline vm-del" onclick="removeVisionModel(this)">删除</button>'
     +'</div>'
     +'</div>';
 }
 
 function toggleVisionModel(head){
   head.parentElement.classList.toggle('expanded');
 }
 
 function addVisionModel(){
   AppState.visionModels.push({id:'m'+Date.now(),name:'',api_url:'',api_key:'',model:'',_new:true});
   const el=document.getElementById('vision-models-edit-list');
   paintVisionModelsEdit(el);
   const items=el.querySelectorAll('.vm-item');
   const last=items[items.length-1];
   if(last){last.classList.add('expanded');const inp=last.querySelector('input[data-f="name"]');if(inp)inp.focus();}
 }
 
 function removeVisionModel(btn){
   const item=btn.closest('.vm-item');
   if(!item)return;
   const id=item.getAttribute('data-id');
   AppState.visionModels=AppState.visionModels.filter(m=>m.id!==id);
   paintVisionModelsEdit(document.getElementById('vision-models-edit-list'));
 }
 
 function collectVisionModels(){
   document.querySelectorAll('#vision-models-edit-list .vm-item').forEach(item=>{
     const id=item.getAttribute('data-id');
     const m=AppState.visionModels.find(x=>x.id===id);
     if(!m)return;
     item.querySelectorAll('input[data-f]').forEach(inp=>{
       m[inp.getAttribute('data-f')]=inp.value.trim();
     });
     delete m._new;
   });
 }
 
 async function saveVisionModels(){
   collectVisionModels();
   const clean=AppState.visionModels.map(m=>({id:m.id,name:m.name,api_url:m.api_url,api_key:m.api_key,model:m.model}));
   try{
     const r=await apiRequest('POST', ADMIN_API + '/vision-models', {models:clean}, {busy:document.getElementById('vm-save-btn')});
     if(!r.ok) return;
     const j=r.data||{};
     if(j.success){
       toast('视觉模型已保存');
       closeModal('visionModelsModal');
       renderVisionModels();
     }else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误: '+e.message)}
 }
 
 function visionModelsOptionHtml(selId){
   let s='<option value="">未选择</option>';
   AppState.visionModels.forEach(m=>{
     s+='<option value="'+escapeHtml(m.id)+'"'+(m.id===selId?' selected':'')+'>'+escapeHtml((m.name||'未命名')+(m.model?'（'+m.model+'）':''))+'</option>';
   });
   return s;
 }
 
 function selectedVisionModelName(id){
   const m=AppState.visionModels.find(x=>x.id===id);
   if(!m)return '未选择';
   return (m.name||'未命名')+(m.model?'（'+m.model+'）':'');
 }
 
 // ============ 共影环境 ============
 function renderCoView(){
   const el=document.getElementById('co-view-status');
   if(!el)return;
   el.innerHTML='<div class="empty">加载中…</div>';
   fetch(ADMIN_API + '/config').then(r=>r.json()).then(cfg=>{
     if(!cfg||typeof cfg!=='object'){el.innerHTML='<div class="empty">加载失败</div>';return}
     const vm=AppState.visionModels.find(m=>m.id===cfg.co_vision_model_id);
   const ok=!!(vm&&(vm.api_key_set||(vm.api_key&&String(vm.api_key).trim())));
     let rows='';
     rows+='<div class="env-row"><span class="env-key">视觉模型</span><span class="env-val">'+escapeHtml(selectedVisionModelName(cfg.co_vision_model_id))+'</span></div>';
     rows+='<div class="env-row"><span class="env-key">定时截帧间隔</span><span class="env-val">'+escapeHtml(String(cfg.co_frame_interval!=null?cfg.co_frame_interval:30))+' 秒</span></div>';
     rows+='<div class="env-row"><span class="env-key">手动查看采样</span><span class="env-val">'+escapeHtml(String(cfg.co_peek_seconds!=null?cfg.co_peek_seconds:3))+' 秒</span></div>';
     rows+='<div class="env-row"><span class="env-key">状态</span><span class="env-val">'+(ok?'<span style="color:var(--accent)">视觉模型已配置</span>':'<span style="color:#c0392b">视觉模型未配置或未选择</span>')+'</span></div>';
     el.innerHTML=rows;
   }).catch(e=>{el.innerHTML='<div class="empty">加载失败: '+escapeHtml(e.message)+'</div>'});
 }
 
 function openCoViewEditor(){
   document.getElementById('co-model-select').innerHTML=visionModelsOptionHtml('');
   document.getElementById('co-frame-interval').value='';
   document.getElementById('co-peek-seconds').value='';
   fetch(ADMIN_API + '/config').then(r=>r.json()).then(cfg=>{
     if(!cfg||typeof cfg!=='object')return;
     document.getElementById('co-model-select').innerHTML=visionModelsOptionHtml(cfg.co_vision_model_id);
     document.getElementById('co-frame-interval').value=cfg.co_frame_interval!=null?cfg.co_frame_interval:30;
     document.getElementById('co-peek-seconds').value=cfg.co_peek_seconds!=null?cfg.co_peek_seconds:3;
     openModal('coViewModal');
   }).catch(e=>{toast('读取配置失败: '+e.message)});
 }
 
 async function saveCoViewConfig(){
   const updates={};
   updates.co_vision_model_id=document.getElementById('co-model-select').value;
   const interval=parseFloat(document.getElementById('co-frame-interval').value);
   if(Number.isFinite(interval)&&interval>=5)updates.co_frame_interval=interval;
   const peek=parseFloat(document.getElementById('co-peek-seconds').value);
   if(Number.isFinite(peek)&&peek>=1&&peek<=10)updates.co_peek_seconds=peek;
   try{
     const r=await apiRequest('POST', ADMIN_API + '/config', updates, {busy:document.getElementById('covew-save-btn')});
     if(!r.ok) return;
     const j=r.data||{};
     if(j.success){toast('共影环境已保存');closeModal('coViewModal');renderCoView();}
     else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误: '+e.message)}
 }
 
 // ============ 截图上传 ============
 function renderScreenshotStatus(){
   const el=document.getElementById('screenshot-status');
   if(!el)return;
   el.innerHTML='<div class="empty">加载中…</div>';
   fetch(ADMIN_API + '/config').then(r=>r.json()).then(cfg=>{
     if(!cfg||typeof cfg!=='object'){el.innerHTML='<div class="empty">加载失败</div>';return}
     const vm=AppState.visionModels.find(m=>m.id===cfg.screenshot_vision_model_id);
   const ok=!!(vm&&(vm.api_key_set||(vm.api_key&&String(vm.api_key).trim())));
     const wake=!!cfg.screenshot_wake_enabled;
     const inject=!!(cfg.event_inject_types&&cfg.event_inject_types.includes&&cfg.event_inject_types.includes('screenshot'));
     let rows='';
     rows+='<div class="env-row"><span class="env-key">视觉模型</span><span class="env-val">'+escapeHtml(selectedVisionModelName(cfg.screenshot_vision_model_id))+'</span></div>';
     rows+='<div class="env-row"><span class="env-key">截图唤醒</span><span class="env-val">'+(wake?'<span style="color:var(--accent)">已开启</span>':'<span style="color:var(--text3)">已关闭</span>')+'</span></div>';
     rows+='<div class="env-row"><span class="env-key">注入上下文</span><span class="env-val">'+(inject?'<span style="color:var(--accent)">已开启</span>':'<span style="color:var(--text3)">已关闭</span>')+'</span></div>';
     rows+='<div class="env-row"><span class="env-key">状态</span><span class="env-val">'+(ok?'<span style="color:var(--accent)">视觉模型已配置</span>':'<span style="color:#c0392b">视觉模型未配置或未选择</span>')+'</span></div>';
     rows+='<div class="env-row"><span class="env-key">上传接口</span><span class="env-val" style="font-size:11px;font-family:monospace">/screenshot-api/wake</span></div>';
     el.innerHTML=rows;
   }).catch(e=>{el.innerHTML='<div class="empty">加载失败: '+escapeHtml(e.message)+'</div>'});
 }
 
 function openScreenshotEditor(){
   document.getElementById('shot-model-select').innerHTML=visionModelsOptionHtml('');
   document.getElementById('screenshot-wake-switch').checked=false;
   document.getElementById('screenshot-inject-switch').checked=false;
   fetch(ADMIN_API + '/config').then(r=>r.json()).then(cfg=>{
     if(!cfg||typeof cfg!=='object')return;
     document.getElementById('shot-model-select').innerHTML=visionModelsOptionHtml(cfg.screenshot_vision_model_id);
     document.getElementById('screenshot-wake-switch').checked=!!cfg.screenshot_wake_enabled;
     document.getElementById('screenshot-inject-switch').checked=!!(cfg.event_inject_types&&cfg.event_inject_types.includes&&cfg.event_inject_types.includes('screenshot'));
     openModal('screenshotModal');
   }).catch(e=>{toast('读取配置失败: '+e.message)});
 }
 
 async function saveScreenshotConfig(){
   const updates={};
   updates.screenshot_vision_model_id=document.getElementById('shot-model-select').value;
   updates.screenshot_wake_enabled=document.getElementById('screenshot-wake-switch').checked;
   try{
     const cfgRes=await fetch(ADMIN_API + '/config');
     const cfg=await cfgRes.json();
     const types=Array.isArray(cfg.event_inject_types)?cfg.event_inject_types.slice():[];
     const has=types.includes('screenshot');
     const wantInject=document.getElementById('screenshot-inject-switch').checked;
     if(wantInject&&!has)types.push('screenshot');
     if(!wantInject&&has)types.splice(types.indexOf('screenshot'),1);
     updates.event_inject_types=types;
     const r=await apiRequest('POST', ADMIN_API + '/config', updates, {busy:document.getElementById('shot-save-btn')});
     if(!r.ok) return;
     const j=r.data||{};
     if(j.success){toast('截图上传已保存');closeModal('screenshotModal');renderScreenshotStatus();}
     else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误: '+e.message)}
 }
 
 // ============ 日志页：截图提示词 ============
  // ============ 记忆与唤醒参数 ============
  async function loadReparsePrompt(){
    const msg=document.getElementById('reparse-prompt-msg');
    try{
      const r=await fetch(ADMIN_API + '/memory-pool/config');
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
      const r=await fetch(ADMIN_API+'/memory-pool/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reparse_system_prompt:s.trim(),reparse_user_prompt:u.trim()})});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='保存失败: '+d.error; return; }
      if(msg) msg.textContent='已保存，下次解析入库/再解析生效。';
      toast('解析提示词已保存');
    }catch(e){ if(msg) msg.textContent='保存失败: '+e.message; }
  }
  async function resetReparsePrompt(){
    const s=document.getElementById('reparse-sys-prompt');
    const u=document.getElementById('reparse-user-prompt');
    const _c=await (await fetch(ADMIN_API + '/memory-pool/config')).json() || {};
    if(s) s.value=_c.default_reparse_system_prompt||'';
    if(u) u.value=_c.default_reparse_user_prompt||'';
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reparse_system_prompt:'',reparse_user_prompt:''})});
      const d=await r.json();
      if(d.error){ toast('恢复失败: '+d.error); return; }
      toast('已恢复内置默认提示词');
      const m=document.getElementById('reparse-prompt-msg'); if(m) m.textContent='已恢复内置默认';
    }catch(e){ toast('网络错误: '+e.message); }
  }

  async function loadCleanPrompt(){
    const msg=document.getElementById('clean-prompt-msg');
    try{
      const r=await fetch(ADMIN_API + '/memory-pool/clean/prompt');
      const c=await r.json();
      const s=document.getElementById('clean-sys-prompt'); if(s) s.value=c.clean_system_prompt||c.default_clean_system_prompt||'';
      const u=document.getElementById('clean-user-prompt'); if(u) u.value=c.clean_user_prompt||c.default_clean_user_prompt||'';
      if(msg) msg.textContent='已载入内置默认清洗提示词；可修改保存覆盖，或点「恢复内置默认」。';
    }catch(e){ if(msg) msg.textContent='读取清洗提示词失败: '+e.message; }
  }
  async function saveCleanPrompt(){
    const msg=document.getElementById('clean-prompt-msg');
    const s=document.getElementById('clean-sys-prompt').value;
    const u=document.getElementById('clean-user-prompt').value;
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clean_system_prompt:s.trim(),clean_user_prompt:u.trim()})});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='保存失败: '+d.error; return; }
      if(msg) msg.textContent='已保存，下次整理记忆池生效。';
      toast('清洗提示词已保存');
    }catch(e){ if(msg) msg.textContent='保存失败: '+e.message; }
  }
  async function resetCleanPrompt(){
    const s=document.getElementById('clean-sys-prompt');
    const u=document.getElementById('clean-user-prompt');
    const _c=await (await fetch(ADMIN_API + '/memory-pool/clean/prompt')).json() || {};
    if(s) s.value=_c.default_clean_system_prompt||'';
    if(u) u.value=_c.default_clean_user_prompt||'';
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clean_system_prompt:'',clean_user_prompt:''})});
      const d=await r.json();
      if(d.error){ toast('恢复失败: '+d.error); return; }
      toast('已恢复内置默认清洗提示词');
      const m=document.getElementById('clean-prompt-msg'); if(m) m.textContent='已恢复内置默认';
    }catch(e){ toast('网络错误: '+e.message); }
  }
  async function loadMemoryWakeConfig(){
    const msg=document.getElementById('memory-wake-config-msg');
    try{
      const r=await fetch(ADMIN_API + '/config');
      const c=await r.json();
      document.getElementById('mw-wake-history-max').value=c.wake_history_max_messages!=null?c.wake_history_max_messages:80;
    }catch(e){ if(msg)msg.textContent='读取记忆参数失败: '+e.message; }
    try{
      const r=await fetch(ADMIN_API + '/memory-pool/config');
      const c=await r.json();
      document.getElementById('mw-dedup').value=c.dedup_threshold!=null?c.dedup_threshold:0.78;

      document.getElementById('mw-decay-days').value=c.decay_days!=null?c.decay_days:30;
      document.getElementById('mw-auto-pin-count').value=c.auto_pin_retrieval_count!=null?c.auto_pin_retrieval_count:5;

       document.getElementById('mw-reparse-warm').checked=c.reparse_warm!==false;
        document.getElementById('mw-reparse-maxchars').value=c.reparse_max_chars!=null?c.reparse_max_chars:30;
        document.getElementById('mw-reparse-maxitems').value=c.reparse_max_items!=null?c.reparse_max_items:8;
        document.getElementById('mw-reparse-mergemaxchars').value=c.reparse_merge_max_chars!=null?c.reparse_merge_max_chars:8000;
      document.getElementById('mw-cross-enabled').checked=c.cross_inject_enabled!==false;
      document.getElementById('mw-cross-diary').checked=c.cross_inject_diary!==false;
      document.getElementById('mw-cross-memory').checked=c.cross_inject_memory!==false;
       document.getElementById('mw-cross-days').value=c.cross_inject_diary_count!=null?c.cross_inject_diary_count:3;
    }catch(e){ if(msg)msg.textContent='读取记忆池参数失败: '+e.message; }
    if(msg)msg.textContent='';
  }
  async function saveMemoryWakeConfig(){
    const msg=document.getElementById('memory-wake-config-msg');
    if(msg)msg.textContent='保存中...';
    const up={};
    up.wake_history_max_messages=Number(document.getElementById('mw-wake-history-max').value)||0;
    let saved=true;
    try{
      const r=await fetch(ADMIN_API+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(up)});
      const d=await r.json();
      if(d.error){ saved=false; if(msg)msg.textContent='记忆参数保存失败: '+d.error; }
    }catch(e){ saved=false; if(msg)msg.textContent='记忆参数保存失败: '+e.message; }
    const up2={};
    up2.dedup_threshold=Number(document.getElementById('mw-dedup').value)||0.78;

    up2.decay_days=Number(document.getElementById('mw-decay-days').value)||30;
    up2.auto_pin_retrieval_count=Math.max(2, Number(document.getElementById('mw-auto-pin-count').value)||5);

     up2.reparse_warm=document.getElementById('mw-reparse-warm').checked;
      up2.reparse_max_chars=Number(document.getElementById('mw-reparse-maxchars').value)||30;
      up2.reparse_max_items=Number(document.getElementById('mw-reparse-maxitems').value)||8;
      up2.reparse_merge_max_chars=Number(document.getElementById('mw-reparse-mergemaxchars').value)||8000;
    up2.cross_inject_enabled=document.getElementById('mw-cross-enabled').checked;
    up2.cross_inject_diary=document.getElementById('mw-cross-diary').checked;
    up2.cross_inject_memory=document.getElementById('mw-cross-memory').checked;
     up2.cross_inject_diary_count=Number(document.getElementById('mw-cross-days').value)||3;
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(up2)});
      const d=await r.json();
      if(d.error){ saved=false; if(msg)msg.textContent='记忆池参数保存失败: '+d.error; }
    }catch(e){ saved=false; if(msg)msg.textContent='记忆池参数保存失败: '+e.message; }
    if(saved){ toast('记忆与唤醒参数已保存'); if(msg)msg.textContent='已保存，下次请求/重启生效（跨窗口注入即时生效）。'; }
  }
  async function clearRetrievalStats(){
    if(!confirm('确定清空所有记忆的检索次数？\n计数归零后要重新检索满「自动置顶检索次数」才会自动置顶；已置顶的记忆保持不变。'))return;
    const msg=document.getElementById('mw-clear-retrieval-msg');
    if(msg)msg.textContent='清空中...';
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/clear-retrieval',{method:'POST'});
      const d=await r.json();
      if(d.error){ if(msg)msg.textContent='清空失败: '+d.error; toast('清空失败: '+d.error); return; }
      if(msg)msg.textContent='已清空 '+d.cleared+' 条';
      toast('已清空 '+d.cleared+' 条记忆的检索次数');
    }catch(e){ if(msg)msg.textContent='网络错误: '+e.message; toast('网络错误: '+e.message); }
  }

 // 2026-09-13 死代码清理：loadSendConfig/saveSendConfig 空壳及其唯一调用点已删（功能 2026-09-08 移除后遗留）

 async function loadScreenshotWakePromptLog(){
   const pe=document.getElementById('log-screenshot-wake-prompt');
   if(!pe)return;
   try{
     const r=await fetch(ADMIN_API + '/logs/screenshot-wake-prompt');
     const j=await r.json();
     pe.value=j.prompt||'';
   }catch(e){pe.value='加载失败'}
 }
 async function saveScreenshotWakePromptLog(){
   const pe=document.getElementById('log-screenshot-wake-prompt');
   const v=pe.value.trim();
   if(!v||v==='加载中...'||v==='加载失败'){toast('提示词还没加载出来，先点「重新载入」');return}
   try{
     const r=await fetch(ADMIN_API + '/logs/screenshot-wake-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:pe.value})});
     const j=await r.json();
     if(j.ok) toast('已保存，截图唤醒时生效');
     else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }
 async function resetScreenshotWakePromptLog(){
   if(!confirm('恢复默认截图唤醒提示词？'))return;
   try{
     const r=await fetch(ADMIN_API + '/logs/screenshot-wake-prompt',{method:'DELETE'});
     const j=await r.json();
     if(j.ok){toast('已恢复默认');loadScreenshotWakePromptLog();}
     else toast('失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }
 async function loadScreenshotVisionPromptLog(){
   const pe=document.getElementById('log-screenshot-vision-prompt');
   if(!pe)return;
   try{
     const r=await fetch(ADMIN_API + '/logs/screenshot-vision-prompt');
     const j=await r.json();
     pe.value=j.prompt||'';
   }catch(e){pe.value='加载失败'}
 }
 async function saveScreenshotVisionPromptLog(){
   const pe=document.getElementById('log-screenshot-vision-prompt');
   const v=pe.value.trim();
   if(!v||v==='加载中...'||v==='加载失败'){toast('提示词还没加载出来，先点「重新载入」');return}
   try{
     const r=await fetch(ADMIN_API + '/logs/screenshot-vision-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:pe.value})});
     const j=await r.json();
     if(j.ok) toast('已保存，截图画面描述生效');
     else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }
 async function resetScreenshotVisionPromptLog(){
   if(!confirm('恢复默认画面描述提示词？'))return;
   try{
     const r=await fetch(ADMIN_API + '/logs/screenshot-vision-prompt',{method:'DELETE'});
     const j=await r.json();
     if(j.ok){toast('已恢复默认');loadScreenshotVisionPromptLog();}
     else toast('失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }
 
 function escapeHtml(s){
   return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]});
 }
 function escJsStr(v){
   return String(v==null?'':v)
     .replace(/&/g,'&amp;')
     .replace(/"/g,'&quot;')
     .replace(/</g,'&lt;')
     .replace(/>/g,'&gt;')
     .replace(/\\/g,'\\\\')
     .replace(/'/g,"\\'");
 }
 
 let editingDiaryName = null;
 // 2026-09-12 日记按会话分开保存：分组渲染需要会话名（token→名称），异步加载后补渲染一次
 const ADM_SESSION_NAMES = {};
 async function loadDiarySessionNames(){
   try{
     const r=await fetch('/v1/sessions',{credentials:'include'});
     const j=await r.json();
     for(const s of ((j&&j.sessions)||[])){ if(s&&s.id) ADM_SESSION_NAMES[s.id]=s.name||''; }
   }catch(e){}
 }
 function renderDiary(){
   const entries=AppState.INITIAL_DATA.diary||[];
   const el=document.getElementById('diary-list');
   if(!entries.length){el.innerHTML='<div class="empty">暂无日记</div>';return}
   // 2026-09-13：去分组，完全按日记时间排（服务端已按文件名日期倒序平铺返回）；
   // 同一天不同窗口各有日记时用小标注区分（有会话名显示会话名，否则显示窗口 id）
   el.innerHTML=entries.map(e=>{
     const key=e.relPath||e.name||'';
     const label=e.name||'';
     const hidden=e.hidden===true;
     const tag=e.session?'<em style="font-style:normal;font-size:11px;opacity:.65;margin-left:6px">'+escapeHtml(ADM_SESSION_NAMES[e.session]||('窗口 '+e.session))+'</em>':'';
     return '<div class="diary-item'+(hidden?' diary-is-hidden':'')+'"><div class="diary-head"><span>'+escapeHtml(label)+tag+(hidden?'<em class="diary-hidden-tag">已隐藏</em>':'')+'</span><span style="display:flex;align-items:center;gap:8px"><em>'+escapeHtml(e.time)+'</em><button class="diary-hide-btn" onclick="toggleDiaryHidden(\''+escJsStr(key)+'\')">'+(hidden?'显示':'隐藏')+'</button><button class="diary-edit-btn" onclick="openDiaryEditor(\''+escJsStr(key)+'\')">编辑</button></span></div></div>'
   }).join('');
 }

 async function toggleDiaryHidden(relPath){
   const entries=AppState.INITIAL_DATA.diary||[];
   const entry=entries.find(e=>(e.relPath||e.name)===relPath);
   const toHidden=!(entry&&entry.hidden===true);
   if(toHidden&&!confirm('隐藏 '+relPath+' ？\n隐藏后：不参与新会话的跨窗口日记注入、不占注入份数（顺位补足）。\n日记文件与时间线记录保留，可随时点「显示」恢复。'))return;
   try{
     const r=await fetch(ADMIN_API+'/diary/hide',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:relPath,hidden:toHidden})});
     const j=await r.json();
     if(j.success){
       toast(toHidden?'已隐藏，不再参与跨窗口注入':'已恢复，重新参与跨窗口注入');
       try{
         const dr=await fetch(ADMIN_API+'/env');
         if(dr.ok){const d=await dr.json();AppState.INITIAL_DATA=d;}
       }catch(e){}
       renderDiary();
     }else{
       toast('操作失败: '+j.error);
     }
   }catch(e){
     toast('网络错误: '+e.message);
   }
 }
 
 function openDiaryEditor(relPath){
   editingDiaryName=relPath;
   const entries=AppState.INITIAL_DATA.diary||[];
   const entry=entries.find(e=>(e.relPath||e.name)===relPath);
   document.getElementById('diary-edit-name').textContent=relPath;
   document.getElementById('diary-edit-content').value=entry?entry.content:'';
   openModal('diaryEditModal');
 }
 
 async function saveDiaryEditor(){
   if(!editingDiaryName){closeModal('diaryEditModal');return}
   const content=document.getElementById('diary-edit-content').value;
   try{
     const r=await fetch(ADMIN_API+'/diary/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:editingDiaryName,content})});
     const j=await r.json();
     if(j.success){
       toast('已保存，同步 '+j.syncedEvents+' 条上下文特殊事件');
       closeModal('diaryEditModal');
       try{
         const dr=await fetch(ADMIN_API+'/env');
         if(dr.ok){const d=await dr.json();AppState.INITIAL_DATA=d;}
       }catch(e){}
       renderDiary();
     }else{
       toast('保存失败: '+j.error);
     }
   }catch(e){
     toast('网络错误: '+e.message);
   }
 }
 
 
 async function deleteDiaryEditor(){
   if(!editingDiaryName){closeModal('diaryEditModal');return}
   if(!confirm('确认删除 '+editingDiaryName+'？上下文里对应的特殊事件也会同步移除。'))return;
   try{
     const r=await fetch(ADMIN_API+'/diary/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:editingDiaryName})});
     const j=await r.json();
     if(j.success){
       toast('已删除，移除 '+j.removedEvents+' 条上下文特殊事件');
       closeModal('diaryEditModal');
       editingDiaryName=null;
       try{
         const dr=await fetch(ADMIN_API+'/env');
         if(dr.ok){const d=await dr.json();AppState.INITIAL_DATA=d;}
       }catch(e){}
       renderDiary();
     }else{
       toast('删除失败: '+j.error);
     }
   }catch(e){
     toast('网络错误: '+e.message);
   }
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
 // 多选模式状态

 const CC_GAP_PAGE = 200;
 
 function escHtml(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
 
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
 async function loadMarkedList(){
   const el=document.getElementById('cc-marked-list');
   if(!el) return;
   const info=document.getElementById('cc-marked-info');
   if(info) info.textContent='加载中...';
   try{
     const r=await fetch(ADMIN_API + '/context-compaction/marked-list');
     const j=await r.json();
     const list=j.results||[];
     window.__markedList=list;
     el.innerHTML='';
     if(info) info.textContent='共 ' + list.length + ' 条已标星消息';
     if(!list.length){ el.innerHTML='<div class="empty">暂无标星消息（在上方原文搜索里点星可以标记）</div>'; return; }
     el.innerHTML=list.map(function(x){
       let tH=''; try{ tH=x.markedAt?new Date(x.markedAt).toLocaleString('zh-CN',{hour12:false}) : (x.time||''); }catch(err){}
       const roleCls = x.role==='user' ? 'color:var(--accent)' : (x.role==='system' ? 'color:var(--tab-active)' : 'color:var(--text)');
       // 进入上下文标记（替代原「未覆盖」标签）：绿=正文当前在发给模型的上下文中，灰=不在
       const ctxTag = x.in_context
         ? '<span class="mem-tag" style="background:#27ae60;color:#fff" title="该标星正文当前在发给模型的上下文中">已入上下文</span>'
         : '<span class="mem-tag" style="background:#95a5a6;color:#fff" title="该标星正文当前不在发给模型的上下文中">未入上下文</span>';
       return '<div style="padding:8px 0;border-bottom:1px dashed var(--border)">'
         +'<div style="display:flex;align-items:center;gap:6px">'
         +'<span style="font-size:11px;color:var(--text3)">第 '+x.index+' 条</span>'
         +'<span style="font-size:11px;'+roleCls+'">'+escHtml2(x.role||'')+'</span>'
         +ctxTag
         +'<button type="button" onclick="openMarkEdit(this)" data-key="'+x.key+'" title="编辑正文" aria-label="编辑正文" style="flex-shrink:0;padding:2px 8px;border:1px solid var(--border);border-radius:6px;background:rgba(0,0,0,0.02);color:var(--text2);font-size:11px;cursor:pointer">编辑</button>'
         +'<button style="margin-left:auto;flex-shrink:0" class="cc-msg-mark on" data-key="'+x.key+'" onclick="unmarkMsg(this)" title="取消标星：将后此消息可被摘要覆盖" aria-pressed="true" aria-label="取消标星">★</button>'
         +'</div>'
         +'<div style="font-size:11px;color:var(--text3);margin-top:2px">'+tH+'</div>'
         +'<div style="font-size:12px;margin-top:2px;word-break:break-all">'+escHtml2(x.content)+'</div>'
         +'</div>';
     }).join('');
   }catch(e){ el.innerHTML='<div class="empty">加载失败</div>'; if(info) info.textContent=''; }
 }

 // 取消标星（卡片内）
 function unmarkMsg(btn){
   if(!btn) return;
   if(!confirm('取消标星该条消息？取消后它可能会被压缩/替换为摘要。')) return;
   const key=btn.getAttribute('data-key');
   btn.disabled=true;
   fetch(ADMIN_API + '/context-compaction/mark',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({key:key, marked:false})
   }).then(function(r){return r.json()}).then(function(d){
     if(d && d.error){ alert('取消失败: '+d.error); btn.disabled=false; return; }
     loadMarkedList();
   }).catch(function(e){ alert('取消失败: '+e.message); btn.disabled=false; });
 }


  // 编辑标星消息正文（管理台"已标星消息"）
  function openMarkEdit(btn){
    if(!btn) return;
    const key=btn.getAttribute('data-key');
    const list=window.__markedList||[];
    const it=list.find(function(x){ return String(x.key)===String(key); });
    if(!it){ toast('未找到该标星消息'); return; }
    window.__markEditKey=key;
    const mt=document.getElementById('mark-modal-title'); if(mt) mt.textContent='编辑标星消息';
    const info=document.getElementById('mark-modal-info');
    if(info){
      let t=''; try{ t=it.markedAt?new Date(it.markedAt).toLocaleString('zh-CN',{hour12:false}):(it.time||''); }catch(err){}
      info.textContent='第 '+it.index+' 条 · '+(it.role||'')+(t?(' · '+t):'');
    }
    const ce=document.getElementById('mark-edit-content'); if(ce) ce.value=it.content||'';
    openModal('markEditModal');
  }
  async function saveMarkEdit(){
    const key=window.__markEditKey;
    if(!key){ toast('记录不存在'); return; }
    const el=document.getElementById('mark-edit-content');
    const content=(el?el.value:'').trim();
    if(!content){ toast('正文内容不能为空'); return; }
    const btn=document.getElementById('mark-save-btn');
    try{
      const r=await apiRequest('POST', ADMIN_API+'/context-compaction/marked/update', {key:key, content:content}, {busy:btn});
      if(!r.ok) return;
      const d=r.data||{};
      if(d.error){ toast('保存失败: '+d.error); return; }
      toast('已保存');
      closeModal('markEditModal');
      loadMarkedList();
    }catch(e){ toast('网络错误: '+e.message); }
  }

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
 * 未触发自动压缩时的提示卡片 HTML。
 * @param {Object} d 压缩预览数据
 * @param {number} ccGaps 未覆盖区数量
 * @param {number} ccMin 自动压缩阈值
 * @returns {string}
 */
function ccBuildEmptyNoticeHtml(d, ccGaps, ccMin){
  // 自动压缩相关提示已下线（不再提醒未达阈值/未触发自动压缩），
  // 保留函数与调用点不变，仅不再渲染任何内容，避免影响手动压缩流程。
  return '';
}

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
    +(t.manualHiddenCount>0?'<div class="cc-hidden-tip"><b>'+(t.manualHiddenCount||0)+'</b> 块手动隐藏（入池归档）：摘要与原文均不进入上下文，可在对应块上点「取消隐藏」恢复。</div>':'')
    +'<div class="cc-token-tip" style="font-size:11px;color:#6B7280;margin-top:4px;">容量占用（token 估算）：未覆盖积压 <b>'+fmtCcNum(t.estUncoveredTokens||0)+'</b>，实际发送约 <b>'+fmtCcNum(t.estTotalTokens||0)+'</b>（含标星 <b>'+fmtCcNum(t.markedTokens||0)+'</b>、图片 <b>'+fmtCcNum(t.imageTokens||0)+'</b>、置顶记忆 <b>'+fmtCcNum(t.pinnedTokens||0)+'</b>）。容量上限见上方配置，超限时网关塞隐藏提醒。</div>';
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
   if(!t.chunkCount){
     const ccGaps=(d.uncovered&&d.uncovered.gaps&&d.uncovered.gaps.length)||0;
     const ccMin=Number((d.config&&d.config.compaction_min_messages)||0);
     html+=ccBuildEmptyNoticeHtml(d, ccGaps, ccMin);
   }
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
       + (AppState.ccMultiSelectMode?'<input type="checkbox" class="cc-chk" '+(AppState.ccSelectedChunks.has(c.index)?'checked':'')+' onclick="event.stopPropagation();toggleCcChunkSelect(\'chunk\','+c.index+')" title="选中此块">':'')+'<div class="cc-chunk-head" onclick="toggleCcExpand('+c.index+')">'
       +(c.cached?'<span class="cc-chunk-arrow">'+(expanded?'▾':'▸')+'</span>':'')
       +'<span class="cc-chunk-title '+(isAi?'ai':'manual')+'">块 #'+c.index+'</span>'
       +(hidden
         ? '<span class="cc-badge off">'+(manualHidden?'已隐藏·手动':'已隐藏')+'</span>'
         : '<span class="cc-badge '+(isAi?(enabled?'done':'off'):(c.cached?(enabled?'done':'warn'):'todo'))+'">'+(isAi?(enabled?'已替换':'已停用'):(c.cached?(enabled?'已替换':'待替换'):'待生成'))+'</span>')
       +'<span class="cc-chunk-stat">'+count+' 条 · '+fmtCcNum(c.chars)+' 字</span>'
       +(hidden
         ? (manualHidden
            ? '<button class="cc-btn cc-head-toggle" onclick="event.stopPropagation();unhideBlock('+c.index+','+blockIndex+','+(isAi?1:0)+')" title="取消手动隐藏，块恢复参与上下文">取消隐藏</button>'
            : '')
         : '<button class="cc-btn cc-head-toggle'+(enabled?' on':'')+(c.cached?'':' gen')+'" onclick="event.stopPropagation();'+(c.cached?'toggleCcReplace('+c.index+','+blockIndex+','+(isAi?1:0)+')':'regenerateBlockSummary('+c.index+','+blockIndex+')')+'"'+((!c.cached&&AppState.ccBlockGenerating.has(c.index))?' disabled':'')+'>'+(c.cached?(enabled?'取消替换':'替换'):(AppState.ccBlockGenerating.has(c.index)?'生成中…':'✦ 生成摘要'))+'</button>')
       +'</div>'
       +'<div class="cc-meta">第 '+start+'~'+end+' 条 · '+escHtml(timeLabel)+'</div>'
       +'<div class="cc-preview">'+escHtml(c.head||'')+'</div>'
         +(!isAi ? '<div id="cc-addman-'+c.index+'"></div>' : '')
 +(!isAi
         ? '<div class="cc-boundary">'
           +'<input class="cc-num" type="number" min="1" max="'+d.totalCompressible+'" value="'+start+'" title="开头" oninput="ccNumLiveCheck(this,'+d.totalCompressible+')" onchange="updateCompactionBoundary('+blockIndex+',0,this.value)" onblur="clampCcInput(this,'+blockIndex+',0,'+d.totalCompressible+')">'
           +'<span class="cc-boundary-arrow">→</span>'
           +'<input class="cc-num" type="number" min="1" max="'+d.totalCompressible+'" value="'+end+'" title="结尾" oninput="ccNumLiveCheck(this,'+d.totalCompressible+')" onchange="updateCompactionBoundary('+blockIndex+',1,this.value)" onblur="clampCcInput(this,'+blockIndex+',1,'+d.totalCompressible+')">'
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
           +'<button class="cc-sum-toggle-btn" onclick="event.stopPropagation();regenerateBlockSummary('+c.index+','+blockIndex+')"'+(AppState.ccBlockGenerating.has(c.index)?' disabled':'')+'>'+(AppState.ccBlockGenerating.has(c.index)?'生成中…':'✦ 重新生成摘要')+'</button>'
           +'</div>'
           +'<div id="cc-collapse-sum-'+c.index+'" class="cc-collapse'+(AppState.ccSummaryOpen.has(c.index)&&(prevOpenCol['cc-collapse-sum-'+c.index]||!AppState.ccAnimateOpen.has('cc-collapse-sum-'+c.index))?' open':'')+'"><div class="cc-collapse-inner">'+renderCcSummaryEditor(c, blockIndex)+renderCcHistory(c)+'</div></div>'
           +'</div>'
         : '')
       +'</div>'
       +'<div class="cc-swipe-del"><button class="cc-swipe-del-btn" onclick="removeSingleBlock('+c.index+','+blockIndex+','+(isAi?1:0)+')">移除</button><button class="cc-swipe-del-btn cc-swipe-del-btn-ingest" onclick="ingestSingleBlock('+c.index+','+blockIndex+','+(isAi?1:0)+')">入池</button></div>'
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
 
 // 移除单块：手动块调 blocks/remove_at，AI块调 context-replacements/undo
 
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
  AppState.ccLastRenderedHtml = html;
  const ae=document.activeElement;
  if(ae && el.contains(ae) && /^(TEXTAREA|INPUT)$/.test(ae.tagName)) return;
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
function toggleCcNotice(head){
  const n=head.closest('.cc-notice');
  if(n) n.classList.toggle('open');
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
      const r=await fetch(ADMIN_API + '/memory-pool/config');
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
   let canGenerate = 0, canReplace = 0, canReparse = 0, canExport = 0, canRemove = 0;
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
         if(c.cached && c.enabled === false) canReplace++; // 待替换的可以替换
         if(c.enabled !== false) canReparse++; // 已替换的可以解析入池
       }
     }
   });
   if(genBtn) genBtn.disabled = canGenerate === 0;
   if(replaceBtn) replaceBtn.disabled = canReplace === 0;
   if(reparseBtn) reparseBtn.disabled = canReparse === 0;
   if(exportBtn) exportBtn.disabled = canExport === 0;
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
       if(c && !c.cached){
         if(c.aiRep){
           todo.push({type: 'ai', repId: c.repId, idx: idx, label: '块 #' + idx});
         }else{
           const manualChunks = chunks.filter(function(x){ return !x.aiRep; });
           const blockIndex = (typeof c.blockIndex==='number')?c.blockIndex:manualChunks.indexOf(c);
           if(blockIndex >= 0) todo.push({type: 'block', blockIndex: blockIndex, idx: idx, label: '块 #' + idx});
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
         body = JSON.stringify({action: 'block', blockIndex: item.blockIndex});
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
   const manualChunks = chunks.filter(function(x){ return !x.aiRep; });
   // 收集待替换的块（cached 且 enabled === false）
   const todo = [];
   AppState.ccSelectedChunks.forEach(function(key){
     if(String(key).startsWith('gap-')) return; // 未覆盖区不能替换
     const idx = Number(key);
     const c = chunks.find(function(x){ return x.index === idx; });
     if(c && c.cached && c.enabled === false){
       if(c.aiRep){
         todo.push({type: 'ai', repId: c.repId, idx: idx, label: '块 #' + idx});
       }else{
         const blockIndex = (typeof c.blockIndex==='number')?c.blockIndex:manualChunks.indexOf(c);
         todo.push({type: 'manual', blockIndex: blockIndex, idx: idx, label: '块 #' + idx});
       }
     }
   });
   if(!todo.length){ toast('没有待替换的块'); return; }
   if(!confirm('替换选中的 ' + todo.length + ' 个「待替换」块？')) return;
   const msg = document.getElementById('compaction-msg');
   let done = 0;
   for(let i = 0; i < todo.length; i++){
     const item = todo[i];
     if(msg) msg.textContent = '正在替换 ' + item.label + '（第 ' + (i+1) + '/' + todo.length + '）…';
     try{
       let url, body;
       if(item.type === 'ai'){
         url = ADMIN_API + '/context-replacements/toggle';
         body = JSON.stringify({id: item.repId, enabled: true});
       }else{
         url = ADMIN_API + '/context-compaction/blocks';
         body = JSON.stringify({action: 'toggle', blockIndex: item.blockIndex, enabled: true});
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
   if(msg) msg.textContent = '已替换 ' + done + '/' + todo.length + ' 块。';
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
     ? '将选中的 ' + selectedIds.length + ' 个块拼接为一次 LLM 提炼，归入记忆池？'
     : '将选中的 1 个块解析归入记忆池？')) return;
   const msg = document.getElementById('compaction-msg');
   if(msg) msg.textContent = isMerge ? '正在合并解析选中的摘要并注入记忆池…' : '正在解析选中的摘要并注入记忆池…';
   try{
     const r = await fetch(ADMIN_API + '/memory-pool/reparse', {
       method: 'POST', headers: {'Content-Type': 'application/json'},
       body: JSON.stringify({chunkIds: selectedIds, merge: isMerge})
     });
     const j = await r.json();
     if(j.error) throw new Error(j.error);
     const s = '已解析 ' + j.processed + ' 段 -> 新增 ' + j.added + ' / 合并 ' + j.merged + ' / 失败 ' + j.failed + (j.already ? ' / 已存在(已入过) ' + j.already : '');
     if(msg) msg.textContent = s;
     toast(s);
   }catch(e){
     if(msg) msg.textContent = '解析失败: ' + e.message;
     toast('解析失败: ' + e.message);
   }
   updateMultiSelectBar();
 }

  // 单块入池：按摘要里现成的【分类】标签本地拆分直接入库（不调 LLM）；
  // 入池前问是否同时隐藏（2026-09-15）：确定=入池且隐藏（摘要与原文都不再进上下文），取消=只入池
  async function ingestSingleBlock(cid, blockIndex, isAi){
    const d = AppState.compactionPlan;
    if(!d) return;
    const c = (d.chunks || []).find(function(x){ return x.index === cid; });
    if(!c || c.enabled === false){ toast('该块未替换，无法入池'); return; }
    if(!confirm('将该块摘要按【分类】标签拆分后直接入池（不调用 AI 解析，重要级默认）？')) return;
    const alsoHide = confirm('是否同时隐藏该块？\n\n隐藏后这块的摘要与原文都不再发给 AI（信息已存入记忆池，不会丢）；之后可在块上点「取消隐藏」恢复。\n\n【确定】入池并隐藏　【取消】只入池');
    const msg = document.getElementById('compaction-msg');
    if(msg) msg.textContent = '正在按分类直接入池…';
    try{
      const r = await fetch(ADMIN_API + '/memory-pool/reparse', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chunkIds: [c.id], direct: true})
      });
      const j = await r.json();
      if(j.error) throw new Error(j.error);
      let s = '已入池 ' + j.processed + ' 段 -> 新增 ' + j.added + ' / 合并 ' + j.merged + ' / 失败 ' + j.failed + (j.skipped ? ' / 跳过(无分类标签) ' + j.skipped : '') + (j.already ? ' / 已存在(已入过) ' + j.already : '');
      if(alsoHide){
        try{
          await ccSetBlockHidden(c, blockIndex, isAi, true);
          s += '；块 #' + cid + ' 已隐藏（不再进入上下文）';
        }catch(e2){
          s += '；隐藏失败: ' + e2.message;
        }
      }
      if(msg) msg.textContent = s;
      toast(s);
      if(alsoHide) loadCompactionPreview();
    }catch(e){
      if(msg) msg.textContent = '直接入池失败: ' + e.message;
      toast('直接入池失败: ' + e.message);
    }
  }

  // 设置/取消块的手动隐藏（AI 块走 context-replacements/toggle 带 hidden；手工块走 blocks 的 hide 动作）
  async function ccSetBlockHidden(c, blockIndex, isAi, hidden){
    const url = isAi
      ? ADMIN_API + '/context-replacements/toggle'
      : ADMIN_API + '/context-compaction/blocks';
    const body = isAi
      ? {id: c.repId, hidden: hidden}
      : {action: 'hide', blockIndex: blockIndex, hidden: hidden};
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
 // 批量移除
 async function batchRemoveBlocks(){
   if(!AppState.ccSelectedChunks.size) return;
   const d = AppState.compactionPlan;
   if(!d) return;
   const chunks = d.chunks || [];
   const manualChunks = chunks.filter(function(x){ return !x.aiRep; });
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
         const blockIndex = (typeof c.blockIndex==='number')?c.blockIndex:manualChunks.indexOf(c);
         if(blockIndex >= 0) todo.push({type: 'manual', blockIndex: blockIndex, idx: idx, label: '块 #' + idx});
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
           body: JSON.stringify({action: 'remove_at', blockIndex: item.blockIndex})
         });
         const j = await r.json();
         if(j.error || j.ok === false) throw new Error(j.message || j.error || '移除失败');
       }
       done++;
       // 每移除一个就刷新一下，重新获取索引
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

    


async function generateAllGapSummaries(){
  const d=AppState.compactionPlan;
  if(!d) return;
  const gaps=(d.uncovered&&d.uncovered.gaps)||[];
  if(!gaps.length){ toast('没有未覆盖区，无需生成'); return; }
  if(!confirm('为全部 '+gaps.length+' 个未覆盖区依次生成摘要？会新建块并连续调用模型，可能耗时较长。')) return;
  const btn=document.getElementById('cc-gen-all-btn');
  if(btn) btn.disabled=true;
  const msg=document.getElementById('compaction-msg');
  const ranges=gaps.map(function(g){ return [g.startIdx,g.endIdx]; });
  let done=0;
  for(let i=0;i<ranges.length;i++){
    const key=ranges[i][0]+'-'+ranges[i][1];
    AppState.ccGapGenerating.add(key);
    updateCcStatusBar();
    if(msg) msg.textContent='正在为第 '+ranges[i][0]+'–'+ranges[i][1]+' 条生成摘要（第 '+(i+1)+'/'+ranges.length+' 个）…';
    try{
      const r=await fetch(ADMIN_API+'/context-compaction/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'gap',start:ranges[i][0],end:ranges[i][1]})});
      const j=await r.json();
      if(j.error) throw new Error(j.error);
      if(j.ok===false) throw new Error(j.message||'生成失败');
      done++;
    }catch(e){
      if(msg) msg.textContent='第 '+(i+1)+' 个生成失败：'+e.message;
      toast('生成失败：'+e.message);
      break;
    }finally{
      AppState.ccGapGenerating.delete(key);
    }
  }
  resetCcMsgCache();
  await loadCompactionPreview();
  if(msg) msg.textContent='已生成 '+done+'/'+ranges.length+' 个摘要；点块上的「替换」后生效。';
}
async function replaceAllPendingBlocks(){
  const d=AppState.compactionPlan;
  if(!d) return;
  const ccList=(d.chunks||[]).filter(function(x){return !x.aiRep;});
  const pending=ccList.filter(function(c){ return c.cached && c.enabled===false; });
  if(!pending.length){ toast('没有待替换块'); return; }
  if(!confirm('一键替换 '+pending.length+' 个「待替换」块（把已生成摘要应用到上下文）？')) return;
  const btn=document.getElementById('cc-replace-all-btn');
  if(btn) btn.disabled=true;
  const msg=document.getElementById('compaction-msg');
  let done=0;
  for(let i=0;i<pending.length;i++){
    const c=pending[i];
    const blockIndex=(typeof c.blockIndex==='number')?c.blockIndex:ccList.indexOf(c);
    if(msg) msg.textContent='正在替换块 #'+c.index+'（第 '+(i+1)+'/'+pending.length+'）…';
    try{
      const r=await fetch(ADMIN_API+'/context-compaction/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'toggle',blockIndex:blockIndex,enabled:true})});
      const j=await r.json();
      if(j.error||j.ok===false) throw new Error(j.message||j.error||'替换失败');
      done++;
    }catch(e){
      if(msg) msg.textContent='块 #'+c.index+' 替换失败：'+e.message;
      toast('替换失败：'+e.message);
      break;
    }
  }
  resetCcMsgCache();
  await loadCompactionPreview();
  if(msg) msg.textContent='已替换 '+done+'/'+pending.length+' 块。';
}
async function reparseAllFromCompaction(){
  const d=AppState.compactionPlan;
  if(!d) return;
  const replaced=(d.chunks||[]).filter(function(c){ return c.enabled!==false; }).length;
  if(!replaced){ toast('还没有已替换的块，请先「替换」后再解析'); return; }
  if(!confirm('将已替换的压缩摘要重新解析并归入记忆池（会调用 API 去重）？')) return;
  const btn=document.getElementById('cc-reparse-btn');
  if(btn) btn.disabled=true;
  const msg=document.getElementById('compaction-msg');
  if(msg) msg.textContent='正在解析已替换摘要并注入记忆池…';
  try{
    const r=await fetch(ADMIN_API+'/memory-pool/reparse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({all:true})});
    const j=await r.json();
    if(j.error) throw new Error(j.error);
    const s='已解析 '+j.processed+' 段 -> 新增 '+j.added+' / 合并 '+j.merged+' / 失败 '+j.failed;
    if(msg) msg.textContent=s;
    toast(s);
  }catch(e){
    if(msg) msg.textContent='解析失败: '+e.message;
    toast('解析失败: '+e.message);
  }finally{
    if(btn) btn.disabled=false;
  }
}
function locateCcFromSearch(el){
  if(!el) return;
  const cid=el.getAttribute('data-chunk');
  const idx=el.getAttribute('data-idx');
  let list=document.getElementById('compaction-chunks');
  if(!list) return;
  let target=null;
  if(cid!==null&&cid!=='') target=list.querySelector('.cc-chunk-swipe[data-cid="'+cid+'"]');
  if(!target && idx!==null&&idx!==''){
    const n=Number(idx);
    const gaps=((AppState.compactionPlan&&AppState.compactionPlan.uncovered&&AppState.compactionPlan.uncovered.gaps)||[]);
    const g=gaps.find(function(x){ return n>=x.startIdx && n<=x.endIdx; });
    if(g){ const k=g.startIdx+'-'+g.endIdx; target=list.querySelector('.cc-uncovered[data-gkey="'+k+'"]'); }
  }
  if(!target){
    renderCompaction();
    list=document.getElementById('compaction-chunks');
    if(list && cid!==null && cid!=='') target=list.querySelector('.cc-chunk-swipe[data-cid="'+cid+'"]');
  }
  if(target){
    target.scrollIntoView({behavior:'smooth',block:'center'});
    target.classList.add('cc-locate-target');
    setTimeout(function(){ target.classList.remove('cc-locate-target'); },1100);
  }
}

function removeSingleBlock(idx, blockIndex, isAi){
   if(!confirm('移除这块？该块内容退回未覆盖区'+(isAi?'，AI 写的摘要将被撤销':'')+'。')) return;
   const msg=document.getElementById('compaction-msg');
   if(msg) msg.textContent='正在移除块 #'+idx+'...';
   if(isAi){
     const c=(AppState.compactionPlan.chunks||[]).find(function(x){return x.index===idx;});
     if(c && c.repId){ undoContextReplacement(c.repId); return; }
   }
   fetch(ADMIN_API + '/context-compaction/blocks',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({action:'remove_at', blockIndex: blockIndex})
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
     // 手动块：调 blocks/toggle
     p=fetch(ADMIN_API + '/context-compaction/blocks',{
       method:'POST',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({action:'toggle', blockIndex: blockIndex, enabled: next})
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
function ccGapCutAtInput(key){
  const el=document.getElementById('cc-gap-cut-input-'+key);
  const v=el?el.value.trim():'';
  if(!v){ toast('请输入要切的编号'); return; }
  ccGapCutAt(key, v);
}
async function ccDoCutSegments(segs){
  const msg=document.getElementById('compaction-msg');
  if(msg) msg.textContent='正在按 '+segs.length+' 个切点切分未覆盖区…';
  try{
    for(let i=0;i<segs.length;i++){
      const s=segs[i];
      const r=await fetch(ADMIN_API+'/context-compaction/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add_range',start:s[0],end:s[1]})});
      const j=await r.json();
      if(j.error||j.ok===false) throw new Error(j.message||j.error||'切分失败');
    }
    resetCcMsgCache();
    await loadCompactionPreview();
    if(msg) msg.textContent='已按候选切成 '+segs.length+' 个块。';
  }catch(e){
    if(msg) msg.textContent='切分失败: '+e.message;
    toast('切分失败: '+e.message);
  }
}
function ccGapToggleCuts(key){
  if(AppState.ccGapCutsOff.has(key)) AppState.ccGapCutsOff.delete(key); else AppState.ccGapCutsOff.add(key);
  renderCompaction();
}
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

 function regenerateBlockSummary(idx, blockIndex){
   if(blockIndex===undefined || blockIndex===null || blockIndex<0) return;
   if(!confirm('重新生成块 #'+idx+' 的摘要？现有摘要会保留在历史版本里。')) return;
   const msg=document.getElementById('compaction-msg');
   AppState.ccBlockGenerating.add(idx);
   renderCompaction();
   if(msg) msg.textContent='块 #'+idx+'：正在重新生成摘要（约几十秒）…';
   fetch(ADMIN_API + '/context-compaction/generate',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({action:'block', blockIndex: blockIndex})
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
     'cc-cfg-protect-recent':(c.compaction_protect_recent_messages!==undefined?c.compaction_protect_recent_messages:40)
   };
   Object.keys(fields).forEach(function(id){
     const el=document.getElementById(id);
     if(el && fields[id]!==undefined) el.value=fields[id];
   });
   const th=document.getElementById('cc-cfg-think');
   if(th) th.checked=!!c.compaction_include_thinking;
   const ev=document.getElementById('cc-cfg-events');
   if(ev) ev.checked=c.compaction_compress_events!==false;
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
    compaction_include_thinking: getC('cc-cfg-think'),
    compaction_compress_events: getC('cc-cfg-events'),
    compaction_max_active_blocks: Math.max(0, Math.floor(Number(get('cc-cfg-max-blocks'))||0)),
    compaction_context_limit_chars: Math.max(0, Math.floor(Number(get('cc-cfg-ctx-limit'))||0)),
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
   // 找到这个块对应的真实 blockIndex（非AI块顺序 == blocks数组顺序）
   const ccList=(d.chunks||[]).filter(function(c){return !c.aiRep;});
   const chunk=ccList[i];
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
   // 自动分块 → 用 add_range 固化；手动块 → 用 update_range 更新
   const payload = (typeof chunk.blockStart==='number')
     ? {action:'update_range', blockIndex:i, start:newStart, end:newEnd}
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
     +'<button class="cc-btn secondary" onclick="regenerateBlockSummary('+c.index+','+blockIndex+')"'+(AppState.ccBlockGenerating.has(c.index)?' disabled':'')+'>'+(AppState.ccBlockGenerating.has(c.index)?'生成中…':'重新生成')+'</button>'
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
     body:JSON.stringify({chunkIndex:idx,summary:text})
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
       if(wasForce){
         chunk.forceReplaced=false;
       }
     }
     if(msg) msg.textContent='块 #'+idx+' 摘要已保存修改（'+d.length+' 字）'+(wasForce?'，已取消旧替换，可重新替换。':'，下次请求生效。');
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
   document.querySelectorAll('.tab-content').forEach(el=>el.classList.remove('active'));
   document.querySelectorAll('.tab-item').forEach(el=>el.classList.remove('active'));
   document.getElementById('tab-'+name).classList.add('active');
   document.querySelector('.tab-item[data-tab="'+name+'"]').classList.add('active');
  if(name==='memory'){switchMemView(AppState.memView);}
  if(name==='compaction'){ if(!AppState.compactionPlan || !AppState.ccPreviewLoadedAt || Date.now()-AppState.ccPreviewLoadedAt>15000){ loadCompactionPreview(); } else { renderCompaction(); } if(AppState.compactionPlan) renderCompactionConfig(); }
  if(name==='prompts'){loadWakePrompt();loadCompactionPrompt();loadCtxLimitPrompt();loadCoWakePrompt();loadCoVisionPrompt();loadReparsePrompt();loadCleanPrompt();}
  if(name==='config'){loadToolsConfig();loadServices();}
  if(name==='system'){startLogsAutoRefresh(); loadReplaceLog();}
  if(name!=='system'){stopLogsAutoRefresh();}
  }
 
 async function loadPushLog(){
   const el=document.getElementById('push-log-list');
   if(!el)return;
   el.innerHTML='<div class="loading">加载中...</div>';
   try{
     const r=await fetch(ADMIN_API + '/push-events');
     const d=await r.json();
     renderPushLog(d);
   }catch(e){ el.innerHTML='<div class="empty">加载失败: '+e.message+'</div>'; }
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
      html+='<div class="card push-item" data-push-pos="'+it.position+'" data-push-session="'+escapeHtml(it.session_id||'default')+'" style="margin-bottom:10px;padding:12px 14px">'
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
  async function loadCrossWindowInject(){
    const el=document.getElementById('cross-inject-view');
    if(!el)return;
    el.innerHTML='<div class="loading">加载中...</div>';
    const info=document.getElementById('cross-inject-info');
    try{
      const sid=currentAdminSession();   // 统一入口，空会话兜底 'default' 而非空串
      const r=await fetch(ADMIN_API + '/cross-window-inject?session_id='+encodeURIComponent(sid));
      const d=await r.json();
      if(d.error){ el.innerHTML='<div class="empty">加载失败: '+d.error+'</div>'; return; }
      const txt=d.text||'';
      if(!txt){ el.innerHTML='<div class="empty">当前没有可注入的跨窗口内容</div>'; if(info)info.textContent=''; return; }
      el.innerHTML='<pre style="margin:0;white-space:pre-wrap;word-break:break-all">'+escapeHtml(txt)+'</pre>';
      if(info) info.textContent='共 '+txt.length+' 字';
    }catch(e){ el.innerHTML='<div class="empty">加载失败: '+e.message+'</div>'; }
  }

 function startLogsAutoRefresh(){
   loadWakeLog();
   loadPinned();
   loadPushLog();
   loadCrossWindowInject();
   // 注意：这里不再加载各提示词（loadWakePrompt/loadCompactionPrompt 等）——
   // 它们与「提示词」tab 共用同一批 textarea，切到系统页重拉会静默覆盖用户未保存的编辑；
   // 提示词统一由切到 prompts tab 时的入口加载（见 tab 切换处）
   loadScreenshotWakePromptLog();
   loadScreenshotVisionPromptLog();
   // 完整上下文改为折叠时按需加载(懒加载)，不再自动/定时拉取，避免每5秒重渲染大体积数据卡死
   checkLazyLoadLLMContext();
   if(logsRefreshTimer) clearInterval(logsRefreshTimer);
   logsRefreshTimer = setInterval(() => {
     loadWakeLog();
     loadPinned();
   }, 5000);
 }
 
 let logsRefreshTimer = null;
 function stopLogsAutoRefresh(){
   if(logsRefreshTimer){clearInterval(logsRefreshTimer);logsRefreshTimer=null;}
 }
 
 async function loadWakeLog(){
   const el=document.getElementById('wake-log');
   if(!el)return;
   try{
     const r=await fetch(ADMIN_API + '/logs/wake-up?lines=100');
     const j=await r.json();
     if(!j.lines||!j.lines.length){el.innerHTML='<div class="empty">暂无日志</div>';return}
     el.innerHTML=j.lines.slice(-50).map(l=>{
       const esc=l.replace(/</g,'&lt;').replace(/>/g,'&gt;');
       return '<div>'+esc+'</div>';
     }).join('');
   }catch(e){el.innerHTML='<div class="empty">加载失败</div>'}
 }
 
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

 // 共影观影唤醒提示词
 async function loadCoWakePrompt(){
   const pe=document.getElementById('co-wake-prompt-edit');
   if(!pe)return;
   try{
     const r=await fetch(ADMIN_API + '/logs/co-wake-prompt');
     const j=await r.json();
     pe.value=j.prompt||'';
   }catch(e){pe.value='加载失败'}
 }
 async function saveCoWakePrompt(){
   const pe=document.getElementById('co-wake-prompt-edit');
   const v=pe.value.trim();
   if(!v||v==='加载中...'||v==='加载失败'){toast('提示词还没加载出来，先点「重新载入」');return}
   try{
     const r=await fetch(ADMIN_API + '/logs/co-wake-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:pe.value})});
     const j=await r.json();
     if(j.ok) toast('已保存，共影定时唤醒时生效');
     else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }
 async function resetCoWakePrompt(){
   if(!confirm('恢复默认观影唤醒提示词？'))return;
   try{
     const r=await fetch(ADMIN_API + '/logs/co-wake-prompt',{method:'DELETE'});
     const j=await r.json();
     if(j.ok){toast('已恢复默认');loadCoWakePrompt();}
     else toast('失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }
 
 // 共影画面描述提示词
 async function loadCoVisionPrompt(){
   const pe=document.getElementById('co-vision-prompt-edit');
   if(!pe)return;
   try{
     const r=await fetch(ADMIN_API + '/logs/co-vision-prompt');
     const j=await r.json();
     pe.value=j.prompt||'';
   }catch(e){pe.value='加载失败'}
 }
 async function saveCoVisionPrompt(){
   const pe=document.getElementById('co-vision-prompt-edit');
   const v=pe.value.trim();
   if(!v||v==='加载中...'||v==='加载失败'){toast('提示词还没加载出来，先点「重新载入」');return}
   try{
     const r=await fetch(ADMIN_API + '/logs/co-vision-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:pe.value})});
     const j=await r.json();
     if(j.ok) toast('已保存，共影画面描述生效');
     else toast('保存失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }
 async function resetCoVisionPrompt(){
   if(!confirm('恢复默认画面描述提示词？'))return;
   try{
     const r=await fetch(ADMIN_API + '/logs/co-vision-prompt',{method:'DELETE'});
     const j=await r.json();
     if(j.ok){toast('已恢复默认');loadCoVisionPrompt();}
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
 
 function escHtml2(v){
   return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
 }
 
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
 
 async function loadPinned(){
   const el=document.getElementById('pinned-list');
   if(!el)return;
   try{
     const r=await fetch(ADMIN_API + '/logs/pinned');
     const j=await r.json();
     const list=j.list||[];
     if(!list.length){el.innerHTML='<div class="empty">暂无永久注入上下文</div>';return}
     el.innerHTML=list.map((m,i)=>{
       const mid=String(m.id||'').replace(/"/g,'&quot;');
       const title=(m.title||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
       const content=(m.content||'').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
       return '<div class="mem-item"><div class="mem-meta" style="justify-content:space-between">'+
         '<div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">'+
         '<span class="mem-tag">#'+(i+1)+'</span>'+
         (title?'<span class="mem-time" style="font-weight:500;color:var(--tab-active);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:0">'+title+'</span>':'')+
         '</div>'+
         "<div style=\"display:flex;gap:4px;flex-shrink:0\">"+
         "<button class=\"btn btn-sm\" style=\"background:none;border:none;font-size:13px;color:var(--text2);cursor:pointer;padding:0 5px;line-height:1\" onclick=\"movePinned('" + mid + "','up')\" title=\"上移\">&#9650;</button>"+
         "<button class=\"btn btn-sm\" style=\"background:none;border:none;font-size:13px;color:var(--text2);cursor:pointer;padding:0 5px;line-height:1\" onclick=\"movePinned('" + mid + "','down')\" title=\"下移\">&#9660;</button>"+
         "<button class=\"btn btn-sm\" style=\"background:none;border:none;font-size:14px;color:var(--text3);cursor:pointer;padding:2px 6px;line-height:1\" onclick=\"openEditPinned('" + mid + "')\" title=\"编辑\">&#9998;</button>"+
         "<button class=\"btn btn-sm\" style=\"background:none;border:none;font-size:16px;color:var(--text3);cursor:pointer;padding:2px 6px;line-height:1\" onclick=\"deletePinned('" + mid + "')\">&times;</button>"+
         "</div>"+
         '</div><div class="mem-content">'+content+'</div></div>';
     }).join('');
   }catch(e){el.innerHTML='<div class="empty">加载失败</div>'}
 }
 
 async function addPinned(){
   const title=document.getElementById('pin-title').value.trim();
   const content=document.getElementById('pin-content').value.trim();
   if(!content){toast('请输入内容');return}
   try{
     const r=await fetch(ADMIN_API + '/logs/pinned',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,content})});
     const j=await r.json();
     if(j.success){toast('已添加');document.getElementById('pin-title').value='';document.getElementById('pin-content').value='';loadPinned();}
     else toast('添加失败');
   }catch(e){toast('网络错误')}
 }
 
 async function movePinned(id, dir){
  if(dir!=='up'&&dir!=='down')return;
  try{
    const r=await fetch(ADMIN_API + '/logs/pinned');
    const j=await r.json();
    const list=j.list||[];
    const idx=list.findIndex(m=>String(m.id)===String(id));
    if(idx<0)return;
    const tgt=dir==='up'?idx-1:idx+1;
    if(tgt<0||tgt>=list.length){toast('已到边界，无法移动');return}
    const tmp=list[idx];list[idx]=list[tgt];list[tgt]=tmp;
    const rr=await fetch(ADMIN_API + '/logs/pinned/reorder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:list.map(m=>m.id)})});
    const jj=await rr.json();
    if(jj.success){toast('已重排');loadPinned();}
    else toast('重排失败：'+(jj.error||''));
  }catch(e){toast('网络错误')}
}

async function deletePinned(id){
   if(!confirm('确认删除？'))return;
   try{
     const r=await fetch(ADMIN_API + '/logs/pinned/'+id,{method:'DELETE'});
     const j=await r.json();
     if(j.success){toast('已删除');loadPinned();}
     else toast('删除失败');
   }catch(e){toast('网络错误')}
 }
 
 async function openEditPinned(id){
   AppState.editingPinnedId = id;
   try{
     const r=await fetch(ADMIN_API + '/logs/pinned');
     const j=await r.json();
     const item=(j.list||[]).find(m=>String(m.id)===String(id));
     if(!item){toast('未找到');return}
     document.getElementById('edit-pinned-title').value=item.title||'';
     document.getElementById('edit-pinned-content').value=item.content||'';
     openModal('editPinnedModal');
   }catch(e){toast('加载失败')}
 }
 
 async function saveEditPinned(){
   if(!AppState.editingPinnedId){toast('未找到');return}
   const title=document.getElementById('edit-pinned-title').value.trim();
   const content=document.getElementById('edit-pinned-content').value.trim();
   if(!content){toast('内容不能为空');return}
   try{
     const r=await fetch(ADMIN_API + '/logs/pinned/'+AppState.editingPinnedId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,content})});
     const j=await r.json();
     if(j.success){toast('已更新');closeModal('editPinnedModal');loadPinned();}
     else toast('更新失败: '+(j.error||''));
   }catch(e){toast('网络错误')}
 }

 async function loadReplaceLog(){
   const el=document.getElementById('cc-replacelog-list');
   if(!el)return;
   const info=document.getElementById('cc-replacelog-info');
   try{
     const r=await fetch(ADMIN_API + '/context-replacements/logs?limit=10');
     const j=await r.json();
     const list=j.entries||[];
     if(!list.length){el.innerHTML='<div class="empty">暂无记录（有对话请求发送后，每次都会留一条，包括未触发替换的情况）</div>';if(info)info.textContent='';return;}
     if(info)info.textContent='共记录最近 '+list.length+' 次请求';
     el.innerHTML=list.map(e=>{
       let t='';try{t=new Date(e.time).toLocaleString('zh-CN',{hour12:false});}catch(err){}
       const src=e.source||'对话';
       const applied=(e.applied||[]).map(a=>{
         const title=a.title?('【'+escHtml2(a.title)+'】'):'';
         return title+'<span style="color:var(--text3)">范围['+((a.startIdx||0)+1)+'..'+((a.endIdx||0)+1)+'] '+a.contentLen+'字</span>';
       }).join('；');
       return '<div style="padding:8px 0;border-bottom:1px dashed var(--border)">'
         +'<div style="font-size:11px;color:var(--text3)">'+t+' · '+escHtml2(src)+' · 消息 '+e.before+' → '+e.after+' 条 · 替换 '+e.replaced+' 块</div>'
         +'<div style="font-size:12px;margin-top:2px;word-break:break-all">'+(applied||(e.replaced===0?'<i style="color:var(--text3)">本次未发生上下文替换</i>':'<i style="color:var(--text3)">(无明细)</i>'))+'</div></div>';
     }).join('');
   }catch(e){el.innerHTML='<div class="empty">加载失败</div>';}
 }
 
 let _llmCtxLoaded=false; // 是否已加载过一次(懒加载守卫)
 let _llmCtxInflight=false; // 防止并发重复请求
 let ctxLongTexts={}; // 超长消息全文暂存，点击「展开全文」时换入
 // 折叠卡片后点击标题展开时调用：由 toggleCard 里追加的 checkLazyLoadLLMContext() 触发
 function checkLazyLoadLLMContext(){
   const card=document.querySelector('.card[data-collapse-id="llm-context"]');
   if(card && !card.classList.contains('collapsed') && !_llmCtxLoaded && !_llmCtxInflight){
     loadLLMContext(false);
   }
 }
 async function loadLLMContext(forceRefresh){
   const el=document.getElementById('llm-context');
   if(!el)return;
   // forceRefresh: 用户点"刷新"；否则仅在首次展开或尚未加载时加载
   if(!forceRefresh && _llmCtxLoaded)return;
   if(_llmCtxInflight)return;
   _llmCtxInflight=true;
   // 折叠状态下不渲染(点刷新但卡片是收起的也跳过)
   const card=document.querySelector('.card[data-collapse-id="llm-context"]');
   if(card && card.classList.contains('collapsed')){ _llmCtxInflight=false; return; }
   try{
     const r=await fetch(ADMIN_API + '/logs/context');
     const j=await r.json();
     if(!j.messages||!j.messages.length){el.innerHTML='<div class="empty">暂无上下文 (还未有对话)</div>';document.getElementById('ctx-time').textContent='';return}
     const roleMap={system:'系统',user:'用户',assistant:'AI',tool:'工具',_divider:'---'};
     const roleClass={system:'color:var(--tab-active);',user:'color:var(--accent);',assistant:'color:var(--text);',tool:'color:var(--accent2);',_divider:'color:var(--text3);text-align:center;'}
     let html='<div style="font-size:11px;color:var(--text3);margin-bottom:8px">共 '+j.total+' 条消息</div>';
     html+=j.messages.map((m,mi)=>{
       const role=escapeHtml(roleMap[m.role]||m.role);
       const c=(typeof m.content==='string')?m.content:(m.content?JSON.stringify(m.content):'');
       let esc=escapeHtml(c);
       if(m.images&&m.images.length){
         const totalBytes=m.images.reduce((s,x)=>s+(Number(x.bytes)||0),0);
         const sizeTxt=totalBytes?(' · 共约'+(totalBytes/1024/1024).toFixed(1)+'MB'):'';
         esc+='\n\n[图片 '+m.images.length+' 张'+sizeTxt+']';
       }
       if(m.attachments)esc+='\n[附件 '+m.attachments+' 个]';
       if(m.role==='_divider')return '<div style="padding:6px 0;border-top:1px dashed var(--border);margin:4px 0;">'+esc+'</div>';
       let body=esc;
       if(esc.length>30000){
         const key='ctx'+mi;
         ctxLongTexts[key]=esc;
         body=esc.slice(0,30000)+' …（全文共 '+c.length+' 字）<a href="javascript:void(0)" onclick="expandCtxText(\''+key+'\',this)" style="color:var(--accent);text-decoration:underline">展开全文</a>';
       }
       return '<div style="margin-bottom:8px;"><span style="font-size:10px;font-weight:600;letter-spacing:1px;'+roleClass[m.role]+'">['+role+']</span><div style="font-size:12px;color:var(--text);margin-top:2px;white-space:pre-wrap;word-break:break-all;padding:6px 10px;background:rgba(0,0,0,0.02);border-radius:6px;">'+body+'</div></div>';
     }).join('');
     el.innerHTML=html;
     document.getElementById('ctx-time').textContent=j.captureTime?'更新于: '+new Date(j.captureTime).toLocaleString('zh-CN'):'';
     _llmCtxLoaded=true;
   }catch(e){el.innerHTML='<div class="empty">加载失败</div>'}
   finally{_llmCtxInflight=false;}
 }

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
   // ============ 记忆池（五类结构化记忆，2026-09-12 五类改造） ============
  // 五类：关于她/认账/拓本（AI 写入）、压缩摘要（压缩替换入池）、对话碎片（用户侧）；
  // 旧四类（关于我们/锚点/信号/对话摘要）为存量只读兼容，清洗导入完成后消失，统一暗灰显示
  const MP_CAT_COLORS={关于她:'#2980b9',认账:'#c0392b',拓本:'#8e44ad',压缩摘要:'#7f8c8d',对话碎片:'#f39c12',关于我们:'#95a5a6',锚点:'#95a5a6',信号:'#95a5a6',对话摘要:'#95a5a6'};
  function mpCatColor(c){ return MP_CAT_COLORS[c]||'#7f8c8d'; }

  function initMemPoolView(){
    window.__memShowSunk=false;
    window.__memShowPinned=false;
    populateMemPoolCatOptions();
    loadMemPool();
  }
  function populateMemPoolCatOptions(){
    const sel=document.getElementById('mempool-cat');
    const ed=document.getElementById('mempool-edit-cat');
    const cats=['关于她','认账','拓本','压缩摘要','对话碎片'];
    // 筛选下拉带旧四类（存量只读兼容，清洗导入完成后自然为空）
    const legacy=['关于我们','锚点','信号','对话摘要'];
    if(sel){ sel.innerHTML='<option value="">全部分类</option>'+cats.concat(legacy).map(function(c){return '<option value="'+c+'">'+c+(legacy.indexOf(c)>=0?'（旧）':'')+'</option>';}).join(''); }
    // 编辑下拉只放新五类：编辑旧类条目时必须顺手归到新类
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
    const savedY=(window.pageYOffset!==undefined)?window.pageYOffset:(document.documentElement.scrollTop||0);
    try{
      const r=await fetch(ADMIN_API + '/memory-pool?q='+encodeURIComponent(q)+'&category='+encodeURIComponent(cat)+'&sort='+encodeURIComponent(sort));
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
    if(window.__memShowPinned) items=allItems.filter(function(x){return x.pinned===true;});
    else if(window.__memShowSunk) items=allItems.filter(function(x){return x.active===false;});
    else items=allItems.filter(function(x){return x.active!==false;});
    window.__memPoolItems=items;
    const st=document.getElementById('mempool-stats');
    if(st){
      st.innerHTML=''
        +'<span class="mp-stat">共 <b>'+stats.total+'</b> 条</span>'
        +'<span class="mp-stat">活跃 <b>'+stats.active+'</b></span>'
        +'<span class="mp-stat toggle'+(window.__memShowPinned?' on':'')+'" onclick="toggleMemPoolPinned()" title="点一下只看已置顶记忆，再点回到活跃">已pin <b>'+stats.pinned+'</b></span>'
        +'<span class="mp-stat toggle'+(window.__memShowSunk?' on':'')+'" onclick="toggleMemPoolSunk()" title="点一下只看已沉底记忆，再点回到活跃">已沉底 <b>'+stats.sunk+'</b></span>';
    }
    const el=document.getElementById('mempool-list');
    if(!el)return;
    el.className='mp-list';
    if(!items.length){ el.innerHTML='<div class="mp-empty">暂无记忆，点右上角「＋ 新增记忆」或「整理记忆池」</div>'; return; }
    let html='';
    items.forEach(function(it){
      const sunk=it.active===false, pinned=it.pinned;
      const imp=Math.round((Number(it.importance)||0)*100);
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
          +'<span class="mp-imp">重要 '+imp+'%<span class="mp-imp-bar"><span class="mp-imp-fill" style="width:'+imp+'%"></span></span></span>'
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
      const r=await fetch(ADMIN_API + '/memory-pool');
      const d=await r.json();
      const all=d.items||[];
      const rows=all.filter(function(x){return x.active!==false && (!cat || x.category===cat);});
      if(!rows.length){ toast('该类别下没有可导出的活跃记忆'); if(msg) msg.textContent=''; return; }
      // 结构对齐清洗流程：note 字段说明 + items[{n,id,category,importance,source,active,pinned,content}]
      const items=rows.map(function(e,i){
        return { n:i+1, id:e.id, category:e.category, importance:Math.round((Number(e.importance)||0.5)*100)/100,
          source:e.source||'manual', active:e.active!==false, pinned:e.pinned===true, content:e.content||'' };
      });
      const out={ note:'记忆池导出（'+new Date().toLocaleString('zh-CN')+'，范围：'+catLabel+' 活跃条目，沉底不含）。字段：n 序号 / id 条目唯一 id / category 当前分类 / importance 重要级 / source 写入来源 / active false=已沉底 / pinned 是否置顶 / content 内容。清洗产出变更清单：[{id,op:"update"/"delete"/"merge",category?,importance?,content?,into?}]，到「导入清洗」预览后应用。',
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
  // ---- 清洗结果导入：粘贴/上传清洗产出的变更 JSON → 预览统计 → 确认应用（后端自动备份） ----
  function openMemPoolImport(){
    const ta=document.getElementById('mempool-import-text');
    if(ta) ta.value='';
    const fi=document.getElementById('mempool-import-file');
    if(fi) fi.value='';
    const st=document.getElementById('mempool-import-result');
    if(st) st.textContent='';
    const btn=document.getElementById('mempool-import-apply');
    if(btn) btn.style.display='none';
    openModal('mempoolImportModal');
  }
  function memPoolImportFile(input){
    const f=input.files && input.files[0];
    if(!f) return;
    const reader=new FileReader();
    reader.onload=function(){ const ta=document.getElementById('mempool-import-text'); if(ta) ta.value=String(reader.result||''); };
    reader.readAsText(f, 'utf-8');
  }
  function memPoolParseChanges(){
    const ta=document.getElementById('mempool-import-text');
    const raw=ta?ta.value.trim():'';
    if(!raw){ toast('先粘贴或上传清洗结果 JSON'); return null; }
    try{
      let parsed=JSON.parse(raw);
      if(parsed && !Array.isArray(parsed) && Array.isArray(parsed.changes)) parsed=parsed.changes;
      if(!Array.isArray(parsed)) throw new Error('顶层必须是数组（或 {changes:[...]}）');
      return parsed;
    }catch(e){ toast('JSON 解析失败: '+e.message); return null; }
  }
  async function previewMemPoolImport(){
    const changes=memPoolParseChanges();
    if(!changes) return;
    const st=document.getElementById('mempool-import-result');
    if(st) st.textContent='校验中…';
    try{
      const r=await apiRequest('POST', ADMIN_API + '/memory-pool/import', {changes:changes, preview:true}, {busy:null});
      if(!r.ok) return;
      const d=r.data||{};
      if(d.error){ if(st) st.textContent='校验失败: '+d.error; return; }
      const errs=d.errors||[];
      let txt='校验完成：可应用 '+d.total+' 条（改 '+d.update+' / 删 '+d.delete+' / 并 '+d.merge+'）';
      if(errs.length) txt+='；有问题 '+errs.length+' 条将被跳过（如 '+errs.slice(0,2).map(function(e){return (e.id||'')+' '+e.error;}).join('；')+'）';
      if(st) st.textContent=txt;
      const btn=document.getElementById('mempool-import-apply');
      if(btn) btn.style.display=(d.total>0)?'':'none';
      window.__memPoolImportChanges=changes;
    }catch(e){ if(st) st.textContent='预览失败: '+e.message; }
  }
  async function applyMemPoolImport(){
    const changes=window.__memPoolImportChanges;
    if(!changes || !changes.length){ toast('先预览再确认'); return; }
    const st=document.getElementById('mempool-import-result');
    if(st) st.textContent='导入中…';
    try{
      const r=await apiRequest('POST', ADMIN_API + '/memory-pool/import', {changes:changes, preview:false}, {busy:document.getElementById('mempool-import-apply')});
      if(!r.ok) return;
      const d=r.data||{};
      if(d.error){ if(st) st.textContent='导入失败: '+d.error; return; }
      let txt='导入完成：改 '+d.updated+' / 删 '+d.deleted+' / 并 '+d.merged+' / 无变化 '+d.unchanged;
      if(d.backup) txt+='（已自动备份）';
      const errs=d.errors||[];
      if(errs.length) txt+='；跳过 '+errs.length+' 条';
      if(st) st.textContent=txt;
      toast('清洗结果已导入');
      window.__memPoolImportChanges=null;
      const btn=document.getElementById('mempool-import-apply');
      if(btn) btn.style.display='none';
      loadMemPool();
    }catch(e){ if(st) st.textContent='导入失败: '+e.message; }
  }
  function toggleMemPoolSunk(){
    window.__memShowSunk=!window.__memShowSunk;
    if(window.__memShowSunk) window.__memShowPinned=false;
    if(window.__memPoolData){ renderMemPool(window.__memPoolData); } else { loadMemPool(); }
  }
  function toggleMemPoolPinned(){
    window.__memShowPinned=!window.__memShowPinned;
    if(window.__memShowPinned) window.__memShowSunk=false;
    if(window.__memPoolData){ renderMemPool(window.__memPoolData); } else { loadMemPool(); }
  }
  function openMemPoolAdd(){
    AppState.memPoolEditId=null;
    populateMemPoolCatOptions();
    const ed=document.getElementById('mempool-edit-cat');
    if(ed)ed.value='关于她';
    const ii=document.getElementById('mempool-edit-imp');
    if(ii)ii.value='0.6';
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
      ed.value=has?(it.category||'关于她'):'关于她';
      if(!has) toast('「'+it.category+'」是旧分类，保存时会归入新分类，可先在下拉里选对');
    }
    const ii=document.getElementById('mempool-edit-imp');
    if(ii)ii.value=(Number(it.importance)||0.5)+'';
    const ce=document.getElementById('mempool-edit-content');
    if(ce)ce.value=it.content||'';
    document.getElementById('mempool-modal-title').textContent='编辑记忆';
    openModal('mempoolEditModal');
  }
  async function saveMemPoolEdit(){
    const content=document.getElementById('mempool-edit-content').value.trim();
    const category=document.getElementById('mempool-edit-cat').value;
    const importance=parseFloat(document.getElementById('mempool-edit-imp').value);
    if(!content){ toast('记忆内容不能为空'); return; }
    const url=AppState.memPoolEditId ? (ADMIN_API + '/memory-pool/'+AppState.memPoolEditId) : (ADMIN_API + '/memory-pool');
    try{
      const r=await apiRequest(AppState.memPoolEditId?'PUT':'POST', url, {content:content, category:category, importance:Number.isFinite(importance)?importance:0.6}, {busy:document.getElementById('mp-save-btn')});
      if(!r.ok) return;
      const d=r.data||{};
      if(d.error){ toast('保存失败: '+d.error); return; }
      toast(AppState.memPoolEditId?'记忆已更新':'记忆已新增');
      closeModal('mempoolEditModal');
      loadMemPool();
    }catch(e){ toast('网络错误: '+e.message); }
  }
  async function sinkMemPool(id){
    if(!confirm('沉底该条记忆？沉底后不再参与检索浮现。'))return;
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/sink',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})});
      const d=await r.json().catch(function(){return {};});
      if(d.error){ toast('操作失败: '+d.error); return; }
      toast('已沉底'); loadMemPool();
    }catch(e){ toast('操作失败: '+e.message); }
  }
  async function reviveMemPool(id){
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/revive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})});
      const dv=await r.json().catch(function(){return {};});
      if(dv.error){ toast('操作失败: '+dv.error); return; }
      toast('已恢复'); loadMemPool();
    }catch(e){ toast('操作失败: '+e.message); }
  }
  async function togglePinMemPool(id, v){
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned:!!v})});
      const d=await r.json();
      if(d.error){ toast('置顶失败: '+d.error); return; }
      toast(v?'已置顶（跨窗口永远带上）':'已取消置顶'); loadMemPool();
    }catch(e){ toast('网络错误: '+e.message); }
  }
  async function deleteMemPool(id){
    if(!confirm('删除该条记忆？此操作不可恢复。'))return;
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/'+id,{method:'DELETE'});
      const d=await r.json();
      if(d.error){ toast('删除失败: '+d.error); return; }
      toast('已删除'); loadMemPool();
    }catch(e){ toast('操作失败: '+e.message); }
  }
  async function tidyMemPool(){
    if(!confirm('将把记忆池中所有未清洗过的记忆发给 LLM 做一次全量清洗：合并重复/同义、纠正分类、重估重要级、把过时/无关/与已有重复的沉底（不删除，可恢复）。已清洗过的记忆作为参考一起比对，避免重复&下次不再重洗。\n会先预览，你确认后才落地。继续？')) return;
    const msg=document.getElementById('mempool-clean-msg');
    if(msg) msg.textContent='正在生成清洗预览…';
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/clean',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preview:true})});
      const d=await r.json();
      if(d.error){ if(msg) msg.textContent='清洗失败: '+d.error; toast('清洗失败: '+d.error); return; }
      if(msg) msg.textContent='';
      renderCleanPreview(d);
    }catch(e){ if(msg) msg.textContent='清洗失败: '+e.message; toast('清洗失败: '+e.message); }
  }
  function renderCleanPreview(d){
    window.__cleanPreview=d;
    const body=document.getElementById('mempool-clean-body');
    if(!body) return;
    const st=document.getElementById('mempool-clean-stat');
    if(st) st.textContent='活跃 '+d.found+' 条 · 待清洗 '+(d.to_clean||0)+' 条，建议：合并 '+(d.merged||0)+' / 沉底 '+(d.sunk||0)+' / 重分类 '+(d.recategorized||0)+' / 重打分 '+(d.rescored||0)+' / 新增 '+(d.added||0);
    const changes=d.changes||[];
    if(!changes.length){ body.innerHTML='<div class="mp-empty">未识别到需要整理的记忆，可直接关闭。</div>'; }
    else{
      let html='';
      changes.forEach(function(c){
        if(c.type==='add'){
          html+='<div class="cl-diff add"><span class="cl-tag">新增</span><div class="cl-body">'+escapeHtml(c.content)+'</div></div>';
        }else{
          let cat=c.from.category;
          if(c.to && c.to.category && c.to.category!==c.from.category) cat+=' → '+c.to.category;
          let imp=c.from.importance;
          if(c.to && c.to.importance!=null && c.to.importance!==c.from.importance) imp+=' → '+c.to.importance;
          const tag=c.type==='sink'?'沉底':(c.type==='recat'?'改分类':(c.type==='rescore'?'重打分':'修改'));
          html+='<div class="cl-diff '+c.type+'"><span class="cl-tag">'+tag+'</span>'
            +'<div class="cl-cat">'+escapeHtml(cat)+' · 重要 '+escapeHtml(imp)+'</div>'
            +'<div class="cl-body">'+escapeHtml(c.type==='sink'?c.from.content:c.to.content)+'</div>'
            +(c.type!=='sink'?'<div class="cl-old">原：'+escapeHtml(c.from.content)+'</div>':'')
            +'</div>';
        }
      });
      body.innerHTML=html;
    }
    openModal('mempoolCleanModal');
  }
  async function applyClean(){
    const d=window.__cleanPreview;
    if(!d) return;
    const btn=document.getElementById('mempool-clean-apply');
    if(btn){ btn.disabled=true; btn.textContent='落地中…'; }
    try{
      const r=await fetch(ADMIN_API+'/memory-pool/clean',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preview:false})});
      const res=await r.json();
      if(res.error){ toast('落地失败: '+res.error); if(btn){btn.disabled=false;btn.textContent='确认落地';} return; }
      const msg=document.getElementById('mempool-clean-msg');
      if(msg) msg.textContent='已落地：待清洗 '+(res.to_clean||0)+' 条 → 合并 '+(res.merged||0)+' / 沉底 '+(res.sunk||0)+' / 重分类 '+(res.recategorized||0)+' / 重打分 '+(res.rescored||0)+' / 新增 '+(res.added||0);
      toast('整理完成');
      closeModal('mempoolCleanModal');
      loadMemPool();
    }catch(e){ toast('网络错误: '+e.message); if(btn){btn.disabled=false;btn.textContent='确认落地';} }
  }

// ============ 信封：写给下一个窗口自己的信 ============
 // 2026-09-13 死代码清理：letterSeq 已删（声明后从未读写）

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
 
 