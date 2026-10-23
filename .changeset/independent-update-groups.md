---
"@solidjs/signals": patch
"solid-js": patch
---

Add `independent(fn)` to run synchronous writes in a separate atomic update group while retaining normal microtask batching. Unrelated groups can commit while other work waits on async; shared derivations and writes to held state still entangle them. The grouping engine is optional and tree-shakes when the primitive is not imported. On the server, the callback runs synchronously.
