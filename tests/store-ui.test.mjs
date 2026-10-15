import test from 'node:test';
import assert from 'node:assert/strict';
import {setupStoreUI} from '../dist/store-ui.mjs';

function fixture(t) {
  const original=globalThis.document,nodes=new Map();
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{disabled:false,textContent:'',listeners:new Map(),addEventListener(name,handler){this.listeners.set(name,handler);}});
    return nodes.get(selector);
  };
  globalThis.document={querySelector:node,addEventListener(){}};
  t.after(()=>{globalThis.document=original;});
  let connected=true,context={store:{code:'1450713'},items:[{food:{productCode:'1440',isMeal:false},qty:2}]};
  const messages=[],quotes=[],calls=[];let showConnectionCount=0;
  let apiHandler=async()=>({price:4500});
  setupStoreUI({api:async(...args)=>{calls.push(args);return apiHandler(...args);},openDialog(){},closeDialog(){},toast:text=>messages.push(text),
    getConnected:()=>connected,showConnection:()=>showConnectionCount++,getMeal:()=>context,onQuote:quote=>quotes.push(quote)});
  return {node,messages,quotes,calls,click:()=>node('#quote-meal').listeners.get('click')(),
    setConnected:value=>connected=value,setContext:value=>context=value,setApi:handler=>apiHandler=handler,get showConnectionCount(){return showConnectionCount;}};
}

test('官方核价授权失效后按钮保持禁用，再点击会要求重新连接',async t=>{
  const f=fixture(t);
  f.setApi(async()=>{f.setConnected(false);f.node('#quote-meal').disabled=true;throw new Error('MCP 授权已失效，请重新连接');});
  await f.click();
  assert.equal(f.node('#quote-meal').disabled,true);
  assert.equal(f.quotes.length,0);
  assert.match(f.messages[0],/授权已失效/);
  await f.click();
  assert.equal(f.showConnectionCount,1);
  assert.equal(f.calls.length,1);
});

test('缺少官方餐品编码时不发核价请求，进行中变成无编码餐单也保持禁用',async t=>{
  const f=fixture(t),invalid={store:{code:'1450713'},items:[{food:{name:'参考餐品'},qty:1}]};
  f.setContext(invalid);
  await f.click();
  assert.equal(f.calls.length,0);
  assert.match(f.messages[0],/缺少官方餐品编码/);
  f.setContext({store:{code:'1450713'},items:[{food:{productCode:'1440'},qty:2}]});
  f.setApi(async()=>{f.setContext(invalid);return {price:4500};});
  await f.click();
  assert.equal(f.node('#quote-meal').disabled,true);
  assert.equal(f.quotes.length,0);
  assert.match(f.messages.at(-1),/餐单已变化/);
});

test('已连接有效餐单核价保留官方金额和份数，成功后允许再次核验',async t=>{
  const f=fixture(t);
  await f.click();
  assert.equal(f.quotes[0].amount,45);
  assert.equal(f.node('#quote-meal').disabled,false);
  assert.deepEqual(f.calls[0],[ '/api/tool',{name:'calculate-price',arguments:{storeCode:'1450713',orderType:1,beType:1,items:[{productCode:'1440',quantity:2}]}}]);
});
