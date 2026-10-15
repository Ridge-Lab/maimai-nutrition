import {parseMealDetail,buildMeal,normalizeRoundSelection,initialMealSelections,mealSelectionKey} from './meal-detail.mjs';
import {compare,summarize} from './engine.mjs';
import {$,esc,number,nutrientHtml,deltaHtml,nutrientKeys,metrics,known,nutritionSourceHtml} from './ui.mjs';
import {nutrientCoverage} from './coverage.mjs';
import {missingNutritionHtml} from './nutrition-view.mjs';

export function setupMealUI({api,openDialog,closeDialog,toast,getStore,getNutrition,getGoal,onApply,getRevision=()=>0,getDialogRevision=()=>0,clearFeedback=()=>{}}) {
  const cache=new Map();let state=null;let loading=false;
  async function detailFor(base,{store=getStore(),nutrition=getNutrition(),fresh=false}={}) {
    if(!store)throw new Error('请先选择门店');
    const key=store.code+':'+base.productCode;
    if(!fresh&&cache.has(key))return cache.get(key);
    const result=await api('/api/tool',{name:'query-meal-detail',arguments:{storeCode:store.code,orderType:1,beType:1,code:base.productCode}});
    const detail=parseMealDetail(result,nutrition);
    if(String(detail.code)!==String(base.productCode))throw new Error('官方返回的餐品编码不一致');
    cache.set(key,detail);return detail;
  }
  function calculate(base,detail,selections) {
    const built=buildMeal(detail,selections);
    const price=Number.isFinite(base.price)&&base.price!==null&&built.priceDifference!==null?Math.round((base.price+built.priceDifference)*100)/100:null;
    return withCoverage({...built,price,needsSelection:[],selectionComplete:true});
  }
  function withCoverage(current) {
    const foods=current.components.filter(c=>!c.nonFood),knownTotals={},missingComponents={};
    for(const key of nutrientKeys) {
      const included=foods.filter(c=>known(c[key]));
      const subtotal=included.length||(!foods.length&&current.selectionComplete)?included.reduce((sum,c)=>sum+c[key]*c.qty,0):null;
      knownTotals[key]=known(subtotal)?subtotal:null;
      missingComponents[key]=foods.filter(c=>!known(c[key])).map(c=>({code:c.code,name:c.name,qty:c.qty}));
    }
    return {...current,knownTotals,missingComponents};
  }
  function calculateSelection(base,detail,selections) {
    const selected={},components=[],needsSelection=[];
    for(const round of detail.rounds) {
      const key=String(round.id),choice=normalizeRoundSelection(round,selections[key],{allowIncomplete:true});
      selected[key]=choice.selection;
      for(const [code,qty] of Object.entries(choice.counts)) {
        const option=round.options.find(o=>o.code===code),existing=components.find(c=>c.code===code);
        if(existing){existing.qty+=qty;for(const metric of nutrientKeys)if(existing[metric]!==option[metric])existing[metric]=null;}
        else components.push({...option,qty});
      }
      if(!choice.complete)needsSelection.push({id:key,name:round.name,total:choice.total,min:choice.min,remaining:choice.min-choice.total});
    }
    if(!needsSelection.length)return calculate(base,detail,selected);
    return withCoverage({...Object.fromEntries(nutrientKeys.map(key=>[key,null])),price:null,priceDifference:null,
      components,selections:selected,quoteItem:null,needsSelection,selectionComplete:false,complete:false});
  }
  function makeFood(base,detail,current) {
    const suffix=mealSelectionKey(current.selections)||'standard';
    const {defaultPreview:ignoredPreview,...baseProperties}=base;
    return {...baseProperties,...Object.fromEntries(nutrientKeys.map(k=>[k,current[k]])),id:'configured-'+base.productCode+'-'+suffix,
      name:detail.name||base.name,spec:current.components.map(c=>c.name+(c.qty>1?'×'+c.qty:'')).join(' / '),price:current.price,
      components:current.components,quoteItem:current.quoteItem,selections:current.selections,baseFood:base,parentCode:base.productCode,
      resolvedRecipe:true,nutritionMatch:current.nutritionMatch,nutritionName:current.nutritionName,nutritionSource:current.nutritionSource,
      knownTotals:current.knownTotals,missingComponents:current.missingComponents,selectionComplete:current.selectionComplete,needsSelection:current.needsSelection,
      nutrientCoverage:nutrientCoverage(current),nutritionStatus:current.components.some(c=>c.nutritionMatch==='ambiguous')?'ambiguous':nutrientKeys.some(k=>Number.isFinite(current[k])&&current[k]!==null)?'matched':'unmatched'};
  }
  async function resolveFood(food,selections={},options={}) {
    const base=food.baseFood||food;const detail=await detailFor(base,options);
    if(options.strict) {
      const saved=Object.keys(selections).sort();const current=detail.rounds.map(r=>String(r.id)).sort();
      if(JSON.stringify(saved)!==JSON.stringify(current))throw new Error('套餐轮次已变化，需要重新确认搭配');
      for(const round of detail.rounds) {
        try{normalizeRoundSelection(round,selections[String(round.id)]);}
        catch{throw new Error(round.name+'的原选项已不可用或份数已变化');}
      }
    }
    return makeFood(base,detail,calculate(base,detail,selections));
  }
  async function previewFood(food,options={}) {
    const base=food.baseFood||food,detail=await detailFor(base,options);
    const {baseFood:ignoredBase,...preview}=makeFood(base,detail,calculateSelection(base,detail,initialMealSelections(detail)));
    return {...preview,defaultPreview:true,resolvedRecipe:false};
  }
  const totals=current=>summarize([{food:current,qty:state.qty}]);
  function componentsHtml() {
    return state.current.components.map(c=>'<details class="component-detail"><summary><span>'+esc(c.name)+' ×'+c.qty*state.qty+'</span><b>'+(c.nonFood?'非食品':number(c.kcal===null?null:c.kcal*c.qty*state.qty)+' kcal')+'</b></summary>'+(c.nonFood?'<p class="configuration-note">非食品，不计营养；已保留在套餐选配和官方核价中。</p>':nutrientHtml(c,c.qty*state.qty)+nutritionSourceHtml(c))+'</details>').join('');
  }
  function selectionHtml() {
    const pending=state.current.needsSelection;
    return '<div class="configuration-selection-summary"><strong>你正在选 · '+state.qty+' 份'+esc(state.base.name)+'</strong><p id="configuration-required-note">'+(pending.length?'还需选择：'+pending.map(round=>esc(round.name)+'还差 '+round.remaining+' 份').join('、')+'。选齐后才能加入，未自动改成其他选项。':'当前选择如下，点选后会立即更新。')+'</p><div class="configuration-selection-items">'+state.current.components.map(c=>'<span class="configuration-selection-item"><span aria-hidden="true">✓</span> '+esc(c.name)+' ×'+c.qty*state.qty+'</span>').join('')+pending.map(round=>'<span class="configuration-selection-item">待选择：'+esc(round.name)+'（还差 '+round.remaining+' 份）</span>').join('')+'</div></div>';
  }
  function optionNutrientsHtml(option) {
    if(option.nonFood)return '<span class="choice-option-nutrients non-food-note">非食品，不计营养</span>';
    return '<span class="choice-option-nutrients">'+nutrientKeys.map(key=>'<span><span>'+metrics[key][0]+'</span><b>'+number(option[key],metrics[key][2])+(known(option[key])?'<small> '+metrics[key][1]+'</small>':'')+'</b></span>').join('')+'</span>'+(option.nutritionNote?'<span class="choice-option-meta">'+esc(option.nutritionNote)+'</span>':'');
  }
  function roundProgress(round) {
    const choice=normalizeRoundSelection(round,state.current.selections[String(round.id)],{allowIncomplete:true});
    const target=choice.min===choice.max?'必选 '+choice.min+' 份':'可选 '+choice.min+'–'+choice.max+' 份';
    if(!choice.single)return '已选 '+choice.total+' / '+target+(choice.complete?'':'，还差 '+(choice.min-choice.total)+' 份');
    const option=round.options.find(o=>o.code===state.current.selections[String(round.id)]);
    return option?'已选：'+option.name:'待选择';
  }
  function adjustDisabled(round,option,step) {
    const choice=normalizeRoundSelection(round,state.current.selections[String(round.id)],{allowIncomplete:true}),qty=choice.counts[option.code]||0;
    return step<0?qty===0:option.maxQuantity===0||choice.total>=choice.max||(option.maxQuantity>=0&&qty>=option.maxQuantity);
  }
  function roundsHtml() {
    return state.detail.rounds.map(r=>{
      const choice=normalizeRoundSelection(r,state.current.selections[String(r.id)],{allowIncomplete:true});
      return '<fieldset class="choice-round"><legend class="choice-round-heading">'+esc(r.name)+' <span class="choice-round-selected choice-round-progress" data-round-selected="'+esc(r.id)+'">'+esc(roundProgress(r))+'</span></legend><div class="choice-options">'+r.options.map(o=>{
        const qty=choice.counts[o.code]||0,checked=qty>0,unavailable=o.maxQuantity===0;
        const price=o.diffPriceValue===null?'差价待核验':o.diffPriceValue===0?'不加价':(o.diffPriceValue>0?'+':'−')+'¥'+number(Math.abs(o.diffPriceValue),2);
        const copy='<span class="choice-option-copy"><span class="choice-option-name">'+esc(o.name)+'</span><span class="choice-option-meta">'+price+' / 份</span>'+optionNutrientsHtml(o)+'</span>';
        if(choice.single)return '<label class="choice-option '+(checked?'is-selected':'')+(unavailable?' is-unavailable':'')+'"><input type="radio" name="meal-round-'+esc(r.id)+'" data-round-choice="'+esc(r.id)+'" value="'+esc(o.code)+'" '+(checked?'checked':'')+' '+(unavailable?'disabled':'')+'><span class="choice-option-check" aria-hidden="true">'+(checked?'✓':'')+'</span>'+copy+'<span class="choice-option-state">'+(unavailable?'暂不可选':checked?'已选':'可选')+'</span></label>';
        const button=step=>'<button type="button" data-meal-adjust data-round="'+esc(r.id)+'" data-code="'+esc(o.code)+'" data-step="'+step+'" aria-label="'+(step<0?'减少':'增加')+esc(o.name)+'一份" '+(adjustDisabled(r,o,step)?'disabled':'')+'>'+(step<0?'−':'+')+'</button>';
        return '<div class="choice-option is-multiple '+(checked?'is-selected':'')+(unavailable?' is-unavailable':'')+'" data-meal-option="'+esc(o.code)+'" data-meal-round="'+esc(r.id)+'">'+copy+'<span class="choice-option-state">'+(unavailable?'暂不可选':checked?'已选 '+qty+' 份':'可选')+'</span><div class="choice-quantity-controls">'+button(-1)+'<output data-meal-count="'+esc(o.code)+'" data-meal-round="'+esc(r.id)+'" aria-label="'+esc(o.name)+'已选份数">'+qty+'</output>'+button(1)+'</div></div>';
      }).join('')+'</div></fieldset>';
    }).join('');
  }
  function updateSelectionState() {
    for(const input of document.querySelectorAll?.('input[data-round-choice]')||[]) {
      const selected=state.current.selections[input.dataset.roundChoice]===input.value;
      input.checked=selected;const card=input.closest('.choice-option');card.classList.toggle('is-selected',selected);
      card.querySelector('.choice-option-check').textContent=selected?'✓':'';
      card.querySelector('.choice-option-state').textContent=input.disabled?'暂不可选':selected?'已选':'可选';
    }
    for(const title of document.querySelectorAll?.('[data-round-selected]')||[]) {
      const round=state.detail.rounds.find(r=>String(r.id)===title.dataset.roundSelected);
      title.textContent=roundProgress(round);
    }
    for(const card of document.querySelectorAll?.('[data-meal-option]')||[]) {
      const round=state.detail.rounds.find(r=>String(r.id)===card.dataset.mealRound),choice=normalizeRoundSelection(round,state.current.selections[String(round.id)],{allowIncomplete:true});
      const option=round.options.find(o=>o.code===card.dataset.mealOption),qty=choice.counts[option.code]||0;
      card.classList.toggle('is-selected',qty>0);
      card.querySelector('.choice-option-state').textContent=option.maxQuantity===0?'暂不可选':qty?'已选 '+qty+' 份':'可选';
      card.querySelector('[data-meal-count]').textContent=qty;
      for(const button of card.querySelectorAll('[data-meal-adjust]'))button.disabled=adjustDisabled(round,option,Number(button.dataset.step));
    }
    $('#configuration-selection').innerHTML=selectionHtml();
    const button=$('#apply-configured-meal');button.disabled=!state.current.selectionComplete;button.textContent=applyLabel();
  }
  const applyLabel=()=>!state.current.selectionComplete?'先完成待选择项':(state.existingId?'保存这 '+state.qty+' 份搭配':'确认搭配，加入这一餐')+' ↗';
  function coverageHtml(current) {
    const unknown=nutrientKeys.filter(key=>!known(current[key]));
    if(!unknown.length)return '';
    const missing=new Map();
    for(const key of nutrientKeys)for(const component of current.missingComponents[key]) {
      const id=component.code+':'+component.name,entry=missing.get(id)||{...component,fields:[]};
      entry.fields.push(metrics[key][0]);missing.set(id,entry);
    }
    const subtotal=unknown.some(key=>known(current.knownTotals[key]));
    return '<div class="configuration-coverage-note">'+(subtotal?'<div class="configuration-known-subtotal"><strong>已知部分合计（下限，非完整套餐）</strong>'+nutrientHtml(current.knownTotals,state.qty,unknown)+'<p class="configuration-note">仅累加已取得的数据；不包含待选项或以下缺失字段。</p></div>':'')+(missing.size?missingNutritionHtml(current,state.qty):'')+'</div>';
  }
  function figuresHtml() {
    const note=!state.current.selectionComplete?'还有必选轮次待选择，整餐合计暂缺，差值需选齐后确认。':!state.baseline.selectionComplete?'打开时搭配未选齐，无法计算可靠差值；每份 '+number(state.current.kcal)+' kcal。':'相对打开时搭配，按 '+state.qty+' 份计算；每份 '+number(state.current.kcal)+' kcal。';
    return '<div class="configured-total"><span>当前 '+state.qty+' 份合计</span><strong>'+number(totals(state.current).kcal)+(known(state.current.kcal)?' <small>kcal</small>':'')+'</strong></div>'+nutrientHtml(totals(state.current),1,nutrientKeys.filter(k=>k!=='kcal'))+coverageHtml(state.current)+'<p class="configuration-note">'+note+'</p><div class="delta-grid configuration-deltas">'+deltaHtml(compare(totals(state.baseline),totals(state.current),{goal:getGoal()}))+'</div>';
  }
  function show() {
    openDialog(state.base.name,'<div id="configuration-selection" aria-live="polite">'+selectionHtml()+'</div><p class="dialog-description">以下轮次配置一份套餐：单选轮点击餐品选择，多份轮用加减按钮调整数量。每种餐品营养为标准一份，合计与差值按当前 '+state.qty+' 份套餐计算。</p><div class="round-choices">'+roundsHtml()+'</div><div class="component-list">'+componentsHtml()+'</div><div id="configuration-figures">'+figuresHtml()+'</div><p class="configuration-note">标准份参考营养；少酱、去冰等特制保持官方默认。'+(state.base.demoMeal?'公开快照仅供参考换配，不能用于实时门店核价。':'菜单差价仅供参考，加入后可核验官方报价。')+'</p><div class="configuration-apply-actions"><button id="apply-configured-meal" class="primary-button" type="button" aria-describedby="configuration-required-note" '+(state.current.selectionComplete?'':'disabled')+'>'+applyLabel()+'</button>'+(state.existingId&&!state.base.isMeal?'<button class="secondary-button" data-swap-other="'+esc(state.existingId)+'" type="button">换成其他同类单品 ↗</button>':'')+'</div>','EVERY ITEM, EVERY CHANGE');
  }
  async function configureFood(food,existingId=null,qty=1) {
    if(loading)return;const store=getStore();if(!store)return;loading=true;
    const base=food.baseFood||food;state=null;openDialog(base.name,'<p class="dialog-description">'+(base.demoMeal?'正在读取公开套餐快照…':'正在读取官方规格和套餐组成…')+'</p>');
    const revision=getRevision(),dialogRevision=getDialogRevision();
    try {
      const detail=await detailFor(base,{fresh:true});
      if(getRevision()!==revision||getDialogRevision()!==dialogRevision)return;
      if(getStore()?.code!==store.code)throw new Error('门店已改变，请重新打开餐品详情');
      const current=calculateSelection(base,detail,initialMealSelections(detail,food.selections??detail.defaultSelections??{}));
      state={base,detail,current,baseline:current,existingId,qty};show();
    }catch(e){if(getRevision()!==revision||getDialogRevision()!==dialogRevision)return;state=null;openDialog(base.name,'<p class="dialog-description">'+esc(e.message)+'</p><p class="configuration-note">未推测未返回的规格或营养。可以返回选择其他餐品。</p>');}
    finally{loading=false;}
  }
  document.addEventListener('change',event=>{
    const input=event.target.closest('input[data-round-choice]');if(!input||!state||input.disabled||input.checked===false)return;
    try {state.current=calculateSelection(state.base,state.detail,{...state.current.selections,[input.dataset.roundChoice]:input.value});clearFeedback();updateSelectionState();$('.component-list').innerHTML=componentsHtml();$('#configuration-figures').innerHTML=figuresHtml();}
    catch(e){toast(e.message);updateSelectionState();}
  });
  document.addEventListener('click',event=>{
    const adjust=event.target.closest('[data-meal-adjust]');
    if(adjust?.dataset?.round&&adjust?.dataset?.code&&state) {
      if(adjust.disabled)return;
      const round=state.detail.rounds.find(r=>String(r.id)===adjust.dataset.round),step=Number(adjust.dataset.step);
      if(!round||![1,-1].includes(step))return;
      try {
        const counts={...normalizeRoundSelection(round,state.current.selections[String(round.id)],{allowIncomplete:true}).counts};
        const next=(counts[adjust.dataset.code]||0)+step;
        if(next>0)counts[adjust.dataset.code]=next;else delete counts[adjust.dataset.code];
        state.current=calculateSelection(state.base,state.detail,{...state.current.selections,[String(round.id)]:counts});
        clearFeedback();updateSelectionState();$('.component-list').innerHTML=componentsHtml();$('#configuration-figures').innerHTML=figuresHtml();
      }catch(e){toast(e.message);updateSelectionState();}
      return;
    }
    if(!event.target.closest('#apply-configured-meal')||!state)return;
    if(!state.current.selectionComplete||!state.current.quoteItem){toast('请先完成所有待选择项');return;}
    const food=makeFood(state.base,state.detail,state.current);
    onApply(food,state.existingId,{baseline:state.baseline,current:state.current,qty:state.qty});closeDialog();toast(state.current.complete?'搭配已加入，六项营养已更新':'搭配已加入，已知部分和缺失营养已标明');
  });
  return {configureFood,resolveFood,previewFood};
}

