import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { CustomerImportPreview } from "@/lib/customers/types";
const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "import-dialog",
  useState: <T,>(initial: T) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [
      harness.states[index],
      (next: T | ((value: unknown) => T)) => {
        harness.states[index] =
          typeof next === "function"
            ? (next as (value: unknown) => T)(harness.states[index])
            : next;
      },
    ];
  },
}));
import CustomerImportDialog from "./CustomerImportDialog";
const preview: CustomerImportPreview = {
  previewToken: "frozen-preview-token",
  headers: ["Customer", "Email"],
  mapping: { name: "Customer", email: "Email" },
  rows: [
    {
      rowNumber: 2,
      action: "create",
      errors: [],
      values: { name: "Ada", email: "ada@example.com" },
    },
  ],
  summary: { create: 1, fill_blanks: 0, skip: 0, conflict: 0, total: 1 },
};
const props = { onClose: vi.fn(), onImported: vi.fn() };
function render() {
  harness.cursor = 0;
  return CustomerImportDialog(props);
}
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement;
  return [element, ...elements(element.props.children)];
}
function label(node: ReactNode): string {
  return Array.isArray(node)
    ? node.map(label).join("")
    : typeof node === "string"
      ? node
      : node && typeof node === "object" && "props" in node
        ? label((node as ReactElement).props.children)
        : "";
}
function importButton() {
  return elements(render()).find(
    (element) =>
      element.type === "button" && label(element) === "Import customers",
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.states = [
    "Customer,Email\nAda,ada@example.com",
    "customers.csv",
    preview.mapping,
    preview,
    null,
    false,
    0,
    false,
    null,
  ];
  harness.cursor = 0;
});
afterEach(() => vi.unstubAllGlobals());
describe("customer import safety", () => {
  it("blocks a stale preview after the owner changes column mapping", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const nameMapping = elements(render()).find(
      (element) =>
        element.type === "select" && element.props.id === "import-dialog-name",
    )!;
    nameMapping.props.onChange({ target: { value: "Email" } });
    expect(importButton()?.props.disabled).toBe(true);
    await importButton()?.props.onClick();
    expect(fetch).not.toHaveBeenCalled();
    expect(props.onImported).not.toHaveBeenCalled();
  });
  it("retries an ambiguous commit with the same frozen token, never the raw CSV", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(
        Response.json({
          importId: "import-id",
          created: 1,
          updated: 0,
          skipped: 0,
          conflicts: 0,
          rows: [],
        }),
      );
    vi.stubGlobal("fetch", fetch);
    await importButton()?.props.onClick();
    expect(props.onImported).not.toHaveBeenCalled();
    expect(label(render())).toContain("Connection interrupted");
    await importButton()?.props.onClick();
    expect(
      fetch.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]),
    ).toEqual([
      [
        "/api/customers/import/commit",
        { previewToken: "frozen-preview-token" },
      ],
      [
        "/api/customers/import/commit",
        { previewToken: "frozen-preview-token" },
      ],
    ]);
    expect(props.onImported).toHaveBeenCalledOnce();
    expect(label(render())).toContain("Your customer list is updated.");
  });
  it("removes the previous commit when a replacement file exceeds the import limit", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const text = vi.fn();
    const fileInput = elements(render()).find(
      (element) => element.type === "input" && element.props.type === "file",
    )!;
    fileInput.props.onChange({
      currentTarget: { files: [{ size: 5 * 1024 * 1024 + 1, text }] },
    });
    expect(importButton()).toBeUndefined();
    expect(label(render())).toContain("Choose a CSV smaller than 5 MB");
    expect(text).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
