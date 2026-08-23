import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PLANNING_TOOLS,
  areaDirectives,
  describeSession,
  mapDirectives,
  stepOverrides,
  type Session,
} from "./claude.ts";
import {
  buildDigestTree,
  listTrackedFiles,
  renderDigest,
  renderDigestSubset,
  repoDigest,
  type DigestTree,
} from "./claudeDigest.ts";
import {
  MAP_FILE_NAME,
  clearPlanningArtifacts,
  gateExcludeProposals,
  loadMap,
  mergeParts,
  partFileName,
  readPart,
  repairMap,
  saveMap,
  splitOverBudgetAreas,
  stripMap,
  validateMap,
  type AreaMap,
  type Plan,
} from "./claudePlan.ts";
import type { ProducerRun } from "./contract.ts";
import type { Run } from "./claudeRun.ts";

/**
 * Split planning for large initial bundles (init above
 * `ODW_CLAUDE_SPLIT_PLAN_FILES` documentable files). One map session names
 * the areas from a deterministic digest, one bounded session per area writes
 * its plan fragment, and the fragments merge into the ordinary plan the rest
 * of the run already knows how to apply. Each unit's dot-file in the bundle
 * is its checkpoint — present and valid means done — so one lost session
 * costs one area, never the whole plan. The map/area/part vocabulary and its
 * validation live in `claudePlan.ts`; this file is the orchestration that
 * drives it.
 */

type SplitPlanned = {
  /** The merged, unapplied plan — APPLY treats it exactly like a plan a
   *  single planning session wrote. */
  loaded: { kind: "unapplied"; plan: Plan };
  /** The session the run's failure reporting falls back to: the map session
   *  if one ran, otherwise the last area session. */
  planned: Session | null;
};

export async function planSplit(
  run: Run,
  tracked: string[],
  tree: DigestTree | null,
): Promise<ProducerRun | SplitPlanned> {
  let planned: Session | null = null;
  /* GATE — the map's exclusion proposals, judged from the tree before
   * any takes effect. All-or-nothing: a rejected proposal means the map
   * covered nothing the proposal excluded, so the map is discarded for
   * a re-plan rather than partially applied. Acceptance narrows this
   * run's documentable set and rebuilds the tree from the accepted
   * globs, so sizing, slices, and the merge all share one set. */
  const applyExcludes = async (
    map: AreaMap,
    documentable: string[],
  ): Promise<{ ok: true; map: AreaMap } | { ok: false; error: string }> => {
    const proposals = map.exclude ?? [];
    if (proposals.length === 0) return { ok: true, map };
    const allTracked = await listTrackedFiles(run.checkoutDir).catch(() => null);
    if (allTracked === null) {
      return { ok: false, error: "the checkout's tracked files could not be listed" };
    }
    const gated = gateExcludeProposals(proposals, { tracked: allTracked, documentable });
    if (!gated.ok) {
      await clearPlanningArtifacts(run.bundle);
      return { ok: false, error: gated.error };
    }
    tracked = gated.documentable;
    tree = await buildDigestTree(run.checkoutDir, [...run.cfg.excludeGlobs, ...gated.globs]).catch(
      () => null,
    );
    for (const g of gated.globs) if (!run.appliedGlobs.includes(g)) run.appliedGlobs.push(g);
    run.notes.push(`map excludes accepted: ${gated.globs.join(", ")}`);
    const stripped = stripMap(map, gated.documentable);
    if (stripped.notes.length > 0) run.notes.push(`map stripped: ${stripped.notes.join("; ")}`);
    return { ok: true, map: stripped.map };
  };
  /* MAP — one bounded session names the areas from a deterministic
   * digest; present and valid means done, so a resumed run skips it. */
  let mapped = await loadMap(run.bundle, run.targetSha);
  if (mapped.kind === "stale") {
    run.notes.push(
      `remapping: map was made for ${mapped.targetSha}, now building ${run.targetSha}`,
    );
    await clearPlanningArtifacts(run.bundle);
    mapped = { kind: "absent" };
  }
  if (mapped.kind === "invalid") {
    run.notes.push(`remapping: ${mapped.error}`);
    await clearPlanningArtifacts(run.bundle);
    mapped = { kind: "absent" };
  }
  /* A reused map re-runs the same pure gate on its saved proposals: the
   * stamp pins the commit so the verdict is the same, unless the merged
   * exclude set moved under it — then the map is re-planned. */
  if (mapped.kind === "current" && (mapped.map.exclude?.length ?? 0) > 0) {
    const gated = await applyExcludes(mapped.map, tracked);
    if (!gated.ok) {
      return run.finish(null, {
        outcome: "failed",
        spawnError: `the map was rejected: ${gated.error}`,
      });
    }
    mapped = { kind: "current", map: gated.map };
  }
  if (mapped.kind === "unvalidated") {
    const repaired = repairMap(mapped.map);
    const gated = await applyExcludes(repaired.map, tracked);
    if (!gated.ok) {
      return run.finish(null, {
        outcome: "failed",
        spawnError: `the map was rejected: ${gated.error}`,
      });
    }
    const split = splitOverBudgetAreas(gated.map, tracked);
    const repairs = [...repaired.repairs, ...split.repairs];
    if (repairs.length > 0) run.notes.push(`map repaired: ${repairs.join("; ")}`);
    const validated = validateMap(split.map, tracked);
    if (validated.ok) {
      await saveMap(run.bundle, validated.map, run.targetSha);
      mapped = { kind: "current", map: validated.map };
    } else {
      run.notes.push(`remapping: ${validated.error}`);
      await clearPlanningArtifacts(run.bundle);
      mapped = { kind: "absent" };
    }
  }
  if (mapped.kind === "absent") {
    const digestFile = join(run.promptDir, "digest.txt");
    await writeFile(
      digestFile,
      tree === null
        ? await repoDigest(run.checkoutDir, 400, run.cfg.excludeGlobs)
        : renderDigest(tree),
    );
    const mapping = await run.session(
      run.prompts.map,
      mapDirectives(join(run.bundle, MAP_FILE_NAME), digestFile, tracked.length),
      stepOverrides(run.cfg, "map"),
      PLANNING_TOOLS,
    );
    planned = mapping;
    if (mapping.outcome !== "ok") {
      /* A map session that died after writing a usable map left
       * resumable work — the same rule as a planner that died after
       * writing its plan, or the restore path deletes it. */
      const after = await loadMap(run.bundle, run.targetSha);
      const usable = after.kind === "unvalidated" || after.kind === "current";
      run.notes.push(
        `map: not mapped (${describeSession(mapping)})` +
          (usable ? " — usable map kept, next run resumes from it" : ""),
      );
      return run.finish(mapping, {
        outcome: mapping.outcome,
        ...(usable ? { partial: true } : {}),
      });
    }
    const after = await loadMap(run.bundle, run.targetSha);
    if (after.kind !== "unvalidated") {
      const why = after.kind === "invalid" ? after.error : "the map session produced no map";
      return run.finish(mapping, { outcome: "failed", spawnError: why });
    }
    const repaired = repairMap(after.map);
    const gated = await applyExcludes(repaired.map, tracked);
    if (!gated.ok) {
      return run.finish(mapping, {
        outcome: "failed",
        spawnError: `the map was rejected: ${gated.error}`,
      });
    }
    const split = splitOverBudgetAreas(gated.map, tracked);
    const repairs = [...repaired.repairs, ...split.repairs];
    if (repairs.length > 0) run.notes.push(`map repaired: ${repairs.join("; ")}`);
    const validated = validateMap(split.map, tracked);
    if (!validated.ok) {
      await clearPlanningArtifacts(run.bundle);
      return run.finish(mapping, {
        outcome: "failed",
        spawnError: `the map was rejected: ${validated.error}`,
      });
    }
    await saveMap(run.bundle, validated.map, run.targetSha);
    mapped = { kind: "current", map: validated.map };
    run.units++;
    await run.progress("map", `${validated.map.areas.length} areas`);
  }

  /* AREAS — one bounded session per missing part; a rate-limited one
   * ends the run exactly as a rate-limited page session does. */
  const areas = mapped.kind === "current" ? mapped.map.areas : [];
  let lastArea: Session | null = null;
  let firstAreaFailure: Session | null = null;
  let outOfTime = false;
  let partsDone = 0;
  /* Titles survive each completed part: the areas run in order, so the
   * directives can show every later session what is already claimed. */
  const plannedTitles: string[] = [];
  for (const area of areas) {
    const existing = await readPart(run.bundle, area.id);
    if (existing.kind === "ok") {
      plannedTitles.push(...existing.pages.map((p) => p.title));
      partsDone++;
      continue;
    }
    if (existing.kind === "invalid") {
      await rm(join(run.bundle, partFileName(area.id)), { force: true });
      run.notes.push(`area ${area.id}: part discarded (${existing.error})`);
    }
    if (Date.now() >= run.deadline) {
      outOfTime = true;
      run.notes.push(`out of budget with area ${area.id} and later areas unplanned`);
      break;
    }
    const others = areas.filter((o) => o.id !== area.id);
    /* The area's slice of the structure handout, so the session plans
     * from the tree instead of enumerating it with Glob. */
    const structureFile = tree === null ? null : join(run.promptDir, `digest-${area.id}.txt`);
    if (tree !== null && structureFile !== null) {
      await writeFile(structureFile, renderDigestSubset(tree, area.paths));
    }
    const produced = await run.session(
      run.prompts.planner,
      areaDirectives(
        area,
        join(run.bundle, partFileName(area.id)),
        others,
        plannedTitles,
        structureFile,
      ),
      stepOverrides(run.cfg, "plan"),
      PLANNING_TOOLS,
    );
    lastArea = produced;
    const part = await readPart(run.bundle, area.id);
    if (part.kind === "invalid") {
      await rm(join(run.bundle, partFileName(area.id)), { force: true });
      run.notes.push(`area ${area.id}: part discarded (${part.error})`);
    }
    /* A part is validated whole — parseable JSON with usable paths —
     * so presence decides the unit even when the session exited ugly;
     * a page, whose conformance check cannot see a half-written body,
     * must instead be deleted when its session fails. */
    if (part.kind === "ok") {
      run.units++;
      partsDone++;
      await run.progress("area", `${area.id}: ${partsDone}/${areas.length}`);
      continue;
    }
    run.notes.push(`area ${area.id}: not planned (${describeSession(produced)})`);
    firstAreaFailure ??= produced;
    if (produced.outcome === "rate_limited") {
      return run.finish(produced, { outcome: "rate_limited", partial: true });
    }
  }
  const missingAreas: string[] = [];
  for (const area of areas) {
    if ((await readPart(run.bundle, area.id)).kind !== "ok") missingAreas.push(area.id);
  }
  if (missingAreas.length > 0) {
    return run.finish(firstAreaFailure ?? lastArea, {
      outcome: "failed",
      partial: true,
      timedOut: outOfTime || Date.now() >= run.deadline,
    });
  }

  /* MERGE — every area's pages, concatenated into the plan the rest of
   * the run already knows how to apply. From here the plan file is the
   * checkpoint; the map and parts it was merged from are spent. */
  const merged = await mergeParts(run.bundle, areas, tracked.length);
  if (!merged.ok) {
    return run.finish(lastArea, {
      outcome: "failed",
      spawnError: merged.error,
      partial: true,
    });
  }
  run.units++;
  await run.progress("plan", `${merged.plan.pages.length} pages`);
  run.notes.push(`planning merged from ${areas.length} areas`);
  planned ??= lastArea;
  return { loaded: { kind: "unapplied", plan: merged.plan }, planned };
}
