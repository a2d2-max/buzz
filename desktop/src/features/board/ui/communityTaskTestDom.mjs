// Shared JSDOM setup for the Board › Tasks UI tests. Not a test file itself.
import { JSDOM } from "jsdom";

/** Column width used by the fake layout; matches the board's COLUMN_STEP_PX. */
export const COLUMN_STEP = 268;
export const COLUMN_WIDTH = 250;
export const BOARD_ORDER = ["todo", "doing", "done"];

function rect(x, y, width, height) {
  return {
    bottom: y + height,
    height,
    left: x,
    right: x + width,
    toJSON() {},
    top: y,
    width,
    x,
    y,
  };
}

/**
 * jsdom gives every element a zero rect, which makes every dnd-kit collision
 * a tie. Lay the columns out left to right and put each card inside its
 * column so a drag has somewhere real to land.
 */
function installFakeLayout(window) {
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    // dnd-kit measures the drag overlay, not the source card, once an overlay
    // is rendered. In a browser the overlay sits exactly over the card it
    // replaced, so report the card's box for it.
    const self =
      this.dataset.testid === "community-task-drag-overlay"
        ? window.document.querySelector('[data-drag-state="dragging"]')
        : this;
    if (!self) return rect(0, 0, 0, 0);
    const owner = self.closest("[data-status]");
    const index = owner ? BOARD_ORDER.indexOf(owner.dataset.status) : -1;
    if (index < 0) return rect(0, 0, 0, 0);
    const left = index * COLUMN_STEP;
    return self.dataset.testid === "community-task-card"
      ? rect(left + 5, 50, COLUMN_WIDTH - 10, 40)
      : rect(left, 0, COLUMN_WIDTH, 400);
  };
}

/**
 * Installs a JSDOM window as the global document, with the extras dnd-kit
 * and Radix (Dialog/Sheet) need. Returns the dom so the caller can close it.
 */
export function installBoardTestDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  const { window } = dom;
  Object.assign(globalThis, {
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: window.MutationObserver,
    document: window.document,
    localStorage: window.localStorage,
    self: window,
    window,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: window.navigator,
  });
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  globalThis.matchMedia = window.matchMedia;
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = window.ResizeObserver;
  // Unref'd: a pending animation frame must not hold the test process open.
  globalThis.requestAnimationFrame = (callback) => {
    const handle = setTimeout(callback, 0);
    handle.unref?.();
    return handle;
  };
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  // Copy the DOM-level globals Radix's focus/dismiss machinery references
  // without a window. prefix (HTMLInputElement, NodeFilter, getComputedStyle…).
  for (const key of Object.getOwnPropertyNames(window)) {
    if (
      !(key in globalThis) &&
      (key.startsWith("HTML") ||
        key.startsWith("SVG") ||
        key.startsWith("CSS") ||
        [
          "Node",
          "NodeFilter",
          "NodeList",
          "NamedNodeMap",
          "Event",
          "CustomEvent",
          "MouseEvent",
          "KeyboardEvent",
          "FocusEvent",
          "InputEvent",
          "PointerEvent",
          "TouchEvent",
          "WheelEvent",
          "EventTarget",
          "Text",
          "Comment",
          "DocumentFragment",
          "Range",
          "Selection",
          "IntersectionObserver",
        ].includes(key))
    ) {
      const value = window[key];
      if (value !== undefined) globalThis[key] = value;
    }
  }
  // getComputedStyle must be bound to the window or it throws "Illegal invocation".
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  // Radix DismissableLayer and FocusScope dispatch plain objects via
  // dispatchEvent for layer coordination. JSDOM's strict Event validation
  // throws on these; drop non-Event objects so overlays render.
  const originalDispatch = window.EventTarget.prototype.dispatchEvent;
  window.EventTarget.prototype.dispatchEvent = function (event) {
    if (!(event instanceof window.Event)) return false;
    return originalDispatch.call(this, event);
  };
  globalThis.EventTarget = window.EventTarget;
  installFakeLayout(window);
  return dom;
}

/** Drive a full keyboard drag on `handle`: pick up, step `steps` columns, drop. */
export async function keyboardDrag(handle, steps) {
  const { act, fireEvent } = await import("@testing-library/react");
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  // dnd-kit's KeyboardSensor attaches its keydown listener in a `setTimeout`
  // after pickup, so an arrow key fired before that macrotask runs is simply
  // not heard. Yield one macrotask, then settle React between every press
  // (arrow keys are only read once the drag context has measured).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (let step = 0; step < Math.abs(steps); step += 1) {
    fireEvent.keyDown(handle, {
      code: steps > 0 ? "ArrowRight" : "ArrowLeft",
      key: steps > 0 ? "ArrowRight" : "ArrowLeft",
    });
    await act(async () => {});
  }
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});
}

/** Drive a full pointer drag from `handle` to the middle of `toStatus`. */
export async function pointerDrag(handle, toStatus) {
  const { act, fireEvent } = await import("@testing-library/react");
  const from = handle.getBoundingClientRect();
  const target = BOARD_ORDER.indexOf(toStatus) * COLUMN_STEP + COLUMN_WIDTH / 2;
  const pointer = { isPrimary: true, pointerId: 1 };
  fireEvent.pointerDown(handle, {
    ...pointer,
    button: 0,
    clientX: from.left,
    clientY: from.top,
  });
  // Past the 6px activation constraint, then onto the target column.
  fireEvent.pointerMove(globalThis.document, {
    ...pointer,
    clientX: from.left + 20,
    clientY: from.top,
  });
  await act(async () => {});
  fireEvent.pointerMove(globalThis.document, {
    ...pointer,
    clientX: target,
    clientY: 200,
  });
  await act(async () => {});
  fireEvent.pointerUp(globalThis.document, {
    ...pointer,
    clientX: target,
    clientY: 200,
  });
  await act(async () => {});
}

export function columnOf(container, taskId) {
  const card = container.querySelector(`[data-task-id="${taskId}"]`);
  return card?.closest("[data-status]")?.dataset.status ?? null;
}

export function handleFor(container, status) {
  return container.querySelector(
    `[data-status="${status}"] [data-testid='community-task-drag-handle']`,
  );
}

/** A merged card as `CommunityTasksBoard` receives it. */
export function makeTask(overrides = {}) {
  const id = overrides.id ?? "card-1";
  const author = overrides.author ?? "a".repeat(64);
  return {
    assignees: [],
    author,
    body: "",
    createdAt: 100,
    eventCreatedAt: 100,
    eventId: `${id}-event`,
    id,
    key: `${author}:${id}`,
    order: 1,
    signer: author,
    status: "todo",
    title: `Task ${id}`,
    updatedAt: 100,
    ...overrides,
  };
}
