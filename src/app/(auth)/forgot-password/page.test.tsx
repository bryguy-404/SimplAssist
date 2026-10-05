import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  cursor: 0,
  state: [] as unknown[],
  values: { email: "client@example.com" },
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
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import ForgotPasswordPage from "./page";

interface ElementProps {
  children?: ReactNode;
  onSubmit?: () => Promise<void>;
}

function renderPage(): ReactElement<ElementProps> {
  harness.cursor = 0;
  return ForgotPasswordPage() as ReactElement<ElementProps>;
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

async function submit(): Promise<void> {
  const form = findForm(renderPage());
  if (!form.props.onSubmit) throw new Error("Submit handler not found");
  await form.props.onSubmit();
}

beforeEach(() => {
  vi.restoreAllMocks();
  harness.cursor = 0;
  harness.state = [];
  harness.values = { email: "client@example.com" };
});

describe("ForgotPasswordPage", () => {
  it("prevents native GET email submission before hydration", () => {
    const html = renderToStaticMarkup(renderPage());
    expect(html.match(/<form\b[^>]*>/)?.[0]).toContain('method="post"');
    expect(html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it("renders one branded-layout-compatible email request form", () => {
    const html = renderToStaticMarkup(renderPage());

    expect(html).toContain("Reset your password");
    expect(html).toContain('type="email"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain("Send reset link");
    expect(html).toContain('href="/login"');
  });

  it("posts only the email and renders the exact neutral confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await submit();

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "client@example.com" }),
    });
    const html = renderToStaticMarkup(renderPage());
    expect(html).toContain(
      "If an account exists for this email, a reset link is on its way.",
    );
    expect(html).toContain("Check your email");
    expect(html).not.toContain("<form");
  });

  it.each([
    [400, "Please enter a valid email and try again."],
    [429, "Too many reset requests. Please wait 15 minutes and try again."],
    [500, "We could not request a password reset. Please try again."],
  ])("shows a safe message for HTTP %s", async (status, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status }),
    );

    await submit();

    const html = renderToStaticMarkup(renderPage());
    expect(html).toContain(message);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Check your email");
  });

  it("handles a network failure without exposing an exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("provider")));

    await submit();

    const html = renderToStaticMarkup(renderPage());
    expect(html).toContain(
      "We could not request a password reset. Please try again.",
    );
    expect(html).not.toContain("provider");
  });
});
