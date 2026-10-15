/** Resolve everything first. A failed item must never replace part of the current meal. */
export async function restoreFavorite(recipe,{loadStore,resolveFood,resolveReferenceFood,referenceFoods}) {
  if(!recipe?.items?.length) throw new Error('保存的组合为空或无效');
  let context=null;
  if(recipe.mode==='store') context=await loadStore(recipe.store,{fresh:true});
  const catalog=context?.foods||referenceFoods;
  const items=[];const lockedIds=[];const resolved=[];
  for(const item of recipe.items){
    const base=catalog.find(food=>recipe.mode==='store' ? String(food.productCode)===item.productCode && !food.resolvedRecipe : food.id===item.demoId);
    if(!base)throw new Error(`“${item.name}”已不在当前目录，未恢复任何餐品。请重新选择。`);
    let food=base;
    if(recipe.mode==='demo'&&base.demoMeal){
      if(typeof resolveReferenceFood!=='function')throw new Error('示例套餐需要重新确认搭配');
      food=await resolveReferenceFood(base,item.selections,{strict:true});resolved.push(food);
    }else if(recipe.mode==='store') {
      try {food=await resolveFood(base,item.selections,{store:context.store,nutrition:context.nutritionRecords,fresh:true,strict:true});}
      catch(error){throw new Error(`“${item.name}”无法恢复：${error.message}。当前餐单未改变。`);}
      resolved.push(food);
    }
    items.push({food,qty:item.qty}); if(item.locked)lockedIds.push(food.id);
  }
  return {context,items,lockedIds,resolved};
}
