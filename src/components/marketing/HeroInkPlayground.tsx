import React, { useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { ArrowRight, Download, X } from 'lucide-react';
import { PANVAS_RELEASE } from './releaseMetadata';
type Tool = 'pen' | 'pencil' | 'eraser';
type Mark = { points: [number, number][]; color: string; tool: Tool };
const colors = [['Violet','#8b5cf6',377],['Green','#22c55e',388],['Blue','#0ea5e9',398],['Ink','#18181b',409],['Orange','#f59e0b',420]] as const;
const region = (x:number,y:number,w:number,h:number):React.CSSProperties => ({left:x/1024*100+'%',top:y/517*100+'%',width:w/1024*100+'%',height:h/517*100+'%'});

/** The capture remains the UI. Only safe ink actions are live; deeper controls open Panvas. */
export function HeroInkPlayground({children,onOpenWorkspace}:{children:React.ReactNode;onOpenWorkspace:()=>void}) {
  const [tool,setTool]=useState<Tool>('pen');
  const [color,setColor]=useState<string>(colors[0][1]);
  const [marks,setMarks]=useState<Mark[]>([]);
  const [open,setOpen]=useState(false);
  const viewport=useRef<HTMLDivElement>(null);
  const canvas=useRef<HTMLCanvasElement>(null);
  const drawing=useRef<{mark:Mark;pointer:number;bounds:DOMRect}|null>(null);
  useEffect(()=>{if(viewport.current&&matchMedia('(max-width:760px)').matches)viewport.current.scrollLeft=150;},[]);
  function paint(ctx:CanvasRenderingContext2D,mark:Mark,from=0) {
    ctx.save();ctx.globalCompositeOperation=mark.tool==='eraser'?'destination-out':'source-over';
    ctx.strokeStyle=mark.color;ctx.fillStyle=mark.color;ctx.lineWidth=mark.tool==='eraser'?36:mark.tool==='pencil'?2:3.5;
    ctx.globalAlpha=mark.tool==='pencil'?.7:1;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
    const points=mark.points;
    if(points.length===1){ctx.arc(points[0][0],points[0][1],ctx.lineWidth/2,0,Math.PI*2);ctx.fill();}
    else{ctx.moveTo(...points[from]);for(let i=from+1;i<points.length;i++)ctx.lineTo(...points[i]);ctx.stroke();}
    ctx.restore();
  }
  useEffect(()=>{
    let cancelled=false;
    const redraw=()=>{const ctx=canvas.current?.getContext('2d');if(!ctx||cancelled)return;
      ctx.clearRect(0,0,1000,600);
      ctx.save();ctx.font='68px "Panvas Hand", cursive';ctx.textBaseline='middle';
      for(const [text,color,x,y,angle] of [['Panvas','#1c1917',230,160,-.05],['Welcomes','#42b957',335,265,.025],['You','#cf49c7',480,380,-.035]] as const){
        ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.fillStyle=color;ctx.fillText(text,0,0);ctx.restore();
      }
      ctx.restore();marks.forEach(mark=>paint(ctx,mark));
    };
    void document.fonts.load('68px "Panvas Hand"').then(redraw);redraw();
    return ()=>{cancelled=true;};
  },[marks]);
  function finish(event:React.PointerEvent<HTMLCanvasElement>){
    if(!drawing.current||drawing.current.pointer!==event.pointerId)return;
    const mark=drawing.current.mark;drawing.current=null;setMarks(previous=>[...previous,mark].slice(-200));
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <div className="pl-live-notebook" ref={viewport}>
      <Popover.Trigger className="pl-restored-app-header" aria-label="Open Panvas workspace navigation">
        <span><b>Panvas</b><i>/</i> My Workspace <i>/</i> Notebook <i>/</i> Topic1 <i>/</i> page1</span>
        <span className="pl-header-search">Search Panvas <small>Ctrl K</small></span><span>Local only</span>
      </Popover.Trigger>
      <div className="pl-live-capture">
      {children}
      <Popover.Trigger className="pl-chrome-hit" aria-label="Explore the full Panvas workspace" title="Continue in Panvas"/>
      <div className="pl-live-paper is-grid"><canvas ref={canvas} width={1000} height={600} aria-label="Panvas sample page. Draw with a mouse, finger or pen. Sketches are temporary." data-tool={tool}
        onPointerDown={event=>{
          if(!event.isPrimary||event.button!==0||drawing.current)return;
          const bounds=event.currentTarget.getBoundingClientRect();
          const mark:Mark={points:[[(event.clientX-bounds.left)/bounds.width*1000,(event.clientY-bounds.top)/bounds.height*600]],color,tool};
          drawing.current={mark,pointer:event.pointerId,bounds};event.currentTarget.setPointerCapture(event.pointerId);
          const ctx=event.currentTarget.getContext('2d');if(ctx)paint(ctx,mark);
        }}
        onPointerMove={event=>{
          const current=drawing.current;if(!current||current.pointer!==event.pointerId||current.mark.points.length>=4000)return;
          const start=current.mark.points.length-1;
          const samples=event.nativeEvent.getCoalescedEvents?.()||[event.nativeEvent];
          for(const sample of samples.length?samples:[event.nativeEvent])current.mark.points.push([(sample.clientX-current.bounds.left)/current.bounds.width*1000,(sample.clientY-current.bounds.top)/current.bounds.height*600]);
          const ctx=event.currentTarget.getContext('2d');if(ctx)paint(ctx,current.mark,start);
        }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}/></div>
      <div role="toolbar" aria-label="Panvas drawing toolbar">
        {([['Pencil','pencil',356],['Pen','pen',380],['Eraser','eraser',451]] as const).map(([label,value,x])=><button key={value} type="button" className="pl-control-hit" style={region(x,25,23,29)} title={label} aria-label={label} aria-pressed={tool===value} onClick={()=>setTool(value)}/>)}
        {colors.map(([label,value,x])=><button key={label} type="button" className="pl-color-hit" style={region(x-5,62,10,15)} title={label} aria-label={label+' pen'} aria-pressed={color===value} onClick={()=>{setColor(value);if(tool==='eraser')setTool('pen');}}/>)}
      </div>
      {[
        ['Undo in Panvas',272,25,24,29],['Redo in Panvas',296,25,23,29],['Handwriting options',325,25,24,29],
        ['Pen settings',404,25,23,29],['Highlighter options',428,25,23,29],['Text tool',475,25,23,29],
        ['Selection tool',499,25,28,29],['More tools',532,25,30,29],['Collapse toolbar',562,25,27,29],
        ['Custom ink color',427,62,14,15],['Ink thickness',441,60,46,19],
        ['Notebook and pages',6,83,135,94],['Library',6,52,135,25],['Search Panvas',397,0,231,15],
        ['Page settings',876,21,140,391],['Local elements',700,23,26,29],['Canvas tools',726,23,24,29],
        ['Voice notes',750,23,22,29],['Export options',772,23,20,29],['Workspace layout',792,23,72,29]
      ].map(([label,x,y,w,h])=><Popover.Trigger key={label} className="pl-control-hit pl-app-hit" style={region(Number(x),Number(y),Number(w),Number(h))} aria-label={String(label)} title={String(label)}/>)}
    </div></div>
    <Popover.Portal><Popover.Positioner className="pl-continue-positioner" side="bottom" sideOffset={10} collisionPadding={16}>
      <Popover.Popup className="pl-continue-popup">
        <Popover.Close className="pl-continue-close" aria-label="Close Continue in Panvas"><X size={16}/></Popover.Close>
        <span className="pl-continue-kicker">YOUR NEXT PAGE</span>
        <Popover.Title className="pl-continue-title">Continue in Panvas</Popover.Title>
        <Popover.Description className="pl-continue-description">Open the full workspace for notebooks, page settings and more. This page is a temporary ink sample.</Popover.Description>
        <a href={PANVAS_RELEASE.windows.downloadUrl} target="_blank" rel="noreferrer" className="pl-continue-download"><Download size={15}/>Download for Windows</a>
        <button type="button" className="pl-continue-browser" onClick={()=>{setOpen(false);onOpenWorkspace();}}>Open in browser <ArrowRight size={15}/></button>
        <small>Windows pre-release · Browser development build</small>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
