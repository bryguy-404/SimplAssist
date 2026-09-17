import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact, Conversation } from "@/types/database";
const harness = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, from: vi.fn(), remove: vi.fn(), select: vi.fn(), deleted: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: <T,>(initial: T) => {
    const index = harness.cursor++;
    if (!(index in harness.state)) harness.state[index] = initial;
    return [harness.state[index], (value: T) => { harness.state[index] = value; }];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createBrowserClient: () => ({ from: harness.from }) }));
import ContactDetail from "./ContactDetail";
type Element = ReactElement<{ children?: ReactNode; onClick?: () => unknown }>;
const contact = { id: "contact", name: "Caller", business_id: "business", source_channel: "sms", lead_status: "normal", created_at: "2026-09-17", last_contacted_at: "2026-09-17" } as Contact;
function render(conversations: Conversation[] = []) {
  harness.cursor = 0;
  return ContactDetail({ contact, conversations, onClose: vi.fn(), onUpdated: vi.fn(), onDeleted: harness.deleted });
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as Element, ...elements(node.props.children)];
}
function button(tree: ReactNode, label: string) {
  return elements(tree).find((element) => element.type === "button" && renderToStaticMarkup(element).includes(label))!;
}
beforeEach(() => {
  vi.clearAllMocks(); harness.state = []; harness.cursor = 0;
  harness.from.mockReturnValue({ delete: harness.remove });
  harness.remove.mockReturnValue({ eq: vi.fn(() => ({ select: harness.select })) });
  harness.select.mockResolvedValue({ data: [{ id: "contact" }], error: null });
});
describe("contact deletion with call history", () => {
  it("keeps deletion unavailable for linked voice history", () => {
    const html = renderToStaticMarkup(render([{ id: "voice", channel: "voice", contact_id: "contact", started_at: "2026-09-17", last_message_at: "2026-09-17" } as Conversation]));
    expect(html).toContain("Contacts with voice call history cannot be deleted here.");
    expect(html).not.toContain("Delete Contact"); expect(harness.from).not.toHaveBeenCalled();
  });
  it.each([{ data: null, error: { message: "protected history" } }, { data: [], error: null }])("keeps the contact visible after a rejected or unconfirmed delete", async (result) => {
    harness.select.mockResolvedValue(result);
    button(render(), "Delete Contact").props.onClick!();
    await button(render(), "Confirm").props.onClick!();
    expect(harness.deleted).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(render())).toContain("The contact could not be deleted.");
  });
  it("handles transport failure without hiding the contact", async () => {
    harness.select.mockRejectedValue(new Error("network"));
    button(render(), "Delete Contact").props.onClick!();
    await button(render(), "Confirm").props.onClick!();
    expect(harness.deleted).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(render())).toContain('role="alert"');
  });
  it("removes an ordinary contact from the view only after a confirmed delete", async () => {
    button(render(), "Delete Contact").props.onClick!();
    await button(render(), "Confirm").props.onClick!();
    expect(harness.deleted).toHaveBeenCalledWith("contact");
  });
});
