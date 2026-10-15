// Chatty Wanderers — gives life to tokens: patrols, vision, alert, speech and sounds.

import { MODULE_ID, findPath, cellOf } from "./pathing.js";
import { getPatrol, getRoutes, registerPatrol, resetRuntime, scenePatrollers, setStatus, setting, startClock, stopClock } from "./patrol.js";
import { RouteEditor, clearOverlay, showSelectedRoute } from "./editor.js";
import { drawCones, noticeClass, registerVision } from "./vision.js";
import { registerSpotting } from "./spotting.js";
import { cancelRun, registerMessenger, startRun } from "./messenger.js";
import { SpeechEditor, getSpeech, registerSpeech, say, startSpeech, stopSpeech } from "./speech.js";
import { SoundsEditor, hasSounds, isMuted, registerSounds, startSounds, stopSounds, toggleMute } from "./sounds.js";
import { AlertPanel, alertOp, getConfig as getAlertConfig, getState as getAlertState, registerAlert } from "./alert.js";

/* -------------------------------------------- */
/*  Left toolbar: one button, a small flyout    */
/* -------------------------------------------- */

// The chat bar is already full (privacy, filters, export, clear): the module lives in the Token controls, behind a
// single button that opens a row of buttons beside it.
function onGetSceneControlButtons(controls) {
  if (!game.user.isGM) return;
  const tools = controls.tokens?.tools;
  if (!tools) return;
  tools["cw-menu"] = {
    name: "cw-menu", order: 90, button: true,
    title: "Chatty Wanderers",
    icon: "fa-solid fa-shoe-prints",
    onChange: () => toggleMenu()
  };
}

function menuButtons() {
  const scene = canvas?.scene;
  const alert = scene ? getAlertConfig(scene) : null;
  const level = alert?.enabled ? getAlertState(scene).level : null;
  const paused = setting("paused");
  const patrols = !!scene && scenePatrollers(scene).length > 0;
  return [
    { id: "patrols", icon: paused ? "fa-person" : "fa-person-walking", on: paused, hidden: !patrols,
      tip: paused ? "Patrols paused — click to resume them" : "Patrols running — click to pause all of them",
      run: () => game.settings.set(MODULE_ID, "paused", !paused) },
    { id: "alert", icon: "fa-bell", on: level > 0, badge: level,
      tip: alert?.enabled ? `${alert.title}: level ${level} — open` : "Scene alert — set one up",
      run: () => AlertPanel.open(canvas.scene) },
    { id: "sounds", icon: setting("soundsMuted") ? "fa-volume-xmark" : "fa-volume-high", on: setting("soundsMuted"),
      tip: setting("soundsMuted") ? "Token sounds muted for everyone — click to turn them on" : "Token sounds on — click to mute them all",
      run: () => game.settings.set(MODULE_ID, "soundsMuted", !setting("soundsMuted")) },
    { id: "speech", icon: setting("speechEnabled") ? "fa-comment-dots" : "fa-comment-slash", on: !setting("speechEnabled"),
      tip: setting("speechEnabled") ? "Speech bubbles on — click to silence them" : "Speech bubbles off — click to turn them on",
      run: () => game.settings.set(MODULE_ID, "speechEnabled", !setting("speechEnabled")) }
  ];
}

function closeMenu() {
  document.getElementById("cw-menu")?.remove();
  document.removeEventListener("pointerdown", onOutside, true);
}

function onOutside(ev) {
  if (ev.target.closest?.("#cw-menu, [data-tool='cw-menu']")) return;
  closeMenu();
}

let lastToggle = 0;
function toggleMenu() {
  // Foundry may report one click on a tool twice: ignore the echo.
  if (Date.now() - lastToggle < 300) return;
  lastToggle = Date.now();
  if (document.getElementById("cw-menu")) return closeMenu();
  const menu = document.createElement("div");
  menu.id = "cw-menu";
  menu.className = "cw-flyout";
  document.body.append(menu);
  renderMenu();
  document.addEventListener("pointerdown", onOutside, true);
}

function renderMenu() {
  const menu = document.getElementById("cw-menu");
  if (!menu) return;
  const anchor = document.querySelector('#scene-controls [data-tool="cw-menu"]');
  if (!anchor) return closeMenu();
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.right + 6}px`;
  menu.style.top = `${r.top}px`;
  menu.replaceChildren(...menuButtons().filter(b => !b.hidden).map(b => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `ui-control icon fa-solid ${b.icon} ${b.on ? "cw-on" : ""}`;
    el.dataset.tooltip = b.tip;
    el.setAttribute("aria-label", b.tip);
    if (b.badge !== null && b.badge !== undefined) el.dataset.badge = b.badge;
    el.addEventListener("click", async () => { await b.run(); renderMenu(); });
    return el;
  }));
}

/** Color the toolbar button while something needs attention (alert above 0, patrols paused, sounds muted). */
function decorateTools() {
  const btn = document.querySelector('#scene-controls [data-tool="cw-menu"]');
  if (!btn) return;
  const scene = canvas?.scene;
  const alert = scene ? getAlertConfig(scene) : null;
  const level = alert?.enabled ? getAlertState(scene).level : 0;
  btn.dataset.level = level;
  btn.classList.toggle("cw-attention", level > 0 || setting("paused") || setting("soundsMuted"));
}

function refreshGlobalButton() {
  if (!game.user.isGM) return;
  decorateTools();
  renderMenu();
}

/* -------------------------------------------- */
/*  Token HUD: one button, a palette beside it  */
/* -------------------------------------------- */

// Open state of the module's palette (kept while the HUD redraws for the same token).
const paletteState = { open: false, token: null };
const rerender = hud => hud.render();

function onRenderTokenHUD(hud, html) {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  const col = root?.querySelector(".col.right");
  if (!col || col.querySelector(".cw-hud")) return;
  const td = hud.object?.document;
  if (!td) return;
  const patrol = getPatrol(td);

  if (paletteState.token !== td.id) Object.assign(paletteState, { open: false, token: td.id });
  const main = document.createElement("button");
  main.type = "button";
  main.className = "control-icon cw-hud";
  main.dataset.tooltip = "Chatty Wanderers";
  main.innerHTML = `<i class="fa-solid fa-shoe-prints"></i>`;
  col.append(main);

  const palette = document.createElement("div");
  // Not a Foundry palette (data-palette): Foundry would try to reopen it before this hook draws it, and fail.
  palette.className = "cw-palette";
  const button = (icon, tip, cls, run) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `control-icon ${cls}`;
    b.dataset.tooltip = tip;
    b.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    b.addEventListener("click", ev => { ev.preventDefault(); ev.stopPropagation(); run(); });
    palette.append(b);
  };

  button("fa-route", "Patrol route and alert reactions", patrol?.status === "patrolling" ? "active" : "", () => RouteEditor.open(td));

  // Who patrols notice: automatic (rules), always an intruder, or always ignored.
  const notice = foundry.utils.getProperty(td.flags ?? {}, `${MODULE_ID}.notice`) ?? "auto";
  const auto = noticeClass(td);
  const icons = { auto: auto === "intruder" ? "fa-eye" : "fa-eye-low-vision", intruder: "fa-eye", ignored: "fa-eye-slash" };
  const labels = { auto: `Patrols notice it: automatic (${auto})`, intruder: "Patrols: always noticed", ignored: "Patrols: always ignored" };
  button(icons[notice], `${labels[notice]} — click to change`, `cw-notice cw-notice-${notice}`, async () => {
    const next = { auto: "intruder", intruder: "ignored", ignored: "auto" }[notice];
    await td.update({ [`flags.${MODULE_ID}.notice`]: next === "auto" ? null : next });
    rerender(hud);
  });

  const talks = td.actor && getSpeech(td.actor).lines.some(l => l.text?.trim());
  button("fa-comment-dots", "Speech bubbles", talks ? "cw-has" : "", () => td.actor && SpeechEditor.open(td.actor));

  const sounds = td.actor && hasSounds(td.actor);
  button("fa-volume-high", "Sounds (footsteps, grunts…)", sounds ? "cw-has" : "", () => td.actor && SoundsEditor.open(td.actor));
  if (sounds) {
    const muted = isMuted(td);
    button(muted ? "fa-volume-xmark" : "fa-volume-low", muted ? "Muted — click to hear it again" : "Mute this token (everyone)",
      muted ? "active cw-muted" : "", async () => { await toggleMute(td); rerender(hud); });
  }
  col.append(palette);

  // A column beside the HUD, ending level with the button (it grows upward like the HUD itself).
  const place = () => {
    palette.style.top = `${main.offsetTop + main.offsetHeight - palette.offsetHeight}px`;
  };
  const setOpen = open => {
    paletteState.open = open;
    main.classList.toggle("active", open);
    palette.classList.toggle("active", open);
    if (open) requestAnimationFrame(place);
  };
  // One palette at a time: opening this one closes status effects / movement, and theirs close this one.
  main.addEventListener("click", ev => {
    ev.preventDefault();
    const open = !paletteState.open;
    if (open) try { hud.togglePalette(null); } catch { /* none open */ }
    setOpen(open);
  });
  root.querySelectorAll('[data-action="togglePalette"]').forEach(b => b.addEventListener("click", () => setOpen(false)));
  setOpen(paletteState.open);
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
  Hooks.on("getSceneControlButtons", onGetSceneControlButtons);
  Hooks.on("renderSceneControls", () => decorateTools());
  const choice = (key, name, hint, choices, def) => reg(key, { name, hint, type: String, choices, default: def });
  reg("showCones", { name: "Show vision cones", type: Boolean, default: true, onChange: () => drawCones() });
  reg("conesForPlayers", { name: "Players see the cones", hint: "Default for every patroller (each one can override it). Players only see the cone of a token they can see.", type: Boolean, default: false, onChange: () => drawCones() });
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
  reg("speechEnabled", { name: "Speech bubbles", hint: "Tokens say their lines (idle chatter, greetings, patrol events).", type: Boolean, default: true, onChange: () => refreshGlobalButton() });
  reg("soundsMuted", { name: "Token sounds muted", type: Boolean, default: false, config: false, onChange: () => refreshGlobalButton() });
  game.settings.register(MODULE_ID, "hearSounds", {
    name: "Hear token sounds", hint: "Footsteps and other sounds of tokens (Environment volume). Only for you.", scope: "client", config: true, type: Boolean, default: true
  });
  reg("speechInCombat", { name: "Keep talking during combat", type: Boolean, default: false });
  game.settings.register(MODULE_ID, "showBubbles", {
    name: "Show speech bubbles", hint: "Only for you.", scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "showSelected", {
    name: "Show the route of a selected patroller", hint: "GM only: a faint drawing of its route while the token is selected.",
    scope: "client", config: true, type: Boolean, default: true
  });

  registerPatrol();
  registerAlert();
  registerVision();
  registerSpotting();
  registerMessenger();
  registerSpeech();
  registerSounds();
  game.modules.get(MODULE_ID).api = {
    openEditor: td => RouteEditor.open(td?.document ?? td),
    start: (td, index = 0) => setStatus(td?.document ?? td, "patrolling", { index }),
    stop: td => setStatus(td?.document ?? td, "stopped"),
    runToWarn: td => startRun(td?.document ?? td),
    cancelRun: td => cancelRun(td?.document ?? td),
    pauseAll: (paused = true) => game.settings.set(MODULE_ID, "paused", paused),
    getRoutes, findPath, cellOf, stopClock: () => { stopClock(); stopSpeech(); stopSounds(); },
    openSounds: actor => SoundsEditor.open(actor?.actor ?? actor),
    say: (token, text, opts) => say(token, text, opts),
    openSpeech: actor => SpeechEditor.open(actor?.actor ?? actor),
    alert: {
      raise: (scene, opts) => alertOp(scene ?? canvas.scene, "raise", opts),
      lower: (scene, opts) => alertOp(scene ?? canvas.scene, "lower", opts),
      set: (scene, level, reason) => alertOp(scene ?? canvas.scene, "set", { level, reason }),
      get: scene => getAlertState(scene ?? canvas.scene),
      config: scene => getAlertConfig(scene ?? canvas.scene),
      open: scene => AlertPanel.open(scene ?? canvas.scene)
    }
  };
});

Hooks.once("ready", () => {
  startClock();
  startSpeech();
  startSounds();
  refreshGlobalButton();
  Hooks.on("renderTokenHUD", onRenderTokenHUD);
  Hooks.on("canvasReady", () => { clearOverlay(); refreshGlobalButton(); });
  Hooks.on("controlToken", () => setTimeout(showSelectedRoute, 0));
  Hooks.on("updateToken", (td, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) {
      refreshGlobalButton();
      if (RouteEditor.current?.td === td) RouteEditor.current.render();
    }
  });
  // Scene configuration: open the alert of that scene.
  Hooks.on("renderSceneConfig", (app, html) => {
    if (!game.user.isGM) return;
    const root = html instanceof HTMLElement ? html : html[0];
    const tab = root?.querySelector('.tab[data-tab="basics"]') ?? root?.querySelector("form");
    if (!tab || tab.querySelector(".cw-scene-alert")) return;
    const div = document.createElement("div");
    div.className = "form-group cw-scene-alert";
    div.innerHTML = `<label>Chatty Wanderers</label><div class="form-fields">
      <button type="button"><i class="fa-solid fa-bell"></i> Alert of this scene…</button></div>`;
    div.querySelector("button").addEventListener("click", () => AlertPanel.open(app.document));
    tab.append(div);
  });
  Hooks.on("updateScene", (scene, changes) => {
    if (scene === canvas.scene && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) refreshGlobalButton();
    if (scene === canvas.scene && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) {
      resetRuntime();
      showSelectedRoute();
    }
  });
  for (const h of ["createToken", "deleteToken"]) Hooks.on(h, () => refreshGlobalButton());
});
