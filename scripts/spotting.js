// Chatty Wanderers — what happens when a patroller sees an intruder.
// The patroller stops and faces the target, the game can pause, and the GM gets a card: Passive (DC = passive
// Perception) or Active (roll Perception, DC = result), or "False alarm". The targets then roll Stealth against that DC
// (each player from their own client, through Epic Rolls, or by the GM). Anyone who fails is discovered.

import { MODULE_ID, tokenCenter } from "./pathing.js";
import { getPatrol, isActiveGM, resetRuntime, setting, watches } from "./patrol.js";
import { noticeClass, sees } from "./vision.js";

const SOCKET = `module.${MODULE_ID}`;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const stripButtons = html => html.replace(/<div class="cw-card-buttons">[\s\S]*?<\/div>/, "").replace(/<button type="button" data-cw-spot="resume">[\s\S]*?<\/button>/, "");
const cooldown = new Map(); // "patrollerId:targetId" -> until (ms)
const waits = new Map();     // stealth request id -> resolve

/* -------------------------------------------- */
/*  Detection (GM, every clock tick)            */
/* -------------------------------------------- */

export async function checkSpotting(scene) {
  if (!isActiveGM()) return;
  const now = Date.now();
  const intruders = scene.tokens.filter(t => t.actor && noticeClass(t) === "intruder");
  if (!intruders.length) return;
  for (const td of scene.tokens) {
    const p = getPatrol(td);
    if (!watches(p) || td.hidden || p.status === "spotted" || p.status === "alerted" || p.vision?.enabled === false) continue;
    const seen = intruders.filter(t => t.id !== td.id && (cooldown.get(`${td.id}:${t.id}`) ?? 0) < now && sees(td, t));
    if (seen.length) await spot(td, seen);
  }
}

async function spot(td, targets) {
  const p = getPatrol(td);
  const first = targets[0];
  const from = tokenCenter(td), to = tokenCenter(first);
  const rotation = Math.normalizeDegrees(Math.toDegrees(Math.atan2(to.y - from.y, to.x - from.x)) - 90);
  await td.update({
    rotation,
    [`flags.${MODULE_ID}.patrol.status`]: "spotted",
    [`flags.${MODULE_ID}.patrol.resumeStatus`]: p.status,
    [`flags.${MODULE_ID}.patrol.spot`]: { targets: targets.map(t => t.id), at: Date.now(), x: to.x, y: to.y }
  }, { [MODULE_ID]: true });
  resetRuntime(td.id);
  if (setting("pauseOnSpot") && !game.paused) game.togglePause(true, { broadcast: true });
  const names = targets.map(t => `<b>${esc(t.name)}</b>`).join(", ");
  const passive = td.actor?.system?.skills?.prc?.passive ?? 10;
  await ChatMessage.create({
    speaker: { alias: td.name },
    whisper: ChatMessage.getWhisperRecipients("GM"),
    content: `<div class="cw-card" data-patroller="${td.id}">
      <p><i class="fa-solid fa-eye"></i> <b>${esc(td.name)}</b> spotted ${names}.</p>
      <div class="cw-card-buttons">
        <button type="button" data-cw-spot="passive"><i class="fa-solid fa-eye"></i> Standing (passive ${passive})</button>
        <button type="button" data-cw-spot="active"><i class="fa-solid fa-magnifying-glass"></i> Searching (roll)</button>
        <button type="button" data-cw-spot="dismiss"><i class="fa-solid fa-xmark"></i> False alarm</button>
      </div></div>`,
    flags: { [MODULE_ID]: { spot: { patroller: td.id, scene: td.parent.id, targets: targets.map(t => t.id) } } }
  });
  Hooks.callAll(`${MODULE_ID}.spotted`, td, targets);
}

/* -------------------------------------------- */
/*  Resolution                                  */
/* -------------------------------------------- */

async function resume(td, targets) {
  const until = Date.now() + (Number(setting("spotCooldown")) || 30) * 1000;
  for (const id of targets ?? []) cooldown.set(`${td.id}:${id}`, until);
  const p = getPatrol(td);
  await td.update({
    [`flags.${MODULE_ID}.patrol.status`]: p?.resumeStatus === "spotted" ? "patrolling" : (p?.resumeStatus ?? "patrolling"),
    [`flags.${MODULE_ID}.patrol.-=spot`]: null
  }, { [MODULE_ID]: true });
  resetRuntime(td.id);
}

/** Ask the owning player to roll Stealth (no DC shown); null on timeout. */
function askPlayer(user, td) {
  const rid = foundry.utils.randomID();
  const timeoutMs = (Number(setting("stealthTimeout")) || 30) * 1000;
  return new Promise(resolve => {
    const timer = setTimeout(() => { waits.delete(rid); resolve(null); }, timeoutMs);
    waits.set(rid, total => { clearTimeout(timer); waits.delete(rid); resolve(total); });
    game.socket.emit(SOCKET, { type: "stealthRequest", to: user.id, rid, actorUuid: td.actor.uuid, name: td.name, timeoutMs });
  });
}

function ownerOf(actor) {
  const players = game.users.filter(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
  return players.find(u => u.character?.id === actor.id) ?? players[0] ?? null;
}

async function gmStealth(actor) {
  const rolls = await actor.rollSkill({ skill: "ste" }, { configure: false }, { rollMode: "gmroll", create: true });
  return (Array.isArray(rolls) ? rolls[0] : rolls)?.total ?? 0;
}

/** Stealth totals for every target, according to the chosen mode. Map tokenId -> total. */
async function stealthFor(targets, dc) {
  const out = new Map();
  const mode = setting("stealthMode");
  if (mode === "epic" && ui.EpicRolls5e?.requestRoll) {
    try {
      const res = await ui.EpicRolls5e.requestRoll({ actors: targets.map(t => t.actor.uuid), contestants: [], type: "skill.ste", contest: null, options: { DC: dc, hideDC: true } });
      for (const r of res?.results ?? []) {
        const t = targets.find(t => t.actor.uuid === r.actor?.uuid || t.actor === r.actor);
        const total = r.roll?.total ?? r.value;
        if (t && Number.isFinite(total)) out.set(t.id, total);
      }
    } catch (err) { console.error(`${MODULE_ID} | Epic Rolls`, err); }
  } else if (mode === "players") {
    await Promise.all(targets.map(async t => {
      const user = ownerOf(t.actor);
      if (!user) return;
      const total = await askPlayer(user, t);
      if (Number.isFinite(total)) out.set(t.id, total);
    }));
  }
  for (const t of targets) if (!out.has(t.id)) out.set(t.id, await gmStealth(t.actor));
  return out;
}

async function onCardButton(message, action, btn) {
  const info = message.flags?.[MODULE_ID]?.spot;
  const scene = game.scenes.get(info?.scene);
  const td = scene?.tokens.get(info?.patroller);
  if (!td) return ui.notifications.warn("Chatty Wanderers: that patroller is gone.");
  const targets = (info.targets ?? []).map(id => scene.tokens.get(id)).filter(Boolean);
  btn.closest(".cw-card-buttons")?.querySelectorAll("button").forEach(b => { b.disabled = true; });

  if (action === "dismiss") {
    await resume(td, info.targets);
    return message.update({ content: `${stripButtons(message.content)}<p class="cw-result"><em>False alarm — ${esc(td.name)} carries on.</em></p>` });
  }
  if (action === "resume") {
    await resume(td, info.targets);
    return message.update({ content: `${stripButtons(message.content)}<p class="cw-result"><em>${esc(td.name)} goes back to its route.</em></p>` });
  }

  let dc;
  if (action === "passive") dc = td.actor?.system?.skills?.prc?.passive ?? 10;
  else {
    const rolls = await td.actor.rollSkill({ skill: "prc" }, { configure: false }, { rollMode: "gmroll", create: true });
    dc = (Array.isArray(rolls) ? rolls[0] : rolls)?.total ?? 10;
  }
  const totals = await stealthFor(targets, dc);
  const rows = targets.map(t => {
    const total = totals.get(t.id);
    const hidden = total >= dc;
    return `<li class="${hidden ? "cw-ok" : "cw-fail"}"><b>${esc(t.name)}</b>: ${total} — ${hidden ? "unnoticed" : "<b>discovered</b>"}</li>`;
  }).join("");
  const discovered = targets.filter(t => totals.get(t.id) < dc);
  if (!discovered.length) await resume(td, info.targets);
  else {
    await td.update({ [`flags.${MODULE_ID}.patrol.status`]: "alerted" }, { [MODULE_ID]: true });
    Hooks.callAll(`${MODULE_ID}.discovered`, td, discovered);
    const macroName = setting("discoveredMacro");
    if (macroName) game.macros.getName(macroName)?.execute({ patroller: td, targets: discovered, scene });
  }
  await message.update({
    content: `${stripButtons(message.content)}<div class="cw-result"><p>Stealth vs DC ${dc} (${action === "passive" ? "passive" : "rolled"}):</p><ul>${rows}</ul>
      ${discovered.length ? `<button type="button" data-cw-spot="resume"><i class="fa-solid fa-route"></i> Back to the route</button>` : `<p><em>${esc(td.name)} carries on.</em></p>`}</div>`
  });
}

/* -------------------------------------------- */
/*  Player side                                 */
/* -------------------------------------------- */

async function onStealthRequest(msg) {
  const actor = fromUuidSync(msg.actorUuid);
  if (!actor) return;
  let answered = false;
  const send = total => {
    if (answered) return;
    answered = true;
    game.socket.emit(SOCKET, { type: "stealthResult", rid: msg.rid, total });
  };
  const dlg = new foundry.applications.api.DialogV2({
    window: { title: "Stealth!", icon: "fa-solid fa-user-ninja" },
    classes: ["cw-stealth"],
    content: `<p>Something may have noticed <b>${esc(msg.name)}</b>. Roll <b>Dexterity (Stealth)</b>.</p>
      <p class="cw-hint">If you don't roll in ${Math.round(msg.timeoutMs / 1000)} s, the GM rolls for you.</p>`,
    buttons: [{
      action: "roll", label: "Roll Stealth", icon: "fa-solid fa-dice-d20", default: true,
      callback: async () => {
        const rolls = await actor.rollSkill({ skill: "ste" });
        const roll = Array.isArray(rolls) ? rolls[0] : rolls;
        if (roll) send(roll.total);
      }
    }],
    rejectClose: false
  });
  dlg.render(true);
  setTimeout(() => { if (!answered) { answered = true; dlg.close(); } }, msg.timeoutMs - 500);
}

export function registerSpotting() {
  game.socket.on(SOCKET, msg => {
    if (msg.type === "stealthRequest" && msg.to === game.user.id) return onStealthRequest(msg);
    if (msg.type === "stealthResult" && isActiveGM()) return waits.get(msg.rid)?.(msg.total);
  });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!message.flags?.[MODULE_ID]?.spot) return;
    html.querySelectorAll("[data-cw-spot]").forEach(btn => {
      if (!game.user.isGM) return btn.remove();
      btn.addEventListener("click", () => onCardButton(message, btn.dataset.cwSpot, btn));
    });
  });
}
