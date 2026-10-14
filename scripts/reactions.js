// Chatty Wanderers — what each token does at each alert level of its scene.
// A token keeps per-level reactions in flags.chatty-wanderers.reactions = { "1": { action, ... }, "2": ... }. A level
// without a reaction keeps the one of the level below; level 0 is the token's usual behavior. When the alert changes,
// the active GM gives each token the reaction of the new level. Before the first reaction the token's usual state is
// saved (patrol.home) so it can walk back and carry on when the alert drops again.

import { MODULE_ID, tokenCenter } from "./pathing.js";
import { getPatrol, getRoute, resetRuntime } from "./patrol.js";

export const ACTIONS = {
  "": "— as the level below —",
  normal: "Usual behavior (back to its post / route)",
  route: "Patrol another route",
  goto: "Go to a point",
  investigate: "Investigate the alarm",
  hold: "Stop where it is"
};

const isActiveGM = () => game.user.isGM && game.users.activeGM?.isSelf;

export function getReactions(td) {
  return foundry.utils.getProperty(td?.flags ?? {}, `${MODULE_ID}.reactions`) ?? {};
}

export const hasReactions = td => Object.values(getReactions(td)).some(r => r?.action);

/** The reaction in force at a level: the closest configured level at or below it ({ level: 0 } = usual behavior). */
export function effectiveReaction(td, level) {
  const reactions = getReactions(td);
  for (let n = level; n >= 1; n--) {
    const r = reactions[n];
    if (r?.action) return r.action === "normal" ? { level: 0 } : { level: n, ...r };
  }
  return { level: 0 };
}

/** A point from what a macro passes as the origin of an alarm: { x, y }, a tile, a token, a sound (document or object). */
export function originPoint(o) {
  o = o?.document ?? o;
  if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
  if (o.documentName === "Tile") return { x: o.x + o.width / 2, y: o.y + o.height / 2 };
  if (o.documentName === "Token") return tokenCenter(o);
  return { x: o.x, y: o.y };
}

/** Where the alarm came from: an explicit origin, the signal's spot, else the bell (its tile or Ambient Sound). */
export function alarmOrigin(scene, config, opts = {}) {
  const o = originPoint(opts.origin);
  if (o) return o;
  const src = config.sources?.find(s => s.key === opts.source);
  if (src && Number.isFinite(src.x)) return { x: src.x, y: src.y };
  const tile = config.bellTile && scene.tiles.get(config.bellTile);
  if (tile) return { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
  const sound = config.bellAmbientSound && scene.sounds.get(config.bellAmbientSound);
  if (sound) return { x: sound.x, y: sound.y };
  return null;
}

/** Updates that put a token into a reaction (or back to its usual behavior). */
function reactionUpdate(td, eff, origin) {
  const p = getPatrol(td) ?? {};
  const P = `flags.${MODULE_ID}.patrol`;
  const busy = p.status === "spotted" || p.status === "alerted";
  // Spotting in progress: the new status waits until the GM resolves the card.
  const statusKey = busy ? `${P}.resumeStatus` : `${P}.status`;
  const update = { _id: td.id, [`${P}.react`]: eff.level };

  if (eff.level === 0) {
    if (!p.home) return update;
    update[`${P}.goal`] = { x: p.home.x, y: p.home.y, then: "home" };
    update[`${P}.reactSpeed`] = null;
    update[statusKey] = "moving";
    return update;
  }

  if (!p.home) {
    const c = tokenCenter(td);
    update[`${P}.home`] = { x: c.x, y: c.y, rotation: td.rotation, route: p.route ?? null, status: busy ? (p.resumeStatus ?? "stopped") : (p.status ?? "stopped"), index: p.index ?? 0 };
  }
  update[`${P}.reactSpeed`] = Number(eff.speed) || null;
  switch (eff.action) {
    case "route": {
      const route = getRoute(td.parent, eff.route);
      if (!route?.points?.length) return update;
      const here = tokenCenter(td);
      let index = 0, best = Infinity;
      route.points.forEach((pt, i) => { const d = Math.hypot(pt.x - here.x, pt.y - here.y); if (d < best) { best = d; index = i; } });
      Object.assign(update, { [`${P}.route`]: route.id, [`${P}.index`]: index, [`${P}.dir`]: 1, [`${P}.-=goal`]: null, [statusKey]: "patrolling" });
      break;
    }
    case "goto":
      if (!eff.point) return update;
      Object.assign(update, { [`${P}.goal`]: { x: eff.point.x, y: eff.point.y, facing: eff.facing ?? null, then: eff.then === "hide" ? "hide" : "stay" }, [statusKey]: "moving" });
      break;
    case "investigate":
      if (!origin) {
        ui.notifications.warn(`Chatty Wanderers: ${td.name} has nowhere to investigate (the alarm has no origin and the scene no bell).`);
        Object.assign(update, { [statusKey]: "holding", [`${P}.-=goal`]: null });
        break;
      }
      Object.assign(update, { [`${P}.goal`]: { x: origin.x, y: origin.y, then: "return", wait: Number(eff.wait) || 0 }, [statusKey]: "moving" });
      break;
    case "hold":
      Object.assign(update, { [statusKey]: "holding", [`${P}.-=goal`]: null });
      break;
  }
  return update;
}

/** GM: the alert of a scene changed — every token with reactions takes the one of the new level. */
export async function applyReactions(scene, level, opts = {}, config = {}) {
  if (!isActiveGM() || !scene) return;
  const origin = alarmOrigin(scene, config, opts);
  const updates = [];
  for (const td of scene.tokens) {
    if (!hasReactions(td) && !getPatrol(td)?.home) continue;
    const eff = effectiveReaction(td, level);
    const p = getPatrol(td) ?? {};
    // Only a change of reaction moves the token (a raise that stays on the same reaction changes nothing).
    if ((p.react ?? 0) === eff.level && !opts.force) continue;
    updates.push(reactionUpdate(td, eff, origin));
    resetRuntime(td.id);
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, { [MODULE_ID]: true });
  return updates.length;
}

/**
 * A moving token reached its goal. Returns the token update (or null to keep going).
 * stay: holds there; hide: holds and hides; return: waits, then walks back home; home: its usual behavior again.
 */
export function arrivalUpdate(td, p) {
  const P = `flags.${MODULE_ID}.patrol`;
  const goal = p.goal;
  const update = { _id: td.id };
  switch (goal.then) {
    case "hide":
      // Only a token the alert hid comes back into view when it returns.
      Object.assign(update, { hidden: true, [`${P}.status`]: "holding" });
      if (!td.hidden) update[`${P}.hiddenByAlert`] = true;
      break;
    case "return":
      if (p.home) update[`${P}.goal`] = { x: p.home.x, y: p.home.y, then: "home" };
      else update[`${P}.status`] = "holding";
      break;
    case "home": {
      const home = p.home ?? {};
      Object.assign(update, {
        [`${P}.status`]: home.route ? (home.status === "detached" ? "stopped" : home.status ?? "stopped") : "stopped",
        [`${P}.route`]: home.route ?? null,
        [`${P}.index`]: home.index ?? 0,
        [`${P}.-=goal`]: null, [`${P}.-=home`]: null, [`${P}.-=reactSpeed`]: null
      });
      if (Number.isFinite(home.rotation)) update.rotation = home.rotation;
      if (p.hiddenByAlert) Object.assign(update, { hidden: false, [`${P}.-=hiddenByAlert`]: null });
      break;
    }
    default:
      update[`${P}.status`] = "holding";
  }
  if (Number.isFinite(goal.facing) && goal.then !== "home") update.rotation = goal.facing;
  return update;
}

/** Walking home from hiding: show the token again as soon as it leaves. */
export function leaveHiding(td, p) {
  return p.hiddenByAlert && p.goal?.then === "home" ? { hidden: false, [`flags.${MODULE_ID}.patrol.-=hiddenByAlert`]: null } : null;
}
