import {known,number,metrics,esc,nutrientKeys,officialSourceLink} from './ui.mjs';

/** Keep reliable lower bounds visible without promoting them to complete totals. */
export function nutritionBreakdown(items){
  const knownTotals={},missingComponents={};
  for(const key of nutrientKeys){
    let sum=0,knownCount=0;const missing=[];
    for(const {food,qty} of items){
      if(known(food[key])){sum+=food[key]*qty;knownCount++;continue;}
      const components=food.components?.filter(c=>!c.nonFood);
      if(components?.length){
        for(const component of components){if(known(component[key])){sum+=component[key]*component.qty*qty;knownCount++;}else missing.push({name:component.name,code:component.code,qty:component.qty*qty,...component.nutritionNote?{note:component.nutritionNote,sourceUrl:component.sourceUrl}:{}});}
      }else missing.push({name:food.name,qty,...food.nutritionNote?{note:food.nutritionNote,sourceUrl:food.sourceUrl}:{}});
    }
    const byFood=new Map();
    for(const item of missing){const id=(item.code||'')+':'+item.name;const existing=byFood.get(id);if(existing)existing.qty+=item.qty;else byFood.set(id,{...item});}
    knownTotals[key]=knownCount?sum:null;missingComponents[key]=[...byFood.values()];
  }
  return {knownTotals,missingComponents};
}

export function metricText(food,key,qty=1){
  if(known(food[key]))return number(food[key]*qty,metrics[key][2]);
  const data=nutritionBreakdown([{food,qty}]);
  return known(data.knownTotals[key])?'≥ '+number(data.knownTotals[key],metrics[key][2]):'待补数据';
}

export function nutritionDisplayHtml(food,qty=1,keys=nutrientKeys){
  const data=nutritionBreakdown([{food,qty}]);
  return '<dl class="nutrition-grid">'+keys.map(key=>{const complete=known(food[key]),value=complete?food[key]*qty:data.knownTotals[key];return '<div><dt>'+metrics[key][0]+(!complete&&known(value)?' · 已知部分':'')+'</dt><dd><span class="nutrition-value">'+(known(value)?(complete?'':'≥ ')+number(value,metrics[key][2]):'待补数据')+'</span><small>'+(known(value)?' '+metrics[key][1]:'')+'</small></dd></div>';}).join('')+'</dl>';
}

export function missingNutritionHtml(food,qty=1){
  const data=nutritionBreakdown([{food,qty}]),rows=new Map();
  for(const key of nutrientKeys)for(const item of data.missingComponents[key]){const id=item.code||item.name;const row=rows.get(id)||{...item,keys:[]};row.keys.push(metrics[key][0]);rows.set(id,row);}
  if(!rows.size)return '';
  return '<div class="nutrition-missing-list"><strong>以下数据尚缺，未计作0</strong><ul>'+[...rows.values()].map(row=>'<li>'+esc(row.name)+' ×'+row.qty+'：'+row.keys.join('、')+(row.note?'<details class="missing-reason"><summary>官网核查说明</summary><p>'+esc(row.note)+'</p>'+officialSourceLink(row.sourceUrl)+'</details>':'')+'</li>').join('')+'</ul><p>“≥”为已知部分的合计，尚不是完整营养总量。</p></div>';
}
