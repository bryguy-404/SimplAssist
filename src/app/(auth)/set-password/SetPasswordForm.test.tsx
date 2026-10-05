import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  cursor: 0,
  state: [] as unknown[],
  values: { password: "new-password", confirmPassword: "new-password" },
}));

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: vi.fn(),
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = harness.cursor;
      harness.cursor += 1;
      if (!Object.prototype.hasOwnProperty.call(harness.state, index)) {
        harness.state[index] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      const setValue = (value: T | ((current: T) => T)) => {
        const current = harness.state[index] as T;
        harness.state[index] =
          typeof value === "function"
            ? (value as (current: T) => T)(current)
            : value;
      };
      return [harness.state[index] as T, setValue] as const;
    },
  };
});
vi.mock("react-hook-form", () => ({
  useForm: () => ({
    register: (name: string) => ({ name }),
    handleSubmit:
      (handler: (values: typeof harness.values) => Promise<void>) => () =>
        handler(harness.values),
    formState: { errors: {}, isSubmitting: false },
  }),
}));
vi.mock("@hookform/resolvers/zod", () => ({ zodResolver: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
}));

import SetPasswordForm from "./SetPasswordForm";

interface ElementProps {
  children?: ReactNode;
  onSubmit?: () => Promise<void>;
}

function renderForm(mode: "setup" | "reset"): ReactElement<ElementProps> {
  harness.cursor = 0;
  return SetPasswordForm({ mode }) as ReactElement<ElementProps>;
}

function findForm(node: ReactNode): ReactElement<ElementProps> {
  if (Array.isArray(node)) {
    for (const child of node) {
      try {
        return findForm(child);
      } catch {
        // Continue through siblings.
      }
    }
  }
  if (isValidElement<ElementProps>(node)) {
    if (node.type === "form") return node;
    return findForm(node.props.children);
  }
  throw new Error("Form not found");
}

async function submit(mode: "setup" | "reset"): Promise<void> {
  const form = findForm(renderForm(mode));
  if (!form.props.onSubmit) throw new Error("Submit handler not found");
  await form.props.onSubmit();
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.refresh.mockReset();
  mocks.replace.mockReset();
  harness.cursor = 0;
  harness.state = [];
  harness.values = {
    password: "new-password",
    confirmPassword: "new-password",
  };
});

describe("SetPasswordForm", () => {
  it.each(["setup", "reset"] as const)("prevents native GET credential submission before %s hydration", mode => {
    const html = renderToStaticMarkup(renderForm(mode));
    expect(html.match(/<form\b[^>]*>/)?.[0]).toContain('method="post"');
    expect(html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it.each([
    ["setup", "Create your password", "Set password"],
    ["reset", "Reset your password", "Reset password"],
  ] as const)("renders the required %s password flow", (mode, title, action) => {
    const html = renderToStaticMarkup(renderForm(mode));

    expect(html).toContain(title);
    expect(html).toContain(action);
    expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
    expect(html).not.toMatch(/skip for now/i);
    expect(html).not.toMatch(/dismiss/i);
  });

  it.each([
    ["setup", { password: "new-password" }],
    ["reset", { password: "new-password", mode: "reset" }],
  ] as const)("submits the exact %s payload and uses the fixed handoff", async (
    mode,
    expectedBody,
  ) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await submit(mode);

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/set-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(expectedBody),
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.replace).toHaveBeenCalledWith("/onboarding");
  });

  it("keeps a failed reset on the form with safe reset-specific copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: vi.fn().mockRejectedValue(new Error("invalid token")),
      }),
    );

    await submit("reset");

    const html = renderToStaticMarkup(renderForm("reset"));
    expect(html).toContain(
      "We could not reset your password. Request a new link and try again.",
    );
    expect(html).not.toContain("invalid token");
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
