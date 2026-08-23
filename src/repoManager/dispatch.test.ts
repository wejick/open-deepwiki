import { describe, expect, test } from "bun:test";
import { dispatchOrder } from "./scheduler.ts";

/**
 * Fair, budget-aware dispatch (6.4 / design D15). Registration order starves
 * the tail of the list forever once a batch starts getting truncated.
 */

type R = {
  repoId: string;
  lastSuccessAt: string | null;
  lastIndexedSha: string | null;
  lastRun: { resetAt?: string | undefined };
};

const repo = (repoId: string, over: Partial<R> = {}): R => ({
  repoId,
  lastSuccessAt: null,
  lastIndexedSha: "sha",
  lastRun: {},
  ...over,
});

const NOW = Date.parse("2026-08-28T12:00:00Z");
const ago = (h: number): string => new Date(NOW - h * 3600_000).toISOString();

describe("Scheduled updates dispatch fairly", () => {
  test("least recently succeeded goes first", () => {
    const order = dispatchOrder(
      [
        repo("fresh", { lastSuccessAt: ago(1) }),
        repo("stalest", { lastSuccessAt: ago(72) }),
        repo("middling", { lastSuccessAt: ago(24) }),
      ],
      NOW,
    );
    expect(order.map((r) => r.repoId)).toEqual(["stalest", "middling", "fresh"]);
  });

  test("a truncated batch reaches every repo across successive runs", () => {
    // Three repos, a budget for one per night. Simulate: the winner gets a
    // fresh lastSuccessAt, then re-order.
    let repos = [
      repo("a", { lastSuccessAt: ago(10) }),
      repo("b", { lastSuccessAt: ago(11) }),
      repo("c", { lastSuccessAt: ago(12) }),
    ];
    const served: string[] = [];
    for (let night = 0; night < 3; night++) {
      const first = dispatchOrder(repos, NOW)[0];
      expect(first).toBeDefined();
      served.push(first?.repoId ?? "");
      repos = repos.map((r) =>
        r.repoId === first?.repoId
          ? { ...r, lastSuccessAt: new Date(NOW + night).toISOString() }
          : r,
      );
    }
    // Every repo served exactly once — registration order would have served
    // whichever was first, three times.
    expect(served.toSorted()).toEqual(["a", "b", "c"]);
  });

  test("updates are dispatched ahead of first builds", () => {
    const order = dispatchOrder(
      [
        repo("brand-new", { lastIndexedSha: null, lastSuccessAt: null }),
        repo("existing", { lastSuccessAt: ago(48) }),
      ],
      NOW,
    );
    // One new large repo must not stall the fleet's refresh.
    expect(order.map((r) => r.repoId)).toEqual(["existing", "brand-new"]);
  });

  test("a repo waiting on a limit reset goes last but stays in the batch", () => {
    const order = dispatchOrder(
      [
        repo("limited", {
          lastSuccessAt: ago(99),
          lastRun: { resetAt: new Date(NOW + 3600_000).toISOString() },
        }),
        repo("ready", { lastSuccessAt: ago(1) }),
      ],
      NOW,
    );
    expect(order.map((r) => r.repoId)).toEqual(["ready", "limited"]);
    expect(order).toHaveLength(2); // deferred, never dropped
  });

  test("a reset time already in the past does not defer the repo", () => {
    const order = dispatchOrder(
      [
        repo("was-limited", {
          lastSuccessAt: ago(99),
          lastRun: { resetAt: new Date(NOW - 60_000).toISOString() },
        }),
        repo("ready", { lastSuccessAt: ago(1) }),
      ],
      NOW,
    );
    expect(order[0]?.repoId).toBe("was-limited");
  });

  test("ordering is deterministic for equal ranks", () => {
    const repos = [repo("z", { lastSuccessAt: ago(5) }), repo("a", { lastSuccessAt: ago(5) })];
    expect(dispatchOrder(repos, NOW).map((r) => r.repoId)).toEqual(["a", "z"]);
    expect(dispatchOrder(repos.toReversed(), NOW).map((r) => r.repoId)).toEqual(["a", "z"]);
  });

  test("the input array is not mutated", () => {
    const repos = [repo("b", { lastSuccessAt: ago(1) }), repo("a", { lastSuccessAt: ago(9) })];
    const before = repos.map((r) => r.repoId);
    dispatchOrder(repos, NOW);
    expect(repos.map((r) => r.repoId)).toEqual(before);
  });
});
