import { describe, expect, it } from "vitest";
import {
  action,
  createEffect,
  createErrorBoundary,
  createMemo,
  createRenderEffect,
  createRoot,
  createSignal,
  flush,
  independent,
  isPending,
  latest,
  onCleanup,
  untrack
} from "../src/index.js";
import { deferred, render, root, settle, task } from "./independent-helpers.js";

describe("independent overlapping updates", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])("supersedes a shared signal (flushed=%s, stale first=%s)", async (flushed, staleFirst) => {
    const old = deferred<number>(),
      next = deferred<number>();
    const { setA, setB, pairs, dataValues } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      const data = createMemo(() => (a() === 1 ? old.promise : a() === 2 ? next.promise : 0));
      return { setA, setB, pairs: render(() => [a(), b()]), dataValues: render(data) };
    });
    flush();
    independent(() => setA(1));
    if (flushed) flush();
    independent(() => {
      setA(v => v + 1);
      setB(1);
    });
    flush();
    expect(pairs).toEqual([[0, 0]]);
    (staleFirst ? old : next).resolve(staleFirst ? 1 : 2);
    await settle();
    expect(pairs).toEqual(
      staleFirst
        ? [[0, 0]]
        : [
            [0, 0],
            [2, 1]
          ]
    );
    expect(dataValues).toEqual(staleFirst ? [0] : [0, 2]);
    (staleFirst ? next : old).resolve(staleFirst ? 2 : 1);
    await settle();
    expect(pairs).toEqual([
      [0, 0],
      [2, 1]
    ]);
    expect(dataValues).toEqual([0, 2]);
  });

  it("cancels a held input back to its committed value without waiting on the stale flight", async () => {
    const gate = deferred<number>();
    const { setA, setB, values, data } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      return {
        setA,
        setB,
        values: render(() => [a(), b()]),
        data: render(createMemo(() => (a() ? gate.promise : 0)))
      };
    });
    flush();
    independent(() => setA(1));
    flush();
    independent(() => {
      setA(0);
      setB(1);
    });
    await task();
    expect(values).toEqual([
      [0, 0],
      [0, 1]
    ]);
    gate.reject(new Error("obsolete"));
    await task();
    expect(values).toEqual([
      [0, 0],
      [0, 1]
    ]);
    expect(data).toEqual([0]);
  });

  it("an equal write to committed state does not join an unrelated hold", async () => {
    const gate = deferred<number>();
    const { setA, setB, setC, b, c } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0),
        [c, setC] = createSignal(0);
      render(createMemo(() => (a() ? gate.promise : 0)));
      return { setA, setB, setC, b: render(b), c: render(c) };
    });
    flush();
    setA(1);
    setB(0);
    independent(() => {
      setB(0);
      setC(1);
    });
    flush();
    expect([b, c]).toEqual([[0], [0, 1]]);
    gate.resolve(1);
    await settle();
    expect([b, c]).toEqual([[0], [0, 1]]);
  });

  it.each([false, true])("merges three nested open groups transitively (%s)", async reverse => {
    const ga = deferred<number>(),
      gb = deferred<number>();
    const { setA, setB, setC, setD, values } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      const [c, setC] = createSignal(0),
        [d, setD] = createSignal(0);
      render(createMemo(() => (a() ? ga.promise : 0)));
      render(createMemo(() => (b() ? gb.promise : 0)));
      return { setA, setB, setC, setD, values: render(() => [a(), b(), c(), d()]) };
    });
    flush();
    independent(() => {
      setA(1);
      independent(() => {
        setB(1);
        independent(() => {
          setA(2);
          setB(2);
          setC(1);
        });
        flush();
        expect(values).toEqual([[0, 0, 0, 0]]);
      });
      setD(1);
      flush();
      expect(values).toEqual([[0, 0, 0, 0]]);
    });
    flush();
    (reverse ? gb : ga).resolve(2);
    await settle();
    expect(values).toEqual([[0, 0, 0, 0]]);
    (reverse ? ga : gb).resolve(2);
    await settle();
    expect(values).toEqual([
      [0, 0, 0, 0],
      [2, 2, 1, 1]
    ]);
  });
});

describe("independent lifetime and failure", () => {
  it("releases a rejected group and recovers while another group remains held", async () => {
    const failed = deferred<number>(),
      other = deferred<number>();
    let reset!: () => void;
    const { setA, setB, setC, a, b, c } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0),
        [c, setC] = createSignal(0);
      const data = createMemo(() => (a() ? failed.promise : 0));
      const boundary = createErrorBoundary(
        () => data(),
        (_, retry) => {
          reset = retry;
          return -1;
        }
      );
      render(createMemo(() => (c() ? other.promise : 0)));
      return { setA, setB, setC, a: render(boundary), b: render(b), c: render(c) };
    });
    flush();
    independent(() => {
      setA(1);
      setB(1);
    });
    independent(() => setC(1));
    await task();
    expect([a, b, c]).toEqual([[0], [0], [0]]);
    failed.reject(new Error("failed"));
    await task();
    expect([a, b, c]).toEqual([[0, -1], [0, 1], [0]]);
    independent(() => {
      setA(0);
      reset();
    });
    await task();
    expect([a, b, c]).toEqual([[0, -1, 0], [0, 1], [0]]);
    other.resolve(1);
    await task();
    expect(c).toEqual([0, 1]);
  });

  it.each([false, true])(
    "disposing the last blocker releases surviving writes (reject=%s)",
    async reject => {
      const gate = deferred<number>();
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      const dataValues: number[] = [];
      let disposeReader!: () => void,
        cleanups = 0;
      root(() => {
        disposeReader = createRoot(dispose => {
          onCleanup(() => {
            cleanups++;
          });
          createRenderEffect(
            createMemo(() => (a() ? gate.promise : 0)),
            value => {
              dataValues.push(value);
            }
          );
          return dispose;
        });
      });
      const values = root(() => render(b));
      flush();
      independent(() => {
        setA(1);
        setB(1);
      });
      await task();
      expect(values).toEqual([0]);
      disposeReader();
      await task();
      expect(values).toEqual([0, 1]);
      expect(cleanups).toBe(1);
      reject ? gate.reject(new Error("disposed")) : gate.resolve(1);
      await task();
      expect(dataValues).toEqual([0]);
      expect(values).toEqual([0, 1]);
      expect(cleanups).toBe(1);
    }
  );

  it("a caught inner exception restores outer ownership and later ordinary writes", async () => {
    const gate = deferred<number>();
    const { setA, setB, setC, setD, values } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      const [c, setC] = createSignal(0),
        [d, setD] = createSignal(0);
      render(createMemo(() => (a() ? gate.promise : 0)));
      return { setA, setB, setC, setD, values: [render(a), render(b), render(c), render(d)] };
    });
    flush();
    independent(() => {
      setA(1);
      expect(() =>
        independent(() => {
          setB(1);
          throw new Error("inner");
        })
      ).toThrow("inner");
      setC(1);
    });
    setD(1);
    await task();
    expect(values).toEqual([[0], [0, 1], [0], [0, 1]]);
    gate.resolve(1);
    await task();
    expect(values).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1]
    ]);
  });

  it("an action started inside a group retains that group's sibling writes across yields", async () => {
    const gate = deferred<void>();
    const { setA, setB, values } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      return { setA, setB, values: render(() => [a(), b()]) };
    });
    const run = action(function* () {
      setA(1);
      yield gate.promise;
      setA(2);
    });
    flush();
    let result!: Promise<void>;
    independent(() => {
      result = run();
      setB(1);
    });
    await task();
    expect(values).toEqual([[0, 0]]);
    gate.resolve();
    await result;
    await task();
    expect(values).toEqual([
      [0, 0],
      [2, 1]
    ]);
  });
});

describe("independent read postures", () => {
  it.each(["latest", "pending"] as const)(
    "a shared %s memo still entangles dirty inputs",
    async posture => {
      const gate = deferred<number>();
      const { setA, setB, b, ordinary, verdict } = root(() => {
        const [a, setA] = createSignal(0),
          [b, setB] = createSignal(0);
        const data = createMemo(() => (a() ? gate.promise : 0));
        // Unlike a shared render, this pure derivation is dirtied by both
        // groups. A verdict read does not erase that shared dependency.
        const verdict = createMemo(() => [
          posture === "latest" ? latest(data) : isPending(data),
          b()
        ]);
        return { setA, setB, b: render(b), ordinary: render(data), verdict: render(verdict) };
      });
      flush();
      independent(() => setA(1));
      independent(() => setB(1));
      flush();
      expect([b, ordinary]).toEqual([[0], [0]]);
      gate.resolve(1);
      await settle();
      expect([b, ordinary]).toEqual([
        [0, 1],
        [0, 1]
      ]);
      expect(verdict.at(-1)).toEqual([posture === "latest" ? 1 : false, 1]);
    }
  );

  it.each(["latest", "pending"] as const)(
    "%s does not entangle a separate group",
    async posture => {
      const gate = deferred<number>();
      const { setA, setB, b, ordinary, verdict } = root(() => {
        const [a, setA] = createSignal(0),
          [b, setB] = createSignal(0);
        const data = createMemo(() => (a() ? gate.promise : 0));
        return {
          setA,
          setB,
          b: render(b),
          ordinary: render(data),
          verdict: render(() => [posture === "latest" ? latest(data) : isPending(data), b()])
        };
      });
      flush();
      independent(() => setA(1));
      independent(() => setB(1));
      flush();
      expect(b).toEqual([0, 1]);
      expect(ordinary).toEqual([0]);
      expect(verdict.at(-1)).toEqual([posture === "latest" ? 0 : true, 1]);
      gate.resolve(1);
      await settle();
      expect(ordinary).toEqual([0, 1]);
      expect(verdict.at(-1)).toEqual([posture === "latest" ? 1 : false, 1]);
    }
  );

  it("untrack suppresses subscriptions but still joins a derivation of held state", async () => {
    const gate = deferred<number>();
    let runs = 0;
    const { setA, setB, b, selected } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0);
      render(createMemo(() => (a() ? gate.promise : 0)));
      const selected = createMemo(() => {
        runs++;
        return b() + untrack(a);
      });
      return { setA, setB, b: render(b), selected: render(selected) };
    });
    flush();
    independent(() => setA(1));
    flush();
    independent(() => setB(1));
    flush();
    expect([b, selected]).toEqual([[0], [0]]);
    gate.resolve(1);
    await settle();
    expect([b, selected]).toEqual([
      [0, 1],
      [0, 2]
    ]);
    const before = runs;
    setA(0);
    await settle();
    expect(runs).toBe(before);
    expect(selected).toEqual([0, 2]);
    setB(3);
    await settle();
    expect(selected).toEqual([0, 2, 3]);
  });

  it.each([false, true])(
    "late readers distinguish new held derivations from cached memos (existing=%s)",
    async existing => {
      const gate = deferred<number>();
      const { a, setA, setB, b } = root(() => {
        const [a, setA] = createSignal(0),
          [b, setB] = createSignal(0);
        render(createMemo(() => (a() ? gate.promise : 0)));
        return { a, setA, setB, b: render(b) };
      });
      const memo = existing ? root(() => createMemo(() => a() * 10)) : undefined;
      flush();
      independent(() => {
        setA(1);
        setB(1);
      });
      flush();
      const values = root(() => render(memo ?? createMemo(() => a() * 10)));
      flush();
      expect(values).toEqual(existing ? [0] : []);
      expect(b).toEqual([0]);
      gate.resolve(1);
      await settle();
      expect(values).toEqual(existing ? [0, 10] : [10]);
      expect(b).toEqual([0, 1]);
      setA(0);
      await settle();
      expect(values).toEqual(existing ? [0, 10, 0] : [10, 0]);
    }
  );
});

describe("independent scheduling", () => {
  it.each([false, true])(
    "a shared render publishes each group without manual flushing (%s)",
    async reverse => {
      const ga = deferred<number>(),
        gb = deferred<number>();
      const { setA, setB, pairs } = root(() => {
        const [a, setA] = createSignal(0),
          [b, setB] = createSignal(0);
        const av = createMemo(() => (a() ? ga.promise : 0)),
          bv = createMemo(() => (b() ? gb.promise : 0));
        return { setA, setB, pairs: render(() => [av(), bv()]) };
      });
      await task();
      independent(() => setA(1));
      independent(() => setB(1));
      await task();
      expect(pairs).toEqual([[0, 0]]);
      (reverse ? gb : ga).resolve(1);
      await task();
      expect(pairs).toEqual([[0, 0], reverse ? [0, 1] : [1, 0]]);
      (reverse ? ga : gb).resolve(1);
      await task();
      expect(pairs).toEqual([[0, 0], reverse ? [0, 1] : [1, 0], [1, 1]]);
    }
  );

  it("a user effect can start another group while a sibling remains held", async () => {
    const ga = deferred<number>(),
      gb = deferred<number>();
    const events: string[] = [];
    const { setA, setB, c, b } = root(() => {
      const [a, setA] = createSignal(0),
        [b, setB] = createSignal(0),
        [c, setC] = createSignal(0);
      const data = createMemo(() => (a() ? ga.promise : 0));
      render(createMemo(() => (b() ? gb.promise : 0)));
      createRenderEffect(c, v => {
        events.push(`render:${v}`);
      });
      createEffect(data, v => {
        events.push(`user:${v}`);
        if (v) independent(() => setC(1));
      });
      return { setA, setB, c: render(c), b: render(b) };
    });
    await task();
    events.length = 0;
    independent(() => setA(1));
    independent(() => setB(1));
    await task();
    ga.resolve(1);
    await task();
    expect([c, b]).toEqual([[0, 1], [0]]);
    expect(events).toEqual(["user:1", "render:1"]);
    gb.resolve(1);
    await task();
    expect([c, b]).toEqual([
      [0, 1],
      [0, 1]
    ]);
    expect(events).toEqual(["user:1", "render:1"]);
  });

  it("empty groups and repeated activation preserve subsequent ordinary batching", async () => {
    const [a, setA] = createSignal(0),
      [b, setB] = createSignal(0);
    let current = deferred<number>();
    const values = root(() => {
      render(createMemo(() => (a() ? current.promise : 0)));
      return render(b);
    });
    await task();
    for (let i = 1; i <= 3; i++) {
      current = deferred<number>();
      expect(independent(() => independent(() => {}))).toBeUndefined();
      await task();
      setA(i);
      setB(i);
      await task();
      expect(values).toEqual(Array.from({ length: i }, (_, n) => n));
      current.resolve(i);
      await task();
      expect(values).toEqual(Array.from({ length: i + 1 }, (_, n) => n));
      independent(() => setA(0));
      await task();
    }
  });
});
