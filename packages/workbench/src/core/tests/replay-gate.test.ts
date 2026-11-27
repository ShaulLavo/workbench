import { describe, expect, test } from "vitest";
import { createReplayGate } from "../replay-gate";

describe("createReplayGate", () => {
  test("restores scroll once on replay-complete and enables input only after first paint", () => {
    const scrolled: number[] = [];
    const refreshed: Array<[number, number]> = [];
    const readyStates: boolean[] = [];

    const gate = createReplayGate({
      terminal: {
        scrollBy: (delta) => scrolled.push(delta),
        refresh: (start, end) => refreshed.push([start, end]),
        getRowCount: () => 24,
      },
      getSavedScroll: () => ({ total: 500, length: 24, offset: 400 }),
      onReadyChange: (ready) => readyStates.push(ready),
    });

    gate.begin();
    expect(gate.phase()).toBe("replaying");
    gate.complete();
    expect(gate.phase()).toBe("awaiting-paint");
    expect(scrolled).toEqual([-76]);
    expect(refreshed).toEqual([[0, 23]]);
    expect(readyStates).toEqual([false]);

    gate.paint();
    expect(gate.phase()).toBe("ready");
    expect(readyStates).toEqual([false, true]);

    // Second replay (reconnect) does not restore old scroll a second time.
    gate.begin();
    gate.complete();
    gate.paint();
    expect(scrolled).toEqual([-76]);
    expect(readyStates).toEqual([false, true, false, true]);

    gate.close();
    expect(gate.phase()).toBe("closed");
  });
});
