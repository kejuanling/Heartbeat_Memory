/* 小手机 · 公共小工具：键盘避让、底部输入抽屉、抖一抖 */
(function(){
"use strict";
var P=window.PH;
P.esc=function(s){ return String(s).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
P.kb=function(fn){
  if(!window.visualViewport) return;
  var f=function(){ fn(Math.max(0,innerHeight-visualViewport.height-visualViewport.offsetTop)); };
  visualViewport.addEventListener('resize',f); visualViewport.addEventListener('scroll',f);
};
P.shake=function(el){ P.anim(el,[{transform:'translateX(0)'},{transform:'translateX(-8px)'},{transform:'translateX(7px)'},{transform:'translateX(-4px)'},{transform:'translateX(0)'}],{duration:320,fill:'none'}); };
P.sheet=function(win,o){
  var el=document.createElement('div'); el.className='sheetw';
  el.innerHTML='<div class="scrim"></div><div class="sheet"><div class="grab2"></div>'+(o.title?'<div class="sh-t">'+o.title+'</div>':'')+
    '<textarea rows="4" placeholder="'+P.esc(o.ph||'')+'"></textarea><div class="sh-row"><span class="sh-hint">'+P.esc(o.hint||'')+'</span><button class="sh-btn tap">'+P.esc(o.btn||'好')+'</button></div></div>';
  win.appendChild(el);
  var ta=el.querySelector('textarea'), sh=el.querySelector('.sheet');
  requestAnimationFrame(function(){ requestAnimationFrame(function(){ el.classList.add('show'); }); setTimeout(function(){ try{ ta.focus(); }catch(_){} },320); });
  var closed=false;
  function close(){ if(closed) return; closed=true; el.classList.remove('show'); try{ ta.blur(); }catch(_){} sh.style.transform=''; setTimeout(function(){ el.remove(); },420); }
  el.querySelector('.scrim').addEventListener('click',close);
  el.querySelector('.sh-btn').addEventListener('click',function(){ var v=ta.value.trim(); if(!v){ P.shake(sh); return; } close(); o.onSubmit(v); });
  P.kb(function(kb){ if(!closed) sh.style.transform=kb?'translateY(-'+kb+'px)':''; });
  return {close:close};
};
})();
