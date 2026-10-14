// Chatty Wanderers — per-scene alert level.
// A scene can have an alert counter (0..N levels, each with a name and what it means). Signals raise it (patrols that
// discover someone, traps, puzzles, macros, the GM); after a quiet stretch of game time the GM is offered to lower it
// (never below the floor once an intrusion happened). The bell rings from an Ambient Sound and a tile can swing.
// Config and state live on the scene: flags.chatty-wanderers.alert = { config, state }.

import { MODULE_ID } from "./pathing.js";
import { ACTIONS, applyReactions, effectiveReaction, hasReactions, originPoint } from "./reactions.js";

const SOCKET = `module.${MODULE_ID}`;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const isActiveGM = () => game.user.isGM && game.users.activeGM?.isSelf;

export const DEFAULT_CONFIG = {
  enabled: false,
  title: "Alert",
  levels: [
    { name: "Calm", text: "Everyone stays at their posts." },
    { name: "Suspicious", text: "Someone goes to check the noise." },
    { name: "Alarm", text: "The guards gather and search." }
  ],
  decayMinutes: 10,
  floorAfterIntrusion: 1,
  raiseOnDiscovered: true,
  bell: "",
  bellVolume: 0.9,
  bellAmbientSound: "",
  bellTile: "",
  sources: [],          // [{ key, label }] signals that can be switched off in play
  manual: ["Noise", "Door forced open", "Messenger arrived"]
};

function initialState() {
  return { level: 0, intruded: false, lastSignal: null, lastReason: "", promptedFor: null, disabled: {}, log: [] };
}

const sceneOf = scene => (typeof scene === "string" ? game.scenes.get(scene) : scene) ?? canvas.scene;

export function getConfig(scene) {
  scene = sceneOf(scene);
  const saved = foundry.utils.getProperty(scene?.flags ?? {}, `${MODULE_ID}.alert.config`);
  return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_CONFIG), foundry.utils.deepClone(saved ?? {}), { inplace: false });
}

export function getState(scene) {
  scene = sceneOf(scene);
  const saved = foundry.utils.getProperty(scene?.flags ?? {}, `${MODULE_ID}.alert.state`);
  return foundry.utils.mergeObject(initialState(), foundry.utils.deepClone(saved ?? {}), { inplace: false });
}

const saveState = (scene, state) => scene.update({ [`flags.${MODULE_ID}.alert.state`]: state });
export const saveConfig = async (scene, config) => {
  await scene.update({ [`flags.${MODULE_ID}.alert.-=config`]: null });
  return scene.update({ [`flags.${MODULE_ID}.alert.config`]: config });
};

const maxLevel = c => Math.max(0, c.levels.length - 1);
const floorOf = (c, s) => (s.intruded ? Math.min(c.floorAfterIntrusion ?? 0, maxLevel(c)) : 0);
const levelLine = (c, n) => `<b>${n} — ${esc(c.levels[n]?.name)}</b>${c.levels[n]?.text ? `: ${esc(c.levels[n].text)}` : ""}`;
const gmWhisper = (content, alias) => ChatMessage.create({ content, whisper: ChatMessage.getWhisperRecipients("GM"), speaker: { alias } });

/* -------------------------------------------- */
/*  Changes (GM)                                */
/* -------------------------------------------- */

async function apply(sceneId, op, opts = {}) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return { ok: false, msg: "Scene not found." };
  const c = getConfig(scene);
  if (!c.enabled && op !== "set") return { ok: false, msg: `${scene.name} has no alert.` };
  const s = getState(scene);
  const now = game.time.worldTime;
  const entry = (from, to, reason) => { s.log.unshift({ t: now, from, to, reason }); s.log = s.log.slice(0, 25); };
  switch (op) {
    case "raise": {
      if (opts.source && s.disabled[opts.source]) {
        const label = c.sources.find(x => x.key === opts.source)?.label ?? opts.source;
        return { ok: false, msg: `${label} is switched off.` };
      }
      const before = s.level;
      s.level = Math.min(maxLevel(c), s.level + (Number(opts.amount) || 1));
      s.intruded = true;
      s.lastSignal = now;
      s.lastReason = opts.reason ?? "";
      s.promptedFor = null;
      entry(before, s.level, s.lastReason);
      await saveState(scene, s);
      if (opts.bell !== false) ringBell(scene.id);
      await gmWhisper(`<p><i class="fa-solid fa-bell"></i> <b>${esc(c.title)}</b>: ${before} → <b>${s.level}</b>${s.lastReason ? ` <em>(${esc(s.lastReason)})</em>` : ""}</p>
        <p>${s.level !== before ? levelLine(c, s.level) : "Already at the highest level."}</p>`, c.title);
      await applyReactions(scene, s.level, opts, c);
      Hooks.callAll(`${MODULE_ID}.alertChanged`, scene, s.level, before, s.lastReason, opts);
      return { ok: true, level: s.level };
    }
    case "lower": {
      const floor = floorOf(c, s);
      if (s.level <= floor) return { ok: false, msg: `The alert can't go below ${floor}.` };
      if (opts.ifSignal !== undefined && opts.ifSignal !== s.lastSignal) return { ok: false, msg: "The alert changed since this suggestion." };
      const before = s.level;
      s.level -= 1;
      s.lastSignal = now;
      s.promptedFor = null;
      entry(before, s.level, opts.reason ?? "Quiet for a while");
      await saveState(scene, s);
      await gmWhisper(`<p><b>${esc(c.title)}</b>: ${before} → <b>${s.level}</b></p><p>${levelLine(c, s.level)}</p>`, c.title);
      await applyReactions(scene, s.level, opts, c);
      Hooks.callAll(`${MODULE_ID}.alertChanged`, scene, s.level, before, opts.reason ?? "", opts);
      return { ok: true, level: s.level };
    }
    case "set": {
      const before = s.level;
      const next = initialState();
      next.disabled = s.disabled;
      const level = Math.min(Number(opts.level) || 0, maxLevel(c));
      if (level) Object.assign(next, { level, intruded: true, lastSignal: now });
      next.log = [{ t: now, from: before, to: level, reason: opts.reason ?? "Set by the GM" }, ...s.log].slice(0, 25);
      await saveState(scene, next);
      await applyReactions(scene, level, opts, c);
      Hooks.callAll(`${MODULE_ID}.alertChanged`, scene, level, before, opts.reason ?? "", opts);
      return { ok: true, level };
    }
    case "react": {
      const n = await applyReactions(scene, s.level, { force: true }, c);
      return { ok: true, count: n };
    }
    case "toggle": {
      s.disabled[opts.source] = !s.disabled[opts.source];
      await saveState(scene, s);
      return { ok: true, disabled: s.disabled[opts.source] };
    }
  }
  return { ok: false };
}

/** Change an alert from any client (players' macros reach the GM over the socket). */
export function alertOp(scene, op, opts = {}) {
  const id = sceneOf(scene)?.id;
  if (!id) return Promise.resolve({ ok: false, msg: "No scene." });
  // Documents don't travel over the socket: keep only the point.
  if (opts.origin) opts = { ...opts, origin: originPoint(opts.origin) };
  if (isActiveGM()) return apply(id, op, opts);
  game.socket.emit(SOCKET, { type: "alert", sceneId: id, op, opts });
  return Promise.resolve({ ok: true, sent: true });
}

/** GM: offer to drop a level after a quiet stretch of game time. */
async function checkDecay() {
  if (!isActiveGM()) return;
  const now = game.time.worldTime;
  for (const scene of game.scenes) {
    const c = foundry.utils.getProperty(scene.flags ?? {}, `${MODULE_ID}.alert.config`);
    if (!c?.enabled) continue;
    const cfg = getConfig(scene);
    const s = getState(scene);
    if (s.lastSignal === null || s.level <= floorOf(cfg, s) || s.promptedFor === s.lastSignal) continue;
    const quiet = (now - s.lastSignal) / 60;
    if (quiet < (Number(cfg.decayMinutes) || 10)) continue;
    s.promptedFor = s.lastSignal;
    await saveState(scene, s);
    await gmWhisper(`<p><i class="fa-solid fa-hourglass-half"></i> <b>${esc(cfg.title)}</b> (${esc(scene.name)}): ${Math.floor(quiet)} min without new signals.</p>
      <p>Lower to <b>${s.level - 1} — ${esc(cfg.levels[s.level - 1]?.name)}</b>?</p>
      <button type="button" data-cw-alert-lower="${scene.id}" data-signal="${s.lastSignal}"><i class="fa-solid fa-arrow-down"></i> Lower the alert</button>`, cfg.title);
  }
}

/* -------------------------------------------- */
/*  The bell                                    */
/* -------------------------------------------- */

function ringBell(sceneId) {
  game.socket.emit(SOCKET, { type: "alertBell", sceneId });
  ringLocal(sceneId);
}

function soundFile(src) {
  if (!src || src.includes("/")) return src;
  const entry = globalThis.Sequencer?.Database?.getEntry?.(src);
  const file = Array.isArray(entry) ? entry[0]?.file : entry?.file;
  return Array.isArray(file) ? file[Math.floor(Math.random() * file.length)] : file;
}

/** Volume by distance to the closest listening token (selected tokens, or the player's own). GM without a selection: full. */
function volumeAt(ambient, base) {
  if (game.user.isGM && !canvas.tokens.controlled.length) return base;
  const tokens = canvas.tokens.controlled.length ? canvas.tokens.controlled : canvas.tokens.placeables.filter(t => t.actor?.isOwner);
  if (!tokens.length) return 0;
  const radiusPx = ambient.radius * canvas.dimensions.distancePixels;
  const d = Math.min(...tokens.map(t => Math.hypot(t.center.x - ambient.x, t.center.y - ambient.y)));
  if (d >= radiusPx) return 0;
  const k = 1 - d / radiusPx;
  return base * (ambient.easing ? k * k * (3 - 2 * k) : 1);
}

function ringLocal(sceneId) {
  if (!canvas.ready || canvas.scene?.id !== sceneId) return;
  const c = getConfig(canvas.scene);
  const file = soundFile(c.bell);
  const base = Number(c.bellVolume) || 0.9;
  const ambient = c.bellAmbientSound ? canvas.scene.sounds.get(c.bellAmbientSound) : null;
  if (file) {
    if (ambient?.walls) {
      canvas.sounds.playAtPosition(file, { x: ambient.x, y: ambient.y, elevation: ambient.elevation ?? 0 }, ambient.radius,
        { volume: base, easing: ambient.easing, walls: true, gmAlways: !canvas.tokens.controlled.length }).catch(err => console.warn(err));
    } else {
      const volume = ambient ? volumeAt(ambient, base) : base;
      if (volume > 0) foundry.audio.AudioHelper.play({ src: file, volume, autoplay: true, loop: false }, false);
    }
  }
  swingTile(c.bellTile ? canvas.tiles?.get(c.bellTile) : null);
}

function swingTile(tile) {
  const mesh = tile?.mesh;
  if (!mesh) return;
  const base = Math.toRadians(tile.document.rotation ?? 0);
  const start = performance.now();
  const tick = () => {
    const t = performance.now() - start;
    if (t >= 3200 || mesh.destroyed) {
      canvas.app.ticker.remove(tick);
      if (!mesh.destroyed) mesh.rotation = base;
      return;
    }
    mesh.rotation = base + Math.toRadians(16) * Math.exp(-t / 1100) * Math.sin((2 * Math.PI * t) / 700);
  };
  canvas.app.ticker.add(tick);
}

/* -------------------------------------------- */
/*  GM panel                                    */
/* -------------------------------------------- */

/** Wait for one click on the canvas; resolves to the point (or null on right click / Escape). */
export function pickPoint() {
  return new Promise(resolve => {
    const board = canvas.app.view.parentElement;
    const done = (ev, point) => {
      ev?.stopPropagation(); ev?.preventDefault();
      board.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      resolve(point);
    };
    const onDown = ev => {
      if (ev.target !== canvas.app.view) return;
      if (ev.button === 2) return done(ev, null);
      if (ev.button !== 0) return;
      const p = canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
      done(ev, { x: Math.round(p.x), y: Math.round(p.y) });
    };
    const onKey = ev => { if (ev.key === "Escape") done(ev, null); };
    board.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
  });
}

const { ApplicationV2 } = foundry.applications.api;

export class AlertPanel extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["cw-alert"],
    window: { title: "Scene alert", resizable: true, icon: "fa-solid fa-bell" },
    position: { width: 440, height: "auto" }
  };

  static open(scene) {
    scene = sceneOf(scene);
    const app = new AlertPanel(scene);
    app.render(true);
    return app;
  }

  constructor(scene) {
    super({ id: `cw-alert-${scene.id}`, window: { title: `Alert — ${scene.name}` } });
    this.scene = scene;
    this.tab = "status";
  }

  async _renderHTML() {
    const c = getConfig(this.scene);
    const root = document.createElement("div");
    root.className = "cw-alert-root";
    if (!c.enabled) {
      root.innerHTML = `<p>This scene has no alert yet.</p>
        <button type="button" data-do="enable"><i class="fa-solid fa-bell"></i> Enable an alert for ${esc(this.scene.name)}</button>`;
      return root;
    }
    root.innerHTML = `<nav class="cw-tabs">
        <a data-tab="status" class="${this.tab === "status" ? "active" : ""}">Status</a>
        <a data-tab="setup" class="${this.tab === "setup" ? "active" : ""}">Setup</a></nav>
      ${this.tab === "status" ? this._statusHTML(c) : this._setupHTML(c)}`;
    return root;
  }

  _statusHTML(c) {
    const s = getState(this.scene);
    const quiet = s.lastSignal === null ? null : Math.floor((game.time.worldTime - s.lastSignal) / 60);
    const floor = floorOf(c, s);
    const levels = c.levels.map((l, n) => `<li class="${n === s.level ? "current" : ""}"><b>${n} — ${esc(l.name)}</b><span>${esc(l.text)}</span></li>`).join("");
    const sources = c.sources.map(x => `<label class="cw-src ${s.disabled[x.key] ? "off" : ""}"><input type="checkbox" data-source="${esc(x.key)}" ${s.disabled[x.key] ? "" : "checked"}> ${esc(x.label)}</label>`).join("");
    const log = s.log.slice(0, 6).map(e => `<li>${e.from} → ${e.to} <em>${esc(e.reason)}</em></li>`).join("");
    const hue = c.levels.length > 1 ? Math.round(120 - (s.level / maxLevel(c)) * 120) : 120;
    return `
      <div class="cw-level" style="background: hsl(${hue} 45% 28%)"><span class="cw-num">${s.level}</span><span class="cw-name">${esc(c.levels[s.level]?.name)}</span></div>
      <p class="cw-quiet">${quiet === null ? "No signals yet." : `Last signal ${quiet} min ago (game time)${s.lastReason ? ` — ${esc(s.lastReason)}` : ""}.`}
        ${s.intruded ? `<br>Minimum after an intrusion: ${floor}.` : ""}</p>
      <div class="cw-alert-buttons">
        <select class="cw-reason">${c.manual.map(r => `<option>${esc(r)}</option>`).join("")}</select>
        <button type="button" data-do="raise"><i class="fa-solid fa-arrow-up"></i> +1</button>
        <button type="button" data-do="raiseAt" data-tooltip="+1, then click where the noise happened (who investigates goes there)"><i class="fa-solid fa-location-crosshairs"></i></button>
        <button type="button" data-do="lower" ${s.level <= floor ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i> −1</button>
        <button type="button" data-do="reset" data-tooltip="Back to 0"><i class="fa-solid fa-rotate-left"></i></button>
      </div>
      <ol class="cw-levels" start="0">${levels}</ol>
      ${this._reactingHTML(s)}
      ${sources ? `<h4>Signals</h4><div class="cw-sources">${sources}</div>` : ""}
      ${log ? `<h4>History</h4><ul class="cw-log">${log}</ul>` : ""}`;
  }

  _reactingHTML(s) {
    const tokens = this.scene.tokens.filter(t => hasReactions(t));
    if (!tokens.length) return "";
    const what = { moving: "on the way", holding: "holding", patrolling: "patrolling", stopped: "at its post", detached: "moved by the GM", spotted: "spotted someone", alerted: "alerted" };
    const rows = tokens.map(t => {
      const eff = effectiveReaction(t, s.level);
      const p = foundry.utils.getProperty(t.flags, `${MODULE_ID}.patrol`) ?? {};
      const doing = eff.level ? ACTIONS[eff.action] : "usual behavior";
      return `<li><b>${esc(t.name)}</b>: ${esc(doing)} <em>(${esc(what[p.status] ?? p.status ?? "at its post")})</em></li>`;
    }).join("");
    return `<h4>Reactions <button type="button" class="cw-mini" data-do="react" data-tooltip="Send everyone to the reaction of this level again"><i class="fa-solid fa-rotate"></i></button></h4><ul class="cw-log">${rows}</ul>`;
  }

  _setupHTML(c) {
    const sounds = this.scene.sounds.map(s => `<option value="${s.id}" ${s.id === c.bellAmbientSound ? "selected" : ""}>${esc(s.path?.split("/").pop() || "(no file)")} @ ${Math.round(s.x)},${Math.round(s.y)}</option>`).join("");
    return `
      <label class="cw-field"><span>Title</span><input type="text" data-c="title" value="${esc(c.title)}"></label>
      <h4>Levels</h4>
      ${c.levels.map((l, i) => `<div class="cw-lvl"><b>${i}</b>
        <input type="text" data-l="${i}" data-k="name" value="${esc(l.name)}" placeholder="Name">
        <textarea data-l="${i}" data-k="text" rows="2" placeholder="What happens">${esc(l.text)}</textarea>
        <button type="button" data-del-level="${i}" ${c.levels.length <= 2 ? "disabled" : ""}><i class="fa-solid fa-xmark"></i></button></div>`).join("")}
      <button type="button" data-do="addLevel"><i class="fa-solid fa-plus"></i> Level</button>
      <h4>Rules</h4>
      <label class="cw-field"><span>Offer to lower after (game min)</span><input type="number" min="1" data-c="decayMinutes" value="${esc(c.decayMinutes)}"></label>
      <label class="cw-field"><span>Minimum after an intrusion</span><input type="number" min="0" data-c="floorAfterIntrusion" value="${esc(c.floorAfterIntrusion)}"></label>
      <label class="cw-check"><input type="checkbox" data-c="raiseOnDiscovered" ${c.raiseOnDiscovered ? "checked" : ""}> A patrol discovering someone raises the alert</label>
      <label class="cw-field"><span>Manual reasons</span><input type="text" data-c="manual" value="${esc(c.manual.join(", "))}"></label>
      <label class="cw-field"><span>Signals (key=label, …)</span><input type="text" data-c="sources" value="${esc(c.sources.map(x => `${x.key}=${x.label}`).join(", "))}" placeholder="t1=Pressure plate, t9=Slot table"></label>
      <h4>Bell</h4>
      <label class="cw-field"><span>Sound</span><input type="text" data-c="bell" value="${esc(c.bell)}" placeholder="file path or Sequencer key"></label>
      <label class="cw-field"><span>Volume</span><input type="number" min="0" max="1" step="0.05" data-c="bellVolume" value="${esc(c.bellVolume)}"></label>
      <label class="cw-field"><span>From Ambient Sound</span><select data-c="bellAmbientSound"><option value="">— everywhere —</option>${sounds}</select></label>
      <div class="cw-field"><span>Tile that swings</span><div class="cw-row">
        <input type="text" data-c="bellTile" value="${esc(c.bellTile)}" placeholder="tile id">
        <button type="button" data-do="pickTile" data-tooltip="Use the selected tile"><i class="fa-solid fa-crosshairs"></i></button></div></div>
      <div class="cw-row"><button type="button" data-do="test"><i class="fa-solid fa-bell"></i> Test the bell (only you)</button>
        <button type="button" data-do="disable"><i class="fa-solid fa-bell-slash"></i> Remove the alert</button></div>`;
  }

  _readSetup() {
    const c = getConfig(this.scene);
    const el = this.element;
    el.querySelectorAll("[data-c]").forEach(inp => {
      const k = inp.dataset.c;
      let v = inp.type === "checkbox" ? inp.checked : inp.value;
      if (inp.type === "number") v = Number(v);
      if (k === "manual") v = String(v).split(",").map(x => x.trim()).filter(Boolean);
      if (k === "sources") v = String(v).split(",").map(x => x.trim()).filter(Boolean).map(x => {
        const [key, ...rest] = x.split("=");
        return { key: key.trim(), label: (rest.join("=") || key).trim() };
      });
      c[k] = v;
    });
    el.querySelectorAll("[data-l]").forEach(inp => { c.levels[Number(inp.dataset.l)][inp.dataset.k] = inp.value; });
    return c;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    content.querySelectorAll("[data-tab]").forEach(a => a.addEventListener("click", () => { this.tab = a.dataset.tab; this.render(); }));
    content.querySelectorAll("[data-c], [data-l]").forEach(inp => inp.addEventListener("change", () => saveConfig(this.scene, this._readSetup())));
    content.querySelectorAll("[data-del-level]").forEach(b => b.addEventListener("click", async () => {
      const c = this._readSetup();
      c.levels.splice(Number(b.dataset.delLevel), 1);
      await saveConfig(this.scene, c);
    }));
    content.querySelectorAll("[data-source]").forEach(cb => cb.addEventListener("change", () => alertOp(this.scene, "toggle", { source: cb.dataset.source })));
    const reason = () => content.querySelector(".cw-reason")?.value;
    content.querySelectorAll("[data-do]").forEach(b => b.addEventListener("click", async () => {
      switch (b.dataset.do) {
        case "enable": await saveConfig(this.scene, { ...getConfig(this.scene), enabled: true }); break;
        case "disable": {
          const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Remove the alert" }, content: `<p>Remove the alert of ${esc(this.scene.name)}?</p>` });
          if (ok) await this.scene.update({ [`flags.${MODULE_ID}.-=alert`]: null });
          break;
        }
        case "raise": await alertOp(this.scene, "raise", { reason: reason() }); break;
        case "raiseAt": {
          if (canvas.scene !== this.scene) return ui.notifications.warn("View this scene first.");
          ui.notifications.info("Click on the map where the noise happened (right click cancels).");
          const point = await pickPoint();
          if (point) await alertOp(this.scene, "raise", { reason: reason(), origin: point });
          break;
        }
        case "react": await alertOp(this.scene, "react"); break;
        case "lower": await alertOp(this.scene, "lower", { reason: "Lowered by the GM" }); break;
        case "reset": await alertOp(this.scene, "set", { level: 0, reason: "Reset by the GM" }); break;
        case "addLevel": { const c = this._readSetup(); c.levels.push({ name: `Level ${c.levels.length}`, text: "" }); await saveConfig(this.scene, c); break; }
        case "pickTile": {
          const tile = canvas.tiles.controlled[0];
          if (!tile) return ui.notifications.warn("Select a tile first (Tiles layer).");
          await saveConfig(this.scene, { ...this._readSetup(), bellTile: tile.id });
          break;
        }
        case "test": ringLocal(this.scene.id); break;
      }
      this.render();
    }));
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this._timer = setInterval(() => { if (this.tab === "status") this.render(); }, 30_000);
  }

  _onClose(options) {
    clearInterval(this._timer);
    return super._onClose?.(options);
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerAlert() {
  game.socket.on(SOCKET, msg => {
    if (msg.type === "alertBell") return ringLocal(msg.sceneId);
    if (msg.type === "alert" && isActiveGM()) apply(msg.sceneId, msg.op, msg.opts ?? {});
  });
  Hooks.on("updateWorldTime", () => checkDecay());
  Hooks.on("updateScene", (scene, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.alert`) && !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=alert`)) return;
    foundry.applications.instances.get(`cw-alert-${scene.id}`)?.render();
  });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    html.querySelectorAll("[data-cw-alert-lower]").forEach(btn => {
      if (!game.user.isGM) return btn.remove();
      btn.addEventListener("click", async () => {
        const r = await alertOp(btn.dataset.cwAlertLower, "lower", { ifSignal: Number(btn.dataset.signal), reason: "Quiet for a while" });
        if (r?.msg) ui.notifications.warn(r.msg);
        btn.disabled = true;
      });
    });
  });
  // A patrol discovering someone raises the scene's alert.
  Hooks.on(`${MODULE_ID}.discovered`, (patroller, targets) => {
    const scene = patroller.parent;
    const c = getConfig(scene);
    if (!c.enabled || !c.raiseOnDiscovered) return;
    alertOp(scene, "raise", { reason: `${patroller.name} discovered ${targets.map(t => t.name).join(", ")}`, origin: targets[0] });
  });
}
