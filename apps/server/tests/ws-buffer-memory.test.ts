import { describe, expect, it } from "vitest";
import { WsBufferMemory } from "../src/lib/ws-upload.js";

describe("WsBufferMemory", () => {
  it("is full above its limit and not before", () => {
    const memory = new WsBufferMemory(100);
    memory.take(100);
    expect(memory.full()).toBe(false);
    memory.take(1);
    expect(memory.full()).toBe(true);
  });

  it("lets waiting sessions go on, the longest waiting first, once below three quarters", () => {
    const memory = new WsBufferMemory(100);
    const order: string[] = [];
    memory.take(120);
    memory.wait(() => (order.push("first"), true));
    memory.wait(() => (order.push("second"), true));

    memory.give(40); // 80, below the limit but above three quarters
    expect(order).toEqual([]);
    memory.give(10); // 70
    expect(order).toEqual(["first", "second"]);

    // Both went on, so a later release asks neither again.
    memory.give(10);
    expect(order).toEqual(["first", "second"]);
  });

  it("keeps a session waiting that cannot go on yet and asks it again on the next release", () => {
    const memory = new WsBufferMemory(100);
    let ready = false;
    let asked = 0;
    memory.take(100);
    memory.wait(() => {
      asked++;
      return ready;
    });

    memory.give(50);
    expect(asked).toBe(1);
    ready = true;
    memory.give(10);
    expect(asked).toBe(2);
    memory.give(10);
    expect(asked).toBe(2);
  });

  it("stops waking sessions while one that went on fills it again", () => {
    const memory = new WsBufferMemory(100);
    const order: string[] = [];
    memory.take(100);
    memory.wait(() => {
      order.push("first");
      memory.take(30);
      return true;
    });
    memory.wait(() => (order.push("second"), true));

    memory.give(40); // 60, then the first takes 30 and leaves 90
    expect(order).toEqual(["first"]);
  });

  it("forgets a session that closed while it waited", () => {
    const memory = new WsBufferMemory(100);
    let asked = 0;
    const resume = () => (asked++, true);
    memory.take(120);
    memory.wait(resume);
    memory.forget(resume);
    memory.give(120);
    expect(asked).toBe(0);
    expect(memory.bytes).toBe(0);
  });
});
