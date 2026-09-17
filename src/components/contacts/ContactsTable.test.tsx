import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact, Conversation } from "@/types/database";

const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  stateCursor: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: () => undefined,
    useMemo: <T,>(factory: () => T) => factory(),
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = harness.stateCursor;
      harness.stateCursor += 1;
      if (!Object.prototype.hasOwnProperty.call(harness.state, index)) {
        harness.state[index] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      const setValue = (nextValue: T | ((current: T) => T)) => {
        const current = harness.state[index] as T;
        harness.state[index] =
          typeof nextValue === "function"
            ? (nextValue as (value: T) => T)(current)
            : nextValue;
      };
      return [harness.state[index] as T, setValue] as const;
    },
  };
});

vi.mock("./ContactDetail", () => ({
  default: () => <div>Contact detail</div>,
}));

import ContactsTable from "./ContactsTable";

type ContactRow = Contact & {
  conversation_count: number;
};

interface ElementProps {
  children?: ReactNode;
  [key: string]: unknown;
}

type TestElement = ReactElement<ElementProps>;

function contact(
  name: string,
  overrides: Partial<ContactRow> = {}
): ContactRow {
  return {
    id: `contact-${name.toLowerCase().replaceAll(" ", "-")}`,
    business_id: "business-1",
    name,
    phone_number: null,
    email: null,
    session_id: null,
    source_channel: "web_chat",
    lead_score: 0,
    lead_status: "normal",
    lead_status_updated_at: "2026-08-01T12:00:00.000Z",
    notes: null,
    created_at: "2026-08-01T12:00:00.000Z",
    last_contacted_at: "2026-08-01T12:00:00.000Z",
    conversation_count: 0,
    ...overrides,
  };
}

function renderTable(contacts: ContactRow[]): TestElement {
  harness.stateCursor = 0;
  return ContactsTable({
    contacts,
    conversations: [] as Conversation[],
  }) as TestElement;
}

function childElements(node: ReactNode): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(childElements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...childElements(node.props.children)];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement<ElementProps>(node)) return "";
  return textContent(node.props.children);
}

function invoke(element: TestElement, prop: string, argument?: unknown): unknown {
  const handler = element.props[prop];
  if (typeof handler !== "function") throw new Error(`Missing ${prop}`);
  return handler(argument);
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.state = [];
  harness.stateCursor = 0;
});

describe("ContactsTable canonical lead statuses", () => {
  it("opens only an existing contact when reached from a call or lead", () => {
    const selected = contact("Selected");
    const tree = ContactsTable({ contacts: [selected], conversations: [], initialSelectedId: selected.id });
    expect(renderToStaticMarkup(tree)).toContain("Contact detail");
    harness.state = []; harness.stateCursor = 0;
    expect(renderToStaticMarkup(ContactsTable({ contacts: [selected], conversations: [], initialSelectedId: "foreign-contact" }))).not.toContain("Contact detail");
  });
  it("filters hot leads by lead_status even when historical scores disagree", () => {
    const rows = [
      contact("Numeric Threshold Only", {
        lead_score: 9,
        lead_status: "normal",
      }),
      contact("Canonical Hot", {
        lead_score: 0,
        lead_status: "hot",
      }),
    ];

    let tree = renderTable(rows);
    const hotFilter = childElements(tree).find(
      (element) =>
        element.type === "button" && textContent(element) === "Hot Leads"
    );
    expect(hotFilter).toBeDefined();

    invoke(hotFilter!, "onClick");
    tree = renderTable(rows);
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Canonical Hot");
    expect(html).not.toContain("Numeric Threshold Only");
  });

  it("sorts Hot before Warm before Normal and uses status time as the tie-break", () => {
    const rows = [
      contact("Normal Lead", {
        lead_status: "normal",
        lead_status_updated_at: "2026-08-11T12:00:00.000Z",
      }),
      contact("Older Hot", {
        lead_status: "hot",
        lead_status_updated_at: "2026-08-09T12:00:00.000Z",
      }),
      contact("Warm Lead", {
        lead_status: "warm",
        lead_status_updated_at: "2026-08-11T12:00:00.000Z",
      }),
      contact("Newer Hot", {
        lead_status: "hot",
        lead_status_updated_at: "2026-08-10T12:00:00.000Z",
      }),
    ];

    let tree = renderTable(rows);
    const sort = childElements(tree).find((element) => element.type === "select");
    expect(sort).toBeDefined();

    invoke(sort!, "onChange", { target: { value: "status" } });
    tree = renderTable(rows);
    const html = renderToStaticMarkup(tree);

    expect(html.indexOf("Newer Hot")).toBeLessThan(html.indexOf("Older Hot"));
    expect(html.indexOf("Older Hot")).toBeLessThan(html.indexOf("Warm Lead"));
    expect(html.indexOf("Warm Lead")).toBeLessThan(html.indexOf("Normal Lead"));
  });

  it("renders exact status labels without score numbers or Cold terminology", () => {
    const html = renderToStaticMarkup(
      renderTable([
        contact("Normal Lead", {
          lead_score: 987654,
          lead_status: "normal",
        }),
        contact("Warm Lead", { lead_score: 876543, lead_status: "warm" }),
        contact("Hot Lead", { lead_score: 765432, lead_status: "hot" }),
      ])
    );

    expect(html).toContain("Lead status");
    expect(html).toContain("Normal");
    expect(html).toContain("Warm");
    expect(html).toContain("Hot");
    expect(html).not.toContain("Lead Score");
    expect(html).not.toContain("Highest Score");
    expect(html).not.toContain("Cold");
    expect(html).not.toMatch(/987654|876543|765432/);
  });
});
