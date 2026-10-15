import { parseStores, normalizeMenu } from './live-menu.mjs';
import { parseQuote } from './quote.mjs';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const $ = (selector) => document.querySelector(selector);

export function setupStoreUI({ api, openDialog, closeDialog, toast, getConnected, showConnection, onMenu, getMeal, onQuote, getRevision=()=>0, getDialogRevision=()=>0 }) {
  let stores = [];
  let nutrition = null;
  let nutritionFetchedAt = null;
  let loading = false;

  async function loadStore(store,{fresh=false}={}) {
    if(!getConnected())throw new Error('请先重新连接麦当劳，再核验保存的门店餐单');
    const [menu,nutritionResult]=await Promise.all([
      api('/api/tool',{name:'query-meals',arguments:{storeCode:store.code,orderType:1,beType:1}}),
      nutrition&&!fresh?Promise.resolve({foods:nutrition,fetchedAt:nutritionFetchedAt}):api('/api/nutrition',{})
    ]);
    nutrition=nutritionResult.foods;
    nutritionFetchedAt=nutritionResult.fetchedAt||nutritionFetchedAt;
    const normalized=normalizeMenu(menu,nutrition);
    if(!normalized.foods.length)throw new Error('官方菜单暂未返回可展示餐品，请重新选择门店');
    return {...normalized,store,nutritionRecords:nutrition,fetchedAt:new Date().toISOString(),nutritionFetchedAt};
  }

  function chooseStore() {
    if (!getConnected()) { showConnection(); return; }
    openDialog('找一家，开始搭餐。', '<p class="dialog-description">输入你想查询的城市和商圈／餐厅名称。默认内容仅为上海示例，不代表你的位置。切换目录会清空当前餐单。</p><form id="store-search-form" class="store-form"><label>城市<input id="store-city" value="上海" maxlength="30" required autocomplete="address-level2"></label><label>商圈或餐厅名称<input id="store-keyword" value="人民广场" maxlength="80" required autocomplete="off"></label><button class="primary-button" type="submit">找门店 ↗</button></form><div id="store-search-result" class="store-results" role="status"></div>', 'FIND YOUR RESTAURANT');
  }
  $('#choose-store').addEventListener('click', chooseStore);
  document.addEventListener('submit', async (event) => {
    if (event.target.id !== 'store-search-form') return;
    event.preventDefault();
    const city = $('#store-city').value.trim();
    const keyword = $('#store-keyword').value.trim();
    if (!city || !keyword || loading) return;
    loading = true;
    const button = event.target.querySelector('button'); button.disabled = true;
    const resultArea = $('#store-search-result'); resultArea.textContent = '正在查询官方到店自取门店…';
    const dialogRevision=getDialogRevision();
    try {
      const result = await api('/api/tool', {name:'query-nearby-stores',arguments:{searchType:2,beType:1,city,keyword}});
      if(getDialogRevision()!==dialogRevision)return;
      stores = parseStores(result);
      resultArea.innerHTML = stores.length ? stores.map((store,index) => `<article class="store-option"><div><h3>${escapeHtml(store.name)}</h3><p>${escapeHtml(store.address || '地址以官方门店信息为准')}</p></div><button data-load-store="${index}" type="button">选这家</button></article>`).join('') : '<div class="recommendation-empty">没有找到门店，试试更具体的商圈或餐厅名称。</div>';
    } catch(error) { resultArea.textContent = error.message; }
    finally { loading=false;if(button.isConnected)button.disabled=false; }
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-load-store]');
    if (!button || loading) return;
    const store = stores[Number(button.dataset.loadStore)]; if(!store)return;
    loading=true;button.disabled=true;button.textContent='读取中…';
    const revision=getRevision(),dialogRevision=getDialogRevision();
    try {
      const menu=await loadStore(store);
      if(getRevision()!==revision||getDialogRevision()!==dialogRevision)return;
      onMenu(menu);closeDialog();toast(`已载入${store.name}的当前菜单`);
    } catch(error) { if(button.isConnected){button.disabled=false;button.textContent='重新选择';}toast(error.message); }
    finally { loading=false; }
  });
  $('#quote-meal').addEventListener('click',async()=>{
    if(!getConnected()){showConnection();return;}
    const context=getMeal();
    if(!context.store||!context.items.length)return;
    if(context.items.some(({food})=>food.isMeal&&!food.quoteItem)){toast('请先展开套餐，确认各轮选配。');return;}
    if(context.items.some(({food})=>!food.productCode)){toast('餐单包含缺少官方餐品编码的项目，请重新选择。');return;}
    const button=$('#quote-meal');button.disabled=true;button.textContent='正在向官方核价…';
    const quoteItems=rows=>rows.map(({food,qty})=>({...food.quoteItem||{productCode:food.productCode},quantity:qty}));
    const fingerprint=JSON.stringify(quoteItems(context.items));
    try {
      const result=await api('/api/tool',{name:'calculate-price',arguments:{storeCode:context.store.code,orderType:1,beType:1,items:quoteItems(context.items)}});
      const current=getMeal();
      if(current.store?.code!==context.store.code||JSON.stringify(quoteItems(current.items))!==fingerprint){toast('餐单已变化，请按当前餐单重新核价。');return;}
      onQuote(parseQuote(result));
    } catch(error) { toast(error.message); }
    finally { const context=getMeal();button.disabled=!getConnected()||!context.store||!context.items.length||context.items.some(({food})=>(food.isMeal&&!food.quoteItem)||!food.productCode);button.textContent='核验本餐官方报价 ↗'; }
  });
  return {loadStore,chooseStore};
}
