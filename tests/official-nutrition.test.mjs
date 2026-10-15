import test from 'node:test';
import assert from 'node:assert/strict';
import {matchNutrition} from '../dist/live-menu.mjs';
import {officialGaps,officialSupplements} from '../dist/official-nutrition.mjs';
import {officialSourceLink,nutritionSourceHtml} from '../dist/ui.mjs';
const keys=['kcal','protein','fat','carbohydrate','sodium','calcium'];

test('盒装牛奶须同商品编码3755与已核对名称同时成立，不能给其他牛奶猜规格',()=>{
  const milk=matchNutrition('纯牛奶',[],{code:'3755'});
  assert.deepEqual(keys.map(key=>milk[key]),[129,7,7,10,73,231]);
  assert.equal(milk.nutritionSource,'official-product-page');
  assert.equal(milk.sourceUrl,'https://www.mcdonalds.com.cn/product/Drink-11');
  assert.match(milk.nutritionNote,/2025-04.*541.*4.184.*2026-10-15.*3755/);
  for(const [name,code] of [['纯牛奶','other'],['低脂纯牛奶','3755'],['牛奶','3755']])assert.equal(matchNutrition(name,[],{code}).kcal,null);
  assert.equal(matchNutrition('纯牛奶',[]).kcal,null);
});

test('官网完整同名椒盐鸡排按一份补充，不外推其他风味或改配',()=>{
  const cutlet=matchNutrition('那么大鸡排（椒盐风味）',[]);
  assert.deepEqual(keys.map(key=>cutlet[key]),[385,24,21,24,996,13]);
  assert.equal(cutlet.nutritionMatch,'official-page');
  assert.match(cutlet.sourceUrl,/Big-Chicken-Cutlet$/);
  for(const name of ['那么大鸡排','那么大鸡排（香辣风味）','那么大鸡排（椒盐风味）加酱'])assert.equal(matchNutrition(name,[]).kcal,null);
});

test('当前MCP字段优先，官网只补未知项并保留真实零值与差异说明',()=>{
  const name='那么大鸡排（椒盐风味）';
  const result=matchNutrition(name,[{productName:name,energyKcal:0,protein:24,fat:21,carbohydrate:24,sodium:996,calcium:null}]);
  assert.equal(result.kcal,0);assert.equal(result.calcium,13);
  assert.equal(result.nutritionSource,'official-mcp-and-product-page');
  assert.match(result.nutritionNote,/存在数值差异.*保留本次MCP值/);
  const mcp=matchNutrition('麦香鸡',[{productName:'麦香鸡',energyKj:1546,energyKcal:369}]);
  assert.equal(mcp.kcal,369);
});

test('同名MCP记录存在冲突时不以官网补充掩盖歧义',()=>{
  const name='那么大鸡排（椒盐风味）';
  const result=matchNutrition(name,[{productName:name,energyKcal:385},{productName:name,energyKcal:400}]);
  assert.equal(result.nutritionMatch,'ambiguous');assert.ok(keys.every(key=>result[key]===null));
});

test('60g苹果片、鱼排堡和原味双鳕保留未知及官网核查原因',()=>{
  for(const [code,name] of [['6102','苹果片一袋(60g)'],['504642','鱼排堡'],['520312','原味双层深海鳕鱼堡']]){
    const food=matchNutrition(name,[],{code});assert.equal(food.kcal,null);assert.match(food.nutritionNote,/官网已核查/);
  }
  assert.equal(officialSupplements.length,2);assert.equal(officialGaps.length,32);
});

test('公开来源链接只接受官方HTTPS并转义说明，不插入外部任意脚本',()=>{
  assert.equal(officialSourceLink('javascript:alert(1)'), '');
  assert.equal(officialSourceLink('https://unrelated.example'), '');
  const html=nutritionSourceHtml({nutritionName:'<img>',nutritionSource:'official-product-page',sourceUrl:'https://www.mcdonalds.com.cn/product/Drink-11'});
  assert.ok(html.includes('&lt;img&gt;'));assert.match(html,/官网产品营养表/);assert.match(html,/rel="noopener noreferrer"/);
});
