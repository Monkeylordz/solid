import { describe, expect, it } from "vitest";
import { createMemo, createSignal, createStore, flush, independent } from "../src/index.js";
import { deferred, render, root, settle } from "./independent-helpers.js";

describe("independent store backings", () => {
  it.each([false, true])(
    "different properties of one backing entangle (observed=%s)",
    async observed => {
      const gate = deferred<number>();
      const { setTrigger, setStore, state, values } = root(() => {
        const [trigger, setTrigger] = createSignal(false);
        const [state, setStore] = createStore({ a: 0, b: 0 });
        render(createMemo(() => (trigger() ? gate.promise : 0)));
        return {
          setTrigger,
          setStore,
          state,
          values: observed ? render(() => [state.a, state.b]) : []
        };
      });
      flush();
      independent(() => {
        setTrigger(true);
        setStore(s => {
          s.a = 1;
        });
      });
      independent(() =>
        setStore(s => {
          s.b = 1;
        })
      );
      flush();
      expect([state.a, state.b]).toEqual([0, 0]);
      expect(values).toEqual(observed ? [[0, 0]] : []);
      gate.resolve(1);
      await settle();
      expect([state.a, state.b]).toEqual([1, 1]);
      expect(values).toEqual(
        observed
          ? [
              [0, 0],
              [1, 1]
            ]
          : []
      );
    }
  );

  it.each([false, true])(
    "unobserved backings retain group ownership (ordinary first=%s)",
    async ordinaryFirst => {
      const gate = deferred<number>();
      const { setTrigger, a, setA, b, setB } = root(() => {
        const [trigger, setTrigger] = createSignal(false);
        const [a, setA] = createStore({ value: 0 });
        const [b, setB] = createStore({ value: 0 });
        render(createMemo(() => (trigger() ? gate.promise : 0)));
        return { setTrigger, a, setA, b, setB };
      });
      flush();
      const held = () => {
        setTrigger(true);
        setA(s => {
          s.value = 1;
        });
      };
      // The ordinary-first case activates independent after a backing was
      // staged without any subscription/container node.
      ordinaryFirst ? held() : independent(held);
      independent(() =>
        setB(s => {
          s.value = 1;
        })
      );
      flush();
      expect([a.value, b.value]).toEqual([0, 1]);
      gate.resolve(1);
      await settle();
      expect([a.value, b.value]).toEqual([1, 1]);
    }
  );

  it.each([false, true])("nested objects group by backing identity (aliased=%s)", async aliased => {
    const gate = deferred<number>();
    const { state, setState, setTrigger, left, right } = root(() => {
      const shared = { value: 0, unread: 0 };
      const [state, setState] = createStore({
        left: shared,
        right: aliased ? shared : { value: 0, unread: 0 }
      });
      const [trigger, setTrigger] = createSignal(false);
      render(createMemo(() => (trigger() ? gate.promise : 0)));
      return {
        state,
        setState,
        setTrigger,
        left: render(() => state.left.value),
        right: render(() => state.right.value)
      };
    });
    flush();
    independent(() => {
      setTrigger(true);
      setState(s => {
        s.left.value = 1;
        s.left.unread = 1;
      });
    });
    independent(() =>
      setState(s => {
        s.right.value = 2;
        s.right.unread = 2;
      })
    );
    flush();
    expect([left, right]).toEqual(aliased ? [[0], [0]] : [[0], [0, 2]]);
    expect([state.left.unread, state.right.unread]).toEqual(aliased ? [0, 0] : [0, 2]);
    gate.resolve(1);
    await settle();
    expect([left, right]).toEqual(
      aliased
        ? [
            [0, 2],
            [0, 2]
          ]
        : [
            [0, 1],
            [0, 2]
          ]
    );
    expect([state.left.unread, state.right.unread]).toEqual(aliased ? [2, 2] : [1, 2]);
  });

  it("addition, deletion, presence and enumeration commit with their backing", async () => {
    const gate = deferred<number>();
    const { state, setState, setTrigger, keys, presence, other, setOther } = root(() => {
      const [trigger, setTrigger] = createSignal(false);
      const [state, setState] = createStore<{ keep: number; remove?: number; added?: number }>({
        keep: 0,
        remove: 1
      });
      const [other, setOther] = createSignal(0);
      render(createMemo(() => (trigger() ? gate.promise : 0)));
      return {
        state,
        setState,
        setTrigger,
        keys: render(() => Object.keys(state).sort().join(",")),
        presence: render(() => ["remove" in state, "added" in state]),
        other: render(other),
        setOther
      };
    });
    flush();
    independent(() => {
      setTrigger(true);
      setState(s => {
        delete s.remove;
        s.added = 2;
        s.keep = 1;
      });
    });
    independent(() => setOther(1));
    flush();
    expect({ ...state }).toEqual({ keep: 0, remove: 1 });
    expect(keys).toEqual(["keep,remove"]);
    expect(presence).toEqual([[true, false]]);
    expect(other).toEqual([0, 1]);
    gate.resolve(1);
    await settle();
    expect({ ...state }).toEqual({ keep: 1, added: 2 });
    expect(keys).toEqual(["keep,remove", "added,keep"]);
    expect(presence).toEqual([
      [true, false],
      [false, true]
    ]);
    setState(s => {
      s.remove = 3;
    });
    await settle();
    expect(keys.at(-1)).toBe("added,keep,remove");
    expect(presence.at(-1)).toEqual([true, true]);
  });

  it("array splice, length and unobserved slots publish atomically", async () => {
    const gate = deferred<number>();
    const { items, setItems, setTrigger, lengths, heads } = root(() => {
      const [trigger, setTrigger] = createSignal(false);
      const [items, setItems] = createStore([0, 1, 2]);
      render(createMemo(() => (trigger() ? gate.promise : 0)));
      return {
        items,
        setItems,
        setTrigger,
        lengths: render(() => items.length),
        heads: render(() => items[0])
      };
    });
    flush();
    independent(() => {
      setTrigger(true);
      setItems(s => {
        s.splice(0, 2, 9);
      });
    });
    independent(() =>
      setItems(s => {
        s.push(8, 7);
      })
    );
    flush();
    expect([...items]).toEqual([0, 1, 2]);
    expect([lengths, heads]).toEqual([[3], [0]]);
    gate.resolve(1);
    await settle();
    expect([...items]).toEqual([9, 2, 8, 7]);
    expect([lengths, heads]).toEqual([
      [3, 4],
      [0, 9]
    ]);
    setItems(s => {
      s.length = 1;
    });
    await settle();
    expect([...items]).toEqual([9]);
    expect(lengths).toEqual([3, 4, 1]);
  });
});
