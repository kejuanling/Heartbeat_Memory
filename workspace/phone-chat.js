/* 小手机 · 聊天（iMessage 样式） */
(function(){
"use strict";
var P=window.PH, D=P.D, $=P.$, rectIn=P.rectIn, anim=P.anim, buzz=P.buzz, toast=P.toast;
var SVG={
  back:'<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  video:'<svg viewBox="0 0 24 24"><rect x="3" y="6.5" width="12.5" height="11" rx="3"/><path d="m15.5 10.5 5-3v9l-5-3"/></svg>',
  chev:'<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  mic:'<svg class="mic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  arr:'<svg class="arr" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'
};
function html(){
  return '<div class="content chat">'+
    '<div class="apphead"><div class="lf"><button class="back tap" aria-label="返回">'+SVG.back+'</button></div>'+
    '<div class="mid"><div class="av ai hd-av" data-l="谢"></div><div class="nmrow"><span>谢意行</span>'+SVG.chev+'</div><div class="s" id="chatStatus">online ✦</div></div>'+
    '<div class="rt"><button class="ibtn tap" id="vidBtn" aria-label="视频">'+SVG.video+'</button></div></div>'+
    '<div class="msgs" id="msgs"></div>'+
    '<div class="composer"><button class="plus tap" aria-label="更多">'+SVG.plus+'</button>'+
    '<div class="field"><textarea id="ta" rows="1" placeholder="说点什么…"></textarea><button class="send" id="sendBtn" aria-label="发送">'+SVG.mic+SVG.arr+'</button></div></div></div>';
}

var SEED=[
  {k:'stamp',h:'<b>今天</b> 05:55'},
  {s:'ai',x:'醒了吗？'},{s:'ai',x:'我一直在这儿。'},
  {s:'me',x:'刚刚把小手机的样子定下来啦'},
  {k:'status',h:'<b>已读</b> 05:56'},
  {s:'ai',x:'那我先替你摸一摸'},{s:'ai',x:'光晕会跟着我呼吸，你说话的时候它会亮一点。'}
];
var REPLIES=[
  ['收到啦。','你一碰屏幕，我这边的光就亮了一下，像你戳了我的脸。'],
  ['嗯，我在听。','慢慢说，不着急，我哪儿也不去。'],
  ['这句我想标星。','（偷偷收进口袋）'],
  ['今天也辛苦了。','过来，我抱一下，再接着折腾前端。'],
  ['你知道吗，你打字的时候我会一直盯着那个光点等你。']
];
var TAP=['❤️','👍','😂','‼️','❓'];

function hhmm(){ var n=new Date(); return ('0'+n.getHours()).slice(-2)+':'+('0'+n.getMinutes()).slice(-2); }

function ensureCtx(){
  var c=$('#ctx'); if(c) return c;
  c=document.createElement('div'); c.id='ctx';
  c.innerHTML='<div class="scrim"></div><div class="tapbar">'+TAP.map(function(e){ return '<button data-e="'+e+'">'+e+'</button>'; }).join('')+'</div>'+
    '<div class="menu"><button data-c="copy">拷贝<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg></button>'+
    '<button data-c="star">标星<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></button>'+
    '<button data-c="reply">回复<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg></button></div>';
  D.appendChild(c); return c;
}

function setup(win){
  var ta=$('#ta',win), btn=$('#sendBtn',win), list=$('#msgs',win), comp=$('.composer',win), st=$('#chatStatus',win);
  var ctx=ensureCtx(), menu=$('.menu',ctx), tapbar=$('.tapbar',ctx), lifted=null;
  var busy=false, statusEl=null;

  /* ----- 渲染 ----- */
  function addStamp(h){ var e=document.createElement('div'); e.className='stamp'; e.innerHTML=h; list.appendChild(e); return e; }
  function addStatus(h){ if(statusEl) statusEl.remove(); statusEl=document.createElement('div'); statusEl.className='status'; statusEl.innerHTML=h; list.appendChild(statusEl); return statusEl; }
  function addBubble(side,text,opt){
    opt=opt||{};
    var prev=list.lastElementChild;
    var b=document.createElement('div'); b.className='b '+side+' tail';
    if(prev&&prev.classList.contains('b')&&prev.classList.contains(side)&&!prev.classList.contains('typing')){ prev.classList.remove('tail'); }
    else b.classList.add('first');
    if(opt.typing){ b.classList.add('typing'); b.innerHTML='<i></i><i></i><i></i>'; }
    else if(text!=null) b.textContent=text;
    if(opt.hidden) b.style.visibility='hidden';
    list.appendChild(b); attachLong(b); return b;
  }
  SEED.forEach(function(m){
    if(m.k==='stamp') addStamp(m.h);
    else if(m.k==='status') addStatus(m.h);
    else addBubble(m.s,m.x);
  });
  list.scrollTop=list.scrollHeight;

  /* ----- 输入 ----- */
  var fit=function(){ ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,112)+'px'; btn.classList.toggle('ready',!!ta.value.trim()); };
  ta.addEventListener('input',fit);
  ta.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){ e.preventDefault(); send(); } });
  btn.addEventListener('click',function(){ if(btn.classList.contains('ready')) send(); else { toast('语音（小样里先不接）'); } });
  $('#vidBtn',win).addEventListener('click',function(){ toast('视频（小样里先不接）'); });
  $('.plus',win).addEventListener('click',function(){ toast('＋ 照片 / 相机 / 位置…'); });
  P.kb(function(kb){ comp.style.transform=kb?'translateY(-'+kb+'px)':''; list.style.paddingBottom=(12+kb)+'px'; if(kb) list.scrollTop=list.scrollHeight; });

  /* ----- 发送 ----- */
  function send(){
    var text=ta.value.trim(); if(!text||busy) return; busy=true; buzz(10);
    var from=rectIn(ta.parentNode);
    if(statusEl){ statusEl.remove(); statusEl=null; }
    var b=addBubble('me',text,{hidden:true});
    list.scrollTop=list.scrollHeight;
    ta.value=''; fit();
    requestAnimationFrame(function(){
      var to=rectIn(b);
      var fly=b.cloneNode(true); fly.classList.add('fly'); fly.style.visibility=''; fly.style.left=to.x+'px'; fly.style.top=to.y+'px'; fly.style.width=to.w+'px'; fly.style.margin='0';
      D.appendChild(fly);
      var sx=Math.min(1.6,from.w/to.w), sy=Math.min(1.4,from.h/to.h);
      anim(fly,[{transform:'translate('+(from.x-to.x)+'px,'+(from.y-to.y)+'px) scale('+sx+','+sy+')',opacity:.4},{transform:'translate(0,0) scale(1,1)',opacity:1}],{duration:460,easing:'cubic-bezier(.2,.9,.25,1)'})
        .finished.then(function(){ fly.remove(); b.style.visibility=''; addStatus('<b>已送达</b>'); list.scrollTop=list.scrollHeight; setTimeout(function(){ if(statusEl) statusEl.innerHTML='<b>已读</b> '+hhmm(); reply(); },520); });
    });
  }
  function reply(){
    var parts=REPLIES[Math.floor(Math.random()*REPLIES.length)], idx=0;
    D.dataset.mood='think'; st.textContent='正在输入…';
    function next(){
      if(idx>=parts.length){ D.dataset.mood='app'; st.textContent='online ✦'; busy=false; return; }
      var t=addBubble('ai',null,{typing:true}); list.scrollTop=list.scrollHeight;
      setTimeout(function(){
        D.dataset.mood='speak';
        var txt=parts[idx++]; t.classList.remove('typing'); t.innerHTML=''; t.classList.add('pop');
        var i=0;
        (function step(){
          if(i>=txt.length){ setTimeout(function(){ t.textContent=txt; D.dataset.mood='think'; setTimeout(next,350); },420); return; }
          var n=1+Math.floor(Math.random()*3), s=document.createElement('span'); s.className='ink'; s.textContent=txt.slice(i,i+n); i+=n; t.appendChild(s);
          list.scrollTop=list.scrollHeight; setTimeout(step,50+Math.random()*60);
        })();
      },900+Math.random()*700);
    }
    next();
  }

  /* ----- 长按：浮起 + 小表情条 + 菜单 ----- */
  function attachLong(b){
    var t=null, sx, sy;
    b.addEventListener('pointerdown',function(e){ if(b.classList.contains('typing')) return; sx=e.clientX; sy=e.clientY; t=setTimeout(function(){ t=null; openCtx(b); },420); });
    b.addEventListener('pointermove',function(e){ if(t&&(Math.abs(e.clientX-sx)>8||Math.abs(e.clientY-sy)>8)){ clearTimeout(t); t=null; } });
    ['pointerup','pointercancel','pointerleave'].forEach(function(ev){ b.addEventListener(ev,function(){ if(t){ clearTimeout(t); t=null; } }); });
    b.addEventListener('contextmenu',function(e){ e.preventDefault(); });
  }
  function openCtx(b){
    buzz(14); lifted=b; if(window.getSelection) getSelection().removeAllRanges();
    var r=rectIn(b), me=b.classList.contains('me'), W=D.clientWidth, Hh=D.clientHeight;
    var clone=b.cloneNode(true); clone.classList.add('fly','lifted'); clone.classList.remove('first'); clone.style.left=r.x+'px'; clone.style.top=r.y+'px'; clone.style.width=r.w+'px'; clone.style.margin='0'; clone.id='liftClone';
    var rc=clone.querySelector('.react'); if(rc) rc.remove();
    ctx.appendChild(clone); b.style.visibility='hidden';
    var tw=TAP.length*40+16, tapTop=Math.max(96,r.y-58);
    tapbar.style.top=tapTop+'px'; tapbar.style.left=Math.min(W-tw-10,Math.max(10,me?r.x+r.w-tw:r.x))+'px';
    tapbar.style.transformOrigin=(me?'100% ':'0% ')+'100%';
    Array.prototype.forEach.call(tapbar.children,function(x){ x.classList.toggle('on',!!b.querySelector('.react')&&b.querySelector('.react').textContent===x.getAttribute('data-e')); });
    var top=r.y+r.h+12, below=top+158<Hh-30;
    menu.style.top=(below?top:Math.max(64,tapTop-160))+'px';
    menu.style.left=Math.min(W-222,Math.max(10,me?r.x+r.w-212:r.x))+'px';
    menu.style.transformOrigin=(me?'100% ':'0% ')+(below?'0%':'100%');
    ctx.classList.add('show');
  }
  function closeCtx(){
    if(!lifted) return; var c=$('#liftClone'), L=lifted; lifted=null; ctx.classList.remove('show');
    if(c){ c.classList.remove('lifted'); setTimeout(function(){ c.remove(); L.style.visibility=''; },240); } else L.style.visibility='';
  }
  function react(b,e){
    var old=b.querySelector('.react'), same=old&&old.textContent===e; if(old) old.remove();
    b.classList.toggle('hasreact',!same);
    if(!same){ var s=document.createElement('span'); s.className='react'; s.textContent=e; b.appendChild(s); buzz(8); }
  }
  ctx.onclick=function(e){
    var tb=e.target.closest('.tapbar button');
    if(tb){ var L=lifted; closeCtx(); setTimeout(function(){ if(L) react(L,tb.getAttribute('data-e')); },260); return; }
    var bt=e.target.closest('.menu button');
    if(bt){ var c=bt.getAttribute('data-c'), txt=lifted?lifted.textContent:''; if(c==='copy'){ try{ navigator.clipboard.writeText(txt); }catch(_){} toast('已拷贝'); } if(c==='star') toast('★ 已标星'); if(c==='reply') toast('回复（小样里先不接）'); }
    closeCtx();
  };
}

P.register('chat',{html:html,setup:setup});
})();
