(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PondDrawing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const BRUSHES = [ ['brush','毛笔'], ['pencil','铅笔'], ['marker','马克笔'], ['pen','钢笔'], ['pastel','油画棒'] ];
  function path(ctx, points) {
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (let i=1;i<points.length;i++) ctx.lineTo(points[i].x, points[i].y);
  }
  function paintStroke(ctx, points, options) {
    if (!points.length) return;
    const {brush='pen',size=5,color='#222222',opacity=1} = options;
    ctx.save(); ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineCap='round';ctx.lineJoin='round';
    ctx.globalAlpha=opacity;
    const width=brush==='marker'?size*2.6:brush==='pastel'?size*1.9:brush==='eraser'?size*2:size;
    if (brush==='pen'||brush==='marker'||brush==='eraser') {
      if(brush==='marker')ctx.globalAlpha=opacity*.32;
      if(brush==='eraser'){ctx.globalAlpha=1;ctx.fillStyle='#fff';ctx.strokeStyle='#fff';}
      ctx.lineWidth=width;
      if(points.length===1){ctx.beginPath();ctx.arc(points[0].x,points[0].y,width/2,0,Math.PI*2);ctx.fill();}
      else{path(ctx,points);ctx.stroke();}
    } else {
      // 按距离采样，避免设备事件频率改变颗粒密度。
      const progress=options.progress||{};
      let seed=progress.seed??53;
      const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
      const stamp=(x,y,pressure,speed)=>{
        const p=Math.max(.1,Math.min(1,pressure||.5));
        if(brush==='brush'){
          const radius=size*(.18+.8*p)/(1+speed*.025);
          ctx.globalAlpha=opacity;ctx.beginPath();ctx.ellipse(x,y,radius*.72,radius,-.45,0,Math.PI*2);ctx.fill();
        }else{
          const radius=width/2;
          // 铅笔的细颗粒与油画棒的粗蜡屑使用不同尺寸和覆盖率。
          for(let k=0;k<(brush==='pencil'?10:19);k++){
            const angle=random()*Math.PI*2,r=Math.sqrt(random())*radius;
            ctx.globalAlpha=opacity*(brush==='pencil'?.17+random()*.37:.45+random()*.4);
            const grain=brush==='pencil'?.45+random()*.8:.8+random()*2.2;
            ctx.fillRect(x+Math.cos(angle)*r,y+Math.sin(angle)*r,grain,brush==='pencil'?grain:grain*.7);
          }
        }
      };
      if(!progress.started)stamp(points[0].x,points[0].y,points[0].pressure,0);
      let carry=progress.carry||0;
      const step=brush==='brush'?Math.max(.7,size*.1):Math.max(.65,size*.16);
      for(let i=1;i<points.length;i++){
        const a=points[i-1],b=points[i],distance=Math.hypot(b.x-a.x,b.y-a.y);
        if(!distance)continue;
        for(let d=step-carry;d<=distance;d+=step){const t=d/distance;stamp(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,(a.pressure||.5)+((b.pressure||.5)-(a.pressure||.5))*t,distance);}
        carry=(carry+distance)%step;
      }
      progress.seed=seed;progress.carry=carry;progress.started=true;
    }
    ctx.restore();
  }
  function mount(canvas, tools, onChange, onError) {
    const ctx=canvas.getContext('2d'),doc=canvas.ownerDocument,win=doc.defaultView;
    const state={brush:'pen',color:'#222222',size:5,opacity:1,empty:true,undo:[],redo:[],points:[],pointer:null,before:null,frame:null,loading:false,preserved:'',dead:false};
    let dpr=1,initialized=false;
    const snapshot=()=>({image:ctx.getImageData(0,0,canvas.width,canvas.height),empty:state.empty,preserved:state.preserved});
    const restoreSnapshot=s=>{ctx.putImageData(s.image,0,0);state.empty=s.empty;state.preserved=s.preserved||'';status.textContent=state.preserved?'原速写已保留，清空后可重新绘画。':'';};
    const blank=()=>{ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.restore();};
    const remember=()=>{state.undo.push(snapshot());if(state.undo.length>20)state.undo.shift();state.redo=[];};
    function resize(){
      if(state.pointer!==null)finish();
      const rect=canvas.getBoundingClientRect();
      if(initialized&&(!rect.width||!rect.height))return;
      initialized=true;
      const ratio=Math.min(win.devicePixelRatio||1,2),w=Math.max(1,Math.round((rect.width||640)*ratio)),h=Math.max(1,Math.round((rect.height||300)*ratio));
      if(canvas.width===w&&canvas.height===h&&ratio===dpr)return;
      const old=doc.createElement('canvas');old.width=canvas.width;old.height=canvas.height;old.getContext('2d').drawImage(canvas,0,0);
      const scale=s=>{const c=doc.createElement('canvas');c.width=s.image.width;c.height=s.image.height;c.getContext('2d').putImageData(s.image,0,0);const n=doc.createElement('canvas');n.width=w;n.height=h;const nc=n.getContext('2d');nc.drawImage(c,0,0,w,h);return {...s,image:nc.getImageData(0,0,w,h)};};
      state.undo=state.undo.map(scale);state.redo=state.redo.map(scale);
      canvas.width=w;canvas.height=h;dpr=ratio;blank();ctx.drawImage(old,0,0,w,h);ctx.setTransform(dpr,0,0,dpr,0,0);
    }
    const greys=['#ffffff','#d1d1d1','#929292','#555555','#222222','#000000'];
    const hues=['#ff3b30','#ff9500','#ffcc00','#34c759','#00c7be','#32ade6','#007aff','#5856d6','#af52de','#ff2d55'];
    const swatch=(c,label)=>`<button type="button" class="spectrum-color" data-color="${c}" style="--swatch:${c}" aria-label="${label||c}" aria-pressed="${c===state.color}"></button>`;
    tools.innerHTML=`<div class="drawing-heading"><span>随手画一画</span><span class="drawing-status" role="status" aria-live="polite"></span></div>
      <div class="brush-shelf" role="group" aria-label="选择笔刷">${BRUSHES.map(([id,name])=>`<button type="button" class="brush-choice ${id===state.brush?'active':''}" data-brush="${id}" aria-pressed="${id===state.brush}"><span class="brush-symbol brush-${id}" aria-hidden="true"></span><span>${name}</span></button>`).join('')}</div>
      <div class="drawing-adjust"><label>笔宽 <input id="size-range" aria-label="笔宽" type="range" min="1" max="24" value="5"><output id="size-value">5</output></label><label>透明度 <input id="opacity-range" aria-label="透明度" type="range" min="10" max="100" value="100"><output id="opacity-value">100%</output></label></div>
      <details class="drawing-palette"><summary><span class="current-color" style="--swatch:${state.color}"></span>经典色谱 <span class="color-code">${state.color}</span></summary><div class="grey-spectrum" role="group" aria-label="黑白灰">${greys.map(c=>swatch(c)).join('')}</div><div class="classic-spectrum" role="group" aria-label="彩色色谱">${[.5,1,1.6].map(shade=>hues.map(c=>{const rgb=[1,3,5].map(i=>parseInt(c.slice(i,i+2),16));const hex='#'+rgb.map(v=>Math.round(shade<1?v*shade:v+(255-v)*(shade-1)).toString(16).padStart(2,'0')).join('');return swatch(hex);}).join('')).join('')}</div><label class="custom-color">更多颜色 <input type="color" value="#222222" aria-label="自选颜色"></label></details>
      <div class="drawing-actions"><button type="button" class="tool" data-act="eraser" aria-pressed="false">橡皮擦</button><span></span><button type="button" class="tool" data-act="undo" disabled>撤销</button><button type="button" class="tool" data-act="redo" disabled>重做</button><button type="button" class="tool" data-act="clear">清空</button></div>`;
    const status=tools.querySelector('.drawing-status');
    function update(){
      tools.querySelectorAll('[data-brush]').forEach(b=>{const on=b.dataset.brush===state.brush;b.classList.toggle('active',on);b.setAttribute('aria-pressed',on);});
      tools.querySelector('[data-act="eraser"]').classList.toggle('active',state.brush==='eraser');
      tools.querySelector('[data-act="eraser"]').setAttribute('aria-pressed',state.brush==='eraser');
      tools.querySelector('[data-act="undo"]').disabled=!state.undo.length||state.loading;
      tools.querySelector('[data-act="redo"]').disabled=!state.redo.length||state.loading;
      tools.querySelectorAll('[data-color]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.color===state.color));
      tools.querySelector('.current-color').style.setProperty('--swatch',state.color);
      tools.querySelector('.color-code').textContent=state.color.toUpperCase();
    }
    function render(){
      state.frame=null;if(!state.before||state.dead)return;
      if(['brush','pencil','pastel'].includes(state.brush)){
        if(state.points.length>state.rendered){paintStroke(ctx,state.points.slice(Math.max(0,state.rendered-1)),{...state,progress:state.progress});state.rendered=state.points.length;}
      }else{ctx.putImageData(state.before.image,0,0);paintStroke(ctx,state.points,state);}
    }
    function finish(){
      if(state.pointer===null)return;
      if(state.frame!==null)win.cancelAnimationFrame(state.frame);
      render();state.pointer=null;state.empty=state.brush==='eraser'?state.before.empty:false;state.before=null;state.points=[];state.preserved='';update();onChange();
    }
    function position(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/dpr/(r.width||1),y:(e.clientY-r.top)*canvas.height/dpr/(r.height||1),pressure:e.pointerType==='pen'?e.pressure||.5:.5};}
    function down(e){if(state.dead||state.loading||state.preserved||state.pointer!==null||e.button>0)return;e.preventDefault();remember();state.before=state.undo.at(-1);state.points=[position(e)];state.progress={};state.rendered=0;state.pointer=e.pointerId;canvas.setPointerCapture?.(e.pointerId);render();}
    function move(e){if(state.pointer!==e.pointerId||state.pointer===null)return;e.preventDefault();const p=position(e),last=state.points.at(-1);if(Math.hypot(p.x-last.x,p.y-last.y)<.6)return;state.points.push(p);if(state.frame===null)state.frame=win.requestAnimationFrame(render);}
    const up=e=>{if(e.pointerId===state.pointer)finish();};
    canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('lostpointercapture',up);
    function toolClick(e){
      const b=e.target.closest('button');if(!b||state.loading||state.dead)return;
      finish();
      if(b.dataset.brush)state.brush=b.dataset.brush;
      if(b.dataset.color){state.color=b.dataset.color;if(state.brush==='eraser')state.brush='pen';tools.querySelector('input[type=color]').value=state.color;}
      const act=b.dataset.act;
      if(act==='eraser')state.brush='eraser';
      if(act==='undo'&&state.undo.length){state.redo.push(snapshot());restoreSnapshot(state.undo.pop());onChange();}
      if(act==='redo'&&state.redo.length){state.undo.push(snapshot());restoreSnapshot(state.redo.pop());onChange();}
      if(act==='clear'&&win.confirm('清空画布？清空后仍可撤销。')){remember();blank();state.empty=true;state.preserved='';status.textContent='';onChange();}
      update();
    }
    tools.addEventListener('click',toolClick);
    tools.querySelector('#size-range').addEventListener('input',e=>{finish();state.size=Number(e.target.value);tools.querySelector('#size-value').textContent=state.size;});
    tools.querySelector('#opacity-range').addEventListener('input',e=>{finish();state.opacity=Number(e.target.value)/100;tools.querySelector('#opacity-value').textContent=e.target.value+'%';});
    tools.querySelector('input[type=color]').addEventListener('input',e=>{finish();state.color=e.target.value;if(state.brush==='eraser')state.brush='pen';update();});
    resize();win.addEventListener('resize',resize);update();
    return {
      canvas,ctx,resize,isEmpty:()=>state.empty,
      getData:()=>{if(state.preserved)return state.preserved;finish();const c=doc.createElement('canvas'),scale=Math.min(1200/canvas.width,1200/canvas.height,1);c.width=Math.round(canvas.width*scale);c.height=Math.round(canvas.height*scale);c.getContext('2d').drawImage(canvas,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.88);},
      destroy:()=>{state.dead=true;tools.removeEventListener('click',toolClick);win.removeEventListener('resize',resize);if(state.frame!==null)win.cancelAnimationFrame(state.frame);canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('lostpointercapture',up);},
      restore:data=>{if(!data)return;state.empty=false;state.loading=true;state.preserved=data;status.textContent='正在恢复速写…';const img=new win.Image();img.onload=()=>{if(state.dead)return;blank();ctx.drawImage(img,0,0,canvas.width/dpr,canvas.height/dpr);state.loading=false;state.preserved='';status.textContent='';update();};img.onerror=()=>{if(state.dead)return;state.loading=false;status.textContent='原速写已保留，无法显示；清空后可重新绘画。';onError?.('速写未能显示，原始图片仍保留。');update();};img.src=data;}
    };
  }
  return {paintStroke,mount};
});
