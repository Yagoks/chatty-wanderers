// Chatty Wanderers — vision cones and spotting.
// Each patroller sees through a cone (angle and range configurable), clipped by walls like real sight, using its own
// senses: eyes need light (bright, dim — disadvantage —, or darkness within darkvision — disadvantage), blinded or
// "blind beyond" creatures don't see, truesight sees the invisible, blindsight and tremorsense work all around without
// light (tremorsense only on creatures touching the ground). An invisible target can still be noticed, with
// disadvantage. Only "intruders" count: player characters by default, with per-token overrides and a rule for summons.

import { MODULE_ID, tokenCenter } from "./pathing.js";
import { getPatrol, setting, watches } from "./patrol.js";

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

/** "bright" | "dim" | "dark" at a point: global light, scene darkness, and every light on the map (torches included). */
export function lightAt(point) {
  const env = canvas.scene.environment ?? {};
  const darkness = env.darknessLevel ?? canvas.scene.darkness ?? 0;
  if (env.globalLight?.enabled || darkness <= 0.25) return "bright";
  let best = darkness < 0.6 ? "dim" : "dark";
  for (const src of canvas.effects.lightSources) {
    if (!src.active || src.constructor.name.includes("Global") || !src.shape?.contains(point.x, point.y)) continue;
    const d = Math.hypot(point.x - src.data.x, point.y - src.data.y);
    if (d <= (Number(src.data.bright) || 0)) return "bright";
    best = "dim";
  }
  return best;
}

/** The senses of a token, in feet: its actor's (dnd5e 4/5 layouts) and its token's darkvision. */
export function sensesOf(td) {
  const s = td.actor?.system?.attributes?.senses ?? {};
  const r = s.ranges ?? s;
  const sight = td.sight ?? {};
  const tokenDark = sight.enabled && sight.visionMode === "darkvision" ? Number(sight.range) || 0 : 0;
  return {
    darkvision: Math.max(Number(r.darkvision) || 0, tokenDark),
    blindsight: Number(r.blindsight) || 0,
    tremorsense: Number(r.tremorsense) || 0,
    truesight: Number(r.truesight) || 0,
    // No eyes to speak of: blinded, or "blind beyond" its blindsight.
    blind: !!td.actor?.statuses?.has("blinded") || /blind beyond/i.test(String(s.special ?? ""))
  };
}

const clearLine = (a, b) => !CONFIG.Canvas.polygonBackends.sight.testCollision(a, b, { type: "sight", mode: "any" });
const onGround = (target, patroller) => !target.actor?.statuses?.has("flying") && !target.actor?.statuses?.has("hover")
  && (target.elevation ?? 0) <= (patroller.elevation ?? 0) + 1;

/**
 * How the patroller perceives a target right now, or null. { how, disadvantage, why[] }
 * Disadvantage (on its Perception) for dim light, darkness seen with darkvision, and invisible targets.
 */
export function detect(patroller, target) {
  if (target.hidden) return null;
  const from = patroller.object?.center ?? tokenCenter(patroller);
  const p = target.object?.center ?? tokenCenter(target);
  const distFt = Math.hypot(p.x - from.x, p.y - from.y) / canvas.dimensions.distancePixels;
  const S = sensesOf(patroller);
  // Senses that need no light and no facing.
  if (S.tremorsense && distFt <= S.tremorsense && onGround(target, patroller)) return { how: "tremorsense", disadvantage: false, why: [] };
  if (S.blindsight && distFt <= S.blindsight && clearLine(from, p)) return { how: "blindsight", disadvantage: false, why: [] };
  if (S.blind) return null;
  if (!conePolygon(patroller).contains(p.x, p.y)) return null;
  if (S.truesight && distFt <= S.truesight) return { how: "truesight", disadvantage: false, why: [] };
  const why = [];
  const light = lightAt(p);
  if (light === "dark") {
    if (distFt > S.darkvision) return null;
    why.push("darkness (darkvision)");
  } else if (light === "dim" && distFt > S.darkvision) why.push("dim light");
  if (target.actor?.statuses?.has("invisible")) why.push("invisible");
  return { how: "sight", disadvantage: why.length > 0, why };
}

/** Does the patroller notice this target right now? */
export function sees(patroller, target) {
  return !!detect(patroller, target);
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
    if (!watches(p) || !coneOf(td).enabled || td.hidden && !game.user.isGM) continue;
    const spotted = p.status === "spotted";
    const S = sensesOf(td);
    if (!S.blind) {
      const poly = conePolygon(td);
      g.lineStyle(2, spotted ? 0xff2020 : color, Math.min(1, alpha * 3));
      g.beginFill(spotted ? 0xff2020 : color, alpha);
      g.drawPolygon(poly.points);
      g.endFill();
    }
    // Blindsight / tremorsense reach all around: a thin ring.
    const around = Math.max(S.blindsight, S.tremorsense);
    if (around) {
      const c = td.object?.center ?? tokenCenter(td);
      g.lineStyle(1.5, spotted ? 0xff2020 : color, Math.min(1, alpha * 4));
      g.drawCircle(c.x, c.y, around * canvas.dimensions.distancePixels);
    }
  }
}

export function registerVision() {
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; drawCones(); });
  };
  Hooks.on("refreshToken", token => { if (watches(getPatrol(token.document))) schedule(); });
  Hooks.on("updateToken", (td, changes) => { if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) schedule(); });
  for (const h of ["createWall", "updateWall", "deleteWall", "lightingRefresh"]) Hooks.on(h, () => { clearCones(); schedule(); });
  Hooks.on("canvasReady", () => { clearCones(); layer = null; schedule(); });
  Hooks.on("deleteToken", td => conePolys.delete(td.id));
  return schedule;
}
