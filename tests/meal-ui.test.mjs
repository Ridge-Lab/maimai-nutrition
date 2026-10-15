import test from 'node:test';
import assert from 'node:assert/strict';
import {setupMealUI} from '../dist/meal-ui.mjs';

const records=[
  {productName:'麦辣鸡腿汉堡',energyKcal:485,protein:20,fat:26,carbohydrate:42,sodium:900,calcium:87},
  {productName:'中薯条',energyKcal:289,protein:4,fat:14,carbohydrate:37,sodium:165,calcium:12},
  {productName:'小杯玉米杯',energyKcal:53,protein:2,fat:1,carbohydrate:10,sodium:1,calcium:2},
  {productName:'可乐中杯',energyKcal:147,protein:0,fat:0,carbohydrate:37,sodium:0,calcium:0},
  {productName:'无糖可口可乐中杯',energyKcal:0,protein:0,fat:0,carbohydrate:1,sodium:35,calcium:0}
];
function fixture(){
  const choice=(code,name,isDefault,diffPrice='+ ¥0')=>({code,name,isDefault,diffPrice,maxQuantity:-1});
  const round=(id,name,choices)=>({id,name,quantity:1,minQuantity:1,maxQuantity:1,choices});
  return {structuredContent:{success:true,code:200,data:{code:'meal-1',name:'麦辣鸡腿汉堡三件套',rounds:[
    round(1,'主食',[choice('burger','麦辣鸡腿汉堡',1)]),
    round(2,'小食',[choice('fries','中薯条',1),choice('corn','小杯玉米杯',0,'- ¥0.5')]),
    round(3,'饮料',[choice('cola','可乐中杯',1),choice('zero','无糖可口可乐中杯',0)])
  ]}}};
}
function ui(t){
  const handlers={};const nodes=new Map();
  const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:''});return nodes.get(key);};
  const original=globalThis.document;
  globalThis.document={querySelector:node,addEventListener:(name,fn)=>handlers[name]=fn};
  t.after(()=>{globalThis.document=original;});
  let html='',applied=null,calls=0,revision=0,dialogRevision=0,feedback='';let source=fixture();
  const controller=setupMealUI({
    api:async()=>{calls++;return structuredClone(source);},openDialog:(_title,body)=>html=body,closeDialog:()=>{},toast:message=>feedback=message,clearFeedback:()=>feedback='',
    getStore:()=>({code:'store-1'}),getNutrition:()=>records,getGoal:()=> 'lower-kcal',getRevision:()=>revision,getDialogRevision:()=>dialogRevision,
    onApply:(food,existingId,comparison)=>applied={food,existingId,comparison}
  });
  const base={id:'base-1',productCode:'meal-1',name:'麦辣鸡腿汉堡三件套',spec:'需展开',category:'main',isMeal:true,price:33.5};
  const change=(round,code)=>{const select={dataset:{roundChoice:String(round)},value:code};handlers.change({target:{closest:()=>select}});};
  const apply=()=>handlers.click({target:{closest:()=>({})}});
  const adjust=(round,code,step)=>handlers.click({target:{closest:selector=>selector==='[data-meal-adjust]'?{dataset:{round:String(round),code,step:String(step)}}:null}});
  return {controller,base,change,apply,adjust,node,get html(){return html;},get applied(){return applied;},get calls(){return calls;},get feedback(){return feedback;},setSource:s=>source=s,setRevision:n=>revision=n,setDialogRevision:n=>dialogRevision=n};
}

test('套餐弹窗按当前2份计算七项差值，应用后的food仍是每份营养',async t=>{
  const f=ui(t);
  await f.controller.configureFood(f.base,'existing-row',2);
  assert.match(f.html,/当前 2 份合计/);
  assert.match(f.html,/1,842/);
  for(const name of ['蛋白质','脂肪','碳水','钠','钙'])assert.ok(f.html.includes(name));
  f.change(2,'corn');f.change(3,'zero');
  const selected=f.node('#configuration-selection').innerHTML;
  assert.match(selected,/小杯玉米杯 ×2/);assert.match(selected,/无糖可口可乐中杯 ×2/);
  assert.ok(!selected.includes('中薯条'));
  const figures=f.node('#configuration-figures').innerHTML;
  assert.match(figures,/1,076/);
  assert.match(figures,/热量减少 766 kcal/);
  assert.match(figures,/脂肪减少 26 g/);
  assert.match(figures,/碳水减少 126 g/);
  assert.match(figures,/钙减少 20 mg/);
  f.apply();
  assert.equal(f.applied.existingId,'existing-row');
  assert.equal(f.applied.food.kcal,538);
  assert.equal(f.applied.food.fat,27);
  assert.equal(f.applied.food.carbohydrate,53);
  assert.equal(f.applied.food.calcium,89);
  assert.deepEqual(f.applied.food.selections,{'1':'burger','2':'corn','3':'zero'});
  assert.equal(f.applied.comparison.qty,2);
  await f.controller.configureFood(f.applied.food,'existing-row',2);
  assert.match(f.html,/value="corn" checked/);
  assert.match(f.html,/value="zero" checked/);
  assert.match(f.html,/热量不变/);
});

test('恢复强制重查详情，并拒绝失效轮次或选项而非回退默认',async t=>{
  const f=ui(t);
  await f.controller.configureFood(f.base);
  assert.equal(f.calls,1);
  const options={store:{code:'store-1'},nutrition:records,fresh:true,strict:true};
  await assert.rejects(f.controller.resolveFood(f.base,{'1':'burger','2':'corn'},options),/轮次已变化/);
  assert.equal(f.calls,2);
  await assert.rejects(f.controller.resolveFood(f.base,{'1':'burger','2':'gone','3':'zero'},options),/原选项已不可用/);
  const recipe=await f.controller.resolveFood(f.base,{'1':'burger','2':'corn','3':'zero'},options);
  assert.equal(recipe.kcal,538);assert.equal(recipe.calcium,89);
  assert.equal(f.calls,4);
});

test('新详情缺一项营养只影响该项，真实0仍显示0',async t=>{
  const f=ui(t);
  const nutrition=records.map(r=>r.productName==='小杯玉米杯'?{...r,calcium:null}:r);
  const food=await f.controller.resolveFood(f.base,{'1':'burger','2':'corn','3':'zero'},{store:{code:'store-1'},nutrition,fresh:true,strict:true});
  assert.equal(food.calcium,null);assert.equal(food.kcal,538);assert.equal(food.carbohydrate,53);
  assert.equal(food.components[2].kcal,0);
});

test('关闭读取弹窗或切换目录后，迟到详情不能重新弹出或覆盖新选择',async t=>{
  const f=ui(t);
  const first=f.controller.configureFood(f.base);f.setRevision(1);await first;
  assert.ok(!f.html.includes('apply-configured-meal'));
  const second=f.controller.configureFood(f.base);f.setDialogRevision(1);await second;
  assert.ok(!f.html.includes('apply-configured-meal'));
  await f.controller.configureFood(f.base);
  assert.ok(f.html.includes('apply-configured-meal'));
  assert.equal(f.calls,3);
});

test('不可用默认项保持待选择，用户补齐各轮后才可加入且不偷偷改默认',async t=>{
  const f=ui(t),source=fixture();
  source.structuredContent.data.rounds[1].choices[0].maxQuantity=0;
  source.structuredContent.data.rounds[2].choices[0].maxQuantity=0;
  f.setSource(source);
  await f.controller.configureFood(f.base,null,2);
  assert.match(f.html,/choice-options/);
  assert.match(f.html,/待选择：小食/);
  assert.match(f.html,/待选择：饮料/);
  assert.match(f.html,/value="fries"\s+disabled/);
  assert.match(f.html,/value="cola"\s+disabled/);
  assert.ok(!/value="(?:corn|zero)" checked/.test(f.html));
  assert.match(f.html,/id="apply-configured-meal"[^>]*disabled/);
  assert.match(f.html,/整餐合计暂缺/);
  f.apply();assert.equal(f.applied,null);
  assert.match(f.feedback,/请先完成所有待选择项/);
  f.change(2,'corn');
  assert.equal(f.feedback,'');
  assert.equal(f.node('#apply-configured-meal').disabled,true);
  assert.match(f.node('#configuration-selection').innerHTML,/小杯玉米杯 ×2/);
  assert.match(f.node('#configuration-selection').innerHTML,/待选择：饮料/);
  assert.match(f.node('#configuration-figures').innerHTML,/整餐合计暂缺/);
  f.apply();assert.equal(f.applied,null);
  f.change(3,'zero');
  assert.equal(f.node('#apply-configured-meal').disabled,false);
  assert.ok(!f.node('#configuration-selection').innerHTML.includes('待选择：'));
  assert.match(f.node('#configuration-figures').innerHTML,/1,076/);
  assert.match(f.node('#configuration-figures').innerHTML,/打开时搭配未选齐/);
  assert.ok(!f.node('#configuration-figures').innerHTML.includes('热量减少'));
  f.apply();
  assert.equal(f.applied.food.kcal,538);
  assert.deepEqual(f.applied.food.selections,{'1':'burger','2':'corn','3':'zero'});
  assert.equal(f.applied.comparison.qty,2);
  assert.equal(f.applied.food.quoteItem.roundList.length,3);
});

test('严格恢复遇到仍存在但已不可选的保存选项也整体拒绝',async t=>{
  const f=ui(t),source=fixture();
  source.structuredContent.data.rounds[1].choices[0].maxQuantity=0;
  f.setSource(source);
  const options={store:{code:'store-1'},nutrition:records,fresh:true,strict:true};
  await assert.rejects(f.controller.resolveFood(f.base,{'1':'burger','2':'fries','3':'cola'},options),/小食的原选项已不可用/);
  assert.equal(f.applied,null);
  const alternative=await f.controller.resolveFood(f.base,{'1':'burger','2':'corn','3':'zero'},options);
  assert.equal(alternative.kcal,538);
  assert.deepEqual(alternative.selections,{'1':'burger','2':'corn','3':'zero'});
});

test('已选齐但营养缺失时允许加入，选择完整性不等同营养完整性',async t=>{
  const f=ui(t),source=fixture();
  source.structuredContent.data.rounds[1].choices[1].name='官方新品玉米（未匹配营养）';
  f.setSource(source);
  await f.controller.configureFood(f.base);
  f.change(2,'corn');
  assert.equal(f.node('#apply-configured-meal').disabled,false);
  assert.ok(!f.node('#configuration-selection').innerHTML.includes('待选择：'));
  assert.match(f.node('#configuration-figures').innerHTML,/暂缺/);
  f.apply();
  assert.notEqual(f.applied,null);
  assert.equal(f.applied.food.kcal,null);
  assert.equal(f.applied.food.fat,null);
  assert.equal(f.applied.food.quoteItem.roundList.length,3);
  assert.equal(f.applied.food.selections['2'],'corn');
});

test('玩具轮显示非食品且保留选择，份数换配与严格恢复不丢玩具或污染营养',async t=>{
  const f=ui(t),source=fixture();
  source.structuredContent.data.rounds.push({id:4,name:'系列玩具',quantity:1,minQuantity:1,maxQuantity:1,
    choices:[{code:'toy-1',name:'海绵宝宝×航海王系列玩具',isDefault:1,maxQuantity:-1,diffPrice:'+ ¥0'}]});
  f.setSource(source);
  await f.controller.configureFood(f.base,'existing-row',2);
  assert.match(f.html,/海绵宝宝×航海王系列玩具 ×2/);
  assert.match(f.html,/非食品，不计营养/);
  const toyDetail=f.html.match(/<details class="component-detail"><summary><span>海绵宝宝[^]*?<\/details>/)[0];
  assert.ok(!toyDetail.includes('暂缺'));
  assert.ok(!toyDetail.includes('kcal'));
  assert.match(f.html,/1,842/);
  f.change(2,'corn');f.change(3,'zero');f.apply();
  assert.equal(f.applied.food.kcal,538);
  assert.equal(f.applied.food.components.at(-1).nonFood,true);
  assert.equal(f.applied.food.selections['4'],'toy-1');
  assert.deepEqual(f.applied.food.quoteItem.roundList.at(-1),{round:4,comboItemList:[{code:'toy-1',quantity:1}]});
  const options={store:{code:'store-1'},nutrition:records,fresh:true,strict:true};
  await assert.rejects(f.controller.resolveFood(f.base,{'1':'burger','2':'corn','3':'zero'},options),/轮次已变化/);
  const restored=await f.controller.resolveFood(f.base,f.applied.food.selections,options);
  assert.equal(restored.kcal,538);
  assert.equal(restored.components.at(-1).nonFood,true);
  assert.equal(restored.quoteItem.roundList.length,4);
});

function multiFixture() {
  const source=fixture();
  source.structuredContent.data.rounds=[{id:7,name:'三份分享餐品',quantity:3,minQuantity:3,maxQuantity:3,choices:[
    {code:'burger',name:'麦辣鸡腿汉堡',isDefault:1,quantity:1,maxQuantity:2,diffPrice:'+ ¥0'},
    {code:'fries',name:'中薯条',isDefault:0,quantity:1,maxQuantity:3,diffPrice:'+ ¥0'},
    {code:'corn',name:'小杯玉米杯',isDefault:0,quantity:1,maxQuantity:3,diffPrice:'- ¥0.5'}
  ]},{id:8,name:'饮料',quantity:1,minQuantity:1,maxQuantity:1,choices:[
    {code:'zero',name:'无糖可口可乐中杯',isDefault:1,quantity:1,maxQuantity:1,diffPrice:'+ ¥0'}
  ]}];
  return source;
}

test('多份分享轮保留官方所有默认份数，减配待补齐，加配按真实套餐份数更新并严格恢复',async t=>{
  const f=ui(t);f.setSource(multiFixture());
  await f.controller.configureFood(f.base,'existing-row',2);
  assert.match(f.html,/已选 3 \/ 必选 3 份/);
  assert.match(f.html,/1,654/);
  assert.match(f.html,/data-meal-adjust/);
  assert.match(f.html,/data-meal-count="corn"[^>]*>1<\/output>/);
  for(const name of ['热量','蛋白质','脂肪','碳水','钠','钙'])assert.ok(f.html.includes(name));
  f.adjust(7,'fries',-1);
  assert.equal(f.node('#apply-configured-meal').disabled,true);
  assert.match(f.node('#configuration-selection').innerHTML,/三份分享餐品还差 1 份/);
  assert.match(f.node('#configuration-figures').innerHTML,/已知部分合计（下限，非完整套餐）/);
  assert.match(f.node('#configuration-figures').innerHTML,/1,076/);
  f.apply();assert.equal(f.applied,null);
  f.adjust(7,'burger',1);
  assert.equal(f.node('#apply-configured-meal').disabled,false);
  assert.match(f.node('#configuration-selection').innerHTML,/麦辣鸡腿汉堡 ×4/);
  assert.match(f.node('#configuration-figures').innerHTML,/2,046/);
  assert.match(f.node('#configuration-figures').innerHTML,/热量增加 392 kcal/);
  f.adjust(7,'burger',1); // Capacity cannot be exceeded even by a forged event.
  assert.match(f.feedback,/份数|数量|上限/);
  f.apply();
  assert.deepEqual(f.applied.food.selections,{'7':{burger:2,corn:1},'8':'zero'});
  assert.equal(f.applied.food.kcal,1023);
  assert.deepEqual(f.applied.food.quoteItem.roundList[0].comboItemList,[{code:'burger',quantity:2},{code:'corn',quantity:1}]);
  const restored=await f.controller.resolveFood(f.base,f.applied.food.selections,{fresh:true,strict:true});
  assert.equal(restored.id,f.applied.food.id);
  assert.equal(restored.kcal,1023);
  await assert.rejects(f.controller.resolveFood(f.base,{'7':{burger:1},'8':'zero'},{fresh:true,strict:true}),/份数已变化/);
});

test('营养缺失逐项点名组件和字段，已知部分不是完整营养，也不会把真实零丢失',async t=>{
  const f=ui(t),source=multiFixture();
  source.structuredContent.data.rounds[0].choices[2].name='未匹配新品玉米';
  f.setSource(source);
  await f.controller.configureFood(f.base,null,2);
  assert.match(f.html,/已知部分合计（下限，非完整套餐）/);
  assert.match(f.html,/未匹配新品玉米 ×2：热量、蛋白质、脂肪、碳水、钠、钙/);
  assert.match(f.html,/1,548/);
  f.apply();
  assert.equal(f.applied.food.kcal,null);
  assert.equal(f.applied.food.knownTotals.kcal,774);
  assert.deepEqual(f.applied.food.missingComponents.calcium,[{code:'corn',name:'未匹配新品玉米',qty:1}]);
  assert.equal(f.applied.food.selectionComplete,true);
  assert.match(f.feedback,/已知部分和缺失营养已标明/);
});

test('默认预览不打开弹窗，不把默认搭配当用户已确认，缺省失效不替换其他选项',async t=>{
  const f=ui(t);f.setSource(multiFixture());
  const preview=await f.controller.previewFood(f.base);
  assert.equal(f.html,'');assert.equal(f.applied,null);
  assert.equal(preview.defaultPreview,true);assert.equal(preview.resolvedRecipe,false);
  assert.equal(preview.baseFood,undefined);
  assert.equal(preview.selectionComplete,true);assert.equal(preview.kcal,827);
  assert.deepEqual(preview.selections,{'7':{burger:1,corn:1,fries:1},'8':'zero'});
  const source=multiFixture();source.structuredContent.data.rounds[0].choices[1].maxQuantity=0;f.setSource(source);
  const pending=await f.controller.previewFood(f.base,{fresh:true});
  assert.equal(pending.kcal,null);assert.equal(pending.knownTotals.kcal,538);
  assert.equal(pending.selectionComplete,false);
  assert.deepEqual(pending.needsSelection,[{id:'7',name:'三份分享餐品',total:2,min:3,remaining:1}]);
  assert.equal(pending.selections['7'].fries,undefined);
  assert.equal(pending.selections['7'].burger,1);
});

test('目录默认预览不会污染用户换配结果或生成循环的预览数据',async t=>{
  const f=ui(t);
  f.base.defaultPreview=await f.controller.previewFood(f.base);
  assert.doesNotThrow(()=>JSON.stringify(f.base));
  await f.controller.configureFood(f.base);
  f.change(2,'corn');f.apply();
  assert.equal(f.applied.food.defaultPreview,undefined);
  assert.equal(f.applied.food.kcal,685);
  assert.equal(f.applied.food.resolvedRecipe,true);
});

