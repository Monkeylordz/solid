import { afterEach, describe, expect, it } from "vitest";
import {
  action,
  createMemo,
  createOptimistic,
  createRenderEffect,
  createRoot,
  createSignal,
  createStore,
  createTrackedEffect,
  flush,
  independent
} from "../src/index.js";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  flush();
});
function root<T>(fn: () => T): T {
  return createRoot(dispose => {
    disposers.push(dispose);
    return fn();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  flush();
}
function render<T>(read: () => T): T[] {
  const values: T[] = [];
  createRenderEffect(read, value => {
    values.push(value);
  });
  return values;
}

describe("independent", () => {
  it("applies a shared render in a surviving old subtree after its inputs commit", async () => {
    const gate = deferred<number>();
    const { setRoute, setA, setB, pairs } = root(() => {
      const [route, setRoute] = createSignal(0),
        [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      const pairs: string[] = [];
      render(
        createMemo(() => {
          if (route()) return gate.promise;
          createRenderEffect(
            () => `${a()}:${b()}`,
            value => {
              pairs.push(value);
            }
          );
          return 0;
        })
      );
      return { setRoute, setA, setB, pairs };
    });
    flush();
    independent(() => setRoute(1));
    flush();
    independent(() => setA(1));
    independent(() => setB(1));
    flush();
    expect(pairs).toEqual(["0:0", "1:1"]);
    gate.resolve(1);
    await settle();
  });
  it.each([false, true])(
    "applies shared renders before participating user effects (%s)",
    reverse => {
      const events: string[] = [];
      let displayed = "";
      const { setA, setB } = root(() => {
        const [a, setA] = createSignal(0),
          [b, setB] = createSignal(0);
        createRenderEffect(
          () => `${a()}:${b()}`,
          value => {
            displayed = value;
            events.push(`render:${value}`);
          }
        );
        createTrackedEffect(() => {
          events.push(`user:${a()}:${displayed}`);
        });
        return { setA, setB };
      });
      flush();
      events.length = 0;
      if (reverse) independent(() => setB(1));
      independent(() => setA(1));
      if (!reverse) independent(() => setB(1));
      flush();
      expect(events).toEqual(["render:1:1", "user:1:1:1"]);
    }
  );

  it("keeps unchanged-pass dependencies until their group commits", async () => {
    const gate = deferred<number>();
    const { setA, setB, a, b, selected } = root(() => {
      const [a, setA] = createSignal(1),
        [b, setB] = createSignal(0);
      render(createMemo(() => (b() ? gate.promise : 0)));
      return {
        setA,
        setB,
        a: render(a),
        b: render(b),
        selected: render(createMemo(() => (b() ? b() : a())))
      };
    });
    flush();
    independent(() => setB(1));
    flush();
    setA(2);
    flush();
    expect([a, b, selected]).toEqual([[1], [0], [1]]);
    gate.resolve(1);
    await settle();
    expect(a).toEqual([1, 2]);
  });

  it("updates a displayed old subtree independently of an unrelated hold", async () => {
    const routeGate = deferred<number>(),
      otherGate = deferred<number>();
    const { setRoute, setOther, setVersion, versions } = root(() => {
      const [route, setRoute] = createSignal(0),
        [other, setOther] = createSignal(0),
        [version, setVersion] = createSignal(0);
      const versions: number[] = [];
      const routeView = createMemo(() => {
        if (route()) return routeGate.promise;
        const child = createMemo(version);
        createRenderEffect(child, value => {
          versions.push(value);
        });
        return 0;
      });
      render(routeView);
      render(createMemo(() => (other() ? otherGate.promise : 0)));
      return { setRoute, setOther, setVersion, versions };
    });
    flush();
    independent(() => setRoute(1));
    flush();
    setOther(1);
    independent(() => setVersion(1));
    flush();
    expect(versions).toEqual([0, 1]);
    routeGate.resolve(1);
    otherGate.resolve(1);
    await settle();
  });
  it("consumes ordinary notification ownership before a later independent write", async () => {
    const gate = deferred<number>();
    const { setA, setB, a } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      render(createMemo(() => (b() ? gate.promise : 0)));
      return { setA, setB, a: render(createMemo(() => a() * 10)) };
    });
    setA(1);
    flush();
    setB(1);
    independent(() => setA(2));
    flush();
    expect(a).toEqual([0, 10, 20]);
    gate.resolve(1);
    await settle();
  });

  it("callback writes after one group lands remain live while another waits", async () => {
    const ga = deferred<number>(),
      gb = deferred<number>();
    const { setA, setB, c } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0),
        [c, setC] = createSignal(0);
      createRenderEffect(
        createMemo(() => (a() ? ga.promise : 0)),
        value => {
          if (value) setC(1);
        }
      );
      render(createMemo(() => (b() ? gb.promise : 0)));
      return { setA, setB, c: render(c) };
    });
    flush();
    independent(() => setA(1));
    independent(() => setB(1));
    flush();
    ga.resolve(1);
    await settle();
    expect(c).toEqual([0, 1]);
    gb.resolve(1);
    await settle();
  });

  it("parents optimistic writes to their independent group", async () => {
    const gate = deferred<number>();
    const { setA, setGuess, guesses } = root(() => {
      const [a, setA] = createSignal(0);
      const [guess, setGuess] = createOptimistic(0);
      render(createMemo(() => (a() ? gate.promise : 0)));
      return { setA, setGuess, guesses: render(guess) };
    });
    flush();
    independent(() => {
      setA(1);
      setGuess(9);
    });
    flush();
    expect(guesses).toEqual([0, 9]);
    gate.resolve(1);
    await settle();
    expect(guesses).toEqual([0, 9, 0]);
  });
  it("batches repeated writes and preserves the normal render/user phases", async () => {
    const events: string[] = [];
    const { value, setValue } = root(() => {
      const [value, setValue] = createSignal(0);
      createRenderEffect(value, v => {
        events.push(`render:${v}`);
      });
      createTrackedEffect(() => {
        events.push(`user:${value()}`);
      });
      return { value, setValue };
    });
    flush();
    events.length = 0;
    independent(() => {
      setValue(1);
      setValue(v => v + 1);
    });
    expect(value()).toBe(0);
    expect(events).toEqual([]);
    await settle();
    expect(events).toEqual(["render:2", "user:2"]);
  });

  it("retains atomicity across an explicit flush inside the callback", () => {
    const { a, b, setA, setB } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      return { a: render(a), b: render(b), setA, setB };
    });
    flush();
    independent(() => {
      setA(1);
      flush();
      expect([a, b]).toEqual([[0], [0]]);
      setB(1);
    });
    flush();
    expect([a, b]).toEqual([
      [0, 1],
      [0, 1]
    ]);
  });

  it("ends the scope at synchronous return", async () => {
    const gate = deferred<number>();
    const { a, b, setA, setB } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      render(createMemo(() => (a() ? gate.promise : 0)));
      return { a: render(a), b: render(b), setA, setB };
    });
    flush();
    independent(async () => {
      setA(1);
      await Promise.resolve();
      setB(1);
    });
    await settle();
    expect([a, b]).toEqual([[0], [0, 1]]);
    gate.resolve(1);
    await settle();
  });

  it("an independent write can escape an action's open lifetime", async () => {
    const gate = deferred<void>();
    const { a, b, setA, setB } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      return { a: render(a), b: render(b), setA, setB };
    });
    flush();
    const run = action(function* () {
      setA(1);
      independent(() => setB(1));
      yield gate.promise;
      setA(2);
    });
    const result = run();
    flush();
    expect([a, b]).toEqual([[0], [0, 1]]);
    gate.resolve();
    await result;
    await settle();
    expect(a).toEqual([0, 2]);
  });

  it("separate held groups sharing one effect reveal in either completion order", async () => {
    const ga = deferred<number>(),
      gb = deferred<number>();
    const { setA, setB, pairs } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      const av = createMemo(() => (a() ? ga.promise : 0));
      const bv = createMemo(() => (b() ? gb.promise : 0));
      return { setA, setB, pairs: render(() => `${av()}:${bv()}`) };
    });
    flush();
    independent(() => setA(1));
    independent(() => setB(1));
    flush();
    expect(pairs).toEqual(["0:0"]);
    ga.resolve(1);
    await settle();
    expect(pairs).toEqual(["0:0", "1:0"]);
    gb.resolve(1);
    await settle();
    expect(pairs).toEqual(["0:0", "1:0", "1:1"]);
  });

  it.each([false, true])("separates consumer writes in either callback order (%s)", async first => {
    const gate = deferred<number>();
    const { menu, setMenu, setPage, menus, pages } = root(() => {
      const [menu, setMenu] = createSignal(true);
      const [page, setPage] = createSignal(0);
      const data = createMemo(() => (page() ? gate.promise : 0));
      return { menu, setMenu, setPage, menus: render(menu), pages: render(data) };
    });
    flush();
    if (first) independent(() => setMenu(false));
    setPage(1);
    if (!first) independent(() => setMenu(false));
    expect(menu()).toBe(true);
    expect(menus).toEqual([true]);
    await settle();
    expect(menus).toEqual([true, false]);
    expect(pages).toEqual([0]);
    gate.resolve(1);
    await settle();
    expect(pages).toEqual([0, 1]);
  });

  it("retains ordinary grouping around an independent invocation", async () => {
    const gate = deferred<number>();
    const { setA, setB, setC, a, b, c } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0),
        [c, setC] = createSignal(0);
      const data = createMemo(() => (a() ? gate.promise : 0));
      render(data);
      return { setA, setB, setC, a: render(a), b: render(b), c: render(c) };
    });
    flush();
    setA(1);
    independent(() => setB(1));
    setC(1);
    flush();
    expect([a, b, c]).toEqual([[0], [0, 1], [0]]);
    gate.resolve(1);
    await settle();
    expect([a, b, c]).toEqual([
      [0, 1],
      [0, 1],
      [0, 1]
    ]);
  });

  it.each([false, true])("keeps separate asynchronous groups independent (%s)", async reverse => {
    const ga = deferred<number>(),
      gb = deferred<number>();
    const { setA, setB, a, b } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      render(createMemo(() => (a() ? ga.promise : 0)));
      render(createMemo(() => (b() ? gb.promise : 0)));
      return { setA, setB, a: render(a), b: render(b) };
    });
    flush();
    independent(() => setA(1));
    independent(() => setB(1));
    flush();
    (reverse ? gb : ga).resolve(1);
    await settle();
    expect([a, b]).toEqual(reverse ? [[0], [0, 1]] : [[0, 1], [0]]);
    (reverse ? ga : gb).resolve(1);
    await settle();
    expect([a, b]).toEqual([
      [0, 1],
      [0, 1]
    ]);
  });

  it("holds all writes in one invocation together", async () => {
    const gate = deferred<number>();
    const { setA, setB, a, b } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      render(createMemo(() => (a() ? gate.promise : 0)));
      return { setA, setB, a: render(a), b: render(b) };
    });
    flush();
    independent(() => {
      setA(1);
      setB(1);
    });
    flush();
    expect([a, b]).toEqual([[0], [0]]);
    gate.resolve(1);
    await settle();
    expect([a, b]).toEqual([
      [0, 1],
      [0, 1]
    ]);
  });

  it("entangles groups through a shared derivation", async () => {
    const gate = deferred<number>();
    const { setA, setB, a, b, sum } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      const data = createMemo(() => (a() ? gate.promise : 0));
      const sum = createMemo(() => data() + b());
      return { setA, setB, a: render(a), b: render(b), sum: render(sum) };
    });
    flush();
    setA(1);
    independent(() => setB(1));
    flush();
    expect([a, b, sum]).toEqual([[0], [0], [0]]);
    gate.resolve(1);
    await settle();
    expect([a, b, sum]).toEqual([
      [0, 1],
      [0, 1],
      [0, 2]
    ]);
  });

  it.each([false, true])(
    "a shared render effect observes each committed group (%s)",
    async reverse => {
      const gate = deferred<number>();
      const { setA, setB, pairs } = root(() => {
        const [a, setA] = createSignal(0),
          [b, setB] = createSignal(0);
        const data = createMemo(() => (a() ? gate.promise : 0));
        return { setA, setB, pairs: render(() => `${data()}:${b()}`) };
      });
      flush();
      if (reverse) independent(() => setB(1));
      setA(1);
      if (!reverse) independent(() => setB(1));
      flush();
      expect(pairs).toEqual(["0:0", "0:1"]);
      gate.resolve(1);
      await settle();
      expect(pairs).toEqual(["0:0", "0:1", "1:1"]);
    }
  );

  it("does not merge through an unchanged intermediate", async () => {
    const gate = deferred<number>();
    const { setA, setB, b } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      render(createMemo(() => (a() ? gate.promise : 0)));
      const same = createMemo(() => a() % 2);
      render(createMemo(() => same() + b()));
      return { setA, setB, b: render(b) };
    });
    flush();
    setA(2);
    independent(() => setB(1));
    flush();
    expect(b).toEqual([0, 1]);
    gate.resolve(2);
    await settle();
  });

  it("joins an already held signal even for an equal write", async () => {
    const gate = deferred<number>();
    const { setA, setB, b } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      render(createMemo(() => (a() ? gate.promise : 0)));
      return { setA, setB, b: render(b) };
    });
    flush();
    setA(1);
    flush();
    independent(() => {
      setA(1);
      setB(1);
    });
    flush();
    expect(b).toEqual([0]);
    gate.resolve(1);
    await settle();
    expect(b).toEqual([0, 1]);
  });

  it("restores the surrounding group after nesting and exceptions", async () => {
    const gate = deferred<number>();
    const { setA, setB, setC, a, b, c } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0),
        [c, setC] = createSignal(0);
      render(createMemo(() => (a() ? gate.promise : 0)));
      return { setA, setB, setC, a: render(a), b: render(b), c: render(c) };
    });
    flush();
    expect(() =>
      independent(() => {
        setA(1);
        independent(() => setB(1));
        setC(1);
        throw new Error("callback");
      })
    ).toThrow("callback");
    flush();
    expect([a, b, c]).toEqual([[0], [0, 1], [0]]);
    gate.resolve(1);
    await settle();
  });

  it("keeps separate store backings in their own groups", async () => {
    const gate = deferred<number>();
    const { setA, setB, a, b } = root(() => {
      const [a, setA] = createStore({ value: 0, unread: 0 });
      const [b, setB] = createStore({ value: 0, unread: 0 });
      render(createMemo(() => (a.value ? gate.promise : 0)));
      return { setA, setB, a: render(() => a.value), b: render(() => b.value) };
    });
    flush();
    setA(d => {
      d.value = 1;
      d.unread = 1;
    });
    independent(() =>
      setB(d => {
        d.value = 1;
        d.unread = 1;
      })
    );
    flush();
    expect([a, b]).toEqual([[0], [0, 1]]);
    gate.resolve(1);
    await settle();
    expect([a, b]).toEqual([
      [0, 1],
      [0, 1]
    ]);
  });
});
