import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import {
  OVERVIEW_PAGE,
  PLAN_FILE_NAME,
  enforcePageBudget,
  loadPlan,
  normalizePlan,
  pageBudget,
  parsePlan,
  stampPlan,
  type Plan,
} from "./claudePlan.ts";

const page = (path: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  path,
  type: "module",
  title: path,
  brief: `what ${path} covers`,
  sourcePaths: ["src/a.ts"],
  ...over,
});

const planOf = (...paths: string[]): Plan => {
  const parsed = parsePlan(JSON.stringify({ pages: paths.map((p) => page(p)) }));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.plan;
};

describe("Claude producer page plan › parsing", () => {
  test("a well-formed plan parses", () => {
    const res = parsePlan(JSON.stringify({ pages: [page("services/auth.md")] }));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages[0]?.path).toBe("services/auth.md");
    expect(res.plan.pages[0]?.sourcePaths).toEqual(["src/a.ts"]);
    expect(res.plan.deletePages).toEqual([]);
  });

  test("a page entry without a path is rejected", () => {
    const res = parsePlan(JSON.stringify({ pages: [{ type: "module", title: "x", brief: "y" }] }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("did not match the expected shape");
  });

  test("a page entry carrying only a path parses — the rest is authoring cargo", () => {
    const res = parsePlan(JSON.stringify({ pages: [{ path: "a.md" }] }));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages[0]?.brief).toBe("");
    expect(res.plan.pages[0]?.sourcePaths).toEqual([]);
  });

  test("an unrecognized extra field does not break parsing", () => {
    const res = parsePlan(
      JSON.stringify({ pages: [page("a.md", { confidence: 0.9 })], note: "hello" }),
    );

    expect(res.ok).toBe(true);
  });

  test("Unparseable plan fails the run without writing pages", () => {
    expect(parsePlan(null).ok).toBe(false);
    expect(parsePlan("I could not work out a plan for this repository.").ok).toBe(false);
  });

  test("an empty plan parses — whether it is legal depends on the mode", () => {
    // Only init is required to plan something.
    expect(parsePlan(JSON.stringify({ pages: [] })).ok).toBe(true);
  });
});

describe("Claude producer page plan › normalization", () => {
  test("duplicate page paths collapse to one", () => {
    const res = normalizePlan(planOf("a.md", "a.md", "b.md"), { mode: "init" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages.filter((p) => p.path === "a.md")).toHaveLength(1);
  });

  test("A plan naming a reserved file is rejected", () => {
    for (const reserved of ["index.md", "log.md", "guides/index.md"]) {
      const res = normalizePlan(planOf(reserved), { mode: "init" });

      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error).toContain("unusable page path");
    }
  });

  test("a page path escaping the bundle is rejected", () => {
    for (const bad of ["../outside.md", "/etc/passwd.md", "notmarkdown.txt"]) {
      expect(normalizePlan(planOf(bad), { mode: "init" }).ok).toBe(false);
    }
  });

  test("Empty plan fails the run", () => {
    const empty: Plan = { pages: [], deletePages: [] };

    const res = normalizePlan(empty, { mode: "init" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("no pages");
  });

  test("an update planning nothing is a legitimate no-op", () => {
    const res = normalizePlan(
      { pages: [], deletePages: [] },
      { mode: "update", existingPages: ["a.md", OVERVIEW_PAGE] },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages).toEqual([]);
  });

  test("an init plan cannot delete pages", () => {
    const res = normalizePlan({ ...planOf("a.md"), deletePages: ["old.md"] }, { mode: "init" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("cannot delete");
  });

  test("a page cannot be both written and deleted", () => {
    const res = normalizePlan(
      { ...planOf("a.md"), deletePages: ["a.md", "gone.md"] },
      { mode: "update", existingPages: ["a.md", "gone.md", OVERVIEW_PAGE] },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.deletePages).toEqual(["gone.md"]);
  });

  test("relatedPages are normalized and cannot point at the page itself", () => {
    const plan = planOf("a.md");
    plan.pages[0]!.relatedPages = ["/b.md", "a.md", "index.md", "c.md"];
    const res = normalizePlan(plan, { mode: "init" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages[0]?.relatedPages).toEqual(["c.md"]);
  });

  test("Init always yields an overview page", () => {
    const res = normalizePlan(planOf("a.md"), { mode: "init" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages.map((p) => p.path)).toContain(OVERVIEW_PAGE);
    const overview = res.plan.pages.find((p) => p.path === OVERVIEW_PAGE);
    expect(overview?.brief).toContain("major domains");
    expect(overview?.brief).not.toMatch(/entry point|task-routing/i);
  });

  test("Overview is produced last", () => {
    const res = normalizePlan(planOf("z.md", OVERVIEW_PAGE, "a.md"), { mode: "init" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages.at(-1)?.path).toBe(OVERVIEW_PAGE);
    expect(res.plan.pages.map((p) => p.path)).toEqual(["a.md", "z.md", OVERVIEW_PAGE]);
  });

  test("Update cannot delete the overview page", () => {
    const plan: Plan = { ...planOf("a.md"), deletePages: [OVERVIEW_PAGE, "old.md"] };
    const res = normalizePlan(plan, {
      mode: "update",
      existingPages: ["a.md", "old.md", OVERVIEW_PAGE],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.deletePages).toEqual(["old.md"]);
  });

  test("Update restores a missing overview page", () => {
    const res = normalizePlan(planOf("a.md"), { mode: "update", existingPages: ["a.md"] });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages.map((p) => p.path)).toContain(OVERVIEW_PAGE);
  });

  test("An update that adds no page leaves the overview alone", () => {
    const res = normalizePlan(planOf("a.md"), {
      mode: "update",
      existingPages: ["a.md", OVERVIEW_PAGE],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages.map((p) => p.path)).toEqual(["a.md"]);
  });

  test("an update that adds a page regenerates the overview", () => {
    const res = normalizePlan(planOf("a.md", "new.md"), {
      mode: "update",
      existingPages: ["a.md", OVERVIEW_PAGE],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages.map((p) => p.path)).toEqual(["a.md", "new.md", OVERVIEW_PAGE]);
  });

  test("an update that only deletes a page regenerates the overview", () => {
    const plan: Plan = { pages: [], deletePages: ["gone.md"] };
    const res = normalizePlan(plan, {
      mode: "update",
      existingPages: ["gone.md", OVERVIEW_PAGE],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pages.map((p) => p.path)).toEqual([OVERVIEW_PAGE]);
    expect(res.plan.deletePages).toEqual(["gone.md"]);
  });
});

describe("Plan-file checkpoint", () => {
  test("An absent or corrupt plan file reads as replan rather than throwing", async () => {
    const dir = await makeTmp("odw-plan-");
    try {
      expect((await loadPlan(dir, "sha1")).kind).toBe("absent");

      await writeFile(join(dir, PLAN_FILE_NAME), "{ not json");
      const corrupt = await loadPlan(dir, "sha1");
      expect(corrupt.kind).toBe("invalid");
      if (corrupt.kind !== "invalid") return;
      expect(corrupt.error).toContain("not valid JSON");
    } finally {
      await rmTmp(dir);
    }
  });

  test("The stamp records the commit being built and round-trips", async () => {
    const dir = await makeTmp("odw-plan-");
    try {
      const normalized = normalizePlan(planOf("a.md", "b.md"), { mode: "init" });
      if (!normalized.ok) throw new Error(normalized.error);
      await stampPlan(dir, normalized.plan, "sha1");

      const loaded = await loadPlan(dir, "sha1");
      expect(loaded.kind).toBe("resumable");
      if (loaded.kind !== "resumable") return;
      // The overview job was inserted before stamping, so a resume walks the
      // same sequence the fresh run planned.
      expect(loaded.plan.pages.map((p) => p.path)).toEqual(["a.md", "b.md", OVERVIEW_PAGE]);
      expect(loaded.plan.appliedAtSha).toBe("sha1");
    } finally {
      await rmTmp(dir);
    }
  });

  test("An unstamped plan is applied before it is resumed", async () => {
    const dir = await makeTmp("odw-plan-");
    try {
      await writeFile(join(dir, PLAN_FILE_NAME), JSON.stringify(planOf("a.md")));

      const loaded = await loadPlan(dir, "sha1");
      expect(loaded.kind).toBe("unapplied");
    } finally {
      await rmTmp(dir);
    }
  });

  test("A moved target commit discards the plan", async () => {
    const dir = await makeTmp("odw-plan-");
    try {
      const normalized = normalizePlan(planOf("a.md"), { mode: "init" });
      if (!normalized.ok) throw new Error(normalized.error);
      await stampPlan(dir, normalized.plan, "sha1");

      const loaded = await loadPlan(dir, "sha2");
      expect(loaded.kind).toBe("stale");
      if (loaded.kind !== "stale") return;
      expect(loaded.appliedAtSha).toBe("sha1");
    } finally {
      await rmTmp(dir);
    }
  });
});

describe("Plan-file checkpoint › invisible to the bundle's consumers", () => {
  test("the plan file is a dot-file, so nothing that walks .md files sees it", async () => {
    const { walkMd } = await import("./verify.ts");
    const { scoreGrounding } = await import("./grounding.ts");
    const dir = await makeTmp("odw-plan-");
    try {
      await mkdir(join(dir, "bundle"), { recursive: true });
      const bundle = join(dir, "bundle");
      await writeFile(join(bundle, "index.md"), '---\nokf_version: "0.2"\n---\n\n# Index\n');
      await writeFile(join(bundle, "a.md"), "---\ntype: module\n---\n\nSome body.\n");
      const normalized = normalizePlan(planOf("a.md"), { mode: "init" });
      if (!normalized.ok) throw new Error(normalized.error);
      await stampPlan(bundle, normalized.plan, "sha1");

      expect((await walkMd(bundle)).toSorted()).toEqual(["a.md", "index.md"]);
      // Verification and the scope checks see the same pages, no plan file.
      const { verifyBundle, conceptPagePaths } = await import("./verify.ts");
      const { conceptPages } = await import("./acceptance.ts");
      expect((await verifyBundle(bundle)).errors).toEqual([]);
      expect(await conceptPagePaths(bundle)).toEqual(["a.md"]);
      expect([...(await conceptPages(bundle)).keys()]).toEqual(["a.md"]);
      const grounded = await scoreGrounding(bundle, dir);
      expect(grounded.pages).toBe(1);
      // Still on disk after the pass — nothing removed it, nothing read it.
      expect(await readFile(join(bundle, PLAN_FILE_NAME), "utf8")).toContain("sha1");
    } finally {
      await rmTmp(dir);
    }
  });
});

/* ── split planning: map, parts, merge, progress ─────────────────────────── */

import {
  areaFileBudget,
  expectedAreaCount,
  gateExcludeProposals,
  loadMap,
  mergeParts,
  parseMap,
  partFileName,
  readPlanProgress,
  readPart,
  saveMap,
  repairMap,
  splitOverBudgetAreas,
  stripMap,
  validateMap,
  type Area,
  type AreaMap,
  type ExcludeProposal,
} from "./claudePlan.ts";

const area = (id: string, paths: string[], over: Record<string, unknown> = {}): Area =>
  ({
    id,
    title: id,
    scope: `the ${id} area`,
    paths,
    ...over,
  }) as Area;

const mapOf = (...areas: Area[]): AreaMap => ({ areas });

/** The files scope paths own, mirroring the engine's prefix rule. */
const scopeOwned = (paths: string[], tracked: string[]): string[] =>
  tracked.filter((f) =>
    paths.some(
      (p) =>
        (p.split("/").filter(Boolean).join("/") === "." && !f.includes("/")) ||
        f === p ||
        f.startsWith(`${p}/`),
    ),
  );

/** What an area session writes: the part file, by hand — the orchestrator
 *  only ever reads parts. */
const writePart = async (bundle: string, id: string, pages: Record<string, unknown>[]) =>
  writeFile(join(bundle, partFileName(id)), JSON.stringify({ pages }));

/** A tree of tracked-ish files: src/f0.ts … src/f9.ts (10 files). */
const TEN_FILES = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);

describe("Checkpointed planning for large initial bundles › map validation", () => {
  test("a well-formed map parses and validates against the sizing rule", () => {
    // 10 files → budget min(ceil(0.5), 1000) = 1 → expected 10 areas.
    const map = mapOf(
      ...TEN_FILES.map((f) => area(f.replace("src/", "f").replace(".ts", ""), [f])),
    );
    const parsed = parseMap(JSON.stringify(map));
    expect(parsed.ok).toBe(true);

    const validated = validateMap(map, TEN_FILES);
    expect(validated.ok).toBe(true);
  });

  test("an unparseable or empty map is invalid", () => {
    expect(parseMap(null).ok).toBe(false);
    expect(parseMap("not json").ok).toBe(false);
    expect(parseMap(JSON.stringify({ areas: [] })).ok).toBe(false);
    if (parseMap(JSON.stringify({ areas: [] })).ok) return;
  });

  test("area ids must be filename-safe and unique", () => {
    const dup = parseMap(JSON.stringify(mapOf(area("a", ["src/f0.ts"]), area("a", ["src/f1.ts"]))));
    expect(dup.ok).toBe(true); // shape-level: duplicates are a sizing/validate concern
    const first = validateMap(mapOf(area("a", ["src/f0.ts"]), area("a", ["src/f1.ts"])), TEN_FILES);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toContain("duplicate area id");

    const bad = parseMap(JSON.stringify(mapOf(area("Bad Id", ["src/f0.ts"]))));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toContain("expected shape");
  });

  test("an area over its file budget is rejected", () => {
    // Budget for 10 files is 1 (ceil(10*0.05)=1, capped at 1000).
    const over = validateMap(mapOf(area("all", TEN_FILES)), TEN_FILES);
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.error).toContain("over the 1-file area budget");
  });

  test("a trailing-slash directory path is usable; escapes are not", () => {
    // 100 files in 20 dirs of 5 → budget 5, expected 20 areas (accepted 10–40).
    // The map prompt's own example writes "src/producer/", so a map written
    // in that form must validate — this is the `ci/` rejection, regressed.
    const dirs = Array.from({ length: 20 }, (_, d) => `d${String(d).padStart(2, "0")}`);
    const hundred = dirs.flatMap((d) => Array.from({ length: 5 }, (_, i) => `${d}/f${i}.ts`));
    const map = mapOf(...dirs.map((d) => area(d.replace(/^d/, "a"), [`${d}/`])));
    const validated = validateMap(map, hundred);
    expect(validated.ok).toBe(true);

    for (const bad of ["", "/ci/", "../ci/", "C:/ci/", "ci/../.."]) {
      const rejected = validateMap(mapOf(area("escape", [bad]), ...map.areas.slice(1)), hundred);
      expect(rejected.ok).toBe(false);
      if (rejected.ok) return;
      expect(rejected.error).toContain("unusable scope path");
    }
  });

  test("the root's own files are exempt from the area budget", () => {
    // 19 dirs of 5 files + 7 root files = 102 → budget 6: the root area is
    // over and accepted — no coherent boundary splits a flat config pile.
    const dirs = Array.from({ length: 19 }, (_, d) => `d${String(d).padStart(2, "0")}`);
    const root = [
      "package.json",
      "tsconfig.json",
      "bun.lock",
      ".gitignore",
      "README.md",
      ".npmrc",
      "Makefile",
    ];
    const hundred = [
      ...dirs.flatMap((d) => Array.from({ length: 5 }, (_, i) => `${d}/f${i}.ts`)),
      ...root,
    ];
    const map = mapOf(
      area("root-config", ["."]),
      ...dirs.map((d) => area(d.replace(/^d/, "a"), [`${d}/`])),
    );
    expect(validateMap(map, hundred).ok).toBe(true);

    // An area whose non-root paths exceed the budget is still rejected.
    const over = validateMap(
      mapOf(
        area(
          "dirs",
          dirs.slice(0, 2).map((d) => `${d}/`),
        ),
        ...dirs.slice(2).map((d) => area(d.replace(/^d/, "a"), [`${d}/`])),
      ),
      hundred,
    );
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.error).toContain("over the 6-file area budget");
  });

  test("repair canonicalizes path forms the prompt's vocabulary invites", () => {
    const repaired = repairMap(
      mapOf(
        area("root-config", ["(root)", "./"]),
        area("ci", ["./ci/", "workflows\\\\*.yml"]),
        area("src", ["src//core/"]),
      ),
    );
    expect(repaired.map.areas.map((a) => [a.id, a.paths])).toEqual([
      ["root-config", ["."]],
      ["ci", ["ci", "workflows/*.yml"]],
      ["src", ["src/core"]],
    ]);
    expect(repaired.repairs).toEqual(["normalized 5 path form(s)"]);
  });

  test("repair drops unusable paths, merges duplicate ids, drops emptied areas", () => {
    const repaired = repairMap(
      mapOf(
        area("a", ["src/f0.ts", "../escape", "C:/x"]),
        area("b", ["../only-bad"]),
        area("a", ["src/f9.ts"]),
      ),
    );
    expect(repaired.map.areas.map((a) => [a.id, a.paths])).toEqual([
      ["a", ["src/f0.ts", "src/f9.ts"]],
    ]);
    expect(repaired.repairs).toEqual([
      "dropped unusable path ../escape (area a)",
      "dropped unusable path C:/x (area a)",
      "dropped unusable path ../only-bad (area b)",
      "merged duplicate area id a",
      "dropped area b (no usable paths left)",
    ]);
  });

  test("a repaired map validates: the root `.` case end to end", () => {
    // 19 dirs of 5 + 5 root files = 100 → budget 5, expected 20 areas.
    const dirs = Array.from({ length: 19 }, (_, d) => `d${String(d).padStart(2, "0")}`);
    const root = ["package.json", "tsconfig.json", "bun.lock", ".gitignore", "README.md"];
    const hundred = [
      ...dirs.flatMap((d) => Array.from({ length: 5 }, (_, i) => `${d}/f${i}.ts`)),
      ...root,
    ];
    const repaired = repairMap(
      mapOf(area("root-config", ["."]), ...dirs.map((d) => area(d.replace(/^d/, "a"), [`${d}/`]))),
    );
    expect(validateMap(repaired.map, hundred).ok).toBe(true);
  });

  test("an off-sizing map is rejected: too few areas, and too many", () => {
    // 4 files → budget 1 → expected 4, accepted 2–8: one one-file area is
    // within its own budget but under the count floor.
    const four = ["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts"];
    const tooFew = validateMap(mapOf(area("only", ["src/f0.ts"])), four);
    expect(tooFew.ok).toBe(false);
    if (tooFew.ok) return;
    expect(tooFew.error).toContain("sizing rule implies");

    // 10 files → expected 10, accepted 5–20: 21 areas is over the top.
    const tooMany = validateMap(
      mapOf(...Array.from({ length: 21 }, (_, i) => area(`a${i}`, [`src/f${i}.ts`]))),
      TEN_FILES,
    );
    expect(tooMany.ok).toBe(false);
  });

  test("the sizing derivations: budget and expected count", () => {
    expect(areaFileBudget(10)).toBe(1); // ceil(10 * 5%) = 1
    expect(areaFileBudget(2000)).toBe(100); // ceil(2000 * 5%) = 100, below the cap
    expect(areaFileBudget(20_000)).toBe(1000); // 1000 at the cap
    expect(areaFileBudget(100_000)).toBe(1000); // 5000 capped at 1000
    expect(expectedAreaCount(100_000)).toBe(100); // ceil(100000/1000)
    expect(expectedAreaCount(10)).toBe(10);
  });
});

/** A checkout whose data tree is what the gate exists for: asset catalogs
 *  and frame maps, no code, docs, or config anywhere under it — the svg
 *  rides along as kind-excluded weight the proposal may carry for free. */
const TRACKED = [
  "README.md",
  "src/app.ts",
  "catalog/x/Contents.json",
  "catalog/y/Contents.json",
  "catalog/frames.json",
  "catalog/logo.svg",
];
const DOCUMENTABLE = TRACKED.filter((f) => f !== "catalog/logo.svg");
const proposal = (path: string): ExcludeProposal => ({
  path,
  reason: "asset catalog data, no code",
});
const gate = (props: ExcludeProposal[], tracked = TRACKED, documentable = DOCUMENTABLE) =>
  gateExcludeProposals(props, { tracked, documentable });

describe("Claude producer map exclusion gate", () => {
  test("A certifiable data group is accepted and applied", () => {
    const res = gate([proposal("catalog/")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.globs).toEqual(["catalog/**"]);
    // The narrowed set the rest of the run plans and indexes from.
    expect(res.documentable).toEqual(["README.md", "src/app.ts"]);
  });

  test("a map with exclude proposals parses, and so does one without", () => {
    const withExclude = parseMap(
      JSON.stringify({ areas: [area("a", ["src/"])], exclude: [proposal("catalog/")] }),
    );
    expect(withExclude.ok).toBe(true);
    if (!withExclude.ok) return;
    expect(withExclude.map.exclude).toEqual([proposal("catalog/")]);

    const without = parseMap(JSON.stringify({ areas: [area("a", ["src/"])] }));
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.map.exclude).toBeUndefined();
  });

  test("a saved map keeps its proposals for the resumed run's re-gate", async () => {
    const dir = await makeTmp();
    try {
      await saveMap(dir, { areas: [area("a", ["src/"])], exclude: [proposal("catalog/")] }, "s1");

      const loaded = await loadMap(dir, "s1");
      expect(loaded.kind).toBe("current");
      if (loaded.kind !== "current") return;
      expect(loaded.map.exclude).toEqual([proposal("catalog/")]);
    } finally {
      await rmTmp(dir);
    }
  });

  test("A proposal matching code invalidates the map", () => {
    const res = gate([proposal("catalog/")], [...TRACKED, "catalog/gen.ts"]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('exclude proposal "catalog/"');
    expect(res.error).toContain("contains a code file: catalog/gen.ts");
  });

  test("documentation and configuration files under a proposal reject it too", () => {
    for (const extra of ["catalog/NOTES.md", "catalog/package.json", "catalog/vite.config.ts"]) {
      const res = gate([proposal("catalog/")], [...TRACKED, extra]);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error).toContain("contains a");
    }
  });

  test("A root or malformed proposal invalidates the map", () => {
    for (const bad of [".", "(root)", "../escape", "/abs", "src/app.ts", "nowhere/"]) {
      const res = gate([proposal(bad)]);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error).toContain(bad);
    }
  });

  test("A no-op proposal invalidates the map", () => {
    // imgs/ holds only media — kind-excluded before the gate, so the proposal
    // would change nothing.
    const res = gate([proposal("imgs/")], [...TRACKED, "imgs/a.png", "imgs/b.png"]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("excludes nothing documentable");
  });

  test("a proposal nested inside an accepted one adds nothing and is dropped", () => {
    const res = gate([proposal("catalog/"), proposal("catalog/x/")]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.globs).toEqual(["catalog/**"]);
  });

  test("The map is stripped before area planning", () => {
    const narrowed = ["README.md", "src/app.ts"];
    const stripped = stripMap(
      mapOf(
        area("cat", ["catalog/"]),
        area("app", ["src/", "catalog/frames.json"]),
        area("root", ["."]),
      ),
      narrowed,
    );

    expect(stripped.map.areas.map((a) => a.id)).toEqual(["app", "root"]);
    expect(stripped.map.areas[0]?.paths).toEqual(["src/"]); // partial area pruned, kept
    expect(stripped.notes).toContain("dropped area cat (owned only excluded files)");
    expect(stripped.notes).toContain("pruned catalog/frames.json (area app)");
    // The surviving map validates against the narrowed set.
    expect(validateMap(stripped.map, narrowed).ok).toBe(true);
  });
});

describe("Checkpointed planning for large initial bundles › overflow split", () => {
  test("an over-budget directory area is split into at-most-budget part-N siblings", () => {
    // p/ has three children of 2 files each; filler brings N to 45 → budget 3.
    const children = ["c1", "c2", "c3"].flatMap((c) =>
      Array.from({ length: 2 }, (_, i) => `p/${c}/f${i}.ts`),
    );
    const tracked = [...children, ...Array.from({ length: 39 }, (_, i) => `x${i}.ts`)];
    expect(areaFileBudget(tracked.length)).toBe(3);

    const split = splitOverBudgetAreas(mapOf(area("big", ["p/"])), tracked);

    expect(split.repairs).toEqual(["split big into 3 parts"]);
    expect(split.map.areas.map((a) => a.id)).toEqual(["big-part-1", "big-part-2", "big-part-3"]);
    for (const a of split.map.areas) {
      expect(a.title).toBe("big"); // inherited — the parts still read as one area
      expect(a.scope).toBe("the big area");
      expect(scopeOwned(a.paths, tracked).length).toBeLessThanOrEqual(
        areaFileBudget(tracked.length),
      );
    }
    // The parts partition the original owned set: nothing gained, nothing lost.
    const union = [
      ...new Set(split.map.areas.flatMap((a) => scopeOwned(a.paths, tracked))),
    ].toSorted();
    expect(union).toEqual(children.toSorted());
  });

  test("deterministic, and a no-op when every area is within budget", () => {
    const children = ["c1", "c2", "c3"].flatMap((c) =>
      Array.from({ length: 2 }, (_, i) => `p/${c}/f${i}.ts`),
    );
    const tracked = [...children, ...Array.from({ length: 39 }, (_, i) => `x${i}.ts`)];
    const map = mapOf(area("big", ["p/"]));

    const first = splitOverBudgetAreas(map, tracked);
    const second = splitOverBudgetAreas(map, tracked);
    expect(JSON.stringify(first.map)).toBe(JSON.stringify(second.map));
    expect(first.repairs).toEqual(second.repairs);

    const within = mapOf(area("small", ["p/c1"]));
    const unchanged = splitOverBudgetAreas(within, tracked);
    expect(unchanged.repairs).toEqual([]);
    expect(JSON.stringify(unchanged.map)).toBe(JSON.stringify(within));
  });

  test("an area over budget across small directories splits by whole directory", () => {
    const dirFiles = ["a", "b", "c"].flatMap((d) =>
      Array.from({ length: 2 }, (_, i) => `${d}/f${i}.ts`),
    );
    const tracked = [...dirFiles, ...Array.from({ length: 39 }, (_, i) => `x${i}.ts`)];
    const split = splitOverBudgetAreas(mapOf(area("small", ["a", "b", "c"])), tracked);

    // Each directory is under budget on its own, so each becomes one part.
    expect(split.repairs).toEqual(["split small into 3 parts"]);
    expect(split.map.areas.map((a) => a.id)).toEqual([
      "small-part-1",
      "small-part-2",
      "small-part-3",
    ]);
    for (const a of split.map.areas) {
      expect(a.paths.length).toBe(1);
      expect(scopeOwned(a.paths, tracked).length).toBe(2);
    }
  });

  test("a directory over budget with no subdirectory is split file by file", () => {
    // flat/ holds five files directly and has no children to cut on.
    const flat = Array.from({ length: 5 }, (_, i) => `flat/f${i}.ts`);
    const tracked = [...flat, ...Array.from({ length: 40 }, (_, i) => `x${i}.ts`)];
    expect(areaFileBudget(tracked.length)).toBe(3); // ceil(45 * 5%)

    const split = splitOverBudgetAreas(mapOf(area("flat", ["flat"])), tracked);

    expect(split.repairs).toEqual(["split flat into 2 parts"]);
    const ids = split.map.areas.map((a) => a.id);
    expect(ids).toEqual(["flat-part-1", "flat-part-2"]);
    for (const a of split.map.areas) {
      expect(scopeOwned(a.paths, tracked).length).toBeLessThanOrEqual(3);
    }
    const union = [
      ...new Set(split.map.areas.flatMap((a) => scopeOwned(a.paths, tracked))),
    ].toSorted();
    expect(union).toEqual(flat.toSorted());
  });

  test("the root's own files are exempt and ride unsplit on part 1", () => {
    const rootFiles = Array.from({ length: 8 }, (_, i) => `root${i}.ts`);
    // Root-only: never over budget, so never split, however many root files.
    const rootOnly = splitOverBudgetAreas(mapOf(area("config", ["."])), [
      ...rootFiles,
      ...Array.from({ length: 40 }, (_, i) => `x${i}.ts`),
    ]);
    expect(rootOnly.repairs).toEqual([]);
    expect(rootOnly.map.areas.map((a) => a.id)).toEqual(["config"]);

    // Root plus an over-budget directory: the directories split, `.` stays put.
    const tracked = [
      ...rootFiles,
      "p/c1/f0.ts",
      "p/c1/f1.ts",
      "p/c2/f0.ts",
      "p/c2/f1.ts",
      ...Array.from({ length: 35 }, (_, i) => `x${i}.ts`),
    ];
    expect(areaFileBudget(tracked.length)).toBe(3); // ceil(49 * 5%)
    const mixed = splitOverBudgetAreas(mapOf(area("mixed", [".", "p"])), tracked);

    expect(mixed.repairs).toEqual(["split mixed into 2 parts"]);
    const first = mixed.map.areas[0];
    expect(first?.paths).toContain(".");
    // `.` is claimed once, on part 1 — the root pile is never duplicated.
    const rootClaims = mixed.map.areas.flatMap((a) => a.paths).filter((p) => p === ".");
    expect(rootClaims.length).toBe(1);
    expect(mixed.map.areas[1]?.paths).not.toContain(".");
    for (const a of mixed.map.areas) {
      expect(a.title).toBe("mixed");
      expect(
        scopeOwned(
          a.paths.filter((p) => p !== "."),
          tracked,
        ).length,
      ).toBeLessThanOrEqual(3);
    }
  });

  test("a split map then validates under the count rule, end to end", () => {
    // 18 dirs of 5 files + a 6-file subtree in two 3-file children = 96 files
    // → budget 5, expected 20 areas (accepted 10–40).
    const dirs = Array.from({ length: 18 }, (_, d) => `d${String(d).padStart(2, "0")}`);
    const tracked = [
      ...dirs.flatMap((d) => Array.from({ length: 5 }, (_, i) => `${d}/f${i}.ts`)),
      "big/x/a.ts",
      "big/x/b.ts",
      "big/x/c.ts",
      "big/y/a.ts",
      "big/y/b.ts",
      "big/y/c.ts",
    ];
    expect(tracked.length).toBe(96);
    expect(areaFileBudget(96)).toBe(5);
    const map = mapOf(
      area("big", ["big/"]),
      ...dirs.map((d) => area(d.replace(/^d/, "a"), [`${d}/`])),
    );

    const split = splitOverBudgetAreas(map, tracked);

    expect(split.repairs).toEqual(["split big into 2 parts"]);
    const validated = validateMap(split.map, tracked);
    expect(validated.ok).toBe(true);
  });
});

describe("Checkpointed planning for large initial bundles › merge fold", () => {
  test("A title collision folds at merge", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      await mkdir(bundle, { recursive: true });
      const map = mapOf(area("alpha", ["src/a.ts"]), area("beta", ["src/b.ts"]));
      await writePart(bundle, "alpha", [
        page("growth/state-management.md", {
          title: "State Management",
          brief: "growth stores",
          sourcePaths: ["src/growth/store.ts"],
          relatedPages: ["concepts/promos.md"],
        }),
      ]);
      await writePart(bundle, "beta", [
        page("insurance/state-management.md", {
          title: "state  management",
          brief: "insurance stores",
          sourcePaths: ["src/insurance/store.ts", "src/insurance/widget.ts"],
          relatedPages: ["concepts/policies.md", "concepts/promos.md"],
        }),
      ]);
      const merged = await mergeParts(bundle, map.areas, 100);
      expect(merged.ok).toBe(true);
      if (!merged.ok) return;
      expect(merged.plan.pages).toHaveLength(1);
      const survivor = merged.plan.pages[0]!;
      expect(survivor.path).toBe("growth/state-management.md");
      expect(survivor.sourcePaths).toEqual([
        "src/growth/store.ts",
        "src/insurance/store.ts",
        "src/insurance/widget.ts",
      ]);
      expect(survivor.relatedPages).toEqual(["concepts/promos.md", "concepts/policies.md"]);
    } finally {
      await rmTmp(dir);
    }
  });

  test("A shared cross-cutting stem folds at merge", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      await mkdir(bundle, { recursive: true });
      const map = mapOf(
        area("alpha", ["src/a.ts"]),
        area("beta", ["src/b.ts"]),
        area("gamma", ["src/c.ts"]),
      );
      await writePart(bundle, "alpha", [
        page("architecture/state-management.md", {
          title: "Account state",
          sourcePaths: ["src/a.ts"],
        }),
      ]);
      await writePart(bundle, "beta", [
        page("inventory/state-management.md", {
          title: "Inventory state management",
          sourcePaths: ["src/b.ts", "src/b2.ts"],
        }),
      ]);
      await writePart(bundle, "gamma", [
        page("search/state-management.md", {
          title: "Search state management",
          sourcePaths: ["src/c.ts"],
        }),
      ]);
      const merged = await mergeParts(bundle, map.areas, 100);
      expect(merged.ok).toBe(true);
      if (!merged.ok) return;
      expect(merged.plan.pages).toHaveLength(1);
      expect(merged.plan.pages[0]!.path).toBe("architecture/state-management.md");
      expect(merged.plan.pages[0]!.sourcePaths).toEqual([
        "src/a.ts",
        "src/b.ts",
        "src/b2.ts",
        "src/c.ts",
      ]);
    } finally {
      await rmTmp(dir);
    }
  });

  test("A generic stem outside the subjects never folds", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      await mkdir(bundle, { recursive: true });
      const map = mapOf(area("alpha", ["src/a.ts"]), area("beta", ["src/b.ts"]));
      await writePart(bundle, "alpha", [
        page("modules/auth/overview.md", { title: "Auth module" }),
      ]);
      await writePart(bundle, "beta", [page("crypto/overview.md", { title: "Crypto module" })]);
      const merged = await mergeParts(bundle, map.areas, 100);
      expect(merged.ok).toBe(true);
      if (!merged.ok) return;
      expect(merged.plan.pages.map((p) => p.path)).toEqual([
        "modules/auth/overview.md",
        "crypto/overview.md",
      ]);
    } finally {
      await rmTmp(dir);
    }
  });

  test("The merged plan carries no collisions", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      await mkdir(bundle, { recursive: true });
      const map = mapOf(area("alpha", ["src/a.ts"]), area("beta", ["src/b.ts"]));
      await writePart(bundle, "alpha", [
        page("concepts/alpha.md", { title: "Alpha" }),
        page("shared/utilities.md", { title: "Shared utilities" }),
        page("workflows/status.md", { title: "Status determination" }),
      ]);
      await writePart(bundle, "beta", [
        page("pay/utilities.md", { title: "Utilities" }),
        page("concepts/beta.md", { title: "Beta" }),
      ]);
      const first = await mergeParts(bundle, map.areas, 100);
      const second = await mergeParts(bundle, map.areas, 100);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.plan.pages.map((p) => p.path)).toEqual([
        "concepts/alpha.md",
        "shared/utilities.md",
        "workflows/status.md",
        "concepts/beta.md",
      ]);
      expect(first.plan).toEqual(second.plan);
    } finally {
      await rmTmp(dir);
    }
  });
});

describe("Checkpointed planning for large initial bundles › map and parts on disk", () => {
  test("a map is stamped, ordered, and drift-discarded; parts resume; merge yields a plan", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      await mkdir(bundle, { recursive: true });

      // Unvalidated map → validate → stamp → current.
      const map = mapOf(area("beta", ["src/b.ts"]), area("alpha", ["src/a.ts"]));
      const validated = validateMap(map, ["src/a.ts", "src/b.ts"]);
      expect(validated.ok).toBe(true);
      await saveMap(bundle, map, "sha1");
      const loaded = await loadMap(bundle, "sha1");
      expect(loaded.kind).toBe("current");
      if (loaded.kind !== "current") return;
      expect(loaded.map.areas.map((a) => a.id)).toEqual(["alpha", "beta"]); // stable order

      // Drift: the same map against another commit is stale.
      expect((await loadMap(bundle, "sha2")).kind).toBe("stale");

      // One part lands, a kill follows: the other area is still pending…
      await writePart(bundle, "alpha", [page("concepts/alpha.md")]);
      expect((await readPart(bundle, "alpha")).kind).toBe("ok");
      expect((await readPart(bundle, "beta")).kind).toBe("absent");

      // …so merging before every area is done fails…
      const early = await mergeParts(bundle, loaded.map.areas, 100);
      expect(early.ok).toBe(false);

      // …the next run produces only the missing part, then merging works.
      await writePart(bundle, "beta", [page("concepts/beta.md")]);
      const merged = await mergeParts(bundle, loaded.map.areas, 100);
      expect(merged.ok).toBe(true);
      if (!merged.ok) return;
      expect(merged.plan.pages.map((p) => p.path)).toEqual([
        "concepts/alpha.md",
        "concepts/beta.md",
      ]);
    } finally {
      await rmTmp(dir);
    }
  });

  test("an invalid part (unusable page path) reads as invalid, not ok", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      await mkdir(bundle, { recursive: true });
      await writeFile(
        join(bundle, partFileName("alpha")),
        JSON.stringify({ pages: [page("../escape.md")] }),
      );
      const part = await readPart(bundle, "alpha");
      expect(part.kind).toBe("invalid");
      if (part.kind !== "invalid") return;
      expect(part.error).toContain("unusable page path");
    } finally {
      await rmTmp(dir);
    }
  });
});

describe("Production progress in status › readPlanProgress", () => {
  test("planning units from map and parts; page units from the plan", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      await mkdir(bundle, { recursive: true });

      // Nothing legible: idle → null; in flight → the undecomposed marker.
      expect(await readPlanProgress(bundle, null, false)).toBeNull();
      expect(await readPlanProgress(bundle, null, true)).toEqual({
        phase: "planning",
        split: false,
        done: 0,
        total: 0,
        lastUnitAt: null,
      });

      // A map with one of two parts → planning 1/2.
      await saveMap(bundle, mapOf(area("alpha", ["src/a.ts"]), area("beta", ["src/b.ts"])), "s");
      await writePart(bundle, "alpha", [page("concepts/alpha.md")]);
      const planning = await readPlanProgress(bundle, null, true);
      expect(planning?.phase).toBe("planning");
      expect(planning?.split).toBe(true);
      expect(planning?.done).toBe(1);
      expect(planning?.total).toBe(2);
      expect(planning?.lastUnitAt).not.toBeNull();

      // A stamped plan with one conformant page of two → pages 1/2.
      await Bun.write(
        join(bundle, PLAN_FILE_NAME),
        JSON.stringify({ pages: [page("a.md"), page("b.md")], appliedAtSha: "s" }),
      );
      await Bun.write(join(bundle, "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
      const pages = await readPlanProgress(bundle, null, true);
      expect(pages?.phase).toBe("pages");
      expect(pages?.done).toBe(1);
      expect(pages?.total).toBe(2);
    } finally {
      await rmTmp(dir);
    }
  });

  test("a preserved build stays legible from the WIP area between runs", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      const wip = join(dir, "wip");
      await mkdir(bundle, { recursive: true });

      // The staged bundle says nothing; the WIP area carries the map+part.
      await mkdir(wip, { recursive: true });
      await saveMap(wip, mapOf(area("alpha", ["src/a.ts"])), "s");
      await writePart(wip, "alpha", [page("concepts/alpha.md")]);

      const fromWip = await readPlanProgress(bundle, wip, false);
      expect(fromWip?.phase).toBe("planning");
      expect(fromWip?.done).toBe(1);
      expect(fromWip?.total).toBe(1);
    } finally {
      await rmTmp(dir);
    }
  });

  test("a racing read degrades to null, never an error", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      await mkdir(bundle, { recursive: true });
      // A plan file that is valid JSON but mid-write garbage inside a page
      // body is fine; a directory where the plan file is a directory is not —
      // the read must swallow it.
      await mkdir(join(bundle, PLAN_FILE_NAME), { recursive: true });
      expect(await readPlanProgress(bundle, null, false)).toBeNull();
      const racing = await readPlanProgress(bundle, null, true);
      expect(racing?.phase).toBe("planning");
    } finally {
      await rmTmp(dir);
    }
  });
});

describe("Init plan page budget › Budget scales with the checkout", () => {
  test("max(12, ceil(N/100)): the floor holds small trees, the ratio scales large ones", () => {
    expect(pageBudget(0)).toBe(12);
    expect(pageBudget(500)).toBe(12);
    expect(pageBudget(1200)).toBe(12);
    expect(pageBudget(1201)).toBe(13);
    expect(pageBudget(14000)).toBe(140);
    expect(pageBudget(50000)).toBe(500);
  });
});

describe("Init plan page budget › Over-budget plan merges at the seams, deterministically", () => {
  test("a within-budget plan comes back untouched (same object, nothing merged)", () => {
    const plan = planOf(...Array.from({ length: 12 }, (_, i) => `p/${i}.md`));
    const out = enforcePageBudget(plan, 100, null);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.merged).toBe(0);
    expect(out.plan).toBe(plan);
  });

  test("entries sharing type and source-path parent merge; survivor is earliest in order, titled after the parent, sources and related pages unioned", () => {
    // Eleven distinct-parent fillers hold the plan at the budget's floor; the
    // two same-parent pages over one source parent must merge to get under it.
    const fillers = Array.from({ length: 11 }, (_, i) =>
      page(`filler/f${i}.md`, { title: `F${i}`, sourcePaths: [`s/f${i}/x.js`] }),
    );
    const parsed = parsePlan(
      JSON.stringify({
        pages: [
          ...fillers,
          page("listing/screens/row.md", {
            title: "Row screen",
            sourcePaths: ["modules/listing/row.js"],
          }),
          page("listing/screens/edit.md", {
            title: "Edit screen",
            sourcePaths: ["modules/listing/edit.js"],
            relatedPages: ["concepts/y.md"],
          }),
        ],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const areas = Array.from({ length: 14 }, () => "a");
    const out = enforcePageBudget(parsed.plan, 100, areas);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.merged).toBe(1);
    expect(out.plan.pages).toHaveLength(12);
    const merged = out.plan.pages.find((p) => p.title === "Listing");
    expect(merged?.path).toBe("listing/screens/row.md");
    expect(merged?.sourcePaths).toEqual(["modules/listing/row.js", "modules/listing/edit.js"]);
    expect(merged?.relatedPages).toEqual(["concepts/y.md"]);
    // The fillers survive untouched.
    expect(out.plan.pages.find((p) => p.title === "F0")?.path).toBe("filler/f0.md");
  });

  test("the same plan always merges the same way", () => {
    const build = (): Plan => {
      const pages = Array.from({ length: 14 }, (_, i) =>
        page(`streams/alpha/scene-${i % 2}.md`, {
          title: `Scene ${i}`,
          sourcePaths: [`streams/alpha/f${i}.js`],
        }),
      );
      const parsed = parsePlan(JSON.stringify({ pages }));
      if (!parsed.ok) throw new Error(parsed.error);
      const out = enforcePageBudget(parsed.plan, 100, ["a", "a"]);
      if (!out.ok) throw new Error(out.error);
      return out.plan;
    };
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  test("entries differing in type, area, cross-cutting stem, or citing nothing never merge", () => {
    const fillers = Array.from({ length: 8 }, (_, i) =>
      page(`filler/f${i}.md`, { title: `F${i}`, sourcePaths: [`s/f${i}/x.js`] }),
    );
    const parsed = parsePlan(
      JSON.stringify({
        pages: [
          ...fillers,
          page("m/a1.md", { title: "A1", type: "architecture", sourcePaths: ["src/a1.js"] }),
          page("m/a2.md", { title: "A2", type: "architecture", sourcePaths: ["src2/a2.js"] }),
          page("m/c1.md", { title: "C1", type: "concepts", sourcePaths: ["src/c1.js"] }),
          page("m/state-management.md", {
            title: "State",
            type: "architecture",
            sourcePaths: ["src/s1.js"],
          }),
          page("m/bare.md", { title: "Bare", type: "architecture", sourcePaths: [] }),
        ],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    // Budget 12 (N=1200): thirteen pages, no two of which may merge — a1 vs
    // a2 differ in area, a1 vs c1 in type, state-management is excluded as a
    // cross-cutting stem, bare cites nothing. Irreducible, nothing merged.
    const out = enforcePageBudget(parsed.plan, 1200, [
      "alpha",
      "beta",
      "alpha",
      "alpha",
      "alpha",
      "alpha",
      ...Array.from({ length: 8 }, () => "alpha"),
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("13 pages over 12 after merging 0");
    expect(out.error).toContain("could not merge in: alpha, beta");
  });

  test("a single-session plan with no area attribution still reports its numbers", () => {
    const parsed = parsePlan(
      JSON.stringify({
        pages: Array.from({ length: 20 }, (_, i) =>
          page(`p/leaf-${i}.md`, { title: `L${i}`, sourcePaths: [`s/d${i}/leaf.js`] }),
        ),
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    // Every page cites a different directory: no seam, no merge.
    const out = enforcePageBudget(parsed.plan, 100, null);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("20 pages over 12 after merging 0");
    expect(out.error).toContain("no area seams");
  });
});

describe("Init plan page budget › An over-budget plan merges at the seams through the merge", () => {
  test("an over-budget merged plan comes out within budget", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      await mkdir(bundle, { recursive: true });
      const map = mapOf(area("alpha", ["src/a.ts"]));
      await writePart(
        bundle,
        "alpha",
        Array.from({ length: 15 }, (_, i) =>
          page(`alpha/scene-${i}.md`, {
            title: `Scene ${i}`,
            sourcePaths: [`src/flow${i}.js`],
          }),
        ),
      );
      const merged = await mergeParts(bundle, map.areas, 100);
      expect(merged.ok).toBe(true);
      if (!merged.ok) return;
      expect(merged.plan.pages.length).toBeLessThanOrEqual(12);
    } finally {
      await rmTmp(dir);
    }
  });

  test("an irreducible merged plan fails with the budget, the count, and the areas", async () => {
    const dir = await makeTmp();
    try {
      const bundle = join(dir, "openwiki");
      await mkdir(bundle, { recursive: true });
      const map = mapOf(area("alpha", ["src/a.ts"]), area("beta", ["src/b.ts"]));
      await writePart(
        bundle,
        "alpha",
        Array.from({ length: 8 }, (_, i) =>
          page(`alpha/p${i}.md`, {
            title: `Alpha ${i}`,
            sourcePaths: [`d${i}/f.js`],
          }),
        ),
      );
      await writePart(
        bundle,
        "beta",
        Array.from({ length: 5 }, (_, i) =>
          page(`beta/p${i}.md`, { title: `Beta ${i}`, sourcePaths: [`b${i}/f.js`] }),
        ),
      );
      // Budget 12 (N=100): every page cites its own directory, so no two
      // entries share a seam — 13 pages, irreducible with nothing merged.
      const merged = await mergeParts(bundle, map.areas, 100);
      expect(merged.ok).toBe(false);
      if (merged.ok) return;
      expect(merged.error).toContain("13 pages over 12 after merging 0");
      expect(merged.error).toContain("could not merge in: alpha, beta");
    } finally {
      await rmTmp(dir);
    }
  });
});
