// Chatty Wanderers — gives life to tokens. Stage 1: patrol routes.

import { MODULE_ID, findPath, cellOf } from "./pathing.js";
import { getPatrol, getRoutes, registerPatrol, resetRuntime, scenePatrollers, setStatus, setting, startClock, stopClock } from "./patrol.js";
import { RouteEditor, clearOverlay, showSelectedRoute } from "./editor.js";

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
  game.settings.register(MODULE_ID, "showSelected", {
    name: "Show the route of a selected patroller", hint: "GM only: a faint drawing of its route while the token is selected.",
    scope: "client", config: true, type: Boolean, default: true
  });

  registerPatrol();
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
