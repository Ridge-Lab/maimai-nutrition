import test from 'node:test';
import assert from 'node:assert/strict';
import {setupLayout} from '../dist/layout.mjs';

function fixture(){
  const values=new Map(),dialogValues=new Map(),attributes=new Set(),events=new Map(),frames=[];
  const style=map=>({getPropertyValue:k=>map.get(k)||'',setProperty:(k,v)=>map.set(k,v)});
  let dockHeight=100,dockTop=684,position='sticky',actionHeight=84,action=null,editing=false;
  const root={style:style(values),toggleAttribute:(k,on)=>on?attributes.add(k):attributes.delete(k)};
  const dock={hidden:false,getBoundingClientRect:()=>attributes.has('data-keyboard-open')?{height:0,top:800}:{height:dockHeight,top:dockTop}};
  const bar={getBoundingClientRect:()=>({height:actionHeight})};
  const dialog={open:false,style:style(dialogValues),querySelector:()=>action};
  const observers=[];
  class ResizeObserver{constructor(cb){this.cb=cb;this.seen=new Set();observers.push(this);}observe(el){this.seen.add(el);}unobserve(el){this.seen.delete(el);}disconnect(){this.seen.clear();}}
  const win={innerHeight:800,ResizeObserver,getComputedStyle:()=>({position}),visualViewport:{height:800,addEventListener(){},removeEventListener(){}},
    requestAnimationFrame:cb=>{frames.push(cb);return frames.length;},cancelAnimationFrame(){},
    addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  const doc={documentElement:root,querySelector:s=>s==='#selection-dock'?dock:dialog,activeElement:{matches:()=>editing},
    addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  const layout=setupLayout({document:doc,window:win});
  return {layout,values,dialogValues,attributes,dock,dialog,events,observers,
    dockSize:(height,top)=>{dockHeight=height;dockTop=top;},showActions:()=>{action=bar;dialog.open=true;},
    actionSize:(height,mode)=>{actionHeight=height;position=mode;},
    keyboard:open=>{editing=open;win.visualViewport.height=open?400:800;},
    flush:()=>{while(frames.length)frames.shift()();}};
}

test('底部留白跟随清单实测高度和底边间距，空餐单归零而非保留固定200px',()=>{
  const f=fixture();assert.equal(f.values.get('--dock-space'),'128px');
  f.dockSize(220,564);f.observers[0].cb();f.flush();
  assert.equal(f.values.get('--dock-space'),'248px');
  f.dock.hidden=true;f.layout.refresh();assert.equal(f.values.get('--dock-space'),'0px');
  f.layout.destroy();
});

test('弹窗确认区单独测量，改为短屏普通布局或关闭弹窗后不保留覆盖间距',()=>{
  const f=fixture();f.showActions();f.layout.refresh();
  assert.equal(f.dialogValues.get('--dialog-action-space'),'100px');
  f.actionSize(132,'sticky');f.observers[0].cb();f.flush();
  assert.equal(f.dialogValues.get('--dialog-action-space'),'148px');
  f.actionSize(132,'static');f.layout.refresh();
  assert.equal(f.dialogValues.get('--dialog-action-space'),'0px');
  f.dialog.open=false;f.layout.refresh();assert.equal(f.dialogValues.get('--dialog-action-space'),'0px');
  f.layout.destroy();
});

test('文本键盘显著压缩视觉视口时收起底栏，键盘关闭恢复占位',()=>{
  const f=fixture();f.keyboard(true);f.events.get('focusin')();f.flush();
  assert.ok(f.attributes.has('data-keyboard-open'));assert.equal(f.values.get('--dock-space'),'0px');
  f.keyboard(false);f.events.get('focusout')();f.flush();
  assert.ok(!f.attributes.has('data-keyboard-open'));assert.equal(f.values.get('--dock-space'),'128px');
  f.layout.destroy();
});

test('多次尺寸事件按帧合并；销毁后不再修改布局',()=>{
  const f=fixture();const observer=f.observers[0];
  f.dockSize(150,634);observer.cb();observer.cb();f.flush();
  assert.equal(f.values.get('--dock-space'),'178px');
  f.layout.destroy();f.dockSize(300,484);observer.cb();f.flush();f.layout.refresh();
  assert.equal(f.values.get('--dock-space'),'178px');assert.equal(observer.seen.size,0);
});

