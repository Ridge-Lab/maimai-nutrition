export const metrics = {
  kcal: ['热量', 'kcal', 0], protein: ['蛋白质', 'g', 1], fat: ['脂肪', 'g', 1],
  carbohydrate: ['碳水', 'g', 1], sodium: ['钠', 'mg', 0], calcium: ['钙', 'mg', 0], price: ['参考金额', '元', 2],
};
export const nutrientKeys = ['kcal','protein','fat','carbohydrate','sodium','calcium'];
export const allMetrics = [...nutrientKeys,'price'];
export const $ = s => document.querySelector(s);
export const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const known = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export const number = (v,digits=0) => known(v) ? new Intl.NumberFormat('zh-CN',{maximumFractionDigits:digits}).format(v) : '暂缺';
export const money = v => known(v) ? `¥${number(v,2)}` : '待核价';
export const label = food => `${food.name}${food.spec ? ' · '+food.spec : ''}`;
export function officialSourceLink(url,title='查看官方依据 ↗'){
  try{const source=new URL(url);if(source.protocol==='https:'&&['www.mcdonalds.com.cn','open.mcd.cn'].includes(source.hostname))return '<a href="'+esc(source.href)+'" target="_blank" rel="noopener noreferrer">'+esc(title)+'</a>';}catch{}
  return '';
}
export function nutritionSourceHtml(food){
  const kinds={'official-mcp-nutrition':'官方 MCP 标准份营养','official-product-page':'官网产品营养表','official-mcp-and-product-page':'官方 MCP＋官网补充','official-product-page-and-mcp-nutrition':'官网产品表＋MCP同规格核对','official-component-sum':'按已选组成和份数计算'};
  return '<p class="nutrition-source-note">'+(food.nutritionName?'对应官方品名：'+esc(food.nutritionName)+'。 ':'')+esc(kinds[food.nutritionSource]||'规格或官方数据尚待确认')+(food.nutritionNote?'。 '+esc(food.nutritionNote):'')+' '+officialSourceLink(food.sourceUrl)+'</p>';
}
export function nutrientHtml(food,qty=1,keys=nutrientKeys) {
  return `<dl class="nutrition-grid">${keys.map(k=>`<div><dt>${metrics[k][0]}</dt><dd><span class="nutrition-value">${number(known(food[k])?food[k]*qty:null,metrics[k][2])}</span><small>${known(food[k])?' '+metrics[k][1]:''}</small></dd></div>`).join('')}</dl>`;
}
export function deltaHtml(comparison,keys=allMetrics) {
  return keys.map(k=>{
    const {delta,direction,tone}=comparison[k]; const [title,unit,digits]=metrics[k];
    const arrow={up:'↑',down:'↓',same:'—',unknown:'?'}[direction];
    const word={up:'增加',down:'减少',same:'不变',unknown:'待确认'}[direction];
    const amount=delta===null?'':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:digits}).format(Math.abs(delta));
    return `<span class="delta ${tone}" aria-label="${title}${word}${amount?' '+amount+' '+unit:''}"><span class="delta-arrow" aria-hidden="true">${arrow}</span>${title} ${direction==='unknown'?'待确认':direction==='same'?'不变':amount+' '+unit}</span>`;
  }).join('');
}
