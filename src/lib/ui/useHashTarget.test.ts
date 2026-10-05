import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const harness=vi.hoisted(()=>({effect:undefined as undefined|(()=>void|(()=>void)),ref:{current:null as HTMLElement|null}}));
vi.mock("react",()=>({useRef:()=>harness.ref,useEffect:(effect:()=>void|(()=>void))=>{harness.effect=effect;}}));
import { useHashTarget } from "./useHashTarget";
let frames:Map<number,FrameRequestCallback>,listeners:Map<string,()=>void>,hash:string,cleanup:void|(()=>void);
const scroll=vi.fn(),focus=vi.fn(),visible=vi.fn();
function Mount(enabled=true){useHashTarget("review-sms",enabled);cleanup=harness.effect!();}
function frame(){const pending=Array.from(frames.values());frames.clear();pending.forEach(callback=>callback(0));}
beforeEach(()=>{
  vi.clearAllMocks();frames=new Map();listeners=new Map();hash="#review-sms";cleanup=undefined;let next=0;
  harness.ref.current=null;visible.mockReturnValue([{}]);
  vi.stubGlobal("window",{location:{get hash(){return hash;}},requestAnimationFrame:(callback:FrameRequestCallback)=>{const id=++next;frames.set(id,callback);return id;},cancelAnimationFrame:(id:number)=>frames.delete(id),addEventListener:(name:string,fn:()=>void)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name)});
});
afterEach(()=>{if(cleanup)cleanup();vi.unstubAllGlobals();});
function target(){harness.ref.current={scrollIntoView:scroll,focus,getClientRects:visible} as unknown as HTMLElement;}
describe("asynchronously mounted hash targets",()=>{
  it("waits for the rendered target and moves both the viewport and keyboard focus",()=>{
    Mount();expect(scroll).not.toHaveBeenCalled();target();frame();
    expect(scroll).toHaveBeenCalledWith({block:"start",behavior:"auto"});expect(focus).toHaveBeenCalledWith({preventScroll:true});
  });
  it("does not steal focus without the matching fragment",()=>{
    hash="#different-section";target();Mount();frame();expect(scroll).not.toHaveBeenCalled();expect(focus).not.toHaveBeenCalled();
  });
  it("does not reveal a hidden settings tab",()=>{
    target();Mount(false);frame();expect(scroll).not.toHaveBeenCalled();expect(listeners.size).toBe(0);
  });
  it("responds when a visible panel receives a later matching hash",()=>{
    hash="";target();Mount();hash="#review-sms";listeners.get("hashchange")!();frame();expect(focus).toHaveBeenCalledOnce();
  });
  it("does not scroll after the user leaves the fragment before the scheduled frame",()=>{
    target();Mount();hash="#other";frame();expect(scroll).not.toHaveBeenCalled();
  });
  it("does not focus a target whose layout is still hidden",()=>{
    target();visible.mockReturnValue([]);Mount();frame();expect(focus).not.toHaveBeenCalled();
  });
  it("cancels pending movement and removes its event listener on unmount",()=>{
    target();Mount();if(cleanup)cleanup();cleanup=undefined;frame();expect(scroll).not.toHaveBeenCalled();expect(listeners.size).toBe(0);
  });
});
