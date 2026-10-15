import test from 'node:test';
import assert from 'node:assert/strict';
import {SAMPLE_STORE,sampleInfo,sampleMeals,sampleDetails,sampleNutrition} from '../dist/sample-menu.mjs';
import {parseMealDetail,buildMeal} from '../dist/meal-detail.mjs';
import {NUTRIENT_KEYS} from '../dist/engine.mjs';

// These counts describe this dated, bundled reference snapshot, never a live
// store's current availability. Refresh the date and expectations together.
const SNAPSHOT_DATE='2026-10-15';
const build=code=>buildMeal(parseMealDetail(sampleDetails[code],sampleNutrition));

test('2026-10-15公开参考快照明确标记离线来源，43种默认搭配均保留可构建参数',()=>{
  assert.equal(sampleInfo.checkedAt,SNAPSHOT_DATE);
  assert.match(sampleInfo.source,/官方MCP.*快照/);
  assert.match(sampleInfo.note,/非实时/);
  assert.equal(SAMPLE_STORE.demo,true);
  assert.equal(SAMPLE_STORE.code,'reference-demo');
  assert.equal(sampleMeals.length,43,`${SNAPSHOT_DATE} bundled snapshot only`);
  assert.equal(new Set(sampleMeals.map(food=>food.productCode)).size,sampleMeals.length);
  let complete=0,partial=0;
  for(const food of sampleMeals) {
    assert.equal(food.demoMeal,true);
    assert.equal(food.priceMode,'demo');
    assert.equal(food.storeCode,undefined);
    assert.equal(food.demoId,'sample-meal-'+food.productCode);
    assert.ok(sampleDetails[food.productCode],food.name+'缺少快照详情');
    const meal=build(food.productCode); // Every exception fails the audit.
    assert.equal(meal.selectionComplete,true,food.name);
    assert.equal(meal.quoteItem.productCode,food.productCode);
    for(const metric of NUTRIENT_KEYS) {
      assert.ok(meal[metric]===null||Number.isFinite(meal[metric])&&meal[metric]>=0,food.name+' '+metric);
      assert.ok(meal.missingComponents[metric].every(item=>item.name&&item.qty>0));
      if(meal[metric]===null)assert.ok(meal.missingComponents[metric].length>0);
    }
    meal.complete?complete++:partial++;
  }
  assert.deepEqual({complete,partial},{complete:25,partial:18},`${SNAPSHOT_DATE} snapshot coverage`);
});

test('2026-10-15快照典型套餐热量校验，四翅换算和多份默认组成不丢份数',()=>{
  for(const [code,kcal] of [['9900005456',921],['9900005451',884],['9900015730',975],['9900004066',1936]]) {
    const meal=build(code);
    assert.equal(meal.kcal,kcal,sampleDetails[code].name);
    assert.equal(meal.complete,true,sampleDetails[code].name);
  }
  const wings=build('9900005451').components.find(food=>food.name==='麦辣鸡翅4块');
  assert.equal(wings.kcal,448);
  assert.match(wings.nutritionNote,/2块.*2.*4 块/);
  const seven=build('9900004066');
  assert.deepEqual(seven.components.map(food=>[food.name,food.qty]),[['麦辣鸡腿汉堡',2],['麦辣鸡翅2块',3],['可乐中杯',2]]);
  assert.equal(seven.components.reduce((sum,food)=>sum+food.qty,0),7);
});
