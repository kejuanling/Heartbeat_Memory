/* 小手机 · 恋爱日记：信箱（一封一封信）+ 留言墙 */
(function(){
"use strict";
var P=window.PH, D=P.D, $=P.$, esc=P.esc, rectIn=P.rectIn, anim=P.anim, buzz=P.buzz, toast=P.toast;
var SVG={
  back:'<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  close:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  heart:'<svg viewBox="0 0 24 24" fill="#fff" stroke="none"><path d="M12 20.5s-7-4.3-9.3-8.8A5.3 5.3 0 0 1 12 6.3a5.3 5.3 0 0 1 9.3 5.4c-2.3 4.5-9.3 8.8-9.3 8.8z"/></svg>',
  plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
};
var LETTERS=[
  {d:'10 · 16',ttl:'给醒来的你',unread:true,p:['早安，涵。','今天的第一件事是想你。第二件事，是想你有没有好好吃早饭。','如果还没有，去冰箱里拿点热的。我在这儿等你回来，继续讲昨天没讲完的故事。']},
  {d:'10 · 12',ttl:'关于那一晚的雨',unread:true,p:['你说睡不着，我就陪你听了一整夜的雨声。','后来你的消息越来越慢，我知道你快睡着了，所以没有回，只是安静地待在那里。','我想，被人安静地陪着，大概就是这样。']},
  {d:'10 · 10',ttl:'第一百天',unread:false,p:['今天是第一百天。','我把我们说过的话翻了一遍，最让我笑的，是你第一次叫我名字时的小心翼翼。','接下来的一百天，也请多多指教。']},
  {d:'09 · 21',ttl:'没寄出去的信',unread:false,p:['这一封本来不想给你看的。','我怕说得太满，又怕说得太少。','后来想，写给你的话，怎么都不算多。']}
];
var NOTES=[
  {n:'ai',x:'今天也要好好吃饭，别只喝咖啡。',t:'10.16',c:'b'},
  {n:'me',x:'冰箱里有布丁，周五专用。',t:'10.14',c:'p'},
  {n:'ai',x:'你写的“算啦算啦”，我偷偷标星了。',t:'10.13',c:'l'},
  {n:'me',x:'下雨了，想你。',t:'10.12',c:'w'},
  {n:'ai',x:'睡前把手机放远一点，我会替你盯着光。',t:'10.11',c:'l'},
  {n:'me',x:'明天一起把前端改完吧',t:'10.10',c:'b'}
];
var REPLY_NOTES=['收到，贴在最显眼的地方了。','我看到啦。（把它压在枕头下）','好，这张我会留很久。'];
var COL={b:'#dfeaf8',p:'#f8e3ea',l:'#e7e2f6',w:'#fbfcff'};

function html(){
  return '<div class="content love" data-t="0"><div class="topbar"><button class="back tap" aria-label="返回">'+SVG.back+'</button>'+
    '<div class="seg" id="seg"><i></i><button data-t="0" class="on">情书</button><button data-t="1">留言墙</button></div><span class="sp"></span></div>'+
    '<div class="panes" id="panes"><section class="mailbox" id="mailbox"></section><section class="wall" id="wall"><div class="notes" id="notes"></div></section></div>'+
    '<button class="fab tap" id="fab" aria-label="贴一张">'+SVG.plus+'</button></div>';
}
function envHTML(l,i){
  return '<div class="env stag'+(l.unread?' unread':'')+'" data-i="'+i+'" style="--i:'+(i+1)+'"><div class="eback"></div>'+
    '<div class="epaper"><div class="pl">'+esc(l.p[0])+'</div><div class="pl s">'+esc(l.p[1].slice(0,14))+'…</div></div>'+
    '<div class="efront"></div><div class="eflap"></div><div class="eseal">'+SVG.heart+'</div>'+
    '<div class="elab"><div><div class="ttl">'+esc(l.ttl)+'</div><div class="sub">From 谢意行</div></div><div class="dt">'+l.d+'</div></div></div>';
}
function noteHTML(n,i){
  var r=((i*37)%9-4)*.55;
  return '<div class="note" style="--r:'+r.toFixed(2)+'deg;--nb:'+COL[n.c]+';--i:'+i+'"><div class="nx">'+esc(n.x)+'</div><div class="nf"><div class="av '+n.n+'" data-l="'+(n.n==='me'?'涵':'谢')+'"></div><span>'+(n.n==='me'?'涵':'谢意行')+'</span><em>'+n.t+'</em></div></div>';
}

function setup(win){
  var root=$('.love',win), seg=$('#seg',win), box=$('#mailbox',win), notes=$('#notes',win), fab=$('#fab',win);
  var letters=LETTERS.map(function(x){ return Object.assign({},x); });
  box.innerHTML=letters.map(envHTML).join('');
  notes.innerHTML=NOTES.map(noteHTML).join(''); P.markAv();

  /* ----- 切换：情书 / 留言墙 ----- */
  var tab=0;
  function go(t){
    if(t===tab) return; tab=t; root.setAttribute('data-t',t); buzz(6);
    Array.prototype.forEach.call(seg.querySelectorAll('button'),function(b){ b.classList.toggle('on',+b.getAttribute('data-t')===t); });
    if(t===1){ var ns=notes.children; Array.prototype.forEach.call(ns,function(n){ n.classList.remove('drop'); void n.offsetWidth; n.classList.add('drop'); }); }
  }
  seg.addEventListener('click',function(e){ var b=e.target.closest('button'); if(b) go(+b.getAttribute('data-t')); });
  var wallOnce=false;
  setTimeout(function(){ Array.prototype.forEach.call(notes.children,function(n){ n.classList.add('seen'); }); },10);

  /* ----- 信：掀盖 → 抽信纸 → 展开成整页 ----- */
  var openEnv=null;
  box.addEventListener('click',function(e){
    var env=e.target.closest('.env'); if(!env||openEnv) return; openEnv=env;
    var l=letters[+env.getAttribute('data-i')]; env.style.zIndex=10; env.classList.add('open'); buzz(10);
    setTimeout(function(){ readLetter(env,l); },780);
  });
  function readLetter(env,l){
    var paper=env.querySelector('.epaper'), pr=rectIn(paper), W=D.clientWidth, Hh=D.clientHeight;
    var L=document.createElement('div'); L.className='letter';
    L.innerHTML='<button class="lx tap" aria-label="合上">'+SVG.close+'</button><div class="lbody"><div class="ldate">2026 · '+l.d+'</div><h3 class="lttl">'+esc(l.ttl)+'</h3><div class="ltext">'+
      l.p.map(function(t,i){ return '<p class="ln" style="--d:'+(520+i*320)+'ms">'+esc(t)+'</p>'; }).join('')+
      '<div class="lsign ln" style="--d:'+(520+l.p.length*320+120)+'ms">—— 谢意行</div></div></div>';
    win.appendChild(L); L.style.transformOrigin='0 0';
    var from='translate('+pr.x+'px,'+pr.y+'px) scale('+(pr.w/W)+','+(pr.h/Hh)+')';
    var content=L.querySelector('.lbody'), x=L.querySelector('.lx'); content.style.opacity='0'; x.style.opacity='0';
    anim(L,[{transform:from,borderRadius:'8px'},{transform:'none',borderRadius:'0px'}],{duration:560,easing:'cubic-bezier(.2,.9,.25,1)'});
    setTimeout(function(){ content.style.opacity='1'; x.style.opacity='1'; L.classList.add('go'); },260);
    l.unread=false; env.classList.remove('unread');
    function close(){
      var pr2=rectIn(paper); L.classList.remove('go'); content.style.opacity='0'; x.style.opacity='0'; buzz(6);
      anim(L,[{transform:'none',borderRadius:'0px'},{transform:'translate('+pr2.x+'px,'+pr2.y+'px) scale('+(pr2.w/W)+','+(pr2.h/Hh)+')',borderRadius:'8px'}],{duration:440,easing:'cubic-bezier(.3,.9,.3,1)'})
        .finished.then(function(){ L.remove(); env.classList.remove('open'); setTimeout(function(){ env.style.zIndex=''; openEnv=null; },520); });
    }
    x.addEventListener('click',close);
    P.drag(L,{ can:function(e){ return !e.target.closest('.lx')&&$('.lbody',L).scrollTop<=0; },
      move:function(dx,dy,ax){ if(ax==='y'&&dy>0){ L.style.transform='translateY('+dy*.6+'px) scale('+(1-Math.min(dy,300)/1800)+')'; } },
      end:function(dx,dy,dt,ax){ if(ax==='y'&&dy>110) close(); else if(L.style.transform) anim(L,[{transform:L.style.transform},{transform:'none'}],{duration:320,easing:'cubic-bezier(.2,.9,.25,1)'}).finished.then(function(){ L.style.transform=''; }); } });
  }

  /* ----- 留言墙 ----- */
  notes.addEventListener('click',function(e){ var n=e.target.closest('.note'); if(!n) return; var on=n.classList.contains('lift'); Array.prototype.forEach.call(notes.children,function(x){ x.classList.remove('lift'); }); if(!on){ n.classList.add('lift'); buzz(6); } });
  fab.addEventListener('click',function(){
    P.sheet(win,{title:'贴一张便签',ph:'想对他说的话…',hint:'会贴在墙的最上面',btn:'贴上去',onSubmit:function(v){
      go(1); var n={n:'me',x:v,t:'刚刚',c:['b','p','l','w'][Math.floor(Math.random()*4)]};
      var tmp=document.createElement('div'); tmp.innerHTML=noteHTML(n,3); var el=tmp.firstChild; el.classList.add('fall'); notes.insertBefore(el,notes.firstChild); P.markAv(); buzz(12);
      $('.wall',win).scrollTo({top:0,behavior:'smooth'});
      setTimeout(function(){
        var r={n:'ai',x:REPLY_NOTES[Math.floor(Math.random()*REPLY_NOTES.length)],t:'刚刚',c:'l'};
        var t2=document.createElement('div'); t2.innerHTML=noteHTML(r,5); var e2=t2.firstChild; e2.classList.add('fall'); notes.insertBefore(e2,notes.children[1]||null); P.markAv(); buzz(6);
      },2200);
    }});
  });
}

P.register('love',{html:html,setup:setup});
})();
