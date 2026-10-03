import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  effect: null as null | (() => () => void),
  id: 0,
  dialog: { showModal: vi.fn(), close: vi.fn() },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => `dialog-${++harness.id}`,
  useRef: () => ({ current: harness.dialog }),
  useEffect: (effect: () => () => void) => {
    harness.effect = effect;
  },
}));
import CustomerDialog from "./CustomerDialog";
beforeEach(() => {
  vi.clearAllMocks();
  harness.id = 0;
  harness.effect = null;
});
afterEach(() => vi.unstubAllGlobals());
describe("customer dialog accessibility and pending changes", () => {
  it("opens a native modal and restores the previous page scroll state when closed", () => {
    const style = { overflow: "auto" };
    vi.stubGlobal("document", { body: { style } });
    const dialog = CustomerDialog({
      title: "Import customers",
      description: "Preview first",
      children: null,
      onClose: vi.fn(),
    });
    expect(dialog.type).toBe("dialog");
    expect(dialog.props["aria-labelledby"]).toBe("dialog-1");
    expect(dialog.props["aria-describedby"]).toBe("dialog-2");
    const cleanup = harness.effect!();
    expect(harness.dialog.showModal).toHaveBeenCalledOnce();
    expect(style.overflow).toBe("hidden");
    cleanup();
    expect(harness.dialog.close).toHaveBeenCalledOnce();
    expect(style.overflow).toBe("auto");
  });
  it("keeps an in-flight mutation open on Escape, then permits dismissal after it completes", () => {
    const onClose = vi.fn();
    const preventDefault = vi.fn();
    CustomerDialog({
      title: "Save customer",
      children: null,
      busy: true,
      onClose,
    }).props.onCancel({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    CustomerDialog({
      title: "Save customer",
      children: null,
      busy: false,
      onClose,
    }).props.onCancel({ preventDefault });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
