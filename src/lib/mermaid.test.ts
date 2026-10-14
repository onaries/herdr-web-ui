import { expect, it, mock } from "bun:test";

it("renders concurrent diagrams without removing another render's container", async () => {
  const containers = new Map<string, { remove: () => void }>();
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById: (id: string) => containers.get(id) ?? null,
      querySelectorAll: () => [...containers.values()],
    },
  });

  let finishSecond: (() => void) | undefined;
  mock.module("mermaid", () => ({
    default: {
      initialize: () => {},
      render: (id: string, source: string) => {
        const containerId = `d${id}`;
        containers.set(containerId, { remove: () => { containers.delete(containerId); } });
        if (source === "first") return Promise.resolve({ svg: "<svg>first</svg>" });
        return new Promise<{ svg: string }>((resolve, reject) => {
          finishSecond = () => containers.has(containerId)
            ? resolve({ svg: "<svg>second</svg>" })
            : reject(new Error("another render removed this diagram's container"));
        });
      },
    },
  }));

  try {
    const { renderMermaid } = await import("./mermaid.ts");
    const first = renderMermaid("first", true);
    const second = renderMermaid("second", true);
    expect(await first).toBe("<svg>first</svg>");
    finishSecond?.();
    expect(await second).toBe("<svg>second</svg>");
    expect(containers.size).toBe(0);
  } finally {
    if (documentBefore) Object.defineProperty(globalThis, "document", documentBefore);
    else Reflect.deleteProperty(globalThis, "document");
    mock.restore();
  }
});
