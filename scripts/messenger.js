// Chatty Wanderers — messengers. A patroller set to "run to warn" that discovers intruders leaves its route and runs to
// a point (faster than walking); when it gets there the scene alert goes up one level. Outside combat it runs on its own.
// - Hit on the way: it stops, the game pauses and the GM gets a card (start combat / carry on / cancel).
// - Joining a combat cancels the run for good (it stays where it is), and so does dropping to 0 HP.
// - Grappled, restrained, incapacitated and the like: it waits where it is until it is free.

import { MODULE_ID, tokenCenter } from "./pathing.js";
import { getPatrol, isActiveGM, resetRuntime } from "./patrol.js";
import { alertOp } from "./alert.js";
import { startCombat } from "./spotting.js";

const P = `flags.${MODULE_ID}.patrol`;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
/** Conditions that keep a messenger from running. */
export const HELD = ["grappled", "restrained", "incapacitated", "paralyzed", "petrified", "stunned", "unconscious"];

export const isRunning = p => !!p?.run;
export const isHeld = td => HELD.some(s => td.actor?.statuses?.has(s));
const hpOf = td => Number(td.actor?.system?.attributes?.hp?.value) || 0;

function card(td, content, buttons = []) {
  const labels = {
    combat: '<i class="fa-solid fa-swords"></i> Start combat',
    resume: '<i class="fa-solid fa-person-running"></i> Carry on running',
    cancel: '<i class="fa-solid fa-ban"></i> Cancel the run'
  };
  return ChatMessage.create({
    speaker: { alias: td.name },
    whisper: ChatMessage.getWhisperRecipients("GM"),
    content: `<div class="cw-card">${content}${buttons.length ? `<div class="cw-card-buttons">${buttons.map(b => `<button type="button" data-cw-run="${b}">${labels[b]}</button>`).join("")}</div>` : ""}</div>`,
    flags: { [MODULE_ID]: { run: { scene: td.parent.id, token: td.id } } }
  });
}

/** Send a token running to its warning point (route window → Vision → Discovering: run to warn). */
export async function startRun(td, { reason = "" } = {}) {
  const p = getPatrol(td) ?? {};
  const sp = p.spotting ?? {};
  if (!sp.warnPoint) {
    ui.notifications.warn(`Chatty Wanderers: ${td.name} has no point to run to (route window → Vision).`);
    return false;
  }
  await td.update({
    [`${P}.goal`]: { x: sp.warnPoint.x, y: sp.warnPoint.y, then: "warn" },
    [`${P}.status`]: "moving",
    [`${P}.reactSpeed`]: Number(sp.warnSpeed) || 2,
    [`${P}.run`]: { since: Date.now(), reason, hp: hpOf(td) },
    [`${P}.-=spot`]: null
  }, { [MODULE_ID]: true });
  resetRuntime(td.id);
  await card(td, `<p><i class="fa-solid fa-person-running"></i> <b>${esc(td.name)}</b> runs to warn the others.</p>
    <p class="cw-hint">If it gets there, the alert goes up one level. Hitting it stops it; a combat cancels the run.</p>`, ["cancel"]);
  Hooks.callAll(`${MODULE_ID}.runStarted`, td);
  return true;
}

/** End the run for good: the token stays where it is. */
export async function cancelRun(td, why = "") {
  if (!getPatrol(td)?.run) return;
  await td.update({ [`${P}.status`]: "holding", [`${P}.-=goal`]: null, [`${P}.-=run`]: null, [`${P}.-=reactSpeed`]: null }, { [MODULE_ID]: true });
  resetRuntime(td.id);
  if (why) await card(td, `<p><i class="fa-solid fa-ban"></i> <b>${esc(td.name)}</b> no longer runs to warn: ${esc(why)}.</p>`);
}

/** The run stops where it is (hit on the way); the GM decides what happens next. */
async function haltRun(td) {
  await td.update({ [`${P}.status`]: "halted" }, { [MODULE_ID]: true });
  resetRuntime(td.id);
  if (!game.paused) game.togglePause(true, { broadcast: true });
  await card(td, `<p><i class="fa-solid fa-burst"></i> <b>${esc(td.name)}</b> was hit while running to warn the others. It stopped and the game is paused.</p>`,
    ["combat", "resume", "cancel"]);
}

async function resumeRun(td) {
  const p = getPatrol(td);
  if (!p?.run || !p.goal) return;
  await td.update({ [`${P}.status`]: "moving", [`${P}.run.hp`]: hpOf(td) }, { [MODULE_ID]: true });
  resetRuntime(td.id);
}

/**
 * The messenger reached its point (called from the clock). Raises the alert and returns the token update: it stays
 * there, holding.
 */
export function warnArrival(td) {
  const scene = td.parent;
  const reason = `${td.name} warned the others`;
  queueMicrotask(async () => {
    await alertOp(scene, "raise", { source: "messenger", reason, origin: td });
    Hooks.callAll(`${MODULE_ID}.warned`, td);
  });
  resetRuntime(td.id);
  return { _id: td.id, [`${P}.status`]: "holding", [`${P}.-=goal`]: null, [`${P}.-=run`]: null, [`${P}.-=reactSpeed`]: null };
}

/** Tokens of an actor (an unlinked token's synthetic actor has one). */
function tokensOf(actor) {
  if (actor.isToken) return actor.token ? [actor.token] : [];
  return game.scenes.contents.flatMap(s => s.tokens.filter(t => t.actorLink && t.actorId === actor.id));
}

const inCombat = scene => game.combats.some(c => c.started && c.scene?.id === scene.id);

/** Hit Points of a messenger changed: dropped to 0 cancels the run; hit while running (outside combat) halts it. */
function onHp(td) {
  const run = getPatrol(td)?.run;
  if (!run) return;
  const hp = hpOf(td);
  if (hp <= 0) return cancelRun(td, "it dropped to 0 HP");
  if (hp < (Number(run.hp) || 0) && getPatrol(td).status === "moving" && !inCombat(td.parent)) return haltRun(td);
  if (hp !== Number(run.hp)) return td.update({ [`${P}.run.hp`]: hp }, { [MODULE_ID]: true });
}

function onUpdateActor(actor, changes) {
  if (!isActiveGM() || !foundry.utils.hasProperty(changes, "system.attributes.hp")) return;
  for (const td of tokensOf(actor)) onHp(td);
}

// Unlinked tokens: the damage lands in the token's delta.
function onUpdateToken(td, changes) {
  if (!isActiveGM() || !foundry.utils.hasProperty(changes, "delta.system.attributes.hp")) return;
  onHp(td);
}

function onCombatant(combatant) {
  if (!isActiveGM()) return;
  const td = combatant.token;
  if (td && getPatrol(td)?.run) cancelRun(td, "it joined a combat");
}

/** Player characters near the messenger (for "Start combat"). */
function nearby(td, feet = 60) {
  const c = tokenCenter(td);
  const reach = (feet / td.parent.grid.distance) * td.parent.grid.size;
  return td.parent.tokens.filter(t => t.id !== td.id && t.actor?.hasPlayerOwner && !t.hidden && Math.hypot(tokenCenter(t).x - c.x, tokenCenter(t).y - c.y) <= reach);
}

async function onCardButton(message, action, btn) {
  const info = message.flags?.[MODULE_ID]?.run;
  const scene = game.scenes.get(info?.scene);
  const td = scene?.tokens.get(info?.token);
  if (!td) return ui.notifications.warn("Chatty Wanderers: that token is gone.");
  btn.closest(".cw-card-buttons")?.querySelectorAll("button").forEach(b => { b.disabled = true; });
  let note = "";
  if (action === "cancel") { await cancelRun(td); note = `${td.name} stays where it is.`; }
  if (action === "resume") { await resumeRun(td); note = `${td.name} carries on running${game.paused ? " (unpause the game)" : ""}.`; }
  if (action === "combat") { await startCombat(scene, [td, ...nearby(td)]); note = "Combat! The run is cancelled."; }
  await message.update({ content: `${message.content.replace(/<div class="cw-card-buttons">[\s\S]*?<\/div>/, "")}<p class="cw-result"><em>${esc(note)}</em></p>` });
}

export function registerMessenger() {
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("updateToken", onUpdateToken);
  Hooks.on("createCombatant", onCombatant);
  Hooks.on("combatStart", combat => { for (const c of combat.combatants) onCombatant(c); });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!message.flags?.[MODULE_ID]?.run) return;
    html.querySelectorAll("[data-cw-run]").forEach(btn => {
      if (!game.user.isGM) return btn.remove();
      btn.addEventListener("click", () => onCardButton(message, btn.dataset.cwRun, btn));
    });
  });
}
