import {
  CONFIG_CHILDREN_FORBIDDEN,
  CONFIG_HELD,
  CONFIG_INPUTS_PUBLISHED,
  CONFIG_OVERRIDE,
  CONFIG_VERDICT,
  EFFECT_RENDER,
  NOT_PENDING,
  REACTIVE_JOINED,
  STATUS_PENDING,
  STATUS_UNINITIALIZED
} from "./core/constants.js";
import { bornInto, unflushedStaged, unflushedValue } from "./core/core.js";
import {
  flushTransaction,
  blocked,
  globalQueue,
  installIndependentHooks,
  liveTx,
  merge,
  newTransaction,
  parkNodes,
  passLane,
  resolveTx,
  schedule,
  setFlushTransaction,
  staleReader,
  storeParkHook,
  txOf,
  type IndependentHooks,
  type QueueCallback,
  type Transaction
} from "./core/scheduler.js";
import type { Computed, Signal } from "./core/types.js";

// null is the ordinary batch; false is a render pass dirtied by several
// groups. Proposal ownership is separate from CONFIG_HELD: a group need
// not suspend, and identifying it must not change read visibility.
type Seat = Transaction | null | false;
let current: Seat = null;
let observer: Computed<any> | null = null;
let ambient: Transaction | null = null;
// The optional wrapper re-enters the original core function once. Consume
// this bypass at entry so nested pulls still establish their own context.
let bypass = false;
const proposals = new WeakMap<Signal<any>, Transaction | null>();
const causes = new WeakMap<Computed<any>, Seat>();
let guesses = new WeakMap<Signal<any>, Transaction | null>();
let trims = new WeakMap<Computed<any>, Seat>();
const replays = new WeakMap<Computed<any>, Set<Transaction>>();
const independentGroups = new Set<Transaction>();

function transaction(seat: Seat): Transaction | null {
  const t = seat === null ? ambient : seat || null;
  return t && liveTx(t);
}
function same(a: Seat, b: Seat): boolean {
  return a === b || (a !== false && b !== false && transaction(a) === transaction(b));
}
function ensure(seat: Transaction | null): Transaction {
  return transaction(seat) || (ambient = newTransaction(false));
}
function join(a: Transaction | null, b: Transaction | null): void {
  const x = transaction(a),
    y = transaction(b);
  if (x && y) merge(x, y);
  if (a === null || b === null) ambient = x || y;
  setFlushTransaction(transaction(current));
}
function enter(seat: Seat): Seat {
  const previous = current;
  if (current === null) ambient = flushTransaction;
  current = seat && !transaction(seat) ? null : seat;
  setFlushTransaction(transaction(seat));
  return previous;
}
function exit(previous: unknown): void {
  current = previous as Seat;
  if (current && !transaction(current)) current = null;
  setFlushTransaction(transaction(current));
}
function claim(node: Signal<any>): void {
  if (current && !transaction(current)) current = null;
  if (current === false || passLane !== null || node._config & CONFIG_OVERRIDE) return;
  if (hooks.active && proposals.has(node) && (node as any)._type !== EFFECT_RENDER)
    join(proposals.get(node)!, current);
  proposals.set(node, current);
}

const hooks: IndependentHooks = {
  active: false,
  compute(node, create, fn) {
    if (bypass) {
      bypass = false;
      return false;
    }
    const seat = create ? current : causes.has(node) ? causes.get(node)! : null;
    causes.delete(node);
    replays.delete(node);
    if (!hooks.active) return false;
    const previous = enter(seat);
    const previousObserver = observer;
    observer = node;
    try {
      bypass = true;
      fn(node, create);
    } finally {
      bypass = false;
      observer = previousObserver;
      exit(previous);
    }
    return true;
  },
  wrap() {
    if (!bypass) return hooks.active;
    bypass = false;
    return false;
  },
  run(node, fn) {
    if (!hooks.active) return fn();
    const t =
      (node as Transaction)._nodes !== undefined
        ? resolveTx(node as Transaction)
        : (node as Signal<any>)._config & CONFIG_HELD
          ? txOf(node as Signal<any>)
          : transaction(proposals.get(node as Signal<any>) ?? null);
    let seat: Transaction | null = null;
    if (t)
      for (const group of independentGroups)
        if (resolveTx(group) === t) {
          seat = t;
          break;
        }
    const previous = enter(seat);
    try {
      bypass = true;
      return fn();
    } finally {
      bypass = false;
      exit(previous);
    }
  },
  joined(t) {
    if (!hooks.active) return;
    if (current && !transaction(current)) current = null;
    if (current === null) ambient = t;
    else if (current !== false) {
      independentGroups.add(t);
      current = t;
    }
  },
  write(node, changed) {
    if (changed || node._pendingValue !== NOT_PENDING) claim(node);
  },
  stage: claim,
  cause(node, sub) {
    if (passLane !== null || current === false) return;
    const seat = proposals.has(node) ? proposals.get(node)! : current;
    if (!hooks.active) {
      causes.set(sub, null);
      return;
    }
    if (causes.has(sub)) {
      const previous = causes.get(sub)!;
      if (previous === false || same(previous, seat)) return;
      if ((sub as any)._type === EFFECT_RENDER) {
        causes.set(sub, false);
        return;
      }
      join(previous, seat);
    }
    causes.set(sub, seat);
  },
  read(reader, node) {
    if (
      !proposals.has(node) ||
      !hooks.active ||
      reader._config & (CONFIG_CHILDREN_FORBIDDEN | CONFIG_VERDICT) ||
      passLane !== null ||
      node._config & CONFIG_OVERRIDE ||
      (!globalQueue._running && unflushedStaged && unflushedValue(node) !== NOT_PENDING)
    )
      return false;
    const seat = proposals.get(node)!;
    if ((reader as any)._type === EFFECT_RENDER) {
      const t = transaction(seat);
      if (
        !same(current, seat) &&
        !((node as Computed<any>)._statusFlags & STATUS_UNINITIALIZED) &&
        !(node._config & CONFIG_INPUTS_PUBLISHED) &&
        !(t && bornInto(reader, t))
      ) {
        staleReader(reader, ensure(seat));
        return true;
      }
      return false;
    }
    if (
      !(node._config & CONFIG_HELD) &&
      current !== false &&
      (node._pendingValue !== NOT_PENDING || (node as Computed<any>)._statusFlags & STATUS_PENDING)
    ) {
      join(current, seat);
      if (transaction(current)) reader._flags |= REACTIVE_JOINED;
    }
    return false;
  },
  enqueue(type: number, fn: QueueCallback) {
    if (!hooks.active) return false;
    if (current && !transaction(current)) current = null;
    // A shared pass reads the committed world. A ready group's landing
    // requeues it before its callback can show an obsolete combination.
    if (current === false) return observer !== null && replays.has(observer);
    if (current === null) return false;
    resolveTx(current)._queues[type - 1].push(fn);
    return true;
  },
  park(nodes) {
    if (!hooks.active) return;
    const groups = new Map<Transaction, Signal<any>[]>();
    let count = 0;
    for (const node of nodes) {
      const seat = proposals.get(node);
      const t = seat === undefined ? null : transaction(seat);
      if (t && t !== transaction(null)) {
        let list = groups.get(t);
        if (!list) groups.set(t, (list = []));
        list.push(node);
      } else nodes[count++] = node;
    }
    nodes.length = count;
    for (const [t, list] of groups) {
      parkNodes(list, t);
      for (const node of list) {
        if (node._config & CONFIG_HELD) proposals.set(node, txOf(node));
        else if (node._pendingValue === NOT_PENDING) proposals.delete(node);
      }
    }
    // Freeze the ordinary batch's identity before the next batch starts.
    const t = transaction(null);
    if (t) for (const node of nodes) if (proposals.has(node)) proposals.set(node, t);
    setFlushTransaction(t);
  },
  seam() {
    if (!hooks.active) return;
    for (const t of independentGroups) if (!liveTx(t)) independentGroups.delete(t);
    hooks.active = independentGroups.size !== 0;
    ambient = null;
    trims = new WeakMap();
    setFlushTransaction(current === null || current === false ? null : liveTx(current));
  },
  commit(node) {
    proposals.delete(node);
  },
  guess(node) {
    if (current === false) return;
    if (hooks.active && guesses.has(node)) join(guesses.get(node)!, current);
    guesses.set(node, current);
  },
  parent(node) {
    if (node === undefined) {
      guesses = new WeakMap();
      return;
    }
    return hooks.active && guesses.has(node) ? transaction(guesses.get(node)!) : undefined;
  },
  stale(reader, t) {
    if (!hooks.active) return false;
    let groups = replays.get(reader);
    if (!groups) replays.set(reader, (groups = new Set()));
    for (const group of groups) if (resolveTx(group) === resolveTx(t)) return false;
    groups.add(t);
    return true;
  },
  replay(reader, t) {
    const groups = replays.get(reader);
    if (!groups) return false;
    if (!t) return true;
    for (const group of groups) if (resolveTx(group) === t) return true;
    return false;
  },
  trim(node, record) {
    if (record) {
      if (hooks.active) trims.set(node, current);
      return false;
    }
    const seat = trims.get(node);
    const t = seat === undefined ? null : transaction(seat);
    return t !== null && blocked(t);
  },
  zombies(nodes, ready) {
    if (!hooks.active) return;
    let count = 0;
    for (const node of nodes) {
      const seat = causes.get(node);
      const t = seat === undefined ? transaction(null) : transaction(seat);
      if (t !== null && blocked(t)) continue;
      if (ready) {
        if (!(node._config & CONFIG_VERDICT)) ready.push(node);
      } else nodes[count++] = node;
    }
    if (!ready) nodes.length = count;
  }
};
installIndependentHooks(hooks);

/**
 * Execute `fn` synchronously in its own atomic update group. Its writes
 * batch until the normal flush and can commit while unrelated work waits
 * on async. Async work triggered by the group holds it normally; shared
 * derivations and writes to held state can entangle it with other groups.
 * Nested calls start separate groups. The scope ends when `fn` returns,
 * including when it returns a promise; throws do not roll back writes.
 */
export function independent(fn: () => void): void {
  if (!hooks.active) {
    ambient = flushTransaction;
    // Materialize ordinary store backings staged before the first call;
    // subsequent grouped staging supplies its container immediately.
    storeParkHook?.(ensure(null));
    setFlushTransaction(ambient);
    hooks.active = true;
  }
  const t = newTransaction(false);
  independentGroups.add(t);
  t._open++;
  const previous = enter(t);
  try {
    fn();
  } finally {
    resolveTx(t)._open--;
    exit(previous);
    schedule();
  }
}
