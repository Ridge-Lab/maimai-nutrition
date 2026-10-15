import {foods as referenceFoods,dataInfo} from './catalog.mjs';
import {summarize,compare,recommendSwaps} from './engine.mjs';
import {setupStoreUI} from './store-ui.mjs';
import {setupMealUI} from './meal-ui.mjs';
import {coverageSummary,nutritionStatus,nutrientCoverage,mergeResolvedMenu} from './coverage.mjs';
import {createFavorite,validateFavorite,loadFavorites,saveFavorites} from './favorites.mjs';
import {restoreFavorite} from './restore.mjs';
import {illustration} from './art.mjs';
import {selectionForFood} from './selection.mjs';
import {SAMPLE_STORE,sampleNutrition,sampleDetails,sampleImages,sampleInfo} from './sample-menu.mjs';
import {metricText,nutritionDisplayHtml,missingNutritionHtml} from './nutrition-view.mjs';
import {setupLayout} from './layout.mjs';
import {captureFocus,restoreFocus} from './focus.mjs';
import {$,esc,known,number,money,label,metrics,nutrientKeys,allMetrics,nutrientHtml,deltaHtml,nutritionSourceHtml} from './ui.mjs';

const draftKey='maimai-nutrition-draft-v2';
const preferenceKey='maimai-nutrition-preferences-v2';
let foods=[...referenceFoods],foodMap=new Map(foods.map(f=>[f.id,f]));
let items=[],lockedIds=new Set(),category='all',query='',sorting='default',knownOnly=false;
let maxKcal=800,maxPrice=40,goal='lower-kcal';
let lastChange=null,undoState=null,suggestions=[],localApi=false,connected=false,officialMode=false;
let currentStore=null,currentQuote=null,liveNutrition=[],menuFetchedAt=null,nutritionFetchedAt=null;
let mealController,storeController,toastTimer,busyRestore=false,pendingDraft=null;
let contextVersion=0,dialogVersion=0,connectionVersion=0;
let layoutController,dialogFocusSnapshot=null,dialogFocusFood=null;
let previewGeneration=0,previewRenderTimer;
const revisionOptions={getRevision:()=>contextVersion,getDialogRevision:()=>dialogVersion};
const browserStorage=(()=>{try{return globalThis.localStorage;}catch{return null;}})();
let favorites=loadFavorites(browserStorage);
const statusNames={matched:'规格已匹配','needs-selection':'需确认规格',unmatched:'官方营养暂未匹配',ambiguous:'规格存在歧义'};
const read=(key,fallback=null)=>{try{return JSON.parse(browserStorage.getItem(key))??fallback;}catch{return fallback;}};
const dateLabel=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'本次未记录';
const comparison=(a,b)=>compare(a,b,{goal});
function clearDialogFeedback(){$('#dialog-feedback').textContent='';$('#dialog-feedback').hidden=true;}
function toast(text){
  if($('#app-dialog').open){$('#dialog-feedback').textContent=text;$('#dialog-feedback').hidden=false;layoutController?.refresh();return;}
  $('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3500);
}
function openDialog(title,html,eyebrow='MAKE YOUR CHOICE'){
  if(!$('#app-dialog').open){dialogFocusSnapshot=captureFocus();dialogFocusFood=null;}
  dialogVersion++;clearDialogFeedback();$('#dialog-title').textContent=title;$('#dialog-eyebrow').textContent=eyebrow;$('#dialog-body').innerHTML=html;
  if(!$('#app-dialog').open)$('#app-dialog').showModal();layoutController?.refresh();
}
function closeDialog(){dialogVersion++;$('#app-dialog').close();}
function indexFoods(){foodMap=new Map(foods.map(f=>[f.id,f]));}
function merge(rows){
  const map=new Map();
  for(const {food,qty} of rows)if(qty>0){const old=map.get(food.id);map.set(food.id,{food,qty:qty+(old?.qty||0)});}
  return [...map.values()];
}
function persist(){
  try {
    browserStorage.setItem(preferenceKey,JSON.stringify({maxKcal,maxPrice:Number.isFinite(maxPrice)?maxPrice:null,goal}));
    if(!items.length){if(!pendingDraft)browserStorage.removeItem(draftKey);return;}
    if(officialMode&&!currentStore)return;
    const draft=createFavorite({name:'未完成的这一餐',store:currentStore,items,lockedIds});
    browserStorage.setItem(draftKey,JSON.stringify(draft));pendingDraft=null;
  }catch{toast('当前餐单可继续使用，但浏览器未能保存草稿');}
}
function commit(next,reason,{locks=null}={}){
  contextVersion++;
  const before=summarize(items);undoState={items:items.map(i=>({...i})),lockedIds:[...lockedIds]};
  items=merge(next);if(locks)lockedIds=new Set(locks);
  lockedIds=new Set([...lockedIds].filter(id=>items.some(i=>i.food.id===id)));
  currentQuote=null;suggestions=[];lastChange={label:reason,before,after:summarize(items)};
  persist();render();
  $('#screen-announcement').textContent=reason+'。整餐热量 '+number(summarize(items).kcal)+' 大卡。';
}
function classic({save=true}={}){
  contextVersion++;
  if(save)pendingDraft=null;
  foods=[...referenceFoods];indexFoods();officialMode=false;currentStore=null;currentQuote=null;liveNutrition=[];
  menuFetchedAt=null;nutritionFetchedAt=null;
  items=['grilled-chicken','fries-medium','cola-medium'].map(id=>({food:foodMap.get(id),qty:1}));
  lockedIds=new Set(['grilled-chicken']);lastChange=null;undoState=null;suggestions=[];category='all';query='';$('#food-search').value='';
  if(save)persist();render();void loadDefaultPreviews();
}
function swapItems(fromId,toId){return merge(items.map(i=>({food:i.food.id===fromId?foodMap.get(toId):i.food,qty:i.qty})));}
function art(food){
  if(food.components?.length>1){const edible=food.components.filter(c=>!c.nonFood);return '<span class="configured-food-art" role="img" aria-label="'+esc(edible.map(c=>c.name).join('、'))+'">'+edible.map(c=>'<span class="configured-food-art-item">'+art(c)+'</span>').join('')+'</span>';}
  const fallback=illustration(food.icon,String(food.id).includes('zero'));
  const source=food.image||(food.code?foods.find(row=>row.productCode===String(food.code)&&!row.resolvedRecipe)?.image||sampleImages[String(food.code)]:null)
    ||(food.nutritionName?referenceFoods.find(row=>row.nutritionName===food.nutritionName)?.image:null);
  let image=null;
  if(typeof source==='string'&&/^\.\/assets\/food\/[a-z-]+\.png$/.test(source))image=source;
  else try{const url=new URL(source);if(url.protocol==='https:')image=url.href;}catch{}
  return image?'<img data-food-image src="'+esc(image)+'" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="food-image-fallback" hidden>'+fallback+'</span>':fallback;
}
function compositionHtml(food,qty){
  if(!food.components?.length)return '';
  return '<div class="selected-composition"><strong class="selected-composition-heading">这 '+qty+' 份包含</strong><div class="selected-composition-pills">'+food.components.map(c=>'<span class="selected-component-pill">'+esc(c.name)+' <b>×'+c.qty*qty+'</b></span>').join('')+'</div></div>';
}
function menuSelectionHtml(selection){
  if(!selection.qty)return '';
  return '<div class="selected-composition"><strong class="selected-composition-heading">你已选的'+(selection.rows.length>1?' '+selection.rows.length+' 种搭配':'内容')+'</strong>'+selection.rows.map(row=>'<div class="selected-composition-pills"><span class="menu-quantity-chip">'+row.qty+' 份</span>'+(row.components.length?row.components.map(c=>'<span class="selected-component-pill">'+esc(c.name)+' ×'+c.qty+'</span>').join(''):'<span class="selected-component-pill">'+esc(row.spec||row.name)+'</span>')+'</div>').join('')+'</div>';
}
function fullNutrition(food,qty=1){return '<details class="food-details"><summary>六项参考营养'+(qty>1?' · '+qty+'份':' · 每份')+'</summary>'+nutritionDisplayHtml(food,qty)+nutritionSourceHtml(food)+missingNutritionHtml(food,qty)+'</details>';}
const nutritionView=food=>food.resolvedRecipe?food:food.defaultPreview||food;
function previewHtml(food){
  if(!food.isMeal||food.resolvedRecipe)return '';
  const view=food.defaultPreview;
  if(!view)return '<p class="default-preview">'+(food.defaultPreviewError?'默认搭配读取未完成，点“选择搭配”重试。':'正在读取默认搭配营养…')+'</p>';
  return '<div class="default-preview"><strong>'+(view.selectionComplete?'默认搭配营养预览':'已选部分预览，尚需补选')+'</strong><p>'+view.components.map(c=>esc(c.name)+' ×'+c.qty).join(' / ')+'</p>'+(view.needsSelection?.length?'<p>待选：'+view.needsSelection.map(r=>esc(r.name)+'还差 '+r.remaining+' 份').join('、')+'</p>':'')+'<p>此处为默认搭配；换配后的实际营养在已选清单中查看。</p></div>';
}
async function loadDefaultPreviews(){
  if(!mealController||typeof document.createElement!=='function')return;
  const generation=++previewGeneration,store=currentStore||SAMPLE_STORE,nutrition=currentStore?liveNutrition:sampleNutrition;
  const queue=foods.filter(f=>f.isMeal&&!f.resolvedRecipe&&!f.defaultPreview);
  const update=()=>{if(generation!==previewGeneration)return;clearTimeout(previewRenderTimer);previewRenderTimer=setTimeout(()=>{if(generation===previewGeneration){renderFoods();renderCoverage();}},100);};
  async function worker(){while(queue.length&&generation===previewGeneration){const food=queue.shift();try{const preview=await mealController.previewFood(food,{store,nutrition,fresh:store!==SAMPLE_STORE});if(generation!==previewGeneration)return;food.defaultPreview=preview;delete food.defaultPreviewError;}catch{if(generation!==previewGeneration)return;food.defaultPreviewError=true;if(store!==SAMPLE_STORE&&!connected){for(const pending of queue)pending.defaultPreviewError=true;queue.length=0;}}update();}}
  await Promise.all(Array.from({length:3},worker));
}
function renderMenuStatus(){
  const meals=foods.filter(food=>food.isMeal&&!food.resolvedRecipe).length;
  $('#choose-store').textContent=currentStore?'更换门店 ↗':connected?'选门店看套餐 ↗':'选择门店 ↗';
  $('#menu-mode-status').innerHTML=currentStore?'<strong>当前门店 · '+meals+' 款套餐</strong><p>默认搭配可直接预览六项营养。点击“选择搭配”确认单选或多份餐品；缺项会列出餐品名称和已知小计。</p>':'<strong>'+(officialMode?'官方营养目录，还不是门店菜单':'参考体验 · 12 种单品＋'+meals+' 款示例套餐')+'</strong><p>'+(officialMode?'选择门店后查看可售套餐。':'示例套餐取自 '+sampleInfo.checkedAt+' 官方公开菜单快照，可直接换配、查看营养和保存；不是当前门店可售菜单，金额仅作演示。')+'</p><button id="open-store-menu" class="primary-button" type="button">'+(connected?'选择门店，查看实时菜单':'连接麦当劳，查看实时菜单')+' ↗</button>';
  const mealTab=$('.category-tabs [data-category="meal"]');
  if(mealTab)mealTab.textContent=currentStore?'套餐 '+meals:officialMode?'套餐 · 选店后查看':'示例套餐 '+meals;
}
function renderFoods(){
  const focus=captureFocus();
  renderMenuStatus();
  const matching=foods.filter(f=>(category==='all'||category==='meal'&&f.isMeal||category!=='meal'&&f.category===category)&&label(f).toLowerCase().includes(query.toLowerCase()));
  let visible=matching.filter(f=>!knownOnly||nutrientCoverage(nutritionView(f)).complete);
  if(sorting!=='default')visible.sort((left,right)=>{const a=nutritionView(left),b=nutritionView(right);return !known(a[sorting])?(!known(b[sorting])?0:1):!known(b[sorting])?-1:sorting==='protein'?b.protein-a.protein:a[sorting]-b[sorting];});
  $('#food-count').textContent=visible.length+' 项';
  document.querySelectorAll('.category-tabs [data-category]').forEach(b=>{const active=b.dataset.category===category;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
  $('#food-grid').innerHTML=visible.map(f=>{
    const selected=selectionForFood(f,items);
    const view=nutritionView(f);
    const needsChoice=(currentStore||f.demoMeal)&&!f.resolvedRecipe&&(f.isMeal||!known(f.kcal)||nutritionStatus(f)==='needs-selection');
    const action=needsChoice?(f.isMeal?'选择搭配':'确认规格'):selected.exactQty?'再加一份':'加入这一餐';
    return '<article class="food-card '+(selected.qty?'is-selected':'')+'" data-food-card="'+esc(f.id)+'"><div class="food-art" data-category="'+esc(f.category)+'"><span class="nutrition-tag">'+(f.resolvedRecipe?'已确认具体搭配':f.demoMeal?'公开套餐快照':officialMode?statusNames[nutritionStatus(f)]:'官方标准份参考')+'</span>'+(selected.qty?'<span class="selected-badge">✓ 已选 '+selected.qty+' 份</span>':'')+art(f)+'</div><div class="food-content"><h3>'+esc(f.name)+'</h3><div class="food-spec">'+esc(f.defaultPreview?'默认搭配已展开，可按需换配':f.spec)+'</div>'+previewHtml(f)+'<div class="food-kcal">'+metricText(view,'kcal')+'<small>'+(known(view.kcal)||known(view.knownTotals?.kcal)?'kcal / 份':'')+'</small></div><div class="food-nutrients">'+['protein','fat','carbohydrate','sodium','calcium'].map(k=>'<span>'+metrics[k][0]+' <b>'+metricText(view,k)+(known(view[k])||known(view.knownTotals?.[k])?' '+metrics[k][1]:'')+'</b></span>').join('')+'</div>'+menuSelectionHtml(selected)+(f.defaultPreview||f.resolvedRecipe?missingNutritionHtml(view):!known(f.kcal)?'<p class="missing-note">先确认规格／套餐组成，缺失数据不计作零。</p>':'')+(f.coverageNote?'<p class="missing-note">'+esc(f.coverageNote)+'</p>':'')+'<div class="food-bottom"><div class="food-price">'+money(f.price)+'<small>'+(f.priceMode==='demo'?'演示价':currentStore?'菜单参考价':'')+'</small></div><button class="add-button" data-add="'+esc(f.id)+'" aria-label="添加'+esc(label(f))+'" type="button"><span aria-hidden="true">+</span> '+action+'</button></div></div></article>';
  }).join('')||'<div class="menu-empty">'+(category==='meal'&&knownOnly&&matching.length?'当前营养筛选隐藏了 '+matching.length+' 款待确认套餐，先展开搭配才能计算营养。<br><button id="show-all-meals" class="secondary-button" type="button">显示全部套餐</button>':'没有找到餐品，可调整关键词或营养筛选。')+'</div>';
  restoreFocus(focus);
}
function renderCart(){
  const focus=captureFocus();
  $('#cart-items').innerHTML=items.map(({food:f,qty})=>'<article class="cart-item"><div class="cart-main"><div class="cart-art">'+art(f)+'</div><div class="cart-item-info"><h3>'+esc(f.name)+'</h3><small>'+esc(f.spec)+' · '+metricText(f,'kcal')+' kcal / 份</small></div><div class="cart-energy">'+metricText(f,'kcal',qty)+'<small> kcal</small></div></div>'+compositionHtml(f,qty)+fullNutrition(f,qty)+(f.components?'<details class="meal-components"><summary>查看每项营养 · '+qty+'份</summary>'+f.components.map(c=>'<details class="component-detail"><summary><span>'+esc(c.name)+' ×'+c.qty*qty+'</span><b>'+(c.nonFood?'非食品':number(known(c.kcal)?c.kcal*c.qty*qty:null)+' kcal')+'</b></summary>'+(c.nonFood?'<p class="configuration-note">非食品，不计营养；选择仍用于套餐核价。</p>':nutritionDisplayHtml(c,c.qty*qty)+nutritionSourceHtml(c))+'</details>').join('')+'</details>':'')+'<div class="cart-controls"><div class="cart-control-actions"><button class="lock-button '+(lockedIds.has(f.id)?'locked':'')+'" data-lock="'+esc(f.id)+'" aria-pressed="'+lockedIds.has(f.id)+'" type="button">'+(lockedIds.has(f.id)?'♥ 已保留':'♡ 保留')+'</button><button class="swap-button" data-swap="'+esc(f.id)+'" '+(lockedIds.has(f.id)?'disabled title="先解除保留，再更换"':'')+' type="button">'+(f.quoteItem?'改搭配':'换一份')+' ↗</button></div><div class="qty-control"><button data-qty="'+esc(f.id)+'" data-step="-1" aria-label="减少'+esc(f.name)+'份数" type="button">−</button><span aria-label="'+qty+'份">'+qty+'</span><button data-qty="'+esc(f.id)+'" data-step="1" aria-label="增加'+esc(f.name)+'份数" '+(qty>=99?'disabled':'')+' type="button">+</button></div></div></article>').join('')||'<div class="cart-empty"><span aria-hidden="true">♡</span>先选一样喜欢的，搭出你的这一餐。</div>';
  const totals=summarize(items);
  renderSelectionDock(totals);
  const combined={...totals,name:'这一餐',components:items.flatMap(({food,qty})=>food.components?.length?food.components.map(c=>({...c,qty:c.qty*qty})):[{...food,qty}])};
  $('#total-kcal').textContent=items.length?metricText(combined,'kcal'):'0';
  $('#total-nutrients').innerHTML=nutritionDisplayHtml(combined,1,nutrientKeys.filter(k=>k!=='kcal'));
  $('#total-price').textContent=money(totals.price);
  $('#price-label').textContent=currentStore?'菜单参考金额':officialMode?'金额待核价':'演示金额';
  const missing=nutrientKeys.filter(k=>totals[k]===null);
  $('#meal-coverage').innerHTML=missing.length?'<p>整餐尚缺：'+missing.map(k=>metrics[k][0]).join('、')+'。</p>'+missingNutritionHtml(combined):items.length?'六项营养均已按当前份数计入。':'添加餐品后显示整餐营养。';
  const canQuote=connected&&currentStore&&items.length&&!items.some(({food})=>(food.isMeal&&!food.quoteItem)||!food.productCode);
  $('#quote-meal').disabled=!canQuote;$('#quote-meal').textContent=currentStore?'核验本餐官方报价 ↗':'连接并选店后，可核验官方报价 ↗';
  $('#quote-result').hidden=!currentQuote;
  if(currentQuote)$('#quote-result').innerHTML='官方本餐报价<strong>'+money(currentQuote.amount)+'</strong><small>'+esc(currentQuote.quotedAt||'以本次官方响应为准')+' · 修改餐单后需重新核价</small>';
  const colors={main:'#7e9b66',side:'#e4ba53',drink:'#d47b5f',dessert:'#b1a68c'};
  $('#kcal-bar').innerHTML=items.filter(i=>known(i.food.kcal)&&i.food.kcal>0).map(({food,qty})=>'<span title="'+esc(food.name)+' '+number(food.kcal*qty)+' kcal" style="width:'+Math.min(100,food.kcal*qty/Math.max(maxKcal,totals.kcal||maxKcal)*100)+'%;background:'+(colors[food.category]||'#9fa68f')+'"></span>').join('');
  $('#budget-caption').textContent='本餐预算 '+number(maxKcal)+' kcal';
  $('#budget-remaining').textContent=totals.kcal===null?'含 '+totals.unknownKcalCount+' 份未知热量':totals.kcal>maxKcal?'超出 '+number(totals.kcal-maxKcal)+' kcal':'余 '+number(maxKcal-totals.kcal)+' kcal';
  $('#budget-remaining').className=totals.kcal!==null&&totals.kcal>maxKcal?'over':'';
  $('#save-meal').disabled=!items.length||(officialMode&&!currentStore);
  $('#save-meal').title=officialMode&&!currentStore?'营养目录没有门店餐品编码，请选店后保存真实餐单':'';
  $('#last-change').hidden=!lastChange;
  if(lastChange)$('#last-change').innerHTML='<div class="last-change-title"><span>'+esc(lastChange.label)+'</span>'+(undoState?'<button class="undo-button" id="undo-change" type="button">撤销 ↶</button>':'')+'</div><div class="delta-grid">'+deltaHtml(comparison(lastChange.before,lastChange.after))+'</div>';
  restoreFocus(focus);
}
function renderSelectionDock(totals){
  const quantity=items.reduce((sum,row)=>sum+row.qty,0);
  $('#cart-item-count').textContent=quantity?quantity+' 份':'';
  $('#selection-dock').hidden=!items.length;
  $('#selection-dock-summary').innerHTML='<strong>已选 '+items.length+' 种 · '+quantity+' 份</strong><span>整餐 '+(totals.kcal===null?metricText({name:'这一餐',components:items.flatMap(({food,qty})=>food.components?.length?food.components.map(c=>({...c,qty:c.qty*qty})):[{...food,qty}])},'kcal')+' kcal（已知部分）':number(totals.kcal)+' kcal')+'</span>';
  $('#selection-dock-names').innerHTML=items.map(({food,qty})=>'<div class="selection-dock-item"><strong>'+esc(food.name)+' ×'+qty+'</strong><span class="selection-dock-item-detail">'+(food.components?.length?food.components.map(c=>esc(c.name)+' ×'+c.qty*qty).join(' / '):esc(food.spec))+'</span></div>').join('');
  layoutController?.refresh();
}
function renderCoverage(){
  const c=coverageSummary(foods);
  const baseMeals=foods.filter(f=>f.isMeal&&!f.resolvedRecipe),previews=baseMeals.filter(f=>f.defaultPreview),complete=previews.filter(f=>f.defaultPreview.selectionComplete&&nutrientCoverage(f.defaultPreview).complete).length;
  const previewNote='<p>套餐默认预览：已读取 '+previews.length+'/'+baseMeals.length+' 款，其中 '+complete+' 款六项齐全，'+(previews.length-complete)+' 款仍有待选或数据缺项。具体营养只适用于卡片列明的组成。</p>';
  $('#coverage-panel').innerHTML=officialMode?'<div><strong>当前目录数据覆盖</strong><span>'+c.total+' 个原始餐品 · '+c.complete+' 个六项齐全 · '+c.needsSelection+' 个待确认规格 · '+c.unmatched+' 个未匹配'+(c.ambiguous?' · '+c.ambiguous+' 个有歧义':'')+'</span></div>'+previewNote+'<p>已确认 '+c.resolvedVariants+' 种具体搭配（'+c.resolvedComplete+' 种六项齐全），独立列入菜单；原始餐品不会被某一搭配的数值覆盖。</p><details><summary>逐营养覆盖与说明</summary><div class="coverage-metrics">'+nutrientKeys.map(k=>'<span>'+metrics[k][0]+' '+c.nutrients[k].known+'/'+c.total+'；搭配 '+c.variantNutrients[k].known+'/'+c.resolvedVariants+'</span>').join('')+'</div><p>“待确认”需展开官方轮次；“未匹配”表示官方营养品名无法唯一对应，缺失不等于零。</p></details>':'<strong>公开参考目录 · 12 种单品＋'+baseMeals.length+' 款示例套餐</strong>'+previewNote+'<p>快照核对日期 '+sampleInfo.checkedAt+'；用于体验换配和保存，演示价不能用于实际购买判断。</p>';
}
function renderRecommendations(){
  $('#recommendations').innerHTML=suggestions.length?suggestions.map((s,index)=>'<article class="recommendation-card"><div><h3>'+esc(label(foodMap.get(s.fromId)))+'<span>→</span>'+esc(label(foodMap.get(s.toId)))+'</h3><div class="delta-grid">'+deltaHtml(s.comparison)+'</div><p>换后整餐 '+number(s.after.kcal)+' kcal · '+money(s.after.price)+(s.comparisonOnly?' · 仅营养比较，价格待核验':' · '+(currentStore?'菜单参考价':'演示价'))+'</p></div><button class="apply-swap" data-recommend="'+index+'" type="button">试试这组 ↗</button></article>').join(''):'<div class="recommendation-empty">'+(items.some(i=>i.food.isMeal)?'套餐请点餐单里的“改搭配”，直接比较各轮可选项。单品可使用下方条件找替换方案。':items.length?'选好目标和条件，再找换配方案。金额留空时可只比较营养。':'先选一餐，再试试不同的配餐。')+'</div>';
}
function refreshBanner(){
  const p=$('.data-banner p');
  p.innerHTML=currentStore?'<strong>当前门店菜单＋官方标准份营养；金额为菜单参考价。</strong><span> 实付请核验官方报价，未匹配项明确保留暂缺。</span>':officialMode?'<strong>本人 MCP 查询的官方营养目录；不代表门店可售菜单。</strong><span> 先选择门店再核价和保存真实套餐。</span>':'<strong>官方标准份营养＋公开套餐参考快照；金额为演示数据。</strong><span> 示例可直接换配；连接并选门店可查询实时菜单和官方报价。</span>';
  metrics.price[0]=currentStore?'菜单金额':officialMode?'金额':'演示金额';
  $('#store-label').textContent=currentStore?currentStore.name+' · 到店自取':'参考餐品体验 · 可连接后查询门店';
  $('.budget-hint:not(#goal-note)').textContent=currentStore?'金额筛选使用菜单参考价，最终实付需官方核价。':'预算由你设置；参考目录金额为演示价。';
  $('#goal-note').textContent={ 'lower-kcal':'绿色表示热量下降、金额下降；热量上升或蛋白质减少标红，其余营养中性显示。','higher-protein':'绿色表示蛋白质增加、金额下降；蛋白质减少标红，其余营养中性显示。','lower-sodium':'绿色表示钠减少、金额下降；钠增加标红，其余营养中性显示。','neutral':'营养箭头只表示升降；金额下降为绿、上升为红。颜色不代表总体健康评价。'}[goal];
  $('#draft-recovery').hidden=!pendingDraft;
  if(pendingDraft)$('#draft-recovery').innerHTML='<div><strong>发现上次未完成的'+(pendingDraft.mode==='store'?'真实门店餐单':'参考餐单')+'</strong><p>'+esc(pendingDraft.store?.name||'参考目录')+' · '+pendingDraft.items.reduce((s,i)=>s+i.qty,0)+'份；恢复时重新核验，不沿用旧价格。</p></div><button id="restore-draft" class="secondary-button" type="button">重新核验并恢复 ↗</button>';
}
function render(){const focus=captureFocus();refreshBanner();renderCoverage();renderFoods();renderCart();renderRecommendations();restoreFocus(focus);}
function showSwap(id,forceAlternatives=false){
  const row=items.find(i=>i.food.id===id);if(!row||lockedIds.has(id))return;
  if((currentStore||row.food.demoMeal)&&row.food.quoteItem&&!forceAlternatives){mealController.configureFood(row.food,id,row.qty);return;}
  const alternatives=foods.filter(f=>f.category===row.food.category&&Boolean(f.isMeal)===Boolean(row.food.isMeal)&&f.id!==id&&!lockedIds.has(f.id)&&(!f.isMeal||f.quoteItem));
  const before=summarize(items);
  openDialog('换掉'+row.food.name,'<p class="dialog-description">按 '+row.qty+' 份替换，比较相对当前整餐的七项变化。未知数据保留待确认。</p>'+alternatives.map(f=>'<article class="swap-option">'+art(f)+'<div class="swap-option-info"><h3>'+esc(f.name)+' <small>'+esc(f.spec)+'</small></h3><small>'+metricText(f,'kcal')+' kcal / 份 · '+money(f.price)+'</small><div class="delta-grid">'+deltaHtml(comparison(before,summarize(swapItems(id,f.id))))+'</div></div><button data-replace-from="'+esc(id)+'" data-replace-to="'+esc(f.id)+'" type="button">换这份</button></article>').join(''));
}
function showSources(){
  const c=coverageSummary(foods);
  const source=officialMode?'<h3>当前数据：本人 MCP 查询</h3><p>营养查询时间：'+esc(dateLabel(nutritionFetchedAt))+'；门店菜单查询时间：'+esc(dateLabel(menuFetchedAt))+'。查询时间不是营养测定或配方更新日期；MCP 未返回营养版本号。</p><p>当前范围：'+esc(currentStore?currentStore.name+'，到店自取':'仅官方营养目录，未选择门店')+'。原始餐品 '+c.total+' 项，六项齐全 '+c.complete+' 项；已确认具体搭配 '+c.resolvedVariants+' 种。规格需要完整精确对应，不用相似品名猜数值。</p>':'<h3>参考目录：12 个单品与 43 个示例套餐</h3><p>营养整理自麦当劳中国官方产品页，并使用本机已查询 MCP 的同名同规格数据补充六项营养。官网来源标注版本 '+esc(dataInfo.nutritionDate)+'，核对日期 '+esc(dataInfo.checkedAt)+'。套餐为 '+sampleInfo.checkedAt+' 官方公开快照，非实时门店可售菜单；默认搭配展开后逐组成累加，缺失字段逐项说明。价格全部为交互演示数据。</p>';
  openDialog('每个数字，都有来处。','<div class="sources-copy">'+source+'<h3>这些数字真实吗？</h3><p>营养采用官方标准份参考，合计和差值按已选份数计算，不是对这份实物的测量。当前MCP直接返回kcal时采用原值；仅官网提供kJ的补充按round(kJ÷4.184)换算。官网产品表营养版本为2025年4月，核对日期为2026-10-15，查询日期不是配方更新日期。</p><p>已重新核对12个单品72项数值与官网；160条MCP六项字段与随附快照一致。官方也有来源差异：麦香鸡MCP为369kcal，1546kJ换算约370kcal；本工具保留MCP原值。麦乐鸡采用专用营养表及MCP的213kcal，不采用旧宣传页的215kcal。</p><p>盒装牛奶用相同商品编码确认规格；椒盐鸡排用官网完整同名标准份补充。新品、酱料、鱼排堡和60g苹果片无法确认完整同规格时继续标缺。可在每项营养详情查看官方链接和核查说明。</p><h3>六项数据与计算</h3><p>热量 kcal；蛋白质、脂肪、碳水 g；钠、钙 mg。对应每标准份／杯型；组件乘份数，再对整餐相加。缺任一字段只影响该项总计，不按零补齐。真实零值保留为零。</p><p>整餐差值＝更换后−更换前，按当前实际份数计算。绿色和红色按选定比较目标解释，脂肪、碳水、钙不预设越低越好；仅展示差值，不给医疗饮食建议。</p><h3>规格与价格边界</h3><p>大小份、杯型、冷热分别对应。套餐先展开官方轮次；少酱、去冰等特制保持官方默认，不估算其扣减营养。官方标准份不等于实际摄入测量。</p><p>菜单金额是参考值，会员／活动条件未确定时显示待核价。官方本餐报价只对应当前门店、份数和搭配，任何修改会失效；本工具不下单、不付款。</p><h3>保存与连接</h3><p>常用组合和草稿仅存当前浏览器，保存门店编码、餐品编码、选择和份数。恢复会重查菜单和每项详情，原选项失效会阻止恢复；不保存旧营养、旧报价或 Token。</p><p>Token 仅在本机服务进程内存，关闭服务后清除。线上预览不接收 Token。</p><p><a href="https://open.mcd.cn/mcp/doc" target="_blank" rel="noopener noreferrer">官方 MCP 接口说明 ↗</a></p>'+(!officialMode?'<h3>参考餐品来源</h3><ul class="source-list">'+referenceFoods.filter(f=>f.sourceUrl).map(f=>'<li><a href="'+esc(f.sourceUrl)+'" target="_blank" rel="noopener noreferrer">'+esc(label(f))+' ↗</a></li>').join('')+'</ul>':'')+'<p>麦麦知量为非官方参赛作品。餐品照片来自麦当劳官方产品页或门店菜单；照片用于识别产品，实际份量与套餐组成以文字规格和已选清单为准。图片加载失败时显示示意插图。</p></div>','DATA, NOT GUESSWORK');
}
function showFavorites(){
  openDialog('下次，还想这样吃。','<p class="dialog-description">仅保存在当前浏览器。真实餐单恢复时重新查询门店、组成和营养，报价需要再次核验。</p>'+favorites.map((f,i)=>'<article class="favorite-row"><div><h3>'+esc(f.name)+'</h3><p>'+esc(f.mode==='store'?f.store.name:'参考餐品组合')+' · '+f.items.reduce((n,r)=>n+r.qty,0)+'份 · '+f.items.filter(r=>r.locked).length+'项保留</p></div><button data-favorite-load="'+i+'" type="button">核验并恢复</button><button class="delete-favorite" data-favorite-delete="'+i+'" aria-label="删除'+esc(f.name)+'" type="button">×</button></article>').join('')+(favorites.length?'':'<div class="recommendation-empty">搭好一餐后，保存为常用组合。</div>'));
}
function showSave(){openDialog('给这餐起个名字','<form id="save-form" class="dialog-form"><label for="favorite-name">组合名称</label><input id="favorite-name" maxlength="80" placeholder="比如：我的板烧午餐" required autocomplete="off"><p class="dialog-description">保存当前门店、轮次选择、份数与保留状态；恢复时重新核验。</p><button class="primary-button" type="submit">保存组合 ♡</button></form>');}
function applyMenu(context){
  contextVersion++;
  pendingDraft=null;
  foods=context.foods;indexFoods();liveNutrition=context.nutritionRecords;currentStore=context.store;officialMode=true;
  menuFetchedAt=context.fetchedAt;nutritionFetchedAt=context.nutritionFetchedAt;currentQuote=null;items=[];lockedIds.clear();lastChange=null;undoState=null;suggestions=[];
  category=foods.some(food=>food.isMeal)?'meal':'all';knownOnly=false;$('#known-only').checked=false;query='';$('#food-search').value='';persist();render();void loadDefaultPreviews();
}
async function restore(recipe){
  if(busyRestore)return;
  if(recipe.mode==='store'&&!connected){showConnection();toast('连接后，从草稿或常用组合重新点击恢复');return;}
  busyRestore=true;openDialog('正在重新核验这一餐…','<p class="dialog-description">查询当前菜单和每项原始选择；全部验证通过后再恢复。请稍候。</p>');
  const revision=contextVersion,dialogRevision=dialogVersion;
  try {
    const result=await restoreFavorite(recipe,{loadStore:storeController.loadStore,resolveFood:mealController.resolveFood,resolveReferenceFood:(base,selections,options)=>mealController.resolveFood(base,selections,{...options,store:SAMPLE_STORE,nutrition:sampleNutrition}),referenceFoods});
    if(contextVersion!==revision||dialogVersion!==dialogRevision)return;
    let restoredFoods=result.context?.foods||[...referenceFoods];
    for(const food of result.resolved)restoredFoods=mergeResolvedMenu(restoredFoods,food).foods;
    contextVersion++;
    foods=restoredFoods;
    if(result.context) {liveNutrition=result.context.nutritionRecords;currentStore=result.context.store;officialMode=true;menuFetchedAt=result.context.fetchedAt;nutritionFetchedAt=result.context.nutritionFetchedAt;}
    else {currentStore=null;officialMode=false;liveNutrition=[];menuFetchedAt=null;nutritionFetchedAt=null;}
    indexFoods();items=merge(result.items);lockedIds=new Set(result.lockedIds);lastChange=null;undoState=null;suggestions=[];currentQuote=null;
    category='all';knownOnly=false;$('#known-only').checked=false;query='';$('#food-search').value='';pendingDraft=null;persist();render();void loadDefaultPreviews();closeDialog();toast(currentStore?'已按当前数据恢复；官方报价需重新核验':'已按公开参考数据重新计算并恢复搭配');
  }catch(e){if(contextVersion===revision&&dialogVersion===dialogRevision)openDialog('这餐需要重新确认','<p class="dialog-description">'+esc(e.message)+'</p><p class="configuration-note">原餐单保持不变，已保存组合仍可保留或删除。不会用默认搭配替代失效选项。</p>');}
  finally{busyRestore=false;}
}
async function api(path,body){
  if(path==='/api/tool'&&body?.arguments?.storeCode===SAMPLE_STORE.code){
    const detail=sampleDetails[String(body.arguments.code)];
    if(body.name!=='query-meal-detail'||!detail)throw new Error('未找到该公开示例套餐');
    return {success:true,data:structuredClone(detail)};
  }
  const version=connectionVersion;
  let response;
  try {response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin'});}
  catch {if(connectionVersion===version){connected=false;updateConnectionLabel();renderCart();}throw new Error('本机服务未连接，请确认服务正在运行');}
  const result=await response.json().catch(()=>({}));
  if(!response.ok){if([401,409].includes(response.status)&&connectionVersion===version){connected=false;updateConnectionLabel();renderCart();}throw new Error(result.error||'查询未完成（'+response.status+'）');}
  return result;
}
function updateConnectionLabel(){$('#connect-nav').textContent=connected?'已连接 · 本机 ✓':'连接麦当劳 ↗';$('#connect-nav').classList.toggle('connected',connected);renderMenuStatus();}
async function detectLocal(){
  if(!['127.0.0.1','localhost'].includes(location.hostname))return;
  const version=connectionVersion;
  try{const status=await api('/api/status');if(version!==connectionVersion)return;localApi=status.local===true;connected=status.connected===true;}
  catch{if(version!==connectionVersion)return;localApi=false;connected=false;}
  updateConnectionLabel();renderCart();
}
function showConnection(){
  if(!localApi){openDialog('在本机连接麦当劳','<div class="connection-notice">线上预览不接收 Token。请在电脑运行本机版，打开 <strong>http://127.0.0.1:4318</strong> 后连接。</div><p class="dialog-description">Token 仅保留在本人电脑进程内存；关闭服务会清除。</p>','YOUR TOKEN STAYS LOCAL');return;}
  openDialog(connected?'你的麦当劳，已连接。':'连接你自己的麦当劳',connected?'<div class="connection-notice">连接已验证。可选择门店搭餐，或获取纯营养目录；真实草稿可从页面上方恢复。</div><div class="connect-actions"><button id="connection-choose-store" class="primary-button" type="button">选择门店 ↗</button><button id="fetch-nutrition" class="secondary-button" type="button">仅看官方营养目录</button><button id="disconnect-mcp" class="secondary-button" type="button">断开连接</button></div><div id="connection-result" role="status" class="connection-result"></div>':'<div class="connection-notice">Token 仅存于本机服务进程内存，不存浏览器、文件或线上预览。服务重启后需要重新连接；不要把 Token 发到聊天中。</div><form id="connect-form" class="dialog-form" style="margin-top:18px"><label for="mcp-token">已激活的 MCP Token</label><input id="mcp-token" type="password" autocomplete="off" spellcheck="false" required placeholder="在这里粘贴"><button class="primary-button" type="submit">连接并验证 ↗</button></form><div id="connection-result" role="status" class="connection-result"></div>','YOUR TOKEN STAYS LOCAL');
}
function categoryFor(name){
  if(/冰淇淋|麦旋风|甜筒|圆筒|派$|雪糕/.test(name))return ['dessert','icecream'];
  if(/可乐|咖啡|茶|奶|豆浆|果汁|水$|汽水|饮/.test(name)&&!/汉堡|麦满分|松饼|鸡腿/.test(name))return ['drink','cola'];
  if(/薯条|玉米|麦乐鸡|鸡块|小食|薯饼|鸡翅/.test(name))return ['side',/玉米/.test(name)?'corn':/薯/.test(name)?'fries':'nuggets'];
  return ['main','burger'];
}
async function fetchNutrition(button){
  button.disabled=true;$('#connection-result').textContent='正在获取官方营养目录…';
  const revision=contextVersion,dialogRevision=dialogVersion;
  try {
    const result=await api('/api/nutrition',{});if(!result.foods?.length)throw new Error('官方暂未返回营养条目');
    if(contextVersion!==revision||dialogVersion!==dialogRevision)return;
    contextVersion++;previewGeneration++;pendingDraft=null;
    foods=result.foods.map((e,i)=>{const [category,icon]=categoryFor(e.productName);return {id:'live-'+i,name:e.productName,spec:'标准份，规格以官方品名为准',category,icon,...Object.fromEntries(nutrientKeys.map(k=>[k,k==='kcal'?e.energyKcal:e[k]])),price:null,priceMode:'unknown',nutritionSource:'official-mcp-nutrition',nutritionMatch:'exact'};});
    indexFoods();liveNutrition=result.foods;nutritionFetchedAt=result.fetchedAt;menuFetchedAt=null;currentStore=null;officialMode=true;items=[];lockedIds.clear();currentQuote=null;lastChange=null;undoState=null;suggestions=[];persist();render();closeDialog();toast('已读取 '+foods.length+' 条官方营养数据；选店后可保存真实餐单');
  }catch(e){if($('#connection-result'))$('#connection-result').textContent=e.message;}
  finally{if(button.isConnected)button.disabled=false;}
}
function constraints(){
  const value=(id,fallback)=>$('#'+id).value.trim()===''?fallback:Number($('#'+id).value);
  return {minProtein:value('min-protein',0),maxFat:value('max-fat',Infinity),maxCarbohydrate:value('max-carb',Infinity),maxSodium:value('max-sodium',Infinity)};
}
function budgetChange(){
  if(!$('#kcal-budget').checkValidity()||!$('#price-budget').checkValidity())return false;
  maxKcal=Number($('#kcal-budget').value);maxPrice=$('#price-budget').value.trim()===''?Infinity:Number($('#price-budget').value);
  return known(maxKcal)&&maxKcal>0&&(maxPrice===Infinity||known(maxPrice));
}
layoutController=setupLayout();
$('#hero-food').innerHTML=art(referenceFoods.find(food=>food.id==='grilled-chicken'));
const prefs=read(preferenceKey,{});
maxKcal=known(prefs.maxKcal)&&prefs.maxKcal>0?Math.min(10000,prefs.maxKcal):800;
maxPrice=prefs.maxPrice===null?Infinity:known(prefs.maxPrice)?Math.min(10000,prefs.maxPrice):40;
goal=['lower-kcal','higher-protein','lower-sodium','neutral'].includes(prefs.goal)?prefs.goal:'lower-kcal';
$('#kcal-budget').value=maxKcal;$('#price-budget').value=Number.isFinite(maxPrice)?maxPrice:'';$('#comparison-goal').value=goal;
pendingDraft=validateFavorite(read(draftKey));
if(pendingDraft?.mode==='demo') {
  const draft=pendingDraft;pendingDraft=null;
  const valid=draft.items.every(r=>foodMap.has(r.demoId)&&!foodMap.get(r.demoId).demoMeal);
  if(valid){items=merge(draft.items.map(r=>({food:foodMap.get(r.demoId),qty:r.qty})));lockedIds=new Set(draft.items.filter(r=>r.locked).map(r=>r.demoId));}
  else pendingDraft=draft;
}else if(!pendingDraft)classic({save:false});
storeController=setupStoreUI({...revisionOptions,api,openDialog,closeDialog,toast,getConnected:()=>connected,showConnection,onMenu:applyMenu,getMeal:()=>({store:currentStore,items}),onQuote:q=>{currentQuote=q;renderCart();toast('已取得本餐官方报价，未创建订单');}});
mealController=setupMealUI({...revisionOptions,api,openDialog,closeDialog,toast,clearFeedback:clearDialogFeedback,getStore:()=>currentStore||SAMPLE_STORE,getNutrition:()=>currentStore?liveNutrition:sampleNutrition,getGoal:()=>goal,onApply:(food,existingId,detail)=>{
  dialogFocusFood=existingId?food.id:null;
  const previous=items.find(i=>i.food.id===existingId);const first=!items.length;
  foods=mergeResolvedMenu(foods,food).foods;indexFoods();
  const qty=previous?.qty||1;const locks=new Set(lockedIds);if(existingId&&locks.delete(existingId))locks.add(food.id);
  commit([...items.filter(i=>i.food.id!==existingId),{food,qty}],existingId?'更新 '+qty+' 份套餐搭配':'添加'+food.name,{locks});
  if(first&&food.isMeal){lastChange={label:'相对套餐默认搭配 · '+qty+'份',before:summarize([{food:detail.baseline,qty}]),after:summarize([{food:detail.current,qty}])};renderCart();}
}});
render();void loadDefaultPreviews();void detectLocal();
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void detectLocal();});
$('#food-search').addEventListener('input',e=>{query=e.target.value.trim();renderFoods();});
$('#food-sort').addEventListener('change',e=>{sorting=e.target.value;renderFoods();});
$('#known-only').addEventListener('change',e=>{knownOnly=e.target.checked;renderFoods();});
$('#comparison-goal').addEventListener('change',e=>{goal=e.target.value;suggestions=[];persist();render();});
for(const id of ['kcal-budget','price-budget','min-protein','max-fat','max-carb','max-sodium'])$('#'+id).addEventListener('change',()=>{if(budgetChange()){suggestions=[];persist();renderCart();renderRecommendations();}});
$('#recommend-button').addEventListener('click',()=>{
  for(const input of document.querySelectorAll('.budget-panel input,.constraint-options input'))if(!input.reportValidity())return;
  if(!budgetChange()){toast('请填写有效的本餐热量预算');return;}
  suggestions=recommendSwaps(items,foods.filter(f=>!f.isMeal),{lockedIds:[...lockedIds,...items.filter(i=>i.food.isMeal).map(i=>i.food.id)],maxKcal,maxPrice,goal,...constraints()});
  renderCart();renderRecommendations();persist();
  if(!suggestions.length&&items.length)$('#recommendations').innerHTML='<div class="recommendation-empty">没有找到满足当前条件的单项替换。可以解除部分保留、调整预算；套餐内替换请点“改搭配”。</div>';
});
$('#reset-meal').addEventListener('click',()=>{classic();toast('已载入参考经典组合，主餐已保留');});
$('#clear-meal').addEventListener('click',()=>{if(items.length)commit([],'清空这一餐');});
$('#save-meal').addEventListener('click',showSave);
$('#favorites-nav').addEventListener('click',showFavorites);
for(const id of ['sources-nav','banner-sources','footer-sources'])$('#'+id).addEventListener('click',showSources);
$('#connect-nav').addEventListener('click',showConnection);
$('#dialog-close').addEventListener('click',closeDialog);
$('#app-dialog').addEventListener('close',()=>{if($('#app-dialog').open)return;restoreFocus(dialogFocusSnapshot,{foodId:dialogFocusFood});dialogFocusSnapshot=null;dialogFocusFood=null;layoutController?.refresh();});
$('#view-meal').addEventListener('click',()=>{$('#my-meal').scrollIntoView({behavior:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});$('#my-meal').focus({preventScroll:true});});
document.addEventListener('error',event=>{const image=event.target;if(image?.matches?.('img[data-food-image]')){image.hidden=true;if(image.nextElementSibling)image.nextElementSibling.hidden=false;}},true);
$('#app-dialog').addEventListener('cancel',()=>{dialogVersion++;});
$('#app-dialog').addEventListener('click',e=>{if(e.target===$('#app-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog();}});
document.addEventListener('click',async event=>{
  const b=event.target.closest('button');if(!b||b.disabled||busyRestore)return;const d=b.dataset;
  if(d.category){if(d.category==='meal'&&officialMode&&!currentStore){storeController.chooseStore();return;}category=d.category;renderFoods();}
  if(b.id==='open-store-menu')storeController.chooseStore();
  if(b.id==='show-all-meals'){knownOnly=false;$('#known-only').checked=false;renderFoods();}
  if(d.add){const food=foodMap.get(d.add);if(!food)return;if((currentStore||food.demoMeal)&&!food.resolvedRecipe&&(food.isMeal||!known(food.kcal)||nutritionStatus(food)==='needs-selection')){await mealController.configureFood(food);return;}const row=items.find(i=>i.food.id===food.id);if(row?.qty>=99)return;commit([...items,{food,qty:1}],'添加'+food.name);toast('已添加'+food.name);}
  if(d.qty)commit(items.map(i=>({...i,qty:i.food.id===d.qty?i.qty+Number(d.step):i.qty})),Number(d.step)>0?'增加餐品份数':'减少餐品份数');
  if(d.lock){if(lockedIds.has(d.lock))lockedIds.delete(d.lock);else lockedIds.add(d.lock);suggestions=[];persist();renderCart();renderRecommendations();}
  if(d.swap)showSwap(d.swap);
  if(d.swapOther)showSwap(d.swapOther,true);
  if(d.replaceFrom){const from=foodMap.get(d.replaceFrom),to=foodMap.get(d.replaceTo);const row=items.find(i=>i.food.id===from.id);if((currentStore||to.demoMeal)&&!to.resolvedRecipe&&(to.isMeal||!known(to.kcal)||nutritionStatus(to)==='needs-selection')){await mealController.configureFood(to,from.id,row.qty);return;}dialogFocusFood=to.id;commit(swapItems(from.id,to.id),from.name+' → '+to.name);closeDialog();toast('已换成'+to.name);}
  if(d.recommend!==undefined){const s=suggestions[Number(d.recommend)];if(s){commit(s.items,'应用换配方案');toast('已应用换配，七项差值已更新');}}
  if(b.id==='undo-change'&&undoState){items=undoState.items;lockedIds=new Set(undoState.lockedIds);undoState=null;lastChange=null;currentQuote=null;suggestions=[];persist();render();toast('已恢复更换前的餐单');}
  if(d.favoriteLoad!==undefined&&favorites[Number(d.favoriteLoad)])await restore(favorites[Number(d.favoriteLoad)]);
  if(d.favoriteDelete!==undefined){try{favorites=saveFavorites(browserStorage,favorites.filter((_,i)=>i!==Number(d.favoriteDelete)));showFavorites();}catch{toast('未能删除，请检查浏览器存储');}}
  if(b.id==='restore-draft'&&pendingDraft)await restore(pendingDraft);
  if(b.id==='fetch-nutrition')await fetchNutrition(b);
  if(b.id==='connection-choose-store')storeController.chooseStore();
  if(b.id==='disconnect-mcp'){connectionVersion++;try{await api('/api/disconnect',{});connected=false;updateConnectionLabel();renderCart();showConnection();}catch(e){toast(e.message);}}
});
document.addEventListener('submit',async event=>{
  if(event.target.id==='save-form'){
    event.preventDefault();try{const favorite=createFavorite({name:$('#favorite-name').value.trim(),store:currentStore,items,lockedIds});favorites=saveFavorites(browserStorage,[favorite,...favorites]);closeDialog();toast(currentStore?'已保存门店、搭配、份数和保留状态':'已保存参考搭配、份数和保留状态');}catch(e){toast(browserStorage?(e.message||'浏览器未能保存组合'):'浏览器存储不可用，未保存组合');}
  }
  if(event.target.id==='connect-form'){
    connectionVersion++;
    event.preventDefault();const input=$('#mcp-token');let token=input.value.trim();input.value='';const b=event.target.querySelector('button');b.disabled=true;
    $('#connection-result').textContent='正在验证官方 MCP 连接…';
    try{await api('/api/connect',{token});token='';connected=true;updateConnectionLabel();renderCart();showConnection();}
    catch(e){connected=false;updateConnectionLabel();if($('#connection-result')){$('#connection-result').textContent=e.message;$('#connection-result').classList.add('error');}if(b.isConnected)b.disabled=false;}
    finally{token='';}
  }
});

