import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const harness=vi.hoisted(()=>({states:[] as unknown[],cursor:0,effects:[] as (()=>void)[]}));
vi.mock("react",async(original)=>({...(await original<typeof import("react")>()),useState:<T,>(initial:T)=>{const index=harness.cursor++;if(!(index in harness.states))harness.states[index]=initial;return [harness.states[index],(value:T)=>{harness.states[index]=value;}];},useEffect:(effect:()=>void)=>harness.effects.push(effect)}));
vi.mock("next/dynamic",()=>({default:()=>({active}:{active?:boolean})=><div data-sms-active={String(active)}/> }));
vi.mock("./ReviewSettingsForm",()=>({default:()=>null}));
vi.mock("./ReviewHistory",()=>({default:()=>null}));
import ReviewsWorkspace from "./ReviewsWorkspace";
function render(initialTab:"requests"|"settings"){
  harness.cursor=0;harness.effects=[];
  return renderToStaticMarkup(<ReviewsWorkspace ownerEmail="owner@example.test" smsEnabled initialTab={initialTab}/>);
}
beforeEach(()=>{
  harness.states=[false,{eligibility:{ready:true,enabled:true,paid:true,sendingEnabled:true},settings:{paused:false},usage:{used:0,allowance:500,remaining:500,periodEnd:"2026-11-01T00:00:00Z"}},{campaigns:[]},"requests",false,1,0,false];
});
describe("review section navigation",()=>{
  it("updates the selected tab on a same-route query change and enables the SMS anchor only when visible",()=>{
    expect(render("requests")).toContain('data-sms-active="false"');
    render("settings");harness.effects[0]();
    const settings=render("settings");expect(settings).toMatch(/aria-pressed="true"[^>]*>Settings<\/button>/);expect(settings).toContain('data-sms-active="true"');
    render("requests");harness.effects[0]();
    const requests=render("requests");expect(requests).toMatch(/aria-pressed="true"[^>]*>Requests<\/button>/);expect(requests).toContain('data-sms-active="false"');
  });
});
