import "@testing-library/jest-dom";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    clear: () => {
      store = {};
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    length: 0,
    key: () => null,
  };
})();

Object.defineProperty(global, "localStorage", {
  value: localStorageMock,
  writable: true,
});

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  writable: true,
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(global, "ResizeObserver", {
  value: ResizeObserverMock,
  writable: true,
});

Object.defineProperty(window, "ResizeObserver", {
  value: ResizeObserverMock,
  writable: true,
});

// jsdom implements neither. The reader loads page images through fetch + blob URLs (AUDIT-S4
// removed the `?token=` path `<img>` relied on), so without these every reader test silently
// renders the image-error state. Individual tests still override with spies where they assert.
let objectUrlSeq = 0;
Object.defineProperty(URL, "createObjectURL", {
  value: () => `blob:http://localhost/${++objectUrlSeq}`,
  writable: true,
});

Object.defineProperty(URL, "revokeObjectURL", {
  value: () => {},
  writable: true,
});

class MockEventSource {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_url: string) {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

Object.defineProperty(global, "EventSource", {
  value: MockEventSource,
  writable: true,
});

Object.defineProperty(window, "EventSource", {
  value: MockEventSource,
  writable: true,
});
