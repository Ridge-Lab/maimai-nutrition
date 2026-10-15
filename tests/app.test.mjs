import test from 'node:test';
import assert from 'node:assert/strict';
import {foods} from '../dist/catalog.mjs';
import {summarize} from '../dist/engine.mjs';
import {createFavorite,FAVORITES_STORAGE_KEY} from '../dist/favorites.mjs';

function environment(t,initial={}, {storageBlocked=false,writeBlocked=false}={}){
  const storageDescriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const previous={document:globalThis.document,localStorage:globalThis.localStorage,location:globalThis.location,setTimeout:globalThis.setTimeout};
  const timers=[];globalThis.setTimeout=(...args)=>{const id=previous.setTimeout(...args);timers.push(id);return id;};
  const nodes=new Map(),handlers=new Map(),saved=new Map(Object.entries(initial));
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',value:'',dataset:{},disabled:false,hidden:false,open:false,
      listeners:new Map(),classList:{add(){},remove(){},toggle(){}},setAttribute(){},checkValidity:()=>true,reportValidity:()=>true,
      addEventListener(name,fn){this.listeners.set(name,fn);},showModal(){this.open=true;},close(){this.open=false;}});
    return nodes.get(selector);
  };
  globalThis.document={querySelector:node,querySelectorAll:()=>[],addEventListener:(name,fn)=>{const previous=handlers.get(name);handlers.set(name,async event=>{if(previous)await previous(event);await fn(event);});},hidden:false};
  globalThis.location={hostname:'private-preview.example'};
  const storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>{if(writeBlocked)throw new Error('浏览器存储空间不足，未保存组合');saved.set(k,v);},removeItem:k=>saved.delete(k)};
  Object.defineProperty(globalThis,'localStorage',storageBlocked?{configurable:true,get(){throw new DOMException('Storage is disabled','SecurityError');}}:{configurable:true,writable:true,value:storage});
  t.after(()=>{for(const id of timers)clearTimeout(id);for(const key of ['document','location','setTimeout'])globalThis[key]=previous[key];if(storageDescriptor)Object.defineProperty(globalThis,'localStorage',storageDescriptor);else delete globalThis.localStorage;});
  const click=async(dataset={},id='')=>{const button={dataset,id,disabled:false};await handlers.get('click')({target:{closest:selector=>selector==='button'||selector==='#'+id?button:null}});};
  const direct=(selector,name='click',event={})=>node(selector).listeners.get(name)(event);
  return {node,saved,click,direct,handlers};
}

test('页面启动展示六营养总计，添加及保存使用当前份数并剔除计算快照',async t=>{
  const env=environment(t);
  await import('../dist/app.mjs?app-test=basic');
  const defaultItems=['grilled-chicken','fries-medium','cola-medium'].map(id=>({food:foods.find(f=>f.id===id),qty:1}));
  const expected=summarize(defaultItems);
  assert.equal(env.node('#total-kcal').textContent,String(expected.kcal));
  for(const title of ['蛋白质','脂肪','碳水','钠','钙'])assert.ok(env.node('#total-nutrients').innerHTML.includes(title));
  await env.click({qty:'cola-medium',step:'1'});
  const cards=env.node('#food-grid').innerHTML;
  const colaCard=cards.match(/<article[^>]*data-food-card="cola-medium"[\s\S]*?<\/article>/)[0];
  const zeroCard=cards.match(/<article[^>]*data-food-card="cola-zero-medium"[\s\S]*?<\/article>/)?.[0];
  assert.match(colaCard,/is-selected/);assert.match(colaCard,/已选 2 份/);
  assert.ok(!zeroCard.includes('is-selected'));
  assert.match(env.node('#selection-dock-summary').innerHTML,/4 份/);
  assert.ok(env.node('#selection-dock-names').innerHTML.includes(foods.find(f=>f.id==='cola-medium').name+' ×2'));
  assert.equal(env.node('#selection-dock').hidden,false);
  await env.direct('#save-meal');
  env.node('#favorite-name').value='验收午餐';
  await env.handlers.get('submit')({target:{id:'save-form'},preventDefault(){}});
  const recipe=JSON.parse(env.saved.get(FAVORITES_STORAGE_KEY))[0];
  assert.equal(recipe.items.find(i=>i.demoId==='cola-medium').qty,2);
  assert.equal(recipe.items.find(i=>i.demoId==='grilled-chicken').locked,true);
  assert.equal(recipe.items.some(i=>'fat' in i||'price' in i||'calcium' in i),false);
});

test('待恢复真实草稿不会因调整比较目标或预算而被空演示餐单覆盖',async t=>{
  const draft=createFavorite({name:'真实草稿',store:{code:'1450713',name:'公开示例店'},items:[{food:{id:'configured-1',productCode:'meal-1',name:'午餐',selections:{1:'burger'}},qty:2}]});
  const env=environment(t,{'maimai-nutrition-draft-v2':JSON.stringify(draft)});
  await import('../dist/app.mjs?app-test=pending-draft');
  assert.equal(env.node('#draft-recovery').hidden,false);
  env.node('#comparison-goal').value='higher-protein';
  await env.direct('#comparison-goal','change',{target:env.node('#comparison-goal')});
  assert.deepEqual(JSON.parse(env.saved.get('maimai-nutrition-draft-v2')),draft);
  env.node('#kcal-budget').value='900';env.node('#price-budget').value='';
  await env.direct('#kcal-budget','change');
  assert.deepEqual(JSON.parse(env.saved.get('maimai-nutrition-draft-v2')),draft);
});

test('浏览器拒绝访问 localStorage 时仍能搭餐，保存明确失败且不关闭表单',async t=>{
  const env=environment(t,{}, {storageBlocked:true});
  await import('../dist/app.mjs?app-test=blocked-storage-getter');
  assert.ok(env.node('#cart-items').innerHTML.includes('板烧鸡腿堡'));
  await env.click({qty:'cola-medium',step:'1'});
  assert.match(env.node('#selection-dock-summary').innerHTML,/4 份/);
  assert.match(env.node('#toast').textContent,/未能保存草稿/);
  await env.direct('#save-meal');
  env.node('#favorite-name').value='存储被禁用的午餐';
  await env.handlers.get('submit')({target:{id:'save-form'},preventDefault(){}});
  assert.equal(env.node('#app-dialog').open,true);
  assert.match(env.node('#dialog-feedback').textContent,/浏览器存储不可用，未保存组合/);
  assert.equal(env.saved.has(FAVORITES_STORAGE_KEY),false);
});

test('存储只读或已满时搭餐仍可用，保存不会报告成功或加入常用组合',async t=>{
  const env=environment(t,{}, {writeBlocked:true});
  await import('../dist/app.mjs?app-test=storage-write-failure');
  await env.click({qty:'cola-medium',step:'1'});
  assert.match(env.node('#selection-dock-summary').innerHTML,/4 份/);
  await env.direct('#save-meal');
  env.node('#favorite-name').value='未保存午餐';
  await env.handlers.get('submit')({target:{id:'save-form'},preventDefault(){}});
  assert.equal(env.node('#app-dialog').open,true);
  assert.match(env.node('#dialog-feedback').textContent,/未保存组合/);
  assert.equal(env.saved.has(FAVORITES_STORAGE_KEY),false);
  await env.direct('#favorites-nav');
  assert.match(env.node('#dialog-body').innerHTML,/搭好一餐后，保存为常用组合/);
  assert.ok(!env.node('#dialog-body').innerHTML.includes('未保存午餐'));
});

