// P0 topology safety layer for AI-authored Doom geometry.
//
// This validator is intentionally conservative about pristine legacy maps:
// it preserves compatibility quirks already present in the baseline while
// treating topology introduced or moved by the AI as strict errors.

const NO_SIDE = 0xffff;
const ML_TWOSIDED = 4;
const PATCH_MARK = Symbol.for('web-doom.p0.full-topology-validator');

function keyPoint(p) { return `${p.x},${p.y}`; }
function cross(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function samePoint(a, b) { return a.x === b.x && a.y === b.y; }
function between(v, a, b) { return v >= Math.min(a, b) && v <= Math.max(a, b); }

function pointOnSegment(p, a, b) {
  return cross(a, b, p) === 0 && between(p.x, a.x, b.x) && between(p.y, a.y, b.y);
}

function pointOnSegmentInterior(p, a, b) {
  return pointOnSegment(p, a, b) && !samePoint(p, a) && !samePoint(p, b);
}

function properIntersection(a, b, c, d) {
  const c1 = cross(a, b, c), c2 = cross(a, b, d);
  const c3 = cross(c, d, a), c4 = cross(c, d, b);
  return ((c1 > 0 && c2 < 0) || (c1 < 0 && c2 > 0))
    && ((c3 > 0 && c4 < 0) || (c3 < 0 && c4 > 0));
}

function collinearOverlap(a, b, c, d) {
  if (cross(a, b, c) !== 0 || cross(a, b, d) !== 0) return false;
  const useX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const a1 = useX ? a.x : a.y, a2 = useX ? b.x : b.y;
  const c1 = useX ? c.x : c.y, c2 = useX ? d.x : d.y;
  const lo = Math.max(Math.min(a1, a2), Math.min(c1, c2));
  const hi = Math.min(Math.max(a1, a2), Math.max(c1, c2));
  return hi > lo;
}

function sideSector(g, side) {
  if (side === NO_SIDE) return null;
  return g.sidedefs[side]?.sector ?? null;
}

function changedVertices(workspace) {
  const touched = new Set();
  for (let i = workspace.originalCounts.vertices; i < workspace.geometry.vertices.length; i++) touched.add(i);
  for (const entry of workspace.history || []) {
    const match = /^move_vertex:(\d+)$/.exec(String(entry?.label || ''));
    if (match) touched.add(Number(match[1]));
  }
  return touched;
}

function changedLines(workspace, touchedVertices) {
  const g = workspace.geometry;
  const touched = new Set();
  for (let i = workspace.originalCounts.linedefs; i < g.linedefs.length; i++) touched.add(i);
  g.linedefs.forEach((line, index) => {
    if (touchedVertices.has(line.v1) || touchedVertices.has(line.v2)) touched.add(index);
  });
  return touched;
}

function changedSectors(workspace, touchedLines) {
  const g = workspace.geometry;
  const touched = new Set();
  for (let i = workspace.originalCounts.sectors; i < g.sectors.length; i++) touched.add(i);
  for (const lineIndex of touchedLines) {
    const line = g.linedefs[lineIndex];
    if (!line) continue;
    const a = sideSector(g, line.right), b = sideSector(g, line.left);
    if (a != null) touched.add(a);
    if (b != null) touched.add(b);
  }
  return touched;
}

function addIssue(strings, issues, code, message, details = {}) {
  strings.push(message);
  issues.push({ code, message, ...details });
}

export function validateFullTopology(workspace, baseResult = null) {
  const base = baseResult || { ok: true, errors: [], warnings: [], summary: workspace.summary?.() };
  // Keep errors/warnings as strings because v2 callers join() them when a build fails.
  const errors = [...(base.errors || [])].map(String);
  const warnings = [...(base.warnings || [])].map(String);
  const errorIssues = errors.map(message => ({ code: 'BASE_VALIDATION', message }));
  const warningIssues = warnings.map(message => ({ code: 'BASE_WARNING', message }));

  const g = workspace.geometry;
  const touchedVertices = changedVertices(workspace);
  const touchedLines = changedLines(workspace, touchedVertices);
  const touchedSectors = changedSectors(workspace, touchedLines);

  // Newly-created vertices must not silently duplicate existing coordinates.
  const points = new Map();
  g.vertices.forEach((vertex, index) => {
    const key = keyPoint(vertex);
    const prior = points.get(key);
    if (prior != null && (index >= workspace.originalCounts.vertices || prior >= workspace.originalCounts.vertices)) {
      addIssue(errors, errorIssues, 'DUPLICATE_VERTEX', `Vertex ${index} duplicates vertex ${prior} at (${vertex.x}, ${vertex.y})`, { vertices: [prior, index] });
    } else if (prior == null) {
      points.set(key, index);
    }
  });

  // Catch duplicate geometric edges created by AI edits even when vertex ids differ.
  const edges = new Map();
  g.linedefs.forEach((line, index) => {
    const a = g.vertices[line.v1], b = g.vertices[line.v2];
    if (!a || !b) return;
    const ka = keyPoint(a), kb = keyPoint(b);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const prior = edges.get(key);
    if (prior != null && (touchedLines.has(index) || touchedLines.has(prior))) {
      addIssue(errors, errorIssues, 'DUPLICATE_LINEDEF', `Linedef ${index} duplicates linedef ${prior}`, { linedefs: [prior, index] });
    } else if (prior == null) {
      edges.set(key, index);
    }
  });

  // Full changed-geometry intersection pass. This fixes the v2 hole where moving
  // a legacy vertex could make two legacy-index linedefs cross without detection.
  for (const i of touchedLines) {
    const li = g.linedefs[i];
    if (!li) continue;
    const a = g.vertices[li.v1], b = g.vertices[li.v2];
    if (!a || !b) continue;
    for (let j = 0; j < g.linedefs.length; j++) {
      if (j === i || (touchedLines.has(j) && j < i)) continue;
      const lj = g.linedefs[j];
      const c = g.vertices[lj.v1], d = g.vertices[lj.v2];
      if (!c || !d) continue;

      const sharesVertexId = li.v1 === lj.v1 || li.v1 === lj.v2 || li.v2 === lj.v1 || li.v2 === lj.v2;
      if (properIntersection(a, b, c, d)) {
        addIssue(errors, errorIssues, 'LINEDEF_CROSSING', `Linedef ${i} crosses linedef ${j}`, { linedefs: [i, j] });
        continue;
      }
      if (collinearOverlap(a, b, c, d) && !sharesVertexId) {
        addIssue(errors, errorIssues, 'COLLINEAR_OVERLAP', `Linedef ${i} overlaps linedef ${j} without a shared vertex`, { linedefs: [i, j] });
        continue;
      }

      // Coordinate-touch without shared vertex id is a T-junction / split-edge hazard.
      const cases = [
        [a, li.v1, c, d, j], [b, li.v2, c, d, j],
        [c, lj.v1, a, b, i], [d, lj.v2, a, b, i]
      ];
      for (const [p, vertexId, s1, s2, otherLine] of cases) {
        if (pointOnSegmentInterior(p, s1, s2)) {
          addIssue(errors, errorIssues, 'T_JUNCTION', `Vertex ${vertexId} lies on the interior of linedef ${otherLine} without splitting it`, { vertex: vertexId, linedefs: [i, j] });
          break;
        }
      }
    }
  }

  // New sidedefs/sectors should be referenced; stale authoring primitives usually
  // mean an interrupted or partially-failed edit sequence.
  const sideUse = new Array(g.sidedefs.length).fill(0);
  g.linedefs.forEach(line => {
    if (line.right !== NO_SIDE && line.right < sideUse.length) sideUse[line.right]++;
    if (line.left !== NO_SIDE && line.left < sideUse.length) sideUse[line.left]++;
  });
  for (let i = workspace.originalCounts.sidedefs; i < sideUse.length; i++) {
    if (sideUse[i] === 0) addIssue(errors, errorIssues, 'ORPHAN_SIDEDEF', `New sidedef ${i} is not referenced by any linedef`, { sidedef: i });
  }

  const sectorUse = new Array(g.sectors.length).fill(0);
  g.sidedefs.forEach(side => { if (side.sector < sectorUse.length) sectorUse[side.sector]++; });
  for (let i = workspace.originalCounts.sectors; i < sectorUse.length; i++) {
    if (sectorUse[i] === 0) addIssue(errors, errorIssues, 'ORPHAN_SECTOR', `New sector ${i} has no sidedefs`, { sector: i });
  }

  // Two-sided semantics and affected-sector boundary/manifold checks.
  g.linedefs.forEach((line, index) => {
    if (!touchedLines.has(index)) return;
    const hasRight = line.right !== NO_SIDE, hasLeft = line.left !== NO_SIDE;
    const flagTwoSided = Boolean(line.flags & ML_TWOSIDED);
    if (hasRight && hasLeft && !flagTwoSided) {
      addIssue(errors, errorIssues, 'TWOSIDED_FLAG_MISSING', `Linedef ${index} has two sidedefs but ML_TWOSIDED is not set`, { linedef: index });
    }
    if (!(hasRight && hasLeft) && flagTwoSided) {
      addIssue(errors, errorIssues, 'TWOSIDED_FLAG_ORPHAN', `Linedef ${index} has ML_TWOSIDED but does not have two sidedefs`, { linedef: index });
    }
  });

  for (const sector of touchedSectors) {
    const degree = new Map();
    const boundaryLines = [];
    const bump = v => degree.set(v, (degree.get(v) || 0) + 1);
    g.linedefs.forEach((line, index) => {
      const right = sideSector(g, line.right), left = sideSector(g, line.left);
      if (right === sector || left === sector) {
        boundaryLines.push(index); bump(line.v1); bump(line.v2);
      }
    });
    if (boundaryLines.length < 3) {
      addIssue(errors, errorIssues, 'SECTOR_TOO_FEW_EDGES', `Sector ${sector} has fewer than three boundary linedefs`, { sector, linedefs: boundaryLines });
      continue;
    }
    for (const [vertex, d] of degree) {
      if (d !== 2) addIssue(errors, errorIssues, 'NON_MANIFOLD_SECTOR_VERTEX', `Sector ${sector} boundary vertex ${vertex} has degree ${d}, expected 2`, { sector, vertex, degree: d });
    }

    // A sector boundary must not self-cross after an affected edit.
    for (let x = 0; x < boundaryLines.length; x++) {
      const lx = g.linedefs[boundaryLines[x]];
      const a = g.vertices[lx.v1], b = g.vertices[lx.v2];
      for (let y = x + 1; y < boundaryLines.length; y++) {
        const ly = g.linedefs[boundaryLines[y]];
        if ([lx.v1, lx.v2].includes(ly.v1) || [lx.v1, lx.v2].includes(ly.v2)) continue;
        if (properIntersection(a, b, g.vertices[ly.v1], g.vertices[ly.v2])) {
          addIssue(errors, errorIssues, 'SECTOR_SELF_INTERSECTION', `Sector ${sector} boundary crosses between linedefs ${boundaryLines[x]} and ${boundaryLines[y]}`, { sector, linedefs: [boundaryLines[x], boundaryLines[y]] });
        }
      }
    }
  }

  // Keep duplicate legacy coordinates visible for diagnostics without breaking
  // known-good vanilla maps.
  const legacyPointCounts = new Map();
  for (let i = 0; i < Math.min(workspace.originalCounts.vertices, g.vertices.length); i++) {
    const key = keyPoint(g.vertices[i]); legacyPointCounts.set(key, (legacyPointCounts.get(key) || 0) + 1);
  }
  const legacyDuplicates = [...legacyPointCounts.values()].filter(count => count > 1).length;
  if (legacyDuplicates) {
    addIssue(warnings, warningIssues, 'LEGACY_DUPLICATE_VERTICES', `Baseline contains ${legacyDuplicates} duplicated vertex coordinates; preserved for vanilla compatibility`, { count: legacyDuplicates });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    issues: { errors: errorIssues, warnings: warningIssues },
    summary: base.summary || workspace.summary?.(),
    topology: {
      touchedVertices: [...touchedVertices].sort((a, b) => a - b),
      touchedLinedefs: [...touchedLines].sort((a, b) => a - b),
      touchedSectors: [...touchedSectors].sort((a, b) => a - b)
    }
  };
}

export function installFullTopologyValidator(GeometryWorkspace) {
  if (GeometryWorkspace.prototype[PATCH_MARK]) return;
  const original = GeometryWorkspace.prototype.validate;
  Object.defineProperty(GeometryWorkspace.prototype, PATCH_MARK, { value: true });
  GeometryWorkspace.prototype.validate = function validateWithP0Topology() {
    return validateFullTopology(this, original.call(this));
  };
}
