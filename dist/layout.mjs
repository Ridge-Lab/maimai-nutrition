/** Keep fixed UI out of the document's scrollable/focusable content. */
export function setupLayout({document:doc=globalThis.document,window:win=globalThis.window}={}) {
  if(!doc?.documentElement?.style||!win)return {refresh(){},destroy(){}};
  const root=doc.documentElement,dock=doc.querySelector('#selection-dock'),dialog=doc.querySelector('#app-dialog');
  let action=null,frame=null,destroyed=false;
  const write=(element,name,value)=>{const text=Math.ceil(Math.max(0,value))+'px';if(element?.style?.getPropertyValue(name)!==text)element?.style?.setProperty(name,text);};
  function refresh(){
    if(destroyed)return;
    const viewport=win.visualViewport;
    const editing=doc.activeElement?.matches?.('input:not([type=radio]):not([type=checkbox]),textarea,select')===true;
    const keyboard=editing&&viewport?.height>0&&viewport.height<win.innerHeight*.75;
    root.toggleAttribute('data-keyboard-open',keyboard);
    const box=!dock?.hidden?dock?.getBoundingClientRect?.():null;
    write(root,'--dock-space',box?.height>0?win.innerHeight-box.top+12:0);
    const next=dialog?.querySelector?.('.configuration-apply-actions')||null;
    if(next!==action){if(action)observer?.unobserve(action);action=next;if(action)observer?.observe(action);}
    const sticky=action&&dialog?.open&&win.getComputedStyle(action).position==='sticky';
    write(dialog,'--dialog-action-space',sticky?action.getBoundingClientRect().height+16:0);
  }
  function schedule(){
    if(destroyed||frame!==null)return;
    frame=win.requestAnimationFrame(()=>{frame=null;refresh();});
  }
  const observer=win.ResizeObserver?new win.ResizeObserver(schedule):null;
  if(dock)observer?.observe(dock);
  const mutations=win.MutationObserver?new win.MutationObserver(schedule):null;
  if(dialog)mutations?.observe(dialog,{childList:true,subtree:true,attributes:true,attributeFilter:['open','hidden']});
  win.addEventListener('resize',schedule,{passive:true});
  win.visualViewport?.addEventListener('resize',schedule,{passive:true});
  doc.addEventListener('focusin',schedule);doc.addEventListener('focusout',schedule);
  refresh();
  return {refresh,destroy(){destroyed=true;observer?.disconnect();mutations?.disconnect();if(frame!==null)win.cancelAnimationFrame(frame);win.removeEventListener('resize',schedule);win.visualViewport?.removeEventListener('resize',schedule);doc.removeEventListener('focusin',schedule);doc.removeEventListener('focusout',schedule);}};
}
