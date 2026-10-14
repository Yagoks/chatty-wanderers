// Chatty Wanderers — grid pathfinding around walls. Closed doors that aren't locked count as passable (the patroller
// opens them); locked doors and walls block. Results of single steps are cached until a wall changes.

export const MODULE_ID = "chatty-wanderers";

const stepCache = new Map();

export function clearPathCache() {
  stepCache.clear();
}

export const cellKey = c => `${c.i},${c.j}`;
export const sameCell = (a, b) => !!a && !!b && a.i === b.i && a.j === b.j;

export function cellOf(point) {
  const o = canvas.grid.getOffset(point);
  return { i: o.i, j: o.j };
}

export function centerOf(cell) {
  return canvas.grid.getCenterPoint({ i: cell.i, j: cell.j });
}

/** Center of a token document (its current position, not the animated one). */
export function tokenCenter(td) {
  const g = canvas.grid.size;
  return { x: td.x + (td.width * g) / 2, y: td.y + (td.height * g) / 2 };
}

/** Top-left position that puts the token's center on this cell's center. */
export function tokenPositionFor(td, cell) {
  const c = centerOf(cell);
  const g = canvas.grid.size;
  return { x: Math.round(c.x - (td.width * g) / 2), y: Math.round(c.y - (td.height * g) / 2) };
}

/**
 * Can a creature step between two adjacent cells?
 * @returns {{ok: boolean, doors: string[]}} doors: ids of closed, unlocked doors on the way (to open first)
 */
export function stepInfo(a, b) {
  const k = `${cellKey(a)}>${cellKey(b)}`;
  const cached = stepCache.get(k);
  if (cached) return cached;
  const hits = CONFIG.Canvas.polygonBackends.move.testCollision(centerOf(a), centerOf(b), { type: "move", mode: "all" }) ?? [];
  let ok = true;
  const doors = new Set();
  for (const vertex of hits) {
    for (const edge of vertex.edges ?? []) {
      const doc = edge.object?.document;
      if (doc?.documentName === "Wall") {
        if (doc.door && doc.ds !== CONST.WALL_DOOR_STATES.LOCKED) {
          if (doc.ds === CONST.WALL_DOOR_STATES.CLOSED) doors.add(doc.id);
        } else ok = false;
      } else if (edge.type === "innerBounds" || edge.type === "outerBounds") ok = false;
    }
  }
  const result = { ok, doors: [...doors] };
  stepCache.set(k, result);
  return result;
}

/** Diagonal steps on square grids must not cut a wall corner: both orthogonal steps must be free too. */
function canStep(a, b) {
  const s = stepInfo(a, b);
  if (!s.ok) return null;
  if (canvas.grid.isSquare && a.i !== b.i && a.j !== b.j) {
    const s1 = stepInfo(a, { i: b.i, j: a.j });
    const s2 = stepInfo(a, { i: a.i, j: b.j });
    if (!s1.ok || !s2.ok || s1.doors.length || s2.doors.length || s.doors.length) return null;
  }
  return s;
}

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item, priority) {
    const a = this.items;
    a.push({ item, priority });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].priority <= a[i].priority) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].priority < a[m].priority) m = l;
        if (r < a.length && a[r].priority < a[m].priority) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top?.item;
  }
}

/**
 * A* from one cell to another. Returns the cells to walk (without the start), or null when unreachable.
 * @param {Set<string>} [avoid]  cell keys to treat as blocked (e.g. a cell another token stands on)
 */
export function findPath(from, to, { avoid = null, maxNodes = 40000 } = {}) {
  if (sameCell(from, to)) return [];
  const dims = canvas.dimensions;
  const minC = canvas.grid.getOffset({ x: dims.sceneX, y: dims.sceneY });
  const maxC = canvas.grid.getOffset({ x: dims.sceneX + dims.sceneWidth - 1, y: dims.sceneY + dims.sceneHeight - 1 });
  const inside = c => c.i >= minC.i && c.i <= maxC.i && c.j >= minC.j && c.j <= maxC.j;
  const h = c => Math.max(Math.abs(c.i - to.i), Math.abs(c.j - to.j));
  const open = new MinHeap();
  const g = new Map([[cellKey(from), 0]]);
  const came = new Map();
  open.push(from, h(from));
  let expanded = 0;
  while (open.size && expanded++ < maxNodes) {
    const cur = open.pop();
    const ck = cellKey(cur);
    if (sameCell(cur, to)) {
      const path = [];
      let k = ck, c = cur;
      while (came.has(k)) {
        path.unshift(c);
        c = came.get(k);
        k = cellKey(c);
      }
      return path;
    }
    const gc = g.get(ck);
    for (const n of canvas.grid.getAdjacentOffsets(cur)) {
      const nb = { i: n.i, j: n.j };
      const nk = cellKey(nb);
      if (!inside(nb) || (avoid?.has(nk) && !sameCell(nb, to))) continue;
      const s = canStep(cur, nb);
      if (!s) continue;
      const diagonal = nb.i !== cur.i && nb.j !== cur.j;
      const cost = gc + (diagonal ? 1.001 : 1) + (s.doors.length ? 1 : 0);
      if (cost < (g.get(nk) ?? Infinity)) {
        g.set(nk, cost);
        came.set(nk, cur);
        open.push(nb, cost + h(nb));
      }
    }
  }
  return null;
}
