import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/branding/defaultBrand", () => ({
  getCanonicalAppOrigin: () => "https://api.simplassist.test",
}));

import { GET } from "./route";

type EventListener = (event: Record<string, unknown>) => void;
type TimerCallback = () => void;

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}

  add(...tokens: string[]) {
    const classes = this.classes();
    tokens.forEach((token) => classes.add(token));
    this.owner.className = Array.from(classes).join(" ");
  }

  remove(...tokens: string[]) {
    const classes = this.classes();
    tokens.forEach((token) => classes.delete(token));
    this.owner.className = Array.from(classes).join(" ");
  }

  contains(token: string) {
    return this.classes().has(token);
  }

  private classes() {
    return new Set(this.owner.className.split(/\s+/).filter(Boolean));
  }
}

class FakeTextNode {
  parentNode: FakeElement | null = null;

  constructor(readonly textContent: string) {}

  remove() {
    this.parentNode?.removeChild(this);
  }
}

type FakeNode = FakeElement | FakeTextNode;

class FakeElement {
  readonly children: FakeNode[] = [];
  readonly classList = new FakeClassList(this);
  readonly style: Record<string, string> & {
    setProperty: (name: string, value: string) => void;
  };
  parentNode: FakeElement | null = null;
  className = "";
  value = "";
  disabled = false;
  scrollTop = 0;
  focused = false;
  isContentEditable = false;
  inert = false;
  tabIndex = 0;
  src = "";
  private explicitScrollHeight: number | null = null;
  private attributes = new Map<string, string>();
  private listeners = new Map<string, EventListener[]>();
  private ownText = "";
  private markup = "";

  constructor(
    readonly tagName: string,
    private readonly ownerDocument?: FakeDocument,
  ) {
    const style = {} as FakeElement["style"];
    style.setProperty = (name, value) => {
      style[name] = value;
    };
    this.style = style;
  }

  get id() {
    return this.attributes.get("id") ?? "";
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.clearChildren();
    this.ownText = String(value);
    this.markup = "";
  }

  get innerHTML() {
    return this.markup || this.textContent;
  }

  set innerHTML(value: string) {
    this.clearChildren();
    this.ownText = "";
    this.markup = value;
  }

  get scrollHeight() {
    return this.explicitScrollHeight ?? this.children.length;
  }

  set scrollHeight(value: number) {
    this.explicitScrollHeight = value;
  }

  setAttribute(name: string, value: unknown) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === "class") this.className = stringValue;
    if (name === "src") this.src = stringValue;
  }

  getAttribute(name: string) {
    if (name === "class") return this.className || null;
    if (name === "src") return this.src || null;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "class") this.className = "";
    if (name === "src") this.src = "";
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore<T extends FakeNode>(child: T, reference: FakeNode): T {
    child.parentNode?.removeChild(child);
    const index = this.children.indexOf(reference);
    child.parentNode = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  before(node: FakeNode) {
    this.parentNode?.insertBefore(node, this);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
    this.dispatch("focus");
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];

    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (child.matchesSelector(selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }

    return matches;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  private clearChildren() {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
  }

  private matchesSelector(selector: string) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector.startsWith("#")) return this.id === selector.slice(1);

    const tag = selector.split("[")[0];
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    const attributes = Array.from(
      selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g),
    );
    if (attributes.length === 0) {
      return this.tagName.toLowerCase() === selector.toLowerCase();
    }
    return attributes.every((match) => {
      const actual = this.getAttribute(match[1]);
      return match[2] === undefined ? actual !== null : actual === match[2];
    });
  }
}

class FakeDocument {
  readonly head: FakeElement;
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  readonly currentScript: FakeElement;
  activeElement: FakeElement | null = null;
  visibilityState = "visible";
  private listeners = new Map<string, EventListener[]>();

  constructor(
    preview = false,
    homepageOnly = false,
    scriptOrigin = "https://simplassist.test",
  ) {
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement = new FakeElement("html", this);
    this.currentScript = new FakeElement("script", this);
    this.currentScript.src = `${scriptOrigin}/widget/embed.js`;
    this.currentScript.setAttribute("data-business-id", "business-123");
    if (preview) this.currentScript.setAttribute("data-preview", "true");
    if (homepageOnly) {
      this.currentScript.setAttribute("data-homepage-only", "true");
    }
  }

  createElement(tag: string) {
    return new FakeElement(tag, this);
  }

  createTextNode(text: string) {
    return new FakeTextNode(text);
  }

  getElementsByTagName(tag: string) {
    if (tag.toLowerCase() === "script") return [this.currentScript];
    return [...this.head.querySelectorAll(tag), ...this.body.querySelectorAll(tag)];
  }

  getElementById(id: string) {
    return this.head.querySelector(`#${id}`) ?? this.body.querySelector(`#${id}`);
  }

  querySelector(selector: string) {
    return this.head.querySelector(selector) ?? this.body.querySelector(selector);
  }

  querySelectorAll(selector: string) {
    return [
      ...this.head.querySelectorAll(selector),
      ...this.body.querySelectorAll(selector),
    ];
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeTimers {
  private nextId = 1;
  private scheduled: Array<{
    id: number;
    kind: "timeout" | "interval";
    delay: number;
    callback: TimerCallback;
    active: boolean;
  }> = [];

  readonly setTimeout = (callback: TimerCallback, delay = 0) =>
    this.schedule("timeout", callback, delay);

  readonly setInterval = (callback: TimerCallback, delay = 0) =>
    this.schedule("interval", callback, delay);

  readonly clearTimeout = (id: number) => this.clear(id);
  readonly clearInterval = (id: number) => this.clear(id);

  pendingTimeoutDelays() {
    return this.scheduled
      .filter((timer) => timer.active && timer.kind === "timeout")
      .map((timer) => timer.delay);
  }

  runTimeout(delay: number) {
    const timer = this.scheduled.find(
      (candidate) =>
        candidate.active && candidate.kind === "timeout" && candidate.delay === delay,
    );
    if (!timer) throw new Error(`No active timeout scheduled for ${delay}ms`);
    timer.active = false;
    timer.callback();
  }

  runInterval(delay: number) {
    const timer = this.scheduled.find(
      (candidate) =>
        candidate.active && candidate.kind === "interval" && candidate.delay === delay,
    );
    if (!timer) throw new Error(`No active interval scheduled for ${delay}ms`);
    timer.callback();
  }

  drainIntervalsBelow(maxDelay: number, maxTicks = 1_000) {
    for (let tick = 0; tick < maxTicks; tick += 1) {
      const timer = this.scheduled.find(
        (candidate) =>
          candidate.active &&
          candidate.kind === "interval" &&
          candidate.delay < maxDelay,
      );
      if (!timer) return;
      timer.callback();
    }
    throw new Error(`Active interval did not finish within ${maxTicks} ticks`);
  }

  private schedule(kind: "timeout" | "interval", callback: TimerCallback, delay: number) {
    const id = this.nextId++;
    this.scheduled.push({ id, kind, callback, delay, active: true });
    return id;
  }

  private clear(id: number) {
    const timer = this.scheduled.find((candidate) => candidate.id === id);
    if (timer) timer.active = false;
  }
}

interface QueuedResponse {
  status: number;
  body: Record<string, unknown>;
}

async function createHarness(
  responses: QueuedResponse[],
  options: {
    preview?: boolean;
    homepageOnly?: boolean;
    homepageRouteVisible?: boolean;
    scriptOrigin?: string;
    uuids?: string[];
    width?: number;
    height?: number;
    visualViewportHeight?: number;
    scrollHeight?: number;
    now?: number;
    storage?: Record<string, string>;
    storageThrows?: boolean;
    telemetryFailure?: "throw" | "reject";
    reducedMotion?: boolean;
    coarsePointer?: boolean;
    visibilityState?: "visible" | "hidden";
  } = {},
) {
  const response = await GET();
  const script = await response.text();
  const document = new FakeDocument(
    options.preview,
    options.homepageOnly,
    options.scriptOrigin,
  );
  if (options.homepageRouteVisible) {
    document.body.classList.add("sa-homepage-widget-route");
  }
  document.visibilityState = options.visibilityState ?? "visible";
  document.documentElement.scrollHeight = options.scrollHeight ?? 2_000;
  document.body.scrollHeight = options.scrollHeight ?? 2_000;
  const timers = new FakeTimers();
  const requests: Array<{ url: string; init?: Record<string, unknown> }> = [];
  const telemetryRequests: Array<{ url: string; init?: Record<string, unknown> }> = [];
  const storage = new Map<string, string>(Object.entries(options.storage ?? {}));
  const windowListeners = new Map<string, EventListener[]>();
  const visualViewportListeners = new Map<string, EventListener[]>();
  const mutationObservers: Array<{
    active: boolean;
    target: FakeElement | null;
    callback: () => void;
  }> = [];
  class FakeMutationObserver {
    private readonly record: (typeof mutationObservers)[number];

    constructor(callback: () => void) {
      this.record = { active: true, target: null, callback };
      mutationObservers.push(this.record);
    }

    observe(target: FakeElement) {
      this.record.target = target;
    }

    disconnect() {
      this.record.active = false;
      this.record.target = null;
    }
  }
  const uuids = [...(options.uuids ?? [])];
  let now = options.now ?? 1_800_000_000_000;

  const fetch = (url: string, init?: Record<string, unknown>) => {
    if (url.includes("/api/widget/telemetry")) {
      telemetryRequests.push({ url, init });
      if (options.telemetryFailure === "throw") {
        throw new Error("Telemetry unavailable");
      }
      if (options.telemetryFailure === "reject") {
        return Promise.reject(new Error("Telemetry unavailable"));
      }
      return Promise.resolve({
        ok: true,
        status: 202,
        json: () => Promise.resolve({ accepted: true }),
      });
    }
    requests.push({ url, init });
    const queued = responses.shift();
    if (!queued) return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    return Promise.resolve({
      ok: queued.status >= 200 && queued.status < 300,
      status: queued.status,
      json: () => Promise.resolve(JSON.parse(JSON.stringify(queued.body))),
    });
  };

  const window = {
    __saWidgetLoaded: false,
    MutationObserver: FakeMutationObserver,
    innerWidth: options.width ?? 1_280,
    innerHeight: options.height ?? 800,
    scrollY: 0,
    pageYOffset: 0,
    matchMedia: (query: string) => ({
      matches: query.includes("prefers-reduced-motion")
        ? (options.reducedMotion ?? false)
        : query.includes("pointer: coarse")
          ? (options.coarsePointer ?? false)
          : false,
    }),
    visualViewport: {
      width: options.width ?? 1_280,
      height: options.visualViewportHeight ?? options.height ?? 800,
      offsetTop: 0,
      addEventListener(type: string, listener: EventListener) {
        const listeners = visualViewportListeners.get(type) ?? [];
        listeners.push(listener);
        visualViewportListeners.set(type, listeners);
      },
      removeEventListener(type: string, listener: EventListener) {
        const listeners = visualViewportListeners.get(type) ?? [];
        visualViewportListeners.set(
          type,
          listeners.filter((candidate) => candidate !== listener),
        );
      },
      dispatch(type: string, event: Record<string, unknown> = {}) {
        for (const listener of visualViewportListeners.get(type) ?? []) {
          listener(event);
        }
      },
    },
    addEventListener(type: string, listener: EventListener) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: EventListener) {
      const listeners = windowListeners.get(type) ?? [];
      windowListeners.set(
        type,
        listeners.filter((candidate) => candidate !== listener),
      );
    },
    dispatch(type: string, event: Record<string, unknown> = {}) {
      for (const listener of windowListeners.get(type) ?? []) listener(event);
    },
  };
  const localStorage = {
    getItem: (key: string) => {
      if (options.storageThrows) throw new Error("Storage unavailable");
      return storage.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.storageThrows) throw new Error("Storage unavailable");
      storage.set(key, value);
    },
  };

  const execute = new Function(
    "window",
    "document",
    "localStorage",
    "crypto",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "Date",
    script,
  );
  execute(
    window,
    document,
    localStorage,
    {
      randomUUID: () =>
        uuids.shift() ?? "00000000-0000-4000-8000-000000000002",
    },
    fetch,
    timers.setTimeout,
    timers.clearTimeout,
    timers.setInterval,
    timers.clearInterval,
    { now: () => now },
  );

  return {
    document,
    requests,
    script,
    storage,
    telemetryRequests,
    timers,
    window,
    advanceTime(milliseconds: number) {
      now += milliseconds;
    },
    notifyBodyClassChange() {
      for (const observer of mutationObservers) {
        if (observer.active && observer.target === document.body) {
          observer.callback();
        }
      }
    },
    activeMutationObserverCount() {
      return mutationObservers.filter((observer) => observer.active).length;
    },
  };
}

async function flushPromises() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function requestJsonBody(request: {
  init?: Record<string, unknown>;
} | undefined): Record<string, unknown> {
  const body = request?.init?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(body) as Record<string, unknown>;
}

const availableConfig = {
  available: true,
  businessName: "Acme Landscaping",
  brandColor: "#0066FF",
  position: "bottom_right",
  welcomeMessage: "How can we help?",
  quickReplies: [],
  leadCaptureEnabled: false,
  widgetToken: "test-widget-token",
  widgetSessionNonce: "abcdefghijklmnopqrstuvwx",
  widgetTokenExpiresAt: "2026-08-18T12:05:00.000Z",
};

describe("widget embed runtime", () => {
  it("generates valid standalone JavaScript", async () => {
    const response = await GET();
    const script = await response.text();

    expect(() => new Function(script)).not.toThrow();
  });

  it("is byte-identical across request hosts and preserves public delivery headers", async () => {
    const invokeWithRequest = GET as unknown as (
      request: Request,
    ) => Promise<Response>;
    const first = await invokeWithRequest(
      new Request("https://partner-one.example/widget/embed.js"),
    );
    const second = await invokeWithRequest(
      new Request("https://partner-two.example/widget/embed.js"),
    );

    expect(await first.text()).toBe(await second.text());
    expect(first.headers.get("cache-control")).toBe(
      "public, no-cache, must-revalidate",
    );
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("starts with safe runtime defaults before config resolves", async () => {
    const harness = await createHarness([
      { status: 200, body: availableConfig },
    ]);
    const footerLink = harness.document
      .querySelector(".sa-widget-footer")
      ?.querySelector("a");

    expect(footerLink?.textContent).toBe("Powered by SimplAssist");
    expect(footerLink?.getAttribute("href")).toBe("https://simplassist.test/");
    const panel = harness.document.querySelector(".sa-widget-panel");
    const launcher = harness.document.querySelector(".sa-widget-btn");
    expect(panel?.getAttribute("inert")).toBe("");
    expect(panel?.inert).toBe(true);
    expect(harness.script).toContain("visibility:hidden");
    expect(launcher?.tagName).toBe("button");
    expect(launcher?.disabled).toBe(true);
    expect(launcher?.getAttribute("aria-hidden")).toBe("true");
    expect(launcher?.getAttribute("tabindex")).toBe("-1");
    expect(launcher?.tabIndex).toBe(-1);
  });

  it("keeps partner script branding while routing public traffic through the canonical API", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: {
            ...availableConfig,
            poweredByName: "Alpha Dog Agency",
            poweredByUrl: "https://app.partner.test/",
          },
        },
        { status: 200, body: { available: true, response: "We can help." } },
      ],
      { scriptOrigin: "https://app.partner.test" },
    );
    await flushPromises();

    expect(harness.document.currentScript.src).toBe(
      "https://app.partner.test/widget/embed.js",
    );
    expect(harness.requests[0]?.url).toBe(
      "https://api.simplassist.test/api/widget/config?businessId=business-123&sessionId=00000000-0000-4000-8000-000000000002",
    );
    const footerLink = harness.document
      .querySelector(".sa-widget-footer")
      ?.querySelector("a");
    expect(footerLink?.textContent).toBe("Powered by Alpha Dog Agency");
    expect(footerLink?.getAttribute("href")).toBe(
      "https://app.partner.test/",
    );

    const input = harness.document.querySelector(".sa-widget-input");
    const send = harness.document.querySelector(".sa-widget-send");
    if (!input || !send) throw new Error("Widget input controls were not rendered");
    input.value = "Can you help?";
    send.dispatch("click");

    expect(harness.requests[1]?.url).toBe(
      "https://api.simplassist.test/api/widget/chat?businessId=business-123&sessionId=00000000-0000-4000-8000-000000000002",
    );
  });

  it("marks only an explicitly homepage-scoped widget container", async () => {
    const regularHarness = await createHarness([
      { status: 200, body: availableConfig },
    ]);
    const homepageHarness = await createHarness(
      [{ status: 200, body: availableConfig }],
      { homepageOnly: true },
    );

    expect(
      regularHarness.document
        .querySelector(".sa-widget-container")
        ?.getAttribute("data-homepage-only"),
    ).toBeNull();
    expect(
      homepageHarness.document
        .querySelector(".sa-widget-container")
        ?.getAttribute("data-homepage-only"),
    ).toBe("true");
  });

  it("applies partner attribution and resets it on a later default config", async () => {
    const harness = await createHarness([
      {
        status: 200,
        body: {
          ...availableConfig,
          poweredByName: "Alpha Dog Agency",
          poweredByUrl: "https://partner.example/about?from=widget",
        },
      },
      { status: 200, body: availableConfig },
    ]);
    await flushPromises();

    const footerLink = harness.document
      .querySelector(".sa-widget-footer")
      ?.querySelector("a");
    expect(footerLink?.textContent).toBe("Powered by Alpha Dog Agency");
    expect(footerLink?.getAttribute("href")).toBe(
      "https://partner.example/about?from=widget",
    );

    harness.timers.runInterval(60_000);
    await flushPromises();

    expect(footerLink?.textContent).toBe("Powered by SimplAssist");
    expect(footerLink?.getAttribute("href")).toBe("https://simplassist.test/");
  });

  it.each([
    ["a relative URL", "/partner"],
    ["a scheme-relative URL", "//partner.example"],
    ["a script URL", "javascript:alert(1)"],
    ["a data URL", "data:text/html,unsafe"],
    ["a credentialed URL", "https://user:secret@partner.example/"],
    ["a whitespace-padded URL", " https://partner.example/"],
  ])("retains the runtime URL for %s", async (_, poweredByUrl) => {
    const harness = await createHarness([
      {
        status: 200,
        body: {
          ...availableConfig,
          poweredByName: "Alpha Dog Agency",
          poweredByUrl,
        },
      },
    ]);
    await flushPromises();

    const footerLink = harness.document
      .querySelector(".sa-widget-footer")
      ?.querySelector("a");
    expect(footerLink?.textContent).toBe("Powered by Alpha Dog Agency");
    expect(footerLink?.getAttribute("href")).toBe("https://simplassist.test/");
  });

  it("uses textContent for an untrusted powered-by name", async () => {
    const harness = await createHarness([
      {
        status: 200,
        body: {
          ...availableConfig,
          poweredByName: "<img src=x onerror=alert(1)>",
          poweredByUrl: "http://partner.example/",
        },
      },
    ]);
    await flushPromises();

    const footerLink = harness.document
      .querySelector(".sa-widget-footer")
      ?.querySelector("a");
    expect(footerLink?.textContent).toBe(
      "Powered by <img src=x onerror=alert(1)>",
    );
    expect(footerLink?.children).toHaveLength(0);
    expect(footerLink?.getAttribute("href")).toBe("http://partner.example/");
  });

  it("keeps partner preview config, chat, and end traffic on the partner origin", async () => {
    const harness = await createHarness(
      [
        { status: 200, body: availableConfig },
        { status: 200, body: { response: "Preview reply" } },
        { status: 200, body: { success: true, available: true } },
        { status: 200, body: availableConfig },
      ],
      {
        preview: true,
        scriptOrigin: "https://app.partner.test",
        uuids: [
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000003",
        ],
      },
    );

    await flushPromises();

    expect(harness.requests[0]?.url).toBe(
      "https://app.partner.test/api/widget/preview-config?businessId=business-123",
    );
    expect(
      harness.document
        .querySelector(".sa-widget-btn")
        ?.classList.contains("sa-btn-visible"),
    ).toBe(true);
    const launcher = harness.document.querySelector(".sa-widget-btn");
    expect(launcher?.disabled).toBe(false);
    expect(launcher?.getAttribute("aria-hidden")).toBe("false");
    expect(launcher?.getAttribute("tabindex")).toBe("0");
    expect(launcher?.tabIndex).toBe(0);

    const input = harness.document.querySelector(".sa-widget-input");
    const send = harness.document.querySelector(".sa-widget-send");
    if (!input || !send) throw new Error("Widget input controls were not rendered");

    input.value = "How do I sign up?";
    send.dispatch("click");

    expect(harness.requests[1]?.url).toBe(
      "https://app.partner.test/api/widget/chat?businessId=business-123&sessionId=00000000-0000-4000-8000-000000000002",
    );
    expect(requestJsonBody(harness.requests[1])).toMatchObject({
      businessId: "business-123",
      message: "How do I sign up?",
      sessionId: "00000000-0000-4000-8000-000000000002",
      clientMessageId: "00000000-0000-4000-8000-000000000003",
      preview: true,
    });

    await flushPromises();
    const end = harness.document.querySelector(".sa-widget-end");
    if (!end) throw new Error("End control was not rendered");
    end.dispatch("click");

    expect(harness.requests[2]?.url).toBe(
      "https://app.partner.test/api/widget/end?businessId=business-123&sessionId=00000000-0000-4000-8000-000000000002",
    );
    expect(requestJsonBody(harness.requests[2])).toMatchObject({
      businessId: "business-123",
      sessionId: "00000000-0000-4000-8000-000000000002",
      preview: true,
    });
    await flushPromises();
    expect(harness.requests[3]?.url).toBe(
      "https://app.partner.test/api/widget/preview-config?businessId=business-123",
    );
  });

  it("retries transient config failures with bounded backoff and then initializes", async () => {
    const harness = await createHarness([
      { status: 503, body: { retryable: true } },
      { status: 503, body: { retryable: true } },
      { status: 503, body: { retryable: true } },
      { status: 200, body: availableConfig },
    ]);

    await flushPromises();
    expect(harness.timers.pendingTimeoutDelays()).toContain(750);
    const launcher = harness.document.querySelector(".sa-widget-btn");
    expect(launcher?.disabled).toBe(true);
    expect(launcher?.getAttribute("aria-hidden")).toBe("true");
    expect(launcher?.tabIndex).toBe(-1);

    harness.timers.runTimeout(750);
    await flushPromises();
    expect(harness.timers.pendingTimeoutDelays()).toContain(1500);

    harness.timers.runTimeout(1500);
    await flushPromises();
    expect(harness.timers.pendingTimeoutDelays()).toContain(3000);

    harness.timers.runTimeout(3000);
    await flushPromises();

    expect(harness.requests).toHaveLength(4);
    expect(harness.requests.every((request) => request.url.includes("/api/widget/config"))).toBe(
      true,
    );
    expect(harness.document.querySelector(".sa-widget-btn")?.classList.contains("sa-btn-visible")).toBe(
      true,
    );
    expect(harness.document.querySelector(".sa-widget-header-center")?.textContent).toContain(
      "Acme Landscaping",
    );
    expect(launcher?.disabled).toBe(false);
    expect(launcher?.getAttribute("aria-hidden")).toBe("false");
    expect(launcher?.tabIndex).toBe(0);
  });

  it("restores a typed message and re-enables send after a transient chat failure", async () => {
    const harness = await createHarness([
      { status: 200, body: availableConfig },
      { status: 503, body: { retryable: true } },
    ]);
    await flushPromises();

    const input = harness.document.querySelector(".sa-widget-input");
    const send = harness.document.querySelector(".sa-widget-send");
    if (!input || !send) throw new Error("Widget input controls were not rendered");

    input.value = "Can you mow my lawn?";
    send.dispatch("click");
    expect(send.disabled).toBe(true);

    await flushPromises();

    expect(input.value).toBe("Can you mow my lawn?");
    expect(input.focused).toBe(true);
    expect(send.disabled).toBe(false);
    expect(harness.document.querySelector(".sa-widget-messages")?.textContent).toContain(
      "please try again",
    );
    expect(harness.requests[1]).toMatchObject({
      url: "https://api.simplassist.test/api/widget/chat?businessId=business-123&sessionId=00000000-0000-4000-8000-000000000002",
      init: { method: "POST" },
    });
    expect(requestJsonBody(harness.requests[1])).toMatchObject({
      sessionNonce: "abcdefghijklmnopqrstuvwx",
      clientMessageId: "00000000-0000-4000-8000-000000000002",
    });
    expect(requestJsonBody(harness.requests[1])).not.toHaveProperty("preview");
    expect(
      (harness.requests[1]?.init?.headers as Record<string, string>)
        .Authorization,
    ).toBe("Bearer test-widget-token");
  });

  it("preserves the visitor message and submits the forced offline lead form", async () => {
    const harness = await createHarness(
      [
        { status: 200, body: availableConfig },
        {
          status: 200,
          body: {
            available: true,
            response: null,
            mode: "lead_capture",
            reason: "assistant_unavailable",
          },
        },
        { status: 200, body: { success: true } },
      ],
      {
        uuids: [
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000003",
          "00000000-0000-4000-8000-000000000004",
        ],
      },
    );
    await flushPromises();
    harness.timers.drainIntervalsBelow(1_000);

    const launcher = harness.document.querySelector(".sa-widget-btn");
    const panel = harness.document.querySelector(".sa-widget-panel");
    const input = harness.document.querySelector(".sa-widget-input");
    const send = harness.document.querySelector(".sa-widget-send");
    if (!launcher || !panel || !input || !send) {
      throw new Error("Widget controls were not rendered");
    }
    launcher.dispatch("click");
    input.value = "Please contact me about weekly service.";
    send.dispatch("click");
    await flushPromises();
    harness.timers.drainIntervalsBelow(1_000);

    expect(
      harness.document.querySelector(".sa-widget-msg-user")?.textContent,
    ).toBe("Please contact me about weekly service.");
    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(panel.classList.contains("sa-hidden")).toBe(false);
    expect(launcher.classList.contains("sa-btn-hidden")).toBe(false);
    expect(harness.document.querySelector(".sa-widget-messages")?.textContent)
      .toContain("Our assistant is unavailable right now");

    const leadForm = harness.document.querySelector(".sa-widget-lead-form");
    const leadInputs = leadForm?.querySelectorAll(".sa-widget-lead-input") ?? [];
    const leadSubmit = leadForm?.querySelector(".sa-widget-lead-btn");
    const leadStatus = leadForm?.querySelector(".sa-widget-lead-status");
    if (!leadForm || leadInputs.length !== 2 || !leadSubmit || !leadStatus) {
      throw new Error("Offline lead form was not rendered");
    }
    expect(leadForm.textContent).toContain(
      "Share a name or email so the business can respond.",
    );
    leadSubmit.dispatch("click");
    expect(harness.requests).toHaveLength(2);
    expect(leadStatus.textContent).toContain("Enter a name or email");

    leadInputs[0].value = "Jordan Lee";
    leadSubmit.dispatch("click");
    await flushPromises();

    expect(harness.requests[2]?.url).toBe(
      "https://api.simplassist.test/api/widget/lead?businessId=business-123&sessionId=00000000-0000-4000-8000-000000000002",
    );
    expect(requestJsonBody(harness.requests[2])).toEqual({
      businessId: "business-123",
      sessionId: "00000000-0000-4000-8000-000000000002",
      sessionNonce: "abcdefghijklmnopqrstuvwx",
      clientLeadId: "00000000-0000-4000-8000-000000000004",
      sourceClientMessageId: "00000000-0000-4000-8000-000000000003",
      message: "Please contact me about weekly service.",
      visitorName: "Jordan Lee",
    });
    expect(
      (harness.requests[2]?.init?.headers as Record<string, string>)
        .Authorization,
    ).toBe("Bearer test-widget-token");
    expect(harness.document.querySelector(".sa-widget-lead-form")).toBeNull();
    expect(harness.document.querySelector(".sa-widget-messages")?.textContent)
      .toContain("Your contact information was sent to the business");
  });

  it("keeps the same offline lead id and form values after a failed submission", async () => {
    const harness = await createHarness(
      [
        { status: 200, body: availableConfig },
        {
          status: 200,
          body: {
            available: true,
            response: null,
            mode: "lead_capture",
            reason: "assistant_unavailable",
          },
        },
        { status: 503, body: { error: "service_unavailable", retryable: true } },
        { status: 200, body: { success: true } },
      ],
      {
        uuids: [
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000003",
          "00000000-0000-4000-8000-000000000004",
        ],
      },
    );
    await flushPromises();
    harness.timers.drainIntervalsBelow(1_000);

    const input = harness.document.querySelector(".sa-widget-input");
    const send = harness.document.querySelector(".sa-widget-send");
    if (!input || !send) throw new Error("Widget input controls were not rendered");
    input.value = "Please call me.";
    send.dispatch("click");
    await flushPromises();
    harness.timers.drainIntervalsBelow(1_000);

    const leadForm = harness.document.querySelector(".sa-widget-lead-form");
    const leadInputs = leadForm?.querySelectorAll(".sa-widget-lead-input") ?? [];
    const leadSubmit = leadForm?.querySelector(".sa-widget-lead-btn");
    const leadStatus = leadForm?.querySelector(".sa-widget-lead-status");
    if (leadInputs.length !== 2 || !leadSubmit || !leadStatus) {
      throw new Error("Offline lead form was not rendered");
    }
    leadInputs[1].value = "jordan@example.com";
    leadSubmit.dispatch("click");
    await flushPromises();

    expect(leadInputs[1].value).toBe("jordan@example.com");
    expect(leadSubmit.disabled).toBe(false);
    expect(leadInputs[0].disabled).toBe(true);
    expect(leadInputs[1].disabled).toBe(true);
    expect(leadStatus.textContent).toContain("could not confirm");
    expect(harness.document.querySelector(".sa-widget-lead-form")).toBe(leadForm);

    leadSubmit.dispatch("click");
    await flushPromises();

    expect(requestJsonBody(harness.requests[2]).clientLeadId).toBe(
      "00000000-0000-4000-8000-000000000004",
    );
    expect(requestJsonBody(harness.requests[3]).clientLeadId).toBe(
      "00000000-0000-4000-8000-000000000004",
    );
    expect(harness.document.querySelector(".sa-widget-lead-form")).toBeNull();
  });

  it("closes and hides an open widget when a config refresh reports unavailable", async () => {
    const harness = await createHarness([
      { status: 200, body: availableConfig },
      { status: 200, body: { available: false } },
    ]);
    await flushPromises();

    const launcher = harness.document.querySelector(".sa-widget-btn");
    const panel = harness.document.querySelector(".sa-widget-panel");
    const container = harness.document.querySelector(".sa-widget-container");
    if (!launcher || !panel || !container) throw new Error("Widget shell was not rendered");

    launcher.dispatch("click");
    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(container.classList.contains("sa-open")).toBe(true);

    harness.timers.runInterval(60_000);
    await flushPromises();

    expect(panel.classList.contains("sa-hidden")).toBe(true);
    expect(panel.classList.contains("sa-visible")).toBe(false);
    expect(container.classList.contains("sa-open")).toBe(false);
    expect(launcher.classList.contains("sa-btn-hidden")).toBe(true);
    expect(launcher.disabled).toBe(true);
    expect(launcher.getAttribute("aria-hidden")).toBe("true");
    expect(launcher.getAttribute("tabindex")).toBe("-1");
    expect(launcher.tabIndex).toBe(-1);
  });

  it("fails closed when a public config omits its signed session credential", async () => {
    const unsafeConfig: Record<string, unknown> = { ...availableConfig };
    delete unsafeConfig.widgetToken;
    delete unsafeConfig.widgetSessionNonce;
    const harness = await createHarness([{ status: 200, body: unsafeConfig }]);
    await flushPromises();

    const launcher = harness.document.querySelector(".sa-widget-btn");
    expect(launcher === null || launcher.classList.contains("sa-btn-hidden"))
      .toBe(true);
    expect(launcher?.disabled).toBe(true);
    expect(launcher?.getAttribute("aria-hidden")).toBe("true");
    expect(launcher?.tabIndex).toBe(-1);
    expect(harness.requests).toHaveLength(1);
  });

  it("binds public config, chat, and retry to one session and client message id", async () => {
    const harness = await createHarness([
      { status: 200, body: availableConfig },
      { status: 503, body: { error: "service_unavailable", retryable: true } },
      { status: 200, body: { available: true, response: "We can help." } },
    ]);
    await flushPromises();

    expect(harness.requests[0]?.url).toBe(
      "https://api.simplassist.test/api/widget/config?businessId=business-123&sessionId=00000000-0000-4000-8000-000000000002",
    );
    const input = harness.document.querySelector(".sa-widget-input");
    const send = harness.document.querySelector(".sa-widget-send");
    if (!input || !send) throw new Error("Widget input controls were not rendered");

    input.value = "Can you help?";
    send.dispatch("click");
    await flushPromises();
    const firstBody = requestJsonBody(harness.requests[1]);
    expect(firstBody).toMatchObject({
      sessionId: "00000000-0000-4000-8000-000000000002",
      sessionNonce: "abcdefghijklmnopqrstuvwx",
      clientMessageId: "00000000-0000-4000-8000-000000000002",
    });

    send.dispatch("click");
    await flushPromises();
    const retryBody = requestJsonBody(harness.requests[2]);
    expect(retryBody.clientMessageId).toBe(firstBody.clientMessageId);
    expect(
      (harness.requests[2]?.init?.headers as Record<string, string>)
        .Authorization,
    ).toBe("Bearer test-widget-token");
  });

  it("ends with the signed credential and refreshes it for the new session", async () => {
    const refreshedConfig = {
      ...availableConfig,
      widgetToken: "refreshed-widget-token",
      widgetSessionNonce: "zyxwvutsrqponmlkjihgfedc",
    };
    const harness = await createHarness(
      [
        { status: 200, body: availableConfig },
        { status: 200, body: { success: true, available: true } },
        { status: 200, body: refreshedConfig },
      ],
      {
        uuids: [
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000004",
        ],
      },
    );
    await flushPromises();

    const end = harness.document.querySelector(".sa-widget-end");
    if (!end) throw new Error("End control was not rendered");
    end.dispatch("click");
    await flushPromises();

    expect(harness.requests[1]?.url).toBe(
      "https://api.simplassist.test/api/widget/end?businessId=business-123&sessionId=00000000-0000-4000-8000-000000000002",
    );
    expect(requestJsonBody(harness.requests[1])).toEqual({
      businessId: "business-123",
      sessionId: "00000000-0000-4000-8000-000000000002",
      sessionNonce: "abcdefghijklmnopqrstuvwx",
    });
    expect(
      (harness.requests[1]?.init?.headers as Record<string, string>)
        .Authorization,
    ).toBe("Bearer test-widget-token");
    expect(harness.requests[2]?.url).toBe(
      "https://api.simplassist.test/api/widget/config?businessId=business-123&sessionId=00000000-0000-4000-8000-000000000004",
    );
  });

  it("reveals on desktop at the eight-second dwell without creating a conversation", async () => {
    const harness = await createHarness([
      {
        status: 200,
        body: { ...availableConfig, proactive_invitation_enabled: true },
      },
    ]);
    await flushPromises();

    const panel = harness.document.querySelector(".sa-widget-panel");
    const input = harness.document.querySelector(".sa-widget-input");
    const launcher = harness.document.querySelector(".sa-widget-btn");
    if (!panel || !input || !launcher) throw new Error("Widget shell was not rendered");

    expect(panel.classList.contains("sa-hidden")).toBe(true);
    expect(harness.timers.pendingTimeoutDelays()).toContain(5_000);
    expect(harness.timers.pendingTimeoutDelays()).toContain(8_000);

    harness.timers.runTimeout(8_000);

    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(panel.classList.contains("sa-mobile-compact")).toBe(false);
    expect(input.focused).toBe(false);
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    expect(panel.getAttribute("inert")).toBeNull();
    expect(panel.inert).toBe(false);
    expect(harness.requests).toHaveLength(1);
    expect(harness.storage.get("sa-proactive-v1-shown-business-123")).toBe(
      "1800000000000",
    );
    expect(harness.telemetryRequests).toHaveLength(2);
    expect(requestJsonBody(harness.telemetryRequests[0])).toMatchObject({
      eventType: "widget_loaded",
      source: "widget_load",
      deviceBucket: "desktop",
    });
    expect(requestJsonBody(harness.telemetryRequests[1])).toEqual({
      businessId: "business-123",
      sessionId: "00000000-0000-4000-8000-000000000002",
      sessionNonce: "abcdefghijklmnopqrstuvwx",
      eventType: "invitation_shown",
      source: "proactive_timer",
      deviceBucket: "desktop",
      promptVersion: 1,
    });
  });

  it("records widget_loaded once for repeated public config refreshes in one session", async () => {
    const harness = await createHarness([
      { status: 200, body: availableConfig },
      { status: 200, body: availableConfig },
    ]);
    await flushPromises();
    harness.timers.runInterval(60_000);
    await flushPromises();

    expect(
      harness.telemetryRequests
        .map(requestJsonBody)
        .filter((body) => body.eventType === "widget_loaded"),
    ).toHaveLength(1);
  });

  it("honors the desktop scroll trigger but never before five active seconds", async () => {
    const harness = await createHarness([
      {
        status: 200,
        body: { ...availableConfig, proactiveInvitationEnabled: true },
      },
    ]);
    await flushPromises();

    const panel = harness.document.querySelector(".sa-widget-panel");
    if (!panel) throw new Error("Widget panel was not rendered");
    harness.window.scrollY = 360;
    harness.window.dispatch("scroll");
    expect(panel.classList.contains("sa-hidden")).toBe(true);

    harness.timers.runTimeout(5_000);

    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(harness.requests).toHaveLength(1);
    expect(requestJsonBody(harness.telemetryRequests[1]).source).toBe(
      "proactive_scroll",
    );
  });

  it("uses a compact mobile sheet after twelve seconds and expands only on interaction", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { width: 375, height: 800 },
    );
    await flushPromises();

    const panel = harness.document.querySelector(".sa-widget-panel");
    const input = harness.document.querySelector(".sa-widget-input");
    const close = harness.document.querySelector(".sa-widget-close");
    if (!panel || !input || !close) throw new Error("Widget controls were not rendered");

    expect(harness.timers.pendingTimeoutDelays()).toContain(8_000);
    expect(harness.timers.pendingTimeoutDelays()).toContain(12_000);
    harness.timers.runTimeout(12_000);

    expect(panel.classList.contains("sa-mobile-compact")).toBe(true);
    expect(panel.classList.contains("sa-mobile-expanded")).toBe(false);
    expect(panel.classList.contains("sa-viewport-constrained")).toBe(false);
    expect(panel.style["--sa-mobile-compact-height"]).toBe("384px");
    expect(input.focused).toBe(false);
    expect(close.focused).toBe(false);
    expect(harness.document.activeElement).toBeNull();
    expect(harness.requests).toHaveLength(1);

    const controlPointerPrevented = vi.fn();
    panel.dispatch("pointerdown", {
      target: input,
      button: 0,
      isPrimary: true,
      preventDefault: controlPointerPrevented,
    });
    expect(panel.classList.contains("sa-mobile-compact")).toBe(true);
    expect(controlPointerPrevented).not.toHaveBeenCalled();

    input.focus();

    expect(panel.classList.contains("sa-mobile-compact")).toBe(false);
    expect(panel.classList.contains("sa-mobile-expanded")).toBe(true);
    expect(harness.requests).toHaveLength(1);
    expect(harness.telemetryRequests.map(requestJsonBody)).toMatchObject([
      {
        eventType: "widget_loaded",
        source: "widget_load",
        deviceBucket: "mobile",
      },
      {
        eventType: "invitation_shown",
        source: "proactive_timer",
        deviceBucket: "mobile",
      },
      {
        eventType: "widget_engaged",
        source: "proactive_timer",
        deviceBucket: "mobile",
      },
    ]);

    harness.window.visualViewport.height = 500;
    harness.window.visualViewport.dispatch("resize");
    expect(panel.classList.contains("sa-mobile-compact")).toBe(false);
    expect(panel.classList.contains("sa-mobile-expanded")).toBe(true);
  });

  it("moves manual mobile-open focus to the close control without opening the keyboard", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: {
            ...availableConfig,
            leadCaptureEnabled: true,
            leadCaptureTiming: "start",
          },
        },
      ],
      { width: 390, height: 800 },
    );
    await flushPromises();

    const launcher = harness.document.querySelector(".sa-widget-btn");
    const panel = harness.document.querySelector(".sa-widget-panel");
    const close = harness.document.querySelector(".sa-widget-close");
    const input = harness.document.querySelector(".sa-widget-input");
    if (!launcher || !panel || !close || !input) {
      throw new Error("Widget controls were not rendered");
    }
    launcher.focus();
    launcher.dispatch("click");

    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(panel.classList.contains("sa-mobile-expanded")).toBe(true);
    expect(close.focused).toBe(true);
    expect(harness.document.activeElement).toBe(close);
    expect(input.focused).toBe(false);
    expect(harness.document.querySelector(".sa-widget-lead-form")).not.toBeNull();
  });

  it("focuses the first start-timed lead field on a manual desktop open", async () => {
    const harness = await createHarness([
      {
        status: 200,
        body: {
          ...availableConfig,
          leadCaptureEnabled: true,
          leadCaptureTiming: "start",
        },
      },
    ]);
    await flushPromises();

    const launcher = harness.document.querySelector(".sa-widget-btn");
    const input = harness.document.querySelector(".sa-widget-input");
    if (!launcher || !input) throw new Error("Widget controls were not rendered");
    launcher.focus();
    launcher.dispatch("click");

    const leadForm = harness.document.querySelector(".sa-widget-lead-form");
    const firstLeadInput = leadForm?.querySelector(".sa-widget-lead-input");
    expect(leadForm).not.toBeNull();
    expect(firstLeadInput?.focused).toBe(true);
    expect(harness.document.activeElement).toBe(firstLeadInput);
    expect(input.focused).toBe(false);
  });

  it("uses the mobile scroll threshold only after its eight-second minimum", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { width: 390, height: 800 },
    );
    await flushPromises();

    const panel = harness.document.querySelector(".sa-widget-panel");
    if (!panel) throw new Error("Widget panel was not rendered");
    harness.window.scrollY = 480;
    harness.window.dispatch("scroll");
    expect(panel.classList.contains("sa-hidden")).toBe(true);

    harness.timers.runTimeout(8_000);
    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(panel.classList.contains("sa-mobile-compact")).toBe(true);
  });

  it("treats a coarse-pointer phone in landscape as mobile without overflowing", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { width: 844, height: 390, coarsePointer: true },
    );
    await flushPromises();

    expect(harness.timers.pendingTimeoutDelays()).toContain(8_000);
    expect(harness.timers.pendingTimeoutDelays()).toContain(12_000);
    expect(harness.timers.pendingTimeoutDelays()).not.toContain(5_000);
    harness.timers.runTimeout(12_000);

    const panel = harness.document.querySelector(".sa-widget-panel");
    expect(panel?.classList.contains("sa-mobile-compact")).toBe(true);
    expect(panel?.classList.contains("sa-viewport-constrained")).toBe(false);
    expect(panel?.style["--sa-mobile-compact-height"]).toBe("260px");
    expect(panel?.style.width).toBe("min(560px, calc(100vw - 24px))");
    expect(requestJsonBody(harness.telemetryRequests.at(-1)).deviceBucket).toBe(
      "mobile",
    );
    expect(harness.script).toContain(
      "(max-height:500px) and (max-width:950px) and (pointer:coarse)",
    );
  });

  it("uses the constrained visual viewport fallback for a genuinely tiny landscape phone", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { width: 844, height: 350, coarsePointer: true },
    );
    await flushPromises();
    harness.timers.runTimeout(12_000);

    const panel = harness.document.querySelector(".sa-widget-panel");
    expect(panel?.classList.contains("sa-viewport-constrained")).toBe(true);
    expect(panel?.style.width).toBe("100vw");
    expect(panel?.style["--sa-visual-height"]).toBe("350px");
  });

  it("shows the welcome at the top on a short-landscape automatic open while manual opens keep the bottom", async () => {
    const automaticHarness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      {
        width: 844,
        height: 390,
        coarsePointer: true,
        reducedMotion: true,
      },
    );
    await flushPromises();

    const automaticMessages = automaticHarness.document.querySelector(
      ".sa-widget-messages",
    );
    if (!automaticMessages) throw new Error("Widget messages were not rendered");
    automaticMessages.scrollHeight = 1_000;
    while (automaticHarness.timers.pendingTimeoutDelays().includes(50)) {
      automaticHarness.timers.runTimeout(50);
    }
    automaticMessages.scrollTop = 1_000;

    automaticHarness.timers.runTimeout(12_000);

    expect(automaticMessages.scrollTop).toBe(0);
    automaticMessages.scrollTop = 700;
    automaticHarness.timers.runTimeout(50);
    expect(automaticMessages.scrollTop).toBe(0);

    const manualHarness = await createHarness(
      [{ status: 200, body: availableConfig }],
      {
        width: 844,
        height: 390,
        coarsePointer: true,
        reducedMotion: true,
      },
    );
    await flushPromises();

    const manualMessages = manualHarness.document.querySelector(
      ".sa-widget-messages",
    );
    const launcher = manualHarness.document.querySelector(".sa-widget-btn");
    if (!manualMessages || !launcher) {
      throw new Error("Manual widget controls were not rendered");
    }
    manualMessages.scrollHeight = 1_000;
    while (manualHarness.timers.pendingTimeoutDelays().includes(50)) {
      manualHarness.timers.runTimeout(50);
    }
    manualMessages.scrollTop = 0;

    launcher.dispatch("click");
    manualHarness.timers.runTimeout(50);

    expect(manualMessages.scrollTop).toBe(1_000);
  });

  it("keeps an ordinary short fine-pointer desktop window on desktop behavior", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { width: 844, height: 390, coarsePointer: false },
    );
    await flushPromises();

    expect(harness.timers.pendingTimeoutDelays()).toContain(5_000);
    expect(harness.timers.pendingTimeoutDelays()).toContain(8_000);
    expect(harness.timers.pendingTimeoutDelays()).not.toContain(12_000);
    harness.timers.runTimeout(8_000);

    const panel = harness.document.querySelector(".sa-widget-panel");
    expect(panel?.classList.contains("sa-mobile-compact")).toBe(false);
    expect(panel?.style.width).toBe("");
    expect(requestJsonBody(harness.telemetryRequests.at(-1)).deviceBucket).toBe(
      "desktop",
    );
  });

  it("does not expose start-timed lead capture until the visitor intentionally engages", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: {
            ...availableConfig,
            proactiveInvitationEnabled: true,
            leadCaptureEnabled: true,
            leadCaptureTiming: "start",
          },
        },
      ],
      { width: 390, height: 800 },
    );
    await flushPromises();

    expect(harness.document.querySelector(".sa-widget-lead-form")).toBeNull();
    harness.timers.runTimeout(12_000);
    expect(harness.document.querySelector(".sa-widget-lead-form")).toBeNull();
    expect(harness.requests).toHaveLength(1);

    const input = harness.document.querySelector(".sa-widget-input");
    input?.focus();

    const leadForm = harness.document.querySelector(".sa-widget-lead-form");
    const firstLeadInput = leadForm?.querySelector(".sa-widget-lead-input");
    expect(leadForm).not.toBeNull();
    expect(firstLeadInput).not.toBeNull();
    expect(firstLeadInput?.focused).toBe(true);
    expect(harness.document.activeElement).toBe(firstLeadInput);
    expect(harness.requests).toHaveLength(1);
  });

  it("moves keyboard focus from an activated quick reply into the start-timed lead form", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: {
            ...availableConfig,
            proactiveInvitationEnabled: true,
            quickReplies: ["Book an appointment"],
            leadCaptureEnabled: true,
            leadCaptureTiming: "start",
          },
        },
      ],
      { reducedMotion: true },
    );
    await flushPromises();
    harness.timers.runTimeout(8_000);

    const quickReply = harness.document.querySelector(
      ".sa-widget-quick-reply-btn",
    );
    if (!quickReply) throw new Error("Quick reply was not rendered");
    expect(harness.document.activeElement).toBeNull();
    quickReply.focus();
    quickReply.dispatch("click");

    const leadForm = harness.document.querySelector(".sa-widget-lead-form");
    const firstLeadInput = leadForm?.querySelector(".sa-widget-lead-input");
    expect(leadForm).not.toBeNull();
    expect(firstLeadInput?.focused).toBe(true);
    expect(harness.document.activeElement).toBe(firstLeadInput);
  });

  it("pauses dwell time while hidden and resumes with only active time remaining", async () => {
    const harness = await createHarness([
      {
        status: 200,
        body: { ...availableConfig, proactiveInvitationEnabled: true },
      },
    ]);
    await flushPromises();

    const panel = harness.document.querySelector(".sa-widget-panel");
    if (!panel) throw new Error("Widget panel was not rendered");
    harness.advanceTime(2_000);
    harness.document.visibilityState = "hidden";
    harness.document.dispatch("visibilitychange");
    expect(harness.timers.pendingTimeoutDelays()).not.toContain(8_000);

    harness.advanceTime(20_000);
    harness.document.visibilityState = "visible";
    harness.document.dispatch("visibilitychange");
    expect(harness.timers.pendingTimeoutDelays()).toContain(3_000);
    expect(harness.timers.pendingTimeoutDelays()).toContain(6_000);

    harness.timers.runTimeout(6_000);
    expect(panel.classList.contains("sa-visible")).toBe(true);
  });

  it("pauses a homepage-only invitation off-route and resumes only its remaining active time", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { homepageOnly: true, homepageRouteVisible: true },
    );
    await flushPromises();

    const panel = harness.document.querySelector(".sa-widget-panel");
    if (!panel) throw new Error("Widget panel was not rendered");
    expect(harness.activeMutationObserverCount()).toBe(1);
    expect(harness.timers.pendingTimeoutDelays()).toContain(5_000);
    expect(harness.timers.pendingTimeoutDelays()).toContain(8_000);

    harness.advanceTime(2_000);
    harness.document.body.classList.remove("sa-homepage-widget-route");
    harness.notifyBodyClassChange();
    expect(harness.timers.pendingTimeoutDelays()).not.toContain(5_000);
    expect(harness.timers.pendingTimeoutDelays()).not.toContain(8_000);

    harness.window.scrollY = 1_200;
    harness.window.dispatch("scroll");
    harness.advanceTime(20_000);
    expect(panel.classList.contains("sa-hidden")).toBe(true);
    expect(harness.storage.has("sa-proactive-v1-shown-business-123")).toBe(false);
    expect(
      harness.telemetryRequests
        .map(requestJsonBody)
        .filter((body) => body.eventType === "invitation_shown"),
    ).toHaveLength(0);

    harness.document.body.classList.add("sa-homepage-widget-route");
    harness.notifyBodyClassChange();
    expect(harness.timers.pendingTimeoutDelays()).toContain(3_000);
    expect(harness.timers.pendingTimeoutDelays()).toContain(6_000);

    harness.timers.runTimeout(3_000);
    expect(panel.classList.contains("sa-hidden")).toBe(true);
    harness.timers.runTimeout(6_000);
    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(
      harness.telemetryRequests
        .map(requestJsonBody)
        .filter((body) => body.eventType === "invitation_shown"),
    ).toHaveLength(1);
    expect(harness.activeMutationObserverCount()).toBe(0);
  });

  it("defers homepage-only loaded telemetry when navigation hides the route during config load", async () => {
    const harness = await createHarness(
      [{ status: 200, body: availableConfig }],
      { homepageOnly: true, homepageRouteVisible: true },
    );

    harness.document.body.classList.remove("sa-homepage-widget-route");
    harness.notifyBodyClassChange();
    await flushPromises();

    expect(harness.telemetryRequests).toHaveLength(0);
    expect(harness.activeMutationObserverCount()).toBe(1);

    harness.document.body.classList.add("sa-homepage-widget-route");
    harness.notifyBodyClassChange();

    expect(harness.telemetryRequests.map(requestJsonBody)).toMatchObject([
      { eventType: "widget_loaded", source: "widget_load" },
    ]);
    expect(harness.activeMutationObserverCount()).toBe(0);

    harness.notifyBodyClassChange();
    expect(harness.telemetryRequests).toHaveLength(1);
  });

  it("defers the reveal while the visitor types or another modal is open", async () => {
    const harness = await createHarness([
      {
        status: 200,
        body: { ...availableConfig, proactiveInvitationEnabled: true },
      },
    ]);
    await flushPromises();

    const panel = harness.document.querySelector(".sa-widget-panel");
    if (!panel) throw new Error("Widget panel was not rendered");
    const outsideInput = harness.document.createElement("input");
    harness.document.body.appendChild(outsideInput);
    outsideInput.focus();
    harness.timers.runTimeout(8_000);
    expect(panel.classList.contains("sa-hidden")).toBe(true);
    expect(harness.timers.pendingTimeoutDelays()).toContain(1_000);

    harness.document.activeElement = harness.document.body;
    const modal = harness.document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    harness.document.body.appendChild(modal);
    harness.timers.runTimeout(1_000);
    expect(panel.classList.contains("sa-hidden")).toBe(true);

    modal.remove();
    harness.timers.runTimeout(1_000);
    expect(panel.classList.contains("sa-visible")).toBe(true);
  });

  it("treats every valid focused contenteditable shape and inherited editor as typing", async () => {
    const variants = [
      "empty-attribute",
      "plaintext-only",
      "inherited-descendant",
      "dom-property",
      "focused-iframe",
    ] as const;

    for (const variant of variants) {
      const harness = await createHarness([
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ]);
      await flushPromises();
      const panel = harness.document.querySelector(".sa-widget-panel");
      if (!panel) throw new Error("Widget panel was not rendered");

      let editor = harness.document.createElement("div");
      let focusTarget = editor;
      if (variant === "empty-attribute") {
        editor.setAttribute("contenteditable", "");
      } else if (variant === "plaintext-only") {
        editor.setAttribute("contenteditable", "plaintext-only");
      } else if (variant === "inherited-descendant") {
        editor.setAttribute("contenteditable", "true");
        focusTarget = harness.document.createElement("span");
        editor.appendChild(focusTarget);
      } else if (variant === "dom-property") {
        editor.isContentEditable = true;
      } else {
        editor = harness.document.createElement("iframe");
        focusTarget = editor;
      }
      harness.document.body.appendChild(editor);
      focusTarget.focus();

      harness.timers.runTimeout(8_000);
      expect(panel.classList.contains("sa-hidden"), variant).toBe(true);
      expect(
        harness.telemetryRequests
          .map(requestJsonBody)
          .some((body) => body.eventType === "invitation_shown"),
        variant,
      ).toBe(false);

      harness.document.activeElement = harness.document.body;
      harness.timers.runTimeout(1_000);
      expect(panel.classList.contains("sa-visible"), variant).toBe(true);
    }
  });

  it("expands and records engagement for a non-control panel pointer only once", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: {
            ...availableConfig,
            proactiveInvitationEnabled: true,
            leadCaptureEnabled: true,
            leadCaptureTiming: "start",
          },
        },
      ],
      { width: 390, height: 800 },
    );
    await flushPromises();
    harness.timers.runTimeout(12_000);

    const panel = harness.document.querySelector(".sa-widget-panel");
    const header = harness.document.querySelector(".sa-widget-header-center");
    const messageArea = harness.document.querySelector(".sa-widget-messages");
    const input = harness.document.querySelector(".sa-widget-input");
    const footerLink = harness.document
      .querySelector(".sa-widget-footer")
      ?.querySelector("a");
    if (!panel || !header || !messageArea || !input || !footerLink) {
      throw new Error("Widget panel content was not rendered");
    }

    const linkPreventDefault = vi.fn();
    const linkStopPropagation = vi.fn();
    panel.dispatch("pointerdown", {
      target: footerLink,
      button: 0,
      isPrimary: true,
      preventDefault: linkPreventDefault,
      stopPropagation: linkStopPropagation,
    });
    expect(panel.classList.contains("sa-mobile-compact")).toBe(true);
    expect(linkPreventDefault).not.toHaveBeenCalled();
    expect(linkStopPropagation).not.toHaveBeenCalled();

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    panel.dispatch("pointerdown", {
      target: header,
      button: 0,
      isPrimary: true,
      preventDefault,
      stopPropagation,
    });

    expect(panel.classList.contains("sa-mobile-compact")).toBe(false);
    expect(panel.classList.contains("sa-mobile-expanded")).toBe(true);
    expect(harness.document.querySelector(".sa-widget-lead-form")).toBeNull();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(
      harness.telemetryRequests
        .map(requestJsonBody)
        .filter((body) => body.eventType === "widget_engaged"),
    ).toHaveLength(1);

    panel.dispatch("pointerdown", {
      target: messageArea,
      button: 0,
      isPrimary: true,
    });
    expect(
      harness.telemetryRequests
        .map(requestJsonBody)
        .filter((body) => body.eventType === "widget_engaged"),
    ).toHaveLength(1);

    input.focus();
    expect(harness.document.querySelector(".sa-widget-lead-form")).not.toBeNull();
    expect(
      harness.telemetryRequests
        .map(requestJsonBody)
        .filter((body) => body.eventType === "widget_engaged"),
    ).toHaveLength(1);
  });

  it("suppresses repeat invitations for 24 hours and explicit dismissals for seven days", async () => {
    const now = 1_800_000_000_000;
    const shownHarness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      {
        now,
        storage: {
          "sa-proactive-v1-shown-business-123": String(now - 60_000),
        },
      },
    );
    await flushPromises();
    expect(shownHarness.timers.pendingTimeoutDelays()).not.toContain(8_000);

    const dismissalHarness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { now },
    );
    await flushPromises();
    dismissalHarness.timers.runTimeout(8_000);
    const close = dismissalHarness.document.querySelector(".sa-widget-close");
    const panel = dismissalHarness.document.querySelector(".sa-widget-panel");
    if (!close || !panel) throw new Error("Widget close control was not rendered");
    const closePreventDefault = vi.fn();
    const closeStopPropagation = vi.fn();
    panel.dispatch("pointerdown", {
      target: close,
      button: 0,
      isPrimary: true,
      preventDefault: closePreventDefault,
      stopPropagation: closeStopPropagation,
    });
    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(closePreventDefault).not.toHaveBeenCalled();
    expect(closeStopPropagation).not.toHaveBeenCalled();
    close.focus();
    close.dispatch("click");

    expect(dismissalHarness.storage.get("sa-proactive-v1-dismissed-business-123"))
      .toBe(String(now));
    expect(panel.getAttribute("inert")).toBe("");
    expect(panel.inert).toBe(true);
    expect(
      dismissalHarness.document.querySelector(".sa-widget-btn")?.focused,
    ).toBe(true);
    expect(dismissalHarness.telemetryRequests.map(requestJsonBody)).toMatchObject([
      { eventType: "widget_loaded", source: "widget_load" },
      { eventType: "invitation_shown", source: "proactive_timer" },
      { eventType: "invitation_dismissed", source: "proactive_timer" },
    ]);
    expect(
      dismissalHarness.telemetryRequests
        .map(requestJsonBody)
        .some((body) => body.eventType === "widget_engaged"),
    ).toBe(false);
    dismissalHarness.window.scrollY = 1_000;
    dismissalHarness.window.dispatch("scroll");
    expect(panel.classList.contains("sa-hidden")).toBe(true);

    const suppressedHarness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      {
        now: now + 2 * 24 * 60 * 60 * 1_000,
        storage: Object.fromEntries(dismissalHarness.storage),
      },
    );
    await flushPromises();
    expect(suppressedHarness.timers.pendingTimeoutDelays()).not.toContain(8_000);
  });

  it("rechecks shared storage immediately before revealing in a second tab", async () => {
    const now = 1_800_000_000_000;
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { now },
    );
    await flushPromises();

    harness.storage.set("sa-proactive-v1-shown-business-123", String(now));
    harness.timers.runTimeout(8_000);

    expect(harness.document.querySelector(".sa-widget-panel")?.classList.contains("sa-hidden"))
      .toBe(true);
    expect(
      harness.telemetryRequests
        .map(requestJsonBody)
        .some((body) => body.eventType === "invitation_shown"),
    ).toBe(false);
    expect(harness.timers.pendingTimeoutDelays()).not.toContain(5_000);
  });

  it.each([
    "sa-proactive-v1-shown-business-123",
    "sa-proactive-v1-dismissed-business-123",
  ])("cancels pending scheduling when another tab updates %s", async (key) => {
    const now = 1_800_000_000_000;
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { now },
    );
    await flushPromises();

    harness.storage.set(key, String(now));
    harness.window.dispatch("storage", { key, newValue: String(now) });

    expect(harness.timers.pendingTimeoutDelays()).not.toContain(5_000);
    expect(harness.timers.pendingTimeoutDelays()).not.toContain(8_000);
    expect(harness.document.querySelector(".sa-widget-panel")?.classList.contains("sa-hidden"))
      .toBe(true);
  });

  it("keeps manual opening available while cancelling the pending automatic reveal", async () => {
    const harness = await createHarness([
      {
        status: 200,
        body: { ...availableConfig, proactiveInvitationEnabled: true },
      },
    ]);
    await flushPromises();

    const launcher = harness.document.querySelector(".sa-widget-btn");
    const panel = harness.document.querySelector(".sa-widget-panel");
    if (!launcher || !panel) throw new Error("Widget shell was not rendered");
    launcher.dispatch("click");

    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(harness.timers.pendingTimeoutDelays()).not.toContain(5_000);
    expect(harness.timers.pendingTimeoutDelays()).not.toContain(8_000);
    expect(harness.requests).toHaveLength(1);
    expect(harness.telemetryRequests.map(requestJsonBody)).toMatchObject([
      { eventType: "widget_loaded", source: "widget_load" },
      { eventType: "widget_engaged", source: "manual" },
    ]);
  });

  it("records the first real message once without including visitor content in telemetry", async () => {
    const harness = await createHarness([
      { status: 200, body: availableConfig },
      { status: 200, body: { available: true, response: "We can help." } },
    ]);
    await flushPromises();

    const launcher = harness.document.querySelector(".sa-widget-btn");
    const input = harness.document.querySelector(".sa-widget-input");
    const send = harness.document.querySelector(".sa-widget-send");
    if (!launcher || !input || !send) throw new Error("Widget controls were not rendered");
    launcher.dispatch("click");
    input.value = "This text must never enter telemetry";
    send.dispatch("click");
    await flushPromises();

    expect(harness.telemetryRequests.map(requestJsonBody)).toMatchObject([
      { eventType: "widget_loaded", source: "widget_load" },
      { eventType: "widget_engaged", source: "manual" },
      { eventType: "first_message_submitted", source: "manual" },
    ]);
    for (const request of harness.telemetryRequests) {
      const serialized = JSON.stringify(requestJsonBody(request));
      expect(serialized).not.toContain("This text must never enter telemetry");
      expect(request.init?.keepalive).toBe(true);
      expect(
        (request.init?.headers as Record<string, string>).Authorization,
      ).toBe("Bearer test-widget-token");
    }
    expect(harness.requests.filter((request) => request.url.includes("/chat")))
      .toHaveLength(1);
  });

  it("fails open for the invitation when browser storage is unavailable", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { storageThrows: true },
    );
    await flushPromises();

    harness.timers.runTimeout(8_000);
    expect(harness.document.querySelector(".sa-widget-panel")?.classList.contains("sa-visible"))
      .toBe(true);
    expect(harness.requests).toHaveLength(1);
  });

  it("keeps invitation and chat behavior independent from telemetry failures", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { telemetryFailure: "throw" },
    );
    await flushPromises();

    harness.timers.runTimeout(8_000);
    expect(harness.document.querySelector(".sa-widget-panel")?.classList.contains("sa-visible"))
      .toBe(true);
    expect(harness.requests).toHaveLength(1);
  });

  it("uses a visual-viewport full-screen fallback only under keyboard or tiny constraints", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { width: 320, height: 568, visualViewportHeight: 320 },
    );
    await flushPromises();

    harness.timers.runTimeout(12_000);
    const panel = harness.document.querySelector(".sa-widget-panel");
    expect(panel?.classList.contains("sa-viewport-constrained")).toBe(true);
    expect(panel?.style["--sa-visual-height"]).toBe("320px");
  });

  it("supports reduced motion, nonmodal semantics, and Escape dismissal", async () => {
    const harness = await createHarness(
      [
        {
          status: 200,
          body: { ...availableConfig, proactiveInvitationEnabled: true },
        },
      ],
      { reducedMotion: true },
    );
    await flushPromises();

    const panel = harness.document.querySelector(".sa-widget-panel");
    const launcher = harness.document.querySelector(".sa-widget-btn");
    if (!panel || !launcher) throw new Error("Widget shell was not rendered");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(panel.getAttribute("aria-labelledby")).toBe("sa-widget-title");
    expect(harness.document.querySelector(".sa-widget-messages")?.textContent)
      .toContain("How can we help?");

    harness.timers.runTimeout(8_000);
    harness.document.dispatch("keydown", {
      key: "Escape",
      preventDefault: vi.fn(),
    });

    expect(panel.classList.contains("sa-hidden")).toBe(true);
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(launcher.focused).toBe(true);
  });

  it("leaves Escape untouched for a visible host modal or active host combobox", async () => {
    const harness = await createHarness([
      {
        status: 200,
        body: { ...availableConfig, proactiveInvitationEnabled: true },
      },
    ]);
    await flushPromises();
    harness.timers.runTimeout(8_000);

    const panel = harness.document.querySelector(".sa-widget-panel");
    const launcher = harness.document.querySelector(".sa-widget-btn");
    if (!panel || !launcher) throw new Error("Widget shell was not rendered");

    const modal = harness.document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const modalButton = harness.document.createElement("button");
    modal.appendChild(modalButton);
    harness.document.body.appendChild(modal);
    const modalPreventDefault = vi.fn();
    harness.document.dispatch("keydown", {
      key: "Escape",
      target: modalButton,
      preventDefault: modalPreventDefault,
    });
    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(modalPreventDefault).not.toHaveBeenCalled();
    expect(launcher.focused).toBe(false);

    modal.remove();
    const combobox = harness.document.createElement("input");
    combobox.setAttribute("role", "combobox");
    combobox.setAttribute("aria-expanded", "true");
    harness.document.body.appendChild(combobox);
    const comboboxPreventDefault = vi.fn();
    harness.document.dispatch("keydown", {
      key: "Escape",
      target: combobox,
      preventDefault: comboboxPreventDefault,
    });
    expect(panel.classList.contains("sa-visible")).toBe(true);
    expect(comboboxPreventDefault).not.toHaveBeenCalled();
    expect(launcher.focused).toBe(false);

    const pagePreventDefault = vi.fn();
    harness.document.dispatch("keydown", {
      key: "Escape",
      target: harness.document.body,
      preventDefault: pagePreventDefault,
    });
    expect(panel.classList.contains("sa-hidden")).toBe(true);
    expect(pagePreventDefault).toHaveBeenCalledTimes(1);
    expect(launcher.focused).toBe(true);
  });

  it("handles Escape from inside the widget when no host overlay owns it", async () => {
    const harness = await createHarness([
      {
        status: 200,
        body: { ...availableConfig, proactiveInvitationEnabled: true },
      },
    ]);
    await flushPromises();
    harness.timers.runTimeout(8_000);

    const panel = harness.document.querySelector(".sa-widget-panel");
    const launcher = harness.document.querySelector(".sa-widget-btn");
    const input = harness.document.querySelector(".sa-widget-input");
    if (!panel || !launcher || !input) throw new Error("Widget controls were not rendered");
    input.focus();
    const preventDefault = vi.fn();
    harness.document.dispatch("keydown", {
      key: "Escape",
      target: input,
      preventDefault,
    });

    expect(panel.classList.contains("sa-hidden")).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(launcher.focused).toBe(true);
  });

  it("forces a no-wait, no-focus invitation only inside the authenticated preview", async () => {
    const harness = await createHarness(
      [{ status: 200, body: availableConfig }],
      { preview: true, width: 390, height: 800 },
    );
    await flushPromises();

    harness.window.dispatch("message", {
      data: {
        source: "simplassist-widget-preview",
        type: "apply-preview",
        payload: {
          proactiveInvitationEnabled: true,
          forceProactiveInvitationOpen: true,
        },
      },
    });

    const panel = harness.document.querySelector(".sa-widget-panel");
    const input = harness.document.querySelector(".sa-widget-input");
    expect(panel?.classList.contains("sa-visible")).toBe(true);
    expect(panel?.classList.contains("sa-mobile-compact")).toBe(true);
    expect(input?.focused).toBe(false);
    expect(harness.requests).toHaveLength(1);
    expect(harness.storage.has("sa-proactive-v1-shown-business-123")).toBe(false);
  });

  it("ignores preview-control messages in a public embed", async () => {
    const harness = await createHarness([{ status: 200, body: availableConfig }]);
    await flushPromises();

    harness.window.dispatch("message", {
      data: {
        source: "simplassist-widget-preview",
        type: "apply-preview",
        payload: {
          proactiveInvitationEnabled: true,
          forceProactiveInvitationOpen: true,
        },
      },
    });

    expect(harness.document.querySelector(".sa-widget-panel")?.classList.contains("sa-hidden"))
      .toBe(true);
    expect(harness.timers.pendingTimeoutDelays()).not.toContain(8_000);
    expect(harness.requests).toHaveLength(1);
  });

  describe("header mascot", () => {
    function avatarParts(harness: Awaited<ReturnType<typeof createHarness>>) {
      const avatar = harness.document.querySelector(".sa-widget-header-avatar");
      const pet = harness.document.querySelector(".sa-widget-pet");
      const image = harness.document.querySelector(".sa-widget-header-avatar-img");
      if (!avatar || !pet || !image) throw new Error("Widget avatar was not rendered");
      return { avatar, pet, image };
    }

    it("shows a white dot with brand-coloured eyes when there is no logo", async () => {
      const harness = await createHarness([{ status: 200, body: availableConfig }]);
      await flushPromises();

      const { avatar, pet } = avatarParts(harness);
      expect(avatar.classList.contains("sa-has-pet")).toBe(true);
      expect(avatar.classList.contains("sa-has-logo")).toBe(false);
      expect(pet.getAttribute("aria-hidden")).toBe("true");
      expect(pet.style["--sa-pet"]).toBe("#FFFFFF");
      expect(pet.style["--sa-pet-ink"]).toBe("#0066FF");
      expect(pet.style["--sa-pet-ring"]).toBe("rgba(255,255,255,0.85)");
    });

    it("uses the chosen dot colour and picks eyes that read against it", async () => {
      const harness = await createHarness([
        { status: 200, body: { ...availableConfig, mascotColor: "#F97316" } },
      ]);
      await flushPromises();

      const { pet } = avatarParts(harness);
      expect(pet.style["--sa-pet"]).toBe("#F97316");
      // Blue eyes would not read on orange, so they fall back to dark.
      expect(pet.style["--sa-pet-ink"]).toBe("#1c1917");
    });

    it("outlines a white dot on a white header so it stays visible", async () => {
      const harness = await createHarness([
        { status: 200, body: { ...availableConfig, brandColor: "#FFFFFF" } },
      ]);
      await flushPromises();

      const { pet } = avatarParts(harness);
      expect(pet.style["--sa-pet"]).toBe("#FFFFFF");
      expect(pet.style["--sa-pet-ink"]).toBe("#1c1917");
      expect(pet.style["--sa-pet-ring"]).toBe("rgba(0,0,0,0.2)");
    });

    it("gives a dark dot white eyes", async () => {
      const harness = await createHarness([
        { status: 200, body: { ...availableConfig, mascotColor: "#1F2937" } },
      ]);
      await flushPromises();

      expect(avatarParts(harness).pet.style["--sa-pet-ink"]).toBe("#ffffff");
    });

    it("ignores a dot colour that is not a plain hex value", async () => {
      const harness = await createHarness([
        { status: 200, body: { ...availableConfig, mascotColor: "red;background:url(//evil.test)" } },
      ]);
      await flushPromises();

      expect(avatarParts(harness).pet.style["--sa-pet"]).toBe("#FFFFFF");
    });

    it("gives way to an uploaded logo and returns if the logo fails to load", async () => {
      const harness = await createHarness([
        {
          status: 200,
          body: { ...availableConfig, showLogo: true, logoUrl: "https://cdn.example.test/logo.png" },
        },
      ]);
      await flushPromises();

      const { avatar, image } = avatarParts(harness);
      expect(avatar.classList.contains("sa-has-logo")).toBe(true);
      expect(avatar.classList.contains("sa-has-pet")).toBe(false);
      expect(image.src).toBe("https://cdn.example.test/logo.png");

      image.dispatch("error");

      expect(avatar.classList.contains("sa-has-logo")).toBe(false);
      expect(avatar.classList.contains("sa-has-pet")).toBe(true);
    });

    it("listens while the visitor types and thinks while a reply is on its way", async () => {
      const harness = await createHarness([
        { status: 200, body: availableConfig },
        { status: 200, body: { available: true, response: "We can help with that." } },
      ]);
      await flushPromises();

      const { pet } = avatarParts(harness);
      const input = harness.document.querySelector(".sa-widget-input");
      const send = harness.document.querySelector(".sa-widget-send");
      if (!input || !send) throw new Error("Widget input controls were not rendered");
      expect(pet.getAttribute("data-mood")).toBe("idle");

      input.dispatch("focus");
      expect(pet.getAttribute("data-mood")).toBe("listening");

      input.value = "Do you mow lawns?";
      send.dispatch("click");
      expect(pet.getAttribute("data-mood")).toBe("thinking");

      await flushPromises();
      expect(pet.getAttribute("data-mood")).toBe("listening");
      expect(pet.classList.contains("sa-pet-cheer")).toBe(true);

      input.dispatch("blur");
      expect(pet.getAttribute("data-mood")).toBe("idle");
    });
  });

  describe("readable text on any brand colour", () => {
    it.each([
      ["a white brand colour", "#FFFFFF", "#1c1917", "#374151"],
      ["a pale yellow brand colour", "#FDE68A", "#1c1917", "#374151"],
      ["the default blue", "#0066FF", "#fff", "#0066FF"],
      ["the green preset", "#22C55E", "#fff", "#22C55E"],
      ["the orange preset", "#F97316", "#fff", "#F97316"],
      ["the teal preset", "#14B8A6", "#fff", "#14B8A6"],
    ])("picks text colours for %s", async (_label, brandColor, onBrand, brandInk) => {
      const harness = await createHarness([
        { status: 200, body: { ...availableConfig, brandColor } },
      ]);
      await flushPromises();

      const container = harness.document.querySelector(".sa-widget-container");
      if (!container) throw new Error("Widget container was not rendered");
      expect(container.style["--sa-on-brand"]).toBe(onBrand);
      expect(container.style["--sa-brand-ink"]).toBe(brandInk);
    });

    it("draws its icons in the text colour instead of fixed white", async () => {
      const harness = await createHarness([{ status: 200, body: availableConfig }]);
      await flushPromises();

      expect(harness.script).toContain("var(--sa-on-brand,#fff)");
      expect(harness.script).not.toContain('stroke="#fff"');
    });
  });
});
