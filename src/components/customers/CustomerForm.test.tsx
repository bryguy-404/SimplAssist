import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import type { CustomerRecord } from "@/lib/customers/types";
const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "customer-form",
  useState: <T,>(initial: T) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [
      harness.states[index],
      (next: T) => {
        harness.states[index] = next;
      },
    ];
  },
}));
import CustomerForm from "./CustomerForm";
beforeEach(() => {
  harness.states = [];
  harness.cursor = 0;
});
afterEach(() => vi.unstubAllGlobals());
function values(input: Record<string, string>) {
  vi.stubGlobal(
    "FormData",
    class {
      get(key: string) {
        return input[key] || null;
      }
    },
  );
}
describe("customer editing", () => {
  it("edits a captured phone without rendering the chat session key as a phone", () => {
    const customer = {
      source_channel: "web_chat",
      phone_number: "session_private",
      provided_phone_number: "+15745550123",
      tags: [],
      customer_stage: "lead",
    } as unknown as CustomerRecord;
    const html = renderToStaticMarkup(
      CustomerForm({ customer, onSave: vi.fn(), onCancel: vi.fn() }),
    );
    expect(html).toContain('name="phone_number"');
    expect(html).toContain('value="+15745550123"');
    expect(html).not.toContain("session_private");
  });
  it("preserves the distinction between relationship, owner interest, and automatic classification", async () => {
    values({
      name: "  Ada  ",
      customer_stage: "customer",
      owner_warmth_override: "",
      tags: "Repeat, Website, Repeat",
      is_priority: "on",
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const form = CustomerForm({ onSave, onCancel: vi.fn() });
    await form.props.onSubmit({
      preventDefault: vi.fn(),
      currentTarget: {},
    } as unknown as FormEvent<HTMLFormElement>);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Ada",
        customer_stage: "customer",
        owner_warmth_override: null,
        is_priority: true,
        tags: ["Repeat", "Website"],
        next_follow_up_at: null,
      }),
    );
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("lead_status");
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("source_channel");
  });
  it("keeps the form open and reports a rejected save without presenting success", async () => {
    values({ name: "Ada", customer_stage: "lead" });
    const onSave = vi
      .fn()
      .mockRejectedValue(new Error("This phone belongs to another customer."));
    const onCancel = vi.fn();
    const onBusyChange = vi.fn();
    await CustomerForm({ onSave, onCancel, onBusyChange }).props.onSubmit({
      preventDefault: vi.fn(),
      currentTarget: {},
    } as unknown as FormEvent<HTMLFormElement>);
    harness.cursor = 0;
    const html = renderToStaticMarkup(CustomerForm({ onSave, onCancel }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("This phone belongs to another customer.");
    expect(onCancel).not.toHaveBeenCalled();
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
});
