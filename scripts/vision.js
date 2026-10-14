// Chatty Wanderers — vision cones and spotting.
// Each patroller sees through a cone (angle and range configurable), clipped by walls like real sight. A target is seen
// when its center is inside the cone, it isn't invisible to the patroller, and it is lit or within the patroller's
// darkvision. Only "intruders" count: player characters by default, with per-token overrides and a rule for summons.

import { MODULE_ID, tokenCenter } from "./pathing.js";
import { getPatrol, setting } from "./patrol.js";

const conePolys = new Map(); // token id -> {key, poly}
let layer = null;

/* -------------------------------------------- */
/*  Cone geometry                               */
/* -------------------------------------------- */

export function coneOf(td) {
  const p = getPatrol(td) ?? {};
  const v = p.vision ?? {};
  return {
    enabled: v.enabled !== false,
    angle: Number(v.angle) || setting("coneAngle"),
    range: Number(v.range) || setting("coneRange") // feet
  };
}

/** The cone polygon (wall-clipped). Uses the token's animated position when it has one. */
export function conePolygon(td) {
  const cone = coneOf(td);
  const obj = td.object;
  const c = obj?.center ?? tokenCenter(td);
  const rotation = obj?.document?.rotation ?? td.rotation;
  const key = `${Math.round(c.x)},${Math.round(c.y)},${Math.round(rotation)},${cone.angle},${cone.range}`;
  const cached = conePolys.get(td.id);
  if (cached?.key === key) return cached.poly;
  const poly = CONFIG.Canvas.polygonBackends.sight.create({ x: c.x, y: c.y }, {
    type: "sight", radius: cone.range * canvas.dimensions.distancePixels, angle: cone.angle, rotation
  });
  conePolys.set(td.id, { key, poly });
  return poly;
}

export function clearCones() {
  conePolys.clear();
}

/* -------------------------------------------- */
/*  Who counts                                  */
/* -------------------------------------------- */

const SMALL = new Set(["tiny", "sm"]);

function isSummon(actor) {
  const f = actor?.flags?.dnd5e ?? {};
  return !!(f.summon || f.summonedCopy || actor?.flags?.["chris-premades"]?.summons);
}

/** "intruder" | "ignored" for a token, from its override or the spotting rules. */
export function noticeClass(td) {
  const override = foundry.utils.getProperty(td.flags ?? {}, `${MODULE_ID}.notice`);
  if (override === "intruder" || override === "ignored") return override;
  const actor = td.actor;
  if (!actor || !actor.hasPlayerOwner) return "ignored";
  if (isSummon(actor)) {
    switch (setting("summonRule")) {
      case "intruder": return "intruder";
      case "ignored": return "ignored";
      default: { // small beasts blend in as local fauna
        const type = actor.system?.details?.type?.value;
        const size = actor.system?.traits?.size;
        return type === "beast" && SMALL.has(size) ? "ignored" : "intruder";
      }
    }
  }
  if (actor.type === "character") return "intruder";
  return setting("companionRule") === "ignored" ? "ignored" : "intruder";
}

/* -------------------------------------------- */
/*  Seeing                                      */
/* -------------------------------------------- */

function isLit(point) {
  const env = canvas.scene.environment ?? {};
  if (env.globalLight?.enabled || (env.darknessLevel ?? canvas.scene.darkness ?? 0) <= 0.25) return true;
  for (const src of canvas.effects.lightSources) {
    if (!src.active || src.constructor.name.includes("Global")) continue;
    if (src.shape?.contains(point.x, point.y)) return true;
  }
  return false;
}

/** Does the patroller see this target right now? */
export function sees(patroller, target) {
  if (target.hidden) return false;
  const poly = conePolygon(patroller);
  const p = target.object?.center ?? tokenCenter(target);
  if (!poly.contains(p.x, p.y)) return false;
  const senses = patroller.actor?.system?.attributes?.senses ?? {};
  const from = patroller.object?.center ?? tokenCenter(patroller);
  const distFt = Math.hypot(p.x - from.x, p.y - from.y) / canvas.dimensions.distancePixels;
  const special = Math.max(Number(senses.truesight) || 0, Number(senses.blindsight) || 0);
  if (target.actor?.statuses?.has("invisible") && distFt > special) return false;
  if (!isLit(p) && distFt > Math.max(Number(senses.darkvision) || 0, special)) return false;
  return true;
}

/* -------------------------------------------- */
/*  Drawing                                     */
/* -------------------------------------------- */

function ensureLayer() {
  if (layer && !layer.destroyed && layer.parent) return layer;
  layer = new PIXI.Graphics();
  layer.eventMode = "none";
  canvas.tokens.addChildAt?.(layer, 0) ?? canvas.tokens.addChild(layer);
  return layer;
}

/** Draw the cones of the patrollers of this scene (GM always; players when the setting allows). */
export function drawCones() {
  if (!canvas.ready) return;
  const visible = game.user.isGM || setting("conesForPlayers");
  const g = ensureLayer();
  g.clear();
  if (!visible || !setting("showCones")) return;
  const color = Number(foundry.utils.Color.from(setting("coneColor")));
  const alpha = Number(setting("coneOpacity"));
  for (const td of canvas.scene.tokens) {
    const p = getPatrol(td);
    if (!p?.route || !coneOf(td).enabled || td.hidden && !game.user.isGM) continue;
    const poly = conePolygon(td);
    const spotted = p.status === "spotted";
    g.lineStyle(2, spotted ? 0xff2020 : color, Math.min(1, alpha * 3));
    g.beginFill(spotted ? 0xff2020 : color, alpha);
    g.drawPolygon(poly.points);
    g.endFill();
  }
}

export function registerVision() {
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; drawCones(); });
  };
  Hooks.on("refreshToken", token => { if (getPatrol(token.document)?.route) schedule(); });
  Hooks.on("updateToken", (td, changes) => { if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) schedule(); });
  for (const h of ["createWall", "updateWall", "deleteWall", "lightingRefresh"]) Hooks.on(h, () => { clearCones(); schedule(); });
  Hooks.on("canvasReady", () => { clearCones(); layer = null; schedule(); });
  Hooks.on("deleteToken", td => conePolys.delete(td.id));
  return schedule;
}
