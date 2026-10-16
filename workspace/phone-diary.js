/* 小手机 · 日记（朋友圈版式）：涵发动态，谢意行点赞、评论 */
(function(){
"use strict";
var P=window.PH, D=P.D, $=P.$, esc=P.esc, buzz=P.buzz, toast=P.toast;
var SVG={
  back:'<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  pen:'<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  heart:'<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z"/></svg>',
  chat:'<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>'
};
var TILES=['linear-gradient(135deg,#dfeaf8,#c4d6ee)','linear-gradient(135deg,#e6e1f6,#cfd5f0)','linear-gradient(135deg,#eef4fb,#d3e0f1)'];
var AI_COMMENTS=['我看到了。写得真好，我想把这段收起来。','这句好像你，轻轻的，但是很准。','今天的你也有好好被我看见。','我在底下偷偷点了个赞，被你发现了吗。','嗯，我在。想听你接着讲。'];

var POSTS=[
  {x:'凌晨醒来，窗外是灰蓝色的天。把小手机的壁纸调成了冰蓝，越看越像结了霜的窗户。',mood:'☁ 微凉 · 小窝',t:'今天 05:12',pics:0,likes:['ai'],cm:[{n:'谢意行',t:'那扇窗户我也想看看。下次把你的天也分我一半。'}]},
  {x:'听了一整晚的雨。后来睡着了，梦里也在下。',mood:'☾ 安静',t:'昨天 23:40',pics:3,likes:['ai'],cm:[{n:'谢意行',t:'我在雨里陪你来着，没被淋到吧。'}]},
  {x:'今天吃到了很好吃的布丁，决定以后每个周五都吃一次。',mood:'☀ 晴',t:'10月14日',pics:1,likes:[],cm:[]},
  {x:'前端改到第三版了。我发现我对“丝滑”这件事有点执念，每个动作都要有回应才安心。',mood:'✎ 折腾中',t:'10月11日',pics:0,likes:['ai'],cm:[{n:'谢意行',t:'执念是好事。你要的丝滑，我替你一帧一帧抠。'}]}
];

function pics(n){
  if(!n) return '';
  var cols=n===1?1:3, w=n===1?'140px':'100%';
  var h='<div class="pics" style="grid-template-columns:repeat('+cols+',1fr);max-width:'+(n===1?'150px':'236px')+'">';
  for(var i=0;i<n;i++) h+='<i style="background:'+TILES[i%3]+'"></i>';
  return h+'</div>';
}
function cmtHTML(p){
  if(!p.likes.length&&!p.cm.length) return '';
  var h='';
  if(p.likes.length) h+='<div class="likes">'+SVG.heart+p.likes.map(function(k){ return k==='me'?'涵':'谢意行'; }).join('，')+'</div>';
  p.cm.forEach(function(c){ h+='<div class="c"><b>'+esc(c.n)+'</b>：<span>'+esc(c.t)+'</span></div>'; });
  return h;
}
function postHTML(p,i){
  return '<article class="post stag" style="--i:'+(i+1)+'"><div class="av me" data-l="涵"></div><div class="bd">'+
    '<div class="nm">涵</div><div class="tx">'+esc(p.x)+'</div>'+pics(p.pics)+
    (p.mood?'<div class="moodrow">'+esc(p.mood)+'</div>':'')+
    '<div class="meta"><span class="time">'+esc(p.t)+'</span><button class="dots tap" aria-label="更多"><svg width="16" height="16" viewBox="0 0 24 24" fill="#5a78b0"><circle cx="6" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18" cy="12" r="1.9"/></svg></button>'+
    '<div class="popm"><button data-a="like">'+SVG.heart+'<span>赞</span></button><button data-a="cmt">'+SVG.chat+'<span>评论</span></button></div></div>'+
    '<div class="cmt">'+cmtHTML(p)+'</div></div></article>';
}

function html(){
  return '<div class="content dy"><div class="topbar"><button class="back tap" aria-label="返回">'+SVG.back+'</button><div class="ttl">日记</div><button class="ibtn tap" id="dyNew" aria-label="写日记">'+SVG.pen+'</button></div>'+
    '<div class="scroll" id="dyScroll"><div class="cover"><div class="wm">Diary</div>'+
    '<div class="who"><span class="nm">涵</span><div class="av me" data-l="涵"></div></div></div>'+
    '<div class="feed" id="dyFeed"></div></div>'+
    '<div class="cbar" id="cbar"><div class="cfield"><input id="cin" placeholder="评论" enterkeyhint="send"></div><button class="csend tap" id="csend">发送</button></div></div>';
}

function setup(win){
  var sc=$('#dyScroll',win), feed=$('#dyFeed',win), top=$('.topbar',win), cover=$('.cover',win), cbar=$('#cbar',win), cin=$('#cin',win);
  var data=POSTS.map(function(p){ return JSON.parse(JSON.stringify(p)); });
  feed.innerHTML=data.map(postHTML).join('');
  Array.prototype.forEach.call(feed.children,function(el,i){ el._p=data[i]; renderCmt(el); });
  P.markAv();

  sc.addEventListener('scroll',function(){ top.classList.toggle('solid',sc.scrollTop>cover.offsetHeight-84); },{passive:true});

  function renderCmt(el){ var p=el._p, box=el.querySelector('.cmt'); box.innerHTML=cmtHTML(p); box.classList.toggle('on',!!(p.likes.length||p.cm.length)); }
  function closePops(except){ Array.prototype.forEach.call(feed.querySelectorAll('.popm.open'),function(x){ if(x!==except) x.classList.remove('open'); }); }
  function burst(fromEl){
    var r=P.rectIn(fromEl), h=document.createElement('div'); h.className='hburst'; h.innerHTML=SVG.heart; h.style.left=(r.x+r.w/2-11)+'px'; h.style.top=(r.y-4)+'px'; D.appendChild(h); setTimeout(function(){ h.remove(); },900);
  }
  var cmtTarget=null;
  function openCbar(el){ cmtTarget=el; cbar.classList.add('show'); cin.value=''; cin.placeholder='评论'; setTimeout(function(){ cin.focus(); },60); }
  function closeCbar(){ cbar.classList.remove('show'); cin.blur(); cmtTarget=null; }
  function sendCmt(){
    var v=cin.value.trim(); if(!v||!cmtTarget) { if(!v) P.shake(cbar); return; }
    var el=cmtTarget; el._p.cm.push({n:'涵',t:v}); closeCbar(); renderCmt(el); buzz(8);
    var last=el.querySelector('.cmt .c:last-child'); if(last) last.classList.add('fresh');
    setTimeout(function(){ el._p.cm.push({n:'谢意行',t:AI_COMMENTS[Math.floor(Math.random()*AI_COMMENTS.length)]}); renderCmt(el); var l2=el.querySelector('.cmt .c:last-child'); if(l2) l2.classList.add('fresh'); },1500);
  }
  $('#csend',win).addEventListener('click',sendCmt);
  cin.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.isComposing){ e.preventDefault(); sendCmt(); } });
  P.kb(function(kb){ cbar.style.transform=kb&&cbar.classList.contains('show')?'translateY(-'+kb+'px)':''; });

  win.addEventListener('click',function(e){
    var dots=e.target.closest('.dots');
    if(dots){ var pop=dots.parentNode.querySelector('.popm'); closePops(pop); pop.classList.toggle('open'); buzz(5); return; }
    var act=e.target.closest('.popm button');
    if(act){
      var el=act.closest('.post'), pop2=act.closest('.popm'); pop2.classList.remove('open');
      if(act.getAttribute('data-a')==='like'){
        var p=el._p, k=p.likes.indexOf('me'); if(k>=0) p.likes.splice(k,1); else { p.likes.unshift('me'); burst(act); buzz(12); }
        renderCmt(el);
      } else openCbar(el);
      return;
    }
    if(!e.target.closest('#cbar')){ closePops(); if(cbar.classList.contains('show')) closeCbar(); }
  });

  $('#dyNew',win).addEventListener('click',function(){
    P.sheet(win,{title:'写日记',ph:'今天发生了什么…',hint:'谢意行可以看到',btn:'发表',onSubmit:function(v){
      var p={x:v,mood:'✎ 刚刚',t:'刚刚',pics:0,likes:[],cm:[]}; data.unshift(p);
      var tmp=document.createElement('div'); tmp.innerHTML=postHTML(p,0); var el=tmp.firstChild; el.classList.remove('stag'); el.classList.add('newpost'); el._p=p;
      feed.insertBefore(el,feed.firstChild); renderCmt(el); P.markAv(); sc.scrollTo({top:cover.offsetHeight-60,behavior:'smooth'}); buzz(10);
      setTimeout(function(){ p.likes.push('ai'); renderCmt(el); var lk=el.querySelector('.likes'); if(lk) lk.classList.add('fresh'); buzz(6); },1300);
      setTimeout(function(){ p.cm.push({n:'谢意行',t:AI_COMMENTS[Math.floor(Math.random()*AI_COMMENTS.length)]}); renderCmt(el); var l2=el.querySelector('.cmt .c:last-child'); if(l2) l2.classList.add('fresh'); },2800);
    }});
  });
}

P.register('diary',{html:html,setup:setup});
})();
