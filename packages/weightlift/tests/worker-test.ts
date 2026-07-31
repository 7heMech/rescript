import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Weightlift } from "../src/store.js";
import {
  WEIGHTLIFT_MESSAGE_TYPE,
  attachWorker,
  createWorkerReporter,
  isWeightliftMessage,
} from "../src/worker.js";

describe("worker bridge", () => {
  it("forwards state snapshots over postMessage", () => {
    const wl = new Weightlift();
    const posted: unknown[] = [];
    const reporter = createWorkerReporter((msg) => posted.push(msg), wl);

    wl.start("Downloading…");
    wl.dispatch({ type: "progress_total", loaded: 25, total: 100 });

    assert.ok(posted.length >= 2);
    const last = posted[posted.length - 1];
    assert.equal(isWeightliftMessage(last), true);
    if (isWeightliftMessage(last) && last.kind === "state") {
      assert.equal(last.state.percent, 0.25);
      assert.equal(last.state.message, "Downloading…");
    }
    reporter.unsubscribe();
  });

  it("forwards raw events in event mode", () => {
    const wl = new Weightlift();
    const posted: unknown[] = [];
    const reporter = createWorkerReporter((msg) => posted.push(msg), wl, {
      mode: "event",
    });

    reporter.dispatch({ type: "start", message: "Go" });
    reporter.dispatch({ type: "progress_total", loaded: 1, total: 2 });

    assert.equal(posted.length, 2);
    assert.deepEqual(posted[0], {
      type: WEIGHTLIFT_MESSAGE_TYPE,
      kind: "event",
      event: { type: "start", message: "Go" },
    });
    assert.equal(wl.getSnapshot().percent, 0.5);
  });

  it("attachWorker rehydrates events on the main thread", () => {
    const main = new Weightlift();
    const listeners = new Set<(ev: MessageEvent) => void>();
    const worker = {
      addEventListener(_type: "message", listener: (ev: MessageEvent) => void) {
        listeners.add(listener);
      },
      removeEventListener(
        _type: "message",
        listener: (ev: MessageEvent) => void
      ) {
        listeners.delete(listener);
      },
      emit(data: unknown) {
        for (const l of listeners) l({ data } as MessageEvent);
      },
    };

    const stop = attachWorker(worker, main);
    worker.emit({
      type: WEIGHTLIFT_MESSAGE_TYPE,
      kind: "event",
      event: { type: "start", message: "Hi" },
    });
    worker.emit({
      type: WEIGHTLIFT_MESSAGE_TYPE,
      kind: "event",
      event: { type: "progress_total", loaded: 3, total: 4 },
    });

    assert.equal(main.getSnapshot().message, "Hi");
    assert.equal(main.getSnapshot().percent, 0.75);
    stop();
    assert.equal(listeners.size, 0);
  });
});
