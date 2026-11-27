import { describe, expect, test } from "vitest";
import {
  createCommandRegistry,
  createSubscribable,
  type FileSystemAdapter,
  type PreviewAdapter,
  type PreviewFrameEvent,
} from "../index";

/**
 * Pre-freeze contract validation spike for Consumer 3 (future vibe-coding platform):
 * exercises an agent prompt flow (@file mention lookup -> /slash command -> submit round trip)
 * and a bridge-less remote preview controller.
 */
describe("Consumer 3 vibe-builder pre-freeze contract spike", () => {
  test("exercises @file mention resolution, /slash command, submit round trip, and bridge-less remote preview", async () => {
    const files = new Map<string, string>([
      ["src/App.tsx", "export function App() { return <h1>Hello</h1>; }\n"],
      ["src/styles.css", "body { margin: 0; }\n"],
    ]);

    const fsAdapter: FileSystemAdapter = {
      workspaceId: "builder:sandbox-1",
      writable: createSubscribable(true),
      listFiles: async () => Array.from(files.keys()),
      readText: async (path) => files.get(path),
      createFile: async (path, content) => {
        files.set(path, typeof content === "string" ? content : "");
      },
      createDirectory: async () => {},
      move: async () => {},
      remove: async (path) => {
        files.delete(path);
      },
    };

    const submittedPrompts: Array<{ text: string; mentions: readonly string[] }> = [];
    const commands = createCommandRegistry();
    commands.register([
      {
        id: "agent.refactor",
        label: "/refactor",
        category: "Agent",
        run: () => {
          submittedPrompts.push({
            text: "/refactor @src/App.tsx add dark mode toggle",
            mentions: ["src/App.tsx"],
          });
        },
      },
    ]);

    // 1. Mention lookup via FileSystemAdapter
    const candidates = (await fsAdapter.listFiles()).filter((file) => file.includes("App"));
    expect(candidates).toEqual(["src/App.tsx"]);
    expect(await fsAdapter.readText("src/App.tsx")).toContain("Hello");

    // 2. Slash command discovery + submit round trip
    const slash = commands.commands.getSnapshot().find((c) => c.label === "/refactor");
    expect(slash?.id).toBe("agent.refactor");
    expect(await commands.execute("agent.refactor")).toBe(true);
    expect(submittedPrompts).toEqual([
      { text: "/refactor @src/App.tsx add dark mode toggle", mentions: ["src/App.tsx"] },
    ]);

    // 3. Bridge-less remote preview controller (no injected script, steers by frame.src)
    const frameEvents: PreviewFrameEvent[] = [];
    const preview: PreviewAdapter = {
      kind: "remote",
      servers: createSubscribable([
        { port: 3000, label: "sandbox", url: "https://sandbox-3000.example.dev" },
      ]),
      whenReady: async () => {},
      frameUrl: (port, path) => `https://sandbox-${port}.example.dev${path}`,
      tabUrl: (port, path) => `https://sandbox-${port}.example.dev${path}`,
      locate: (href) => {
        const parsed = URL.parse(href);
        if (!parsed || parsed.hostname !== "sandbox-3000.example.dev") return undefined;
        return { port: 3000, path: `${parsed.pathname}${parsed.search}${parsed.hash}` };
      },
      attachFrame: (frame, port, onEvent) => {
        return {
          onFrameLoad: () => onEvent({ type: "bridge-ready", supported: false }),
          navigate: (path) => {
            frame.src = `https://sandbox-${port}.example.dev${path}`;
            onEvent({ type: "navigate", location: { port, path } });
          },
          reload: () => {
            frame.setAttribute("src", frame.getAttribute("src") ?? "");
          },
          back: () => {},
          forward: () => {},
          dispose: () => {},
        };
      },
    };

    const iframe = document.createElement("iframe");
    const controller = preview.attachFrame(iframe, 3000, (event) => frameEvents.push(event));
    controller.onFrameLoad();
    controller.navigate("/dashboard?tab=metrics");
    expect(iframe.src).toBe("https://sandbox-3000.example.dev/dashboard?tab=metrics");
    expect(frameEvents).toEqual([
      { type: "bridge-ready", supported: false },
      { type: "navigate", location: { port: 3000, path: "/dashboard?tab=metrics" } },
    ]);
    controller.dispose();
  });
});
