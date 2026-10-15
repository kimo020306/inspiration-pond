const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const { paintStroke } = require('../dist/drawing.js');
function draw(brush, extra = {}, points = [{x:20,y:55,pressure:.5},{x:75,y:35,pressure:.9},{x:135,y:55,pressure:.3}]) {
  const canvas = createCanvas(160, 100), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,160,100);
  paintStroke(ctx, points, { brush, color:'#000000', size:12, opacity:1, ...extra });
  return { canvas, ctx, pixels: ctx.getImageData(0,0,160,100).data };
}
test('five brushes leave distinct visible raster marks', () => {
  const results = ['brush','pencil','marker','pen','pastel'].map(name => draw(name));
  for (const r of results) assert.ok(r.pixels.some((v,i) => i%4!==3 && v<220));
  assert.equal(new Set(results.map(r=>r.canvas.toBuffer('image/png').toString('base64'))).size,5);
});
test('a tap leaves a mark and lower opacity deposits less pigment', () => {
  const points = [{x:80,y:50,pressure:.5}];
  const solid = draw('pen',{},points), pale = draw('pen',{opacity:.2},points);
  const at = (50*160+80)*4;
  assert.ok(solid.pixels[at]<20);
  assert.ok(pale.pixels[at]>150 && pale.pixels[at]<240);
});
test('marker remains translucent and chosen color is respected', () => {
  const mark = draw('marker',{color:'#ff0000'},[{x:40,y:50},{x:120,y:50}]);
  const at=(50*160+80)*4;
  assert.equal(mark.pixels[at],255);
  assert.ok(mark.pixels[at+1]>120 && mark.pixels[at+1]<240);
});
test('painting restores context alpha and eraser removes opaque paint', () => {
  const canvas=createCanvas(100,100),ctx=canvas.getContext('2d');
  ctx.fillStyle='#000';ctx.fillRect(0,0,100,100);
  paintStroke(ctx,[{x:20,y:50},{x:80,y:50}],{brush:'eraser',size:15,color:'#f00',opacity:.1});
  assert.deepEqual([...ctx.getImageData(50,50,1,1).data],[255,255,255,255]);
  assert.equal(ctx.globalAlpha,1);
});

function board(t) {
  const { JSDOM }=require('jsdom'), {mount}=require('../dist/drawing.js');
  const dom=new JSDOM('<canvas></canvas><div id="tools"></div>',{pretendToBeVisual:true});
  const win=dom.window, backing=new WeakMap();
  function native(el){let n=backing.get(el);if(!n){n=createCanvas(el.width||1,el.height||1);backing.set(el,n);}if(n.width!==el.width)n.width=el.width;if(n.height!==el.height)n.height=el.height;return n;}
  win.HTMLCanvasElement.prototype.getContext=function(){const el=this;return new Proxy({}, {
    get:(_,k)=>{const ctx=native(el).getContext('2d');if(typeof ctx[k]!=='function')return ctx[k];return (...args)=>{if(k==='drawImage'&&args[0] instanceof win.HTMLCanvasElement)args[0]=native(args[0]);return ctx[k](...args);};},
    set:(_,k,v)=>{native(el).getContext('2d')[k]=v;return true;}
  });};
  win.HTMLCanvasElement.prototype.toDataURL=function(...args){return native(this).toDataURL(...args);};
  let width=360;
  win.HTMLCanvasElement.prototype.getBoundingClientRect=()=>({left:0,top:0,width,height:300});
  win.confirm=()=>true;
  const canvas=win.document.querySelector('canvas'),tools=win.document.querySelector('#tools');
  const api=mount(canvas,tools,()=>{});
  t.after(()=>{api.destroy();win.close();});
  const event=(type,x,y)=>{const e=new win.Event(type,{cancelable:true});Object.assign(e,{clientX:x,clientY:y,pointerId:1,button:0,pointerType:'mouse'});canvas.dispatchEvent(e);};
  return {win,canvas,tools,api,resize:w=>{width=w;win.dispatchEvent(new win.Event('resize'));},stroke:()=>{event('pointerdown',30,50);event('pointermove',100,70);event('pointerup',100,70);},pixels:()=>Buffer.from(native(canvas).getContext('2d').getImageData(0,0,canvas.width,canvas.height).data)};
}
test('undoing the only stroke restores empty state; redo and clear preserve pixels',t=>{
  const b=board(t),blank=b.pixels();b.stroke();const drawn=b.pixels();
  assert.equal(b.api.isEmpty(),false);assert.notDeepEqual(drawn,blank);
  b.tools.querySelector('[data-act=undo]').click();assert.equal(b.api.isEmpty(),true);assert.deepEqual(b.pixels(),blank);
  b.tools.querySelector('[data-act=redo]').click();assert.equal(b.api.isEmpty(),false);assert.deepEqual(b.pixels(),drawn);
  b.tools.querySelector('[data-act=clear]').click();assert.equal(b.api.isEmpty(),true);
  b.tools.querySelector('[data-act=undo]').click();assert.deepEqual(b.pixels(),drawn);assert.equal(b.api.isEmpty(),false);
});
test('resizing preserves drawing and undo history instead of erasing it',t=>{
  const b=board(t);b.stroke();b.resize(240);
  assert.equal(b.canvas.width,240);assert.equal(b.api.isEmpty(),false);
  assert.ok(b.pixels().some((v,i)=>i%4!==3&&v<220));
  b.tools.querySelector('[data-act=undo]').click();assert.equal(b.api.isEmpty(),true);
  b.tools.querySelector('[data-act=redo]').click();assert.equal(b.api.isEmpty(),false);
});
test('destroying and remounting a board leaves only one live toolbar handler',t=>{
  const b=board(t);let confirmations=0;b.win.confirm=()=>{confirmations++;return true;};
  b.api.destroy();const current=require('../dist/drawing.js').mount(b.canvas,b.tools,()=>{});
  t.after(()=>current.destroy());b.stroke();const drawn=b.pixels();
  b.tools.querySelector('[data-act=clear]').click();assert.equal(confirmations,1);
  b.tools.querySelector('[data-act=undo]').click();assert.deepEqual(b.pixels(),drawn);
});
test('clear then undo retains original sketch bytes when image decoding failed',t=>{
  const b=board(t);b.win.Image=class{set src(value){this.onerror();}};
  b.api.restore('data:image/jpeg;base64,b3JpZ2luYWw=');
  b.tools.querySelector('[data-act=clear]').click();b.tools.querySelector('[data-act=undo]').click();
  assert.equal(b.api.getData(),'data:image/jpeg;base64,b3JpZ2luYWw=');
});
test('resizing a collapsed board does not replace its backing width with a fallback',t=>{
  const b=board(t);b.stroke();b.resize(0);assert.equal(b.canvas.width,360);
});
test('incremental textured strokes match one-pass pixels without replaying old segments',()=>{
  const pts=[{x:20,y:40},{x:40,y:50},{x:60,y:35},{x:110,y:60}];
  for(const brush of ['brush','pencil','pastel']){
    const full=draw(brush,{},pts),c=createCanvas(160,100),ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,160,100);
    const opts={brush,size:12,color:'#000000',opacity:1,progress:{}};
    paintStroke(ctx,pts.slice(0,2),opts);paintStroke(ctx,pts.slice(1),opts);
    assert.deepEqual(Buffer.from(ctx.getImageData(0,0,160,100).data),Buffer.from(full.pixels));
  }
});
