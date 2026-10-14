// Chatty Wanderers — the patrol engine. Runs on the active GM only, for the scene the GM is viewing.
// One shared clock: on every tick each patroller that has built up enough movement takes one grid step, and all the
// steps go out in a single update. Slower creatures simply step on fewer ticks.

import { checkSpotting } from "./spotting.js";
import { arrivalUpdate, hasReactions, leaveHiding } from "./reactions.js";
import { MODULE_ID, cellKey, cellOf, centerOf, clearPathCache, findPath, sameCell, stepInfo, tokenCenter, tokenPositionFor } from "./pathing.js";

/** Per-token runtime state (memory only). */
const runtime = new Map();
let timer = null;

export const isActiveGM = () => game.user.isGM && game.users.activeGM?.isSelf;
export const setting = key => game.settings.get(MODULE_ID, key);

/* -------------------------------------------- */
/*  Data                                        */
/* -------------------------------------------- */

export function getRoutes(scene = canvas.scene) {
  return foundry.utils.deepClone(foundry.utils.getProperty(scene?.flags ?? {}, `${MODULE_ID}.routes`) ?? {});
}

export function getRoute(scene, id) {
  return getRoutes(scene)[id] ?? null;
}

export function getPatrol(td) {
  return foundry.utils.getProperty(td?.flags ?? {}, `${MODULE_ID}.patrol`) ?? null;
}

export function scenePatrollers(scene = canvas.scene) {
  return scene?.tokens.filter(t => getPatrol(t)?.route || hasReactions(t)) ?? [];
}

/** Tokens that keep watch: on a route, walking to an alert goal, or holding a post. */
export const watches = p => !!(p && (p.route || p.goal || p.status === "holding"));

/** Grid steps per tick for this token: its walking speed relative to 30 ft, times the token and global multipliers. */
function stepsPerTick(td, patrol) {
  const walk = Number(td.actor?.system?.attributes?.movement?.walk) || 30;
  const tickSeconds = setting("tickMs") / 1000;
  // Baseline: a 30 ft creature walks one square every 0.6 s.
  const perSecond = (walk / 30) / 0.6;
  return Math.min(1, perSecond * tickSeconds * (Number(patrol.speed) || 1) * (Number(patrol.reactSpeed) || 1) * (Number(setting("speed")) || 1));
}

/** Rotation that faces the direction of travel (0 = facing down, like Foundry's auto-rotate). */
function facing(from, to) {
  const a = centerOf(from), b = centerOf(to);
  return Math.normalizeDegrees(Math.toDegrees(Math.atan2(b.y - a.y, b.x - a.x)) - 90);
}

function nextIndex(route, patrol) {
  const n = route.points.length;
  if (n <= 1) return { index: 0, dir: 1 };
  switch (route.mode) {
    case "pingpong": {
      let dir = patrol.dir ?? 1;
      if (patrol.index + dir >= n || patrol.index + dir < 0) dir = -dir;
      return { index: patrol.index + dir, dir };
    }
    case "random": {
      let i = patrol.index;
      while (i === patrol.index) i = Math.floor(Math.random() * n);
      return { index: i, dir: 1 };
    }
    default:
      return { index: (patrol.index + 1) % n, dir: 1 };
  }
}

/* -------------------------------------------- */
/*  Clock                                       */
/* -------------------------------------------- */

function rt(td) {
  let r = runtime.get(td.id);
  if (!r) runtime.set(td.id, r = { acc: 0, path: null, pathTo: null, waitUntil: 0, blocked: 0, toClose: [] });
  return r;
}

export function resetRuntime(tokenId) {
  if (tokenId) runtime.delete(tokenId);
  else runtime.clear();
}

async function tick() {
  if (!isActiveGM() || !canvas.ready || game.paused || setting("paused")) return;
  const scene = canvas.scene;
  if (!scene) return;
  if (game.combats.some(c => c.active && c.scene === scene && c.started)) return;
  const routes = getRoutes(scene);
  const now = Date.now();
  const tokenUpdates = [];
  const openDoors = new Set();
  const closeDoors = new Set();
  // Every creature blocks its square (dnd5e refuses moves into occupied squares, hidden tokens included).
  const occupied = new Map(scene.tokens.filter(t => t.actor).map(t => [cellKey(cellOf(tokenCenter(t))), t.id]));

  for (const td of scene.tokens) {
    const patrol = getPatrol(td);
    // "moving": walking to a goal given by the alert (a post, the alarm, back home).
    const moving = patrol?.status === "moving" && patrol.goal;
    if (!moving && (!patrol?.route || patrol.status !== "patrolling")) continue;
    const route = moving ? null : routes[patrol.route];
    if (!moving && !route?.points?.length) continue;
    // A token being dragged by the GM stays put.
    const mim = td.object?.mouseInteractionManager;
    if (mim && mim.state >= 3) continue;
    const r = rt(td);
    if (now < r.waitUntil) continue;
    r.acc += stepsPerTick(td, patrol);
    if (r.acc < 1) continue;
    r.acc -= 1;

    const cur = cellOf(tokenCenter(td));
    // The last step was refused (another module, an unexpected wall, a blocker): after a few tries, go around.
    if (r.tried && sameCell(r.tried.from, cur)) {
      if (++r.refused >= 3) {
        r.avoid = new Set([...(r.avoid ?? []), cellKey(r.tried.to)]);
        r.path = null;
        r.refused = 0;
      }
    } else r.refused = 0;
    r.tried = null;
    const index = moving ? 0 : Math.min(patrol.index ?? 0, route.points.length - 1);
    const target = cellOf(moving ? patrol.goal : route.points[index]);
    const arrive = () => {
      r.path = null;
      r.avoid = null;
      // Investigating: look around for a while before the next leg.
      const key = `${patrol.goal.x},${patrol.goal.y},${patrol.goal.then}`;
      if (Number(patrol.goal.wait) > 0 && r.waitedFor !== key) {
        r.waitedFor = key;
        r.waitUntil = now + Number(patrol.goal.wait) * 1000;
        return;
      }
      tokenUpdates.push(arrivalUpdate(td, patrol));
    };

    if (moving && sameCell(cur, target)) { arrive(); continue; }
    // Arrived: wait, then head for the next point.
    if (sameCell(cur, target)) {
      const point = route.points[index];
      r.waitUntil = now + (Number(point.wait) || 0) * 1000;
      r.path = null;
      r.avoid = null;
      const next = nextIndex(route, { ...patrol, index });
      const update = { _id: td.id, [`flags.${MODULE_ID}.patrol.index`]: next.index, [`flags.${MODULE_ID}.patrol.dir`]: next.dir };
      if (Number.isFinite(point.facing)) update.rotation = point.facing;
      tokenUpdates.push(update);
      continue;
    }

    if (!r.path || r.pathTo !== cellKey(target)) {
      r.path = findPath(cur, target, { avoid: r.avoid });
      r.pathTo = cellKey(target);
      if (!r.path && r.avoid) { r.avoid = null; r.path = findPath(cur, target); }
    }
    if (!r.path?.length && moving) {
      if (!r.warned?.goal) {
        r.warned = { ...(r.warned ?? {}), goal: true };
        ui.notifications.warn(`Chatty Wanderers: ${td.name} can't reach where the alert sends it — it stays put.`);
      }
      tokenUpdates.push({ _id: td.id, [`flags.${MODULE_ID}.patrol.status`]: "holding" });
      continue;
    }
    if (!r.path?.length) {
      // Unreachable (locked door, closed room): skip to the next point.
      r.path = null;
      if (!r.warned?.[index]) {
        r.warned = { ...(r.warned ?? {}), [index]: true };
        ui.notifications.warn(`Chatty Wanderers: ${td.name} can't reach point ${index + 1} of "${route.name}".`);
      }
      const next = nextIndex(route, { ...patrol, index });
      tokenUpdates.push({ _id: td.id, [`flags.${MODULE_ID}.patrol.index`]: next.index, [`flags.${MODULE_ID}.patrol.dir`]: next.dir });
      r.waitUntil = now + 1000;
      continue;
    }

    const step = r.path[0];
    const info = stepInfo(cur, step);
    if (!info.ok) { r.path = null; continue; }
    if (info.doors.length) {
      if (route?.openDoors === false) { r.path = null; continue; }
      for (const id of info.doors) openDoors.add(id);
      r.toClose.push(...info.doors);
      r.waitUntil = now + 350; // the door swings open, then the step
      continue;
    }
    // Someone stands there: wait a little, then go around.
    const there = occupied.get(cellKey(step));
    if (there && there !== td.id) {
      // Someone stands on the goal itself (the intruder on the trap): close enough.
      if (moving && sameCell(step, target)) { arrive(); continue; }
      if (++r.blocked > 6) {
        r.path = findPath(cur, target, { avoid: new Set([cellKey(step)]) });
        r.blocked = 0;
      }
      continue;
    }
    r.blocked = 0;
    occupied.delete(cellKey(cur));
    occupied.set(cellKey(step), td.id);
    r.path.shift();
    // Close the doors it opened once it is one step past them.
    if (r.toClose.length) {
      r.closeAfter = (r.closeAfter ?? 2) - 1;
      if (r.closeAfter <= 0) {
        if (route?.closeDoors !== false) for (const id of r.toClose) closeDoors.add(id);
        r.toClose = [];
        delete r.closeAfter;
      }
    }
    const pos = tokenPositionFor(td, step);
    r.tried = { from: cur, to: step };
    tokenUpdates.push({ _id: td.id, x: pos.x, y: pos.y, rotation: facing(cur, step), ...(moving ? leaveHiding(td, patrol) : null) });
  }

  if (openDoors.size || closeDoors.size) {
    const W = CONST.WALL_DOOR_STATES;
    const updates = [];
    for (const id of openDoors) updates.push({ _id: id, ds: W.OPEN });
    for (const id of closeDoors) if (!openDoors.has(id) && scene.walls.get(id)?.ds === W.OPEN) updates.push({ _id: id, ds: W.CLOSED });
    if (updates.length) await scene.updateEmbeddedDocuments("Wall", updates, { [MODULE_ID]: true });
  }
  if (tokenUpdates.length) {
    await scene.updateEmbeddedDocuments("Token", tokenUpdates,
      { [MODULE_ID]: true, animation: { duration: Math.max(150, setting("tickMs") * 0.95) } });
  }
  await checkSpotting(scene);
}

export function stopClock() {
  clearInterval(timer);
  timer = null;
}

export function startClock() {
  clearInterval(timer);
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tick(); } catch (err) { console.error(`${MODULE_ID} | tick`, err); } finally { busy = false; }
  }, setting("tickMs"));
}

/* -------------------------------------------- */
/*  Control                                     */
/* -------------------------------------------- */

export async function setStatus(td, status, extra = {}) {
  resetRuntime(td.id);
  await td.update({ [`flags.${MODULE_ID}.patrol.status`]: status, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`flags.${MODULE_ID}.patrol.${k}`, v])) },
    { [MODULE_ID]: true });
}

/**
 * The GM moved a patroller by hand: dropped on one of its route points, it carries on from there; anywhere else it
 * leaves the route and waits.
 */
function onManualMove(td, changes, options) {
  if (options?.[MODULE_ID] || !isActiveGM()) return;
  if (!("x" in changes || "y" in changes)) return;
  const patrol = getPatrol(td);
  // Moved while following the alert: it stays where the GM put it.
  if (patrol?.status === "moving") return setStatus(td, "holding");
  if (patrol?.status === "holding") return;
  if (!patrol?.route) return;
  const route = getRoute(td.parent, patrol.route);
  if (!route) return;
  const cell = cellOf(tokenCenter(td));
  const idx = route.points.findIndex(p => sameCell(cellOf(p), cell));
  if (idx >= 0) setStatus(td, "patrolling", { index: idx });
  else if (patrol.status === "patrolling") setStatus(td, "detached");
}

export function registerPatrol() {
  Hooks.on("updateToken", onManualMove);
  for (const hook of ["createWall", "updateWall", "deleteWall"]) Hooks.on(hook, () => clearPathCache());
  Hooks.on("canvasReady", () => { clearPathCache(); resetRuntime(); });
  Hooks.on("deleteToken", td => resetRuntime(td.id));
}
