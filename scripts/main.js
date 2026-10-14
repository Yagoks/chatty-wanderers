// Chatty Wanderers — gives life to tokens. Stage 1: patrol routes.

import { MODULE_ID, findPath, cellOf } from "./pathing.js";
import { getPatrol, getRoutes, registerPatrol, resetRuntime, scenePatrollers, setStatus, setting, startClock, stopClock } from "./patrol.js";
import { RouteEditor, clearOverlay, showSelectedRoute } from "./editor.js";
import { drawCones, noticeClass, registerVision } from "./vision.js";
import { registerSpotting } from "./spotting.js";

/* -------------------------------------------- */
/*  Global pause button (next to the chat)      */
/* -------------------------------------------- */

function refreshGlobalButton() {
  const host = document.querySelector("#chat-controls .control-buttons");
  let btn = document.getElementById("cw-global");
  const show = game.user.isGM && scenePatrollers().length > 0;
  if (!show) return btn?.remove();
  if (!host) return;
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "cw-global";
    btn.className = "ui-control icon fa-solid fa-person-walking";
    btn.addEventListener("click", async () => {
      await game.settings.set(MODULE_ID, "paused", !setting("paused"));
      refreshGlobalButton();
    });
    host.prepend(btn);
  }
  const paused = setting("paused");
  btn.classList.toggle("cw-paused", paused);
  btn.classList.toggle("fa-person-walking", !paused);
  btn.classList.toggle("fa-person", paused);
  btn.dataset.tooltip = paused ? "Patrols paused — click to resume them" : "Patrols running — click to pause all of them";
  btn.setAttribute("aria-label", btn.dataset.tooltip);
}

/* -------------------------------------------- */
/*  Token HUD                                   */
/* -------------------------------------------- */

function onRenderTokenHUD(hud, html) {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  const col = root?.querySelector(".col.right");
  if (!col || col.querySelector(".cw-hud")) return;
  const td = hud.object?.document;
  const patrol = getPatrol(td);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `control-icon cw-hud ${patrol?.status === "patrolling" ? "active" : ""}`;
  btn.dataset.tooltip = "Patrol route";
  btn.innerHTML = `<i class="fa-solid fa-route"></i>`;
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    RouteEditor.open(td);
  });
  col.append(btn);

  // Who patrols notice: automatic (rules), always an intruder, or always ignored.
  const notice = foundry.utils.getProperty(td.flags ?? {}, `${MODULE_ID}.notice`) ?? "auto";
  const auto = noticeClass(td);
  const icons = { auto: auto === "intruder" ? "fa-eye" : "fa-eye-low-vision", intruder: "fa-eye", ignored: "fa-eye-slash" };
  const labels = { auto: `Patrols: automatic (${auto})`, intruder: "Patrols: always noticed", ignored: "Patrols: always ignored" };
  const nb = document.createElement("button");
  nb.type = "button";
  nb.className = `control-icon cw-notice cw-notice-${notice}`;
  nb.dataset.tooltip = `${labels[notice]} — click to change`;
  nb.innerHTML = `<i class="fa-solid ${icons[notice]}"></i>`;
  nb.addEventListener("click", async ev => {
    ev.preventDefault();
    const next = { auto: "intruder", intruder: "ignored", ignored: "auto" }[notice];
    await td.update({ [`flags.${MODULE_ID}.notice`]: next === "auto" ? null : next });
    hud.render();
  });
  col.append(nb);
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, { scope: "world", config: true, ...data });
  reg("tickMs", {
    name: "Clock (ms)", hint: "How often patrollers take a step. Lower is smoother and heavier. A 30 ft creature walks one square every 0.6 s.",
    type: Number, default: 300, range: { min: 150, max: 1500, step: 50 }, onChange: () => startClock()
  });
  reg("speed", { name: "Global speed ×", hint: "Multiplies every patroller's speed.", type: Number, default: 1, range: { min: 0.25, max: 3, step: 0.25 } });
  reg("paused", { name: "Patrols paused", type: Boolean, default: false, config: false, onChange: () => refreshGlobalButton() });
  const choice = (key, name, hint, choices, def) => reg(key, { name, hint, type: String, choices, default: def });
  reg("showCones", { name: "Show vision cones", type: Boolean, default: true, onChange: () => drawCones() });
  reg("conesForPlayers", { name: "Players see the cones", hint: "Off: only the GM sees them.", type: Boolean, default: false, onChange: () => drawCones() });
  reg("coneColor", { name: "Cone color", type: new foundry.data.fields.ColorField({ initial: "#ff6b3d" }), default: "#ff6b3d", onChange: () => drawCones() });
  reg("coneOpacity", { name: "Cone opacity", type: Number, default: 0.15, range: { min: 0.02, max: 0.6, step: 0.01 }, onChange: () => drawCones() });
  reg("coneAngle", { name: "Default cone angle (degrees)", type: Number, default: 100, range: { min: 20, max: 360, step: 5 } });
  reg("coneRange", { name: "Default cone range (ft)", type: Number, default: 60, range: { min: 5, max: 300, step: 5 } });
  choice("summonRule", "Summons of the players", "Summoned creatures of the players.", {
    smallBeasts: "Tiny/Small beasts blend in (ignored); others are noticed", intruder: "Always noticed", ignored: "Always ignored" }, "smallBeasts");
  choice("companionRule", "Other creatures of the players", "Player-owned non-character actors that aren't summons (companions, mounts).", {
    intruder: "Noticed", ignored: "Ignored" }, "intruder");
  reg("pauseOnSpot", { name: "Pause the game when someone is spotted", type: Boolean, default: true });
  choice("stealthMode", "Stealth rolls", "Who rolls Stealth when someone is spotted.", {
    players: "Each player rolls their own (GM rolls the rest)", epic: "Epic Rolls", gm: "The GM rolls them all" }, "players");
  reg("stealthTimeout", { name: "Seconds players have to roll", type: Number, default: 30, range: { min: 10, max: 120, step: 5 } });
  reg("spotCooldown", { name: "Seconds before the same patroller can spot the same target again", type: Number, default: 30, range: { min: 5, max: 300, step: 5 } });
  reg("discoveredMacro", { name: "Macro when someone is discovered", hint: "Name of a macro to run (receives patroller, targets, scene). Leave empty for none.", type: String, default: "" });
  game.settings.register(MODULE_ID, "showSelected", {
    name: "Show the route of a selected patroller", hint: "GM only: a faint drawing of its route while the token is selected.",
    scope: "client", config: true, type: Boolean, default: true
  });

  registerPatrol();
  registerVision();
  registerSpotting();
  game.modules.get(MODULE_ID).api = {
    openEditor: td => RouteEditor.open(td?.document ?? td),
    start: (td, index = 0) => setStatus(td?.document ?? td, "patrolling", { index }),
    stop: td => setStatus(td?.document ?? td, "stopped"),
    pauseAll: (paused = true) => game.settings.set(MODULE_ID, "paused", paused),
    getRoutes, findPath, cellOf, stopClock
  };
});

Hooks.once("ready", () => {
  startClock();
  refreshGlobalButton();
  Hooks.on("renderTokenHUD", onRenderTokenHUD);
  Hooks.on("renderChatLog", () => refreshGlobalButton());
  Hooks.on("canvasReady", () => { clearOverlay(); refreshGlobalButton(); });
  Hooks.on("controlToken", () => setTimeout(showSelectedRoute, 0));
  Hooks.on("updateToken", (td, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) {
      refreshGlobalButton();
      if (RouteEditor.current?.td === td) RouteEditor.current.render();
    }
  });
  Hooks.on("updateScene", (scene, changes) => {
    if (scene === canvas.scene && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) {
      resetRuntime();
      showSelectedRoute();
    }
  });
  for (const h of ["createToken", "deleteToken"]) Hooks.on(h, () => refreshGlobalButton());
});
