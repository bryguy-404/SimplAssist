import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as Array<{ current: unknown }>, cursor: 0, refCursor: 0 }));
vi.mock("react", async original => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = harness.cursor++;
    if (!(i in harness.states)) harness.states[i] = initial;
    return [harness.states[i], (next: unknown) => { harness.states[i] = next; }];
  },
  useRef: (initial: unknown) => {
    const i = harness.refCursor++;
    return harness.refs[i] ?? (harness.refs[i] = { current: initial });
  },
}));
import { requestSharedRegistration, SharedRegistrationForm } from "./SharedRegistrationForm";

const accounts = {
  sourceBusinessId: "10000000-0000-4000-8000-000000000001",
  targetBusinessId: "20000000-0000-4000-8000-000000000001",
  sourceOwnerId: "30000000-0000-4000-8000-000000000001",
  targetOwnerId: "40000000-0000-4000-8000-000000000001",
};
const inspection = {
  sourceBusinessId: accounts.sourceBusinessId, targetBusinessId: accounts.targetBusinessId,
  targetBusinessName: "Pilot Business", legalBusinessName: "Example LLC", tcrBrandId: "BEXAMPLE",
  campaignCount: 2, verifiedAt: "2026-10-05T12:00:00.000Z", membershipRevision: 0, canApprove: true,
};
const fetcher = vi.fn();
function render() {
  harness.cursor = 0; harness.refCursor = 0;
  return SharedRegistrationForm({ accounts, targetBusinessName: "Pilot Business", membershipStatus: null });
}
type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return;
  if (predicate(node)) return node;
  return find(node.props.children as ReactNode, predicate);
}
function button(label: string) {
  return find(render(), element => element.type === "button" && element.props.children === label);
}
async function click(label: string) {
  const item = button(label);
  expect(item).toBeDefined();
  expect(item!.props.disabled).toBe(false);
  (item!.props.onClick as () => void)();
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
function confirm() {
  const input = find(render(), element => element.type === "input");
  expect(input!.props.disabled).toBe(false);
  (input!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
}
const ok = (value = inspection) => ({ ok: true, json: async () => ({ inspection: value }) });
beforeEach(() => {
  harness.states = []; harness.refs = []; harness.cursor = 0; harness.refCursor = 0;
  fetcher.mockReset().mockResolvedValue(ok());
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("private shared-registration administrative controls", () => {
  it("renders without inspecting, creating memberships, or offering unchecked approval", () => {
    const html = renderToStaticMarkup(render());
    expect(fetcher).not.toHaveBeenCalled();
    expect(html).toContain("Inspection changes nothing");
    expect(html).not.toContain("Approve shared registration</button>");
    expect(html).not.toContain(accounts.targetOwnerId);
  });

  it("inspects read-only, then submits only exact account identifiers and the inspected revision", async () => {
    await click("Inspect shared registration");
    expect(fetcher.mock.calls[0]).toEqual([
      `/api/admin/shared-business-registrations?${new URLSearchParams(accounts)}`, { cache: "no-store" },
    ]);
    expect(button("Approve shared registration")!.props.disabled).toBe(true);
    confirm();
    fetcher.mockResolvedValueOnce(ok({ ...inspection, membershipRevision: 1 }));
    await click("Approve shared registration");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ ...accounts, action: "approve", expectedRevision: 0 });
    expect(renderToStaticMarkup(render())).toContain("Shared registration approved");
    expect(button("Approve shared registration")).toBeUndefined();
  });

  it("blocks a rapid second approval while the first result is pending", async () => {
    await click("Inspect shared registration"); confirm();
    fetcher.mockImplementationOnce(() => new Promise(() => {}));
    const onClick = button("Approve shared registration")!.props.onClick as () => void;
    onClick(); onClick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(button("Approving…")!.props.disabled).toBe(true);
  });

  it("clears an uncertain approval and requires inspection instead of repeating the mutation", async () => {
    await click("Inspect shared registration"); confirm();
    fetcher.mockRejectedValueOnce(new Error("Connection lost"));
    await click("Approve shared registration");
    expect(button("Approve shared registration")).toBeUndefined();
    fetcher.mockResolvedValueOnce(ok({ ...inspection, membershipRevision: 1 }));
    await click("Inspect shared registration");
    expect(renderToStaticMarkup(render())).toContain("A membership already exists");
    expect(button("Approve shared registration")).toBeUndefined();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not enable approval when admission is disabled or capacity is full", async () => {
    fetcher.mockResolvedValueOnce(ok({ ...inspection, canApprove: false, campaignCount: 5 }));
    await click("Inspect shared registration");
    expect(button("Approve shared registration")!.props.disabled).toBe(true);
    expect(find(render(), element => element.type === "input")!.props.disabled).toBe(true);
  });

  it("rejects inspection belonging to another account", async () => {
    fetcher.mockResolvedValueOnce(ok({ ...inspection, targetBusinessId: accounts.sourceBusinessId }));
    await click("Inspect shared registration");
    expect(button("Approve shared registration")).toBeUndefined();
    expect(renderToStaticMarkup(render())).toContain("registration could not be confirmed");
  });

  it("does not forward actor or provider identity fields from a caller", async () => {
    fetcher.mockResolvedValueOnce(ok({ ...inspection, membershipRevision: 1 }));
    await requestSharedRegistration({ ...accounts, actorId: "forged", ein: "private" } as typeof accounts,
      { action: "approve", expectedRevision: 0 }, fetcher as typeof fetch);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ ...accounts, action: "approve", expectedRevision: 0 });
  });

  it("does not claim approval from a response that leaves the inspected revision unchanged", async () => {
    await click("Inspect shared registration"); confirm();
    await click("Approve shared registration");
    expect(renderToStaticMarkup(render())).not.toContain("Shared registration approved");
    expect(button("Approve shared registration")).toBeUndefined();
  });
});
