// Chatty Wanderers — sounds that follow a token (footsteps, grunts…). Played on the Environment channel by every
// client, louder the closer that player's tokens are, muffled through walls. Loops can play only while the token walks;
// "now and then" sounds are timed by the GM so everyone hears the same grunt at the same moment.
// Config on the actor (flags.chatty-wanderers.sounds; an unlinked token's sheet keeps its own); mute per token
// (flags.chatty-wanderers.soundMuted) and for the whole world (setting soundsMuted).

import { MODULE_ID } from "./pathing.js";
import { isActiveGM, setting } from "./patrol.js";

const SOCKET = `module.${MODULE_ID}`;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const BASE = `modules/${MODULE_ID}/sounds`;

export const MODES = { moving: "While it walks (loop)", always: "Always (loop)", random: "Now and then" };
// Like an Ambient Sound: walls can be ignored, block the sound, or let it through muffled (quieter, low-pass).
export const WALLS = { muffle: "Muffled through walls", block: "Blocked by walls", ignore: "Ignores walls" };
const MUFFLED_VOLUME = 0.35;

const FX = "modules/soundfxlibrary/Creatures";
export const PRESETS = {
  light: { label: "Footsteps — light (stone)", src: `${BASE}/footsteps-stone-light.ogg`, mode: "moving", volume: 0.7, radius: 40 },
  heavy: { label: "Footsteps — heavy, claws (stone)", src: `${BASE}/footsteps-stone-heavy.ogg`, mode: "moving", volume: 0.8, radius: 60 },
  armored: { label: "Footsteps — armored", src: `${BASE}/footsteps-armored.ogg`, mode: "moving", volume: 0.75, radius: 50 },
  growl: { label: "Growls (Sound FX Library)", module: "soundfxlibrary", mode: "random", volume: 0.6, radius: 50, min: 20, max: 60,
    src: [1, 2, 3, 4, 5, 6].map(n => `${FX}/Monsters/Growl/growl-${n}.mp3`).join(" | ") },
  moan: { label: "Moans (Sound FX Library)", module: "soundfxlibrary", mode: "random", volume: 0.6, radius: 50, min: 25, max: 70,
    src: [1, 2].map(n => `${FX}/Monsters/Moan/moan-${n}.mp3`).join(" | ") },
  angry: { label: "Angry noises (Sound FX Library)", module: "soundfxlibrary", mode: "random", volume: 0.6, radius: 50, min: 20, max: 50,
    src: [1, 2].map(n => `${FX}/Monsters/Angry Noises/angry-noises-${n}.mp3`).join(" | ") }
};

const DEFAULT_SOUNDS = { enabled: true, list: [] };
const DEFAULT_ENTRY = { src: "", mode: "moving", volume: 0.7, radius: 40, min: 20, max: 60, walls: "muffle", easing: true };
const wallMode = e => (e.walls === true || e.walls === undefined ? "muffle" : e.walls === false ? "ignore" : e.walls);

export function getSounds(actor) {
  const saved = foundry.utils.getProperty(actor?.flags ?? {}, `${MODULE_ID}.sounds`);
  const s = foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_SOUNDS), foundry.utils.deepClone(saved ?? {}), { inplace: false });
  s.list = (s.list ?? []).map(e => ({ ...DEFAULT_ENTRY, ...e, walls: wallMode(e) }));
  return s;
}

export const hasSounds = actor => getSounds(actor).list.some(e => e.src);
export const isMuted = td => !!foundry.utils.getProperty(td?.flags ?? {}, `${MODULE_ID}.soundMuted`);

/** A path, several paths separated by "|" (one picked each time), or a Sequencer database key. */
function resolveSrc(src) {
  const options = String(src ?? "").split("|").map(s => s.trim()).filter(Boolean);
  const one = options[Math.floor(Math.random() * options.length)];
  if (!one || one.includes("/")) return one;
  const entry = globalThis.Sequencer?.Database?.getEntry?.(one);
  const file = Array.isArray(entry) ? entry[0]?.file : entry?.file;
  return Array.isArray(file) ? file[Math.floor(Math.random() * file.length)] : file;
}

/* -------------------------------------------- */
/*  Hearing (every client)                      */
/* -------------------------------------------- */

const players = new Map(); // tokenId -> { sounds: [{ entry, sound, src, zeroSince }], lastMoved }
const lastMoved = new Map();
let timer = null;

/** Where this client listens from: its controlled tokens, else its own tokens; the GM without a selection hears from the middle of the screen. */
function listeners() {
  const controlled = canvas.tokens.controlled;
  if (controlled.length) return controlled.map(t => t.center);
  if (game.user.isGM) return [{ x: canvas.stage.pivot.x, y: canvas.stage.pivot.y }];
  return canvas.tokens.placeables.filter(t => t.actor?.isOwner).map(t => t.center);
}

/** Where the sound reaches unobstructed: the same wall-clipped area an Ambient Sound uses (cached until the token moves). */
const polys = new Map();
export function soundArea(token, radiusPx) {
  const c = token.center;
  const key = `${Math.round(c.x)},${Math.round(c.y)},${Math.round(radiusPx)}`;
  const hit = polys.get(token.id);
  if (hit?.key === key) return hit.poly;
  let poly = null;
  try {
    poly = CONFIG.Canvas.polygonBackends.sound.create({ x: c.x, y: c.y, elevation: token.document.elevation ?? 0 }, { type: "sound", radius: radiusPx });
  } catch (err) { console.warn(`${MODULE_ID} | sound area`, err); }
  polys.set(token.id, { key, poly });
  return poly;
}

/** How one sound of a token reaches this client: { volume, muffled } (volume 0 = silent). */
function volumeFor(token, entry, ears) {
  const out = { volume: 0, muffled: false };
  if (!ears.length) return out;
  const radius = (Number(entry.radius) || 40) * canvas.dimensions.distancePixels;
  const walls = wallMode(entry);
  const area = walls === "ignore" ? null : soundArea(token, radius);
  const c = token.center;
  for (const ear of ears) {
    const d = Math.hypot(ear.x - c.x, ear.y - c.y);
    if (d >= radius) continue;
    const k = 1 - d / radius;
    let v = entry.easing === false ? 1 : k * k * (3 - 2 * k);
    let muffled = false;
    if (area && !area.contains(ear.x, ear.y)) {
      if (walls === "block") continue;
      v *= MUFFLED_VOLUME;
      muffled = true;
    }
    // The clearest way the sound reaches any of this client's tokens wins.
    if (v > out.volume || (v === out.volume && !muffled)) Object.assign(out, { volume: v, muffled });
  }
  out.volume *= Number(entry.volume) || 0.7;
  return out;
}

/** Switch the low-pass "through the wall" filter on or off. */
function setMuffled(sound, slot, muffled) {
  if (!sound || slot.muffled === muffled) return;
  slot.muffled = muffled;
  try {
    const Filter = foundry.audio.BiquadFilterEffect;
    sound.applyEffects(muffled && Filter ? [new Filter(sound.context, { type: "lowpass", intensity: 6 })] : []);
  } catch (err) { console.warn(`${MODULE_ID} | muffle`, err); }
}

function audible(td, cfg) {
  if (!cfg.enabled || isMuted(td) || setting("soundsMuted") || !setting("hearSounds")) return false;
  // Hidden by the GM = not there yet. Invisible or hiding creatures still make noise.
  if (td.hidden) return false;
  return true;
}

const isMoving = td => Date.now() - (lastMoved.get(td.id) ?? 0) < Math.max(900, setting("tickMs") * 2.5);

async function startLoop(slot) {
  if (slot.starting || slot.sound) return;
  slot.starting = true;
  try {
    await game.audio.unlock;
    const src = resolveSrc(slot.entry.src);
    if (!src) return;
    const sound = new foundry.audio.Sound(src, { context: game.audio.environment });
    await sound.load();
    await sound.play({ loop: true, volume: 0, offset: Math.random() * (sound.duration || 0) });
    slot.sound = sound;
  } catch (err) {
    console.warn(`${MODULE_ID} | sound`, slot.entry.src, err);
    slot.failed = true;
  } finally { slot.starting = false; }
}

function stopSlot(slot) {
  slot.sound?.stop();
  slot.sound = null;
  slot.zeroSince = null;
}

function stopToken(tokenId) {
  const p = players.get(tokenId);
  if (!p) return;
  p.slots.forEach(stopSlot);
  players.delete(tokenId);
}

export function stopAllSounds() {
  for (const id of [...players.keys()]) stopToken(id);
}

/** Keep the loops of the viewed scene in step: start, fade with distance, stop when long silent. */
function hearTick() {
  if (!canvas.ready) return;
  const ears = listeners();
  const now = Date.now();
  const seen = new Set();
  for (const token of canvas.tokens.placeables) {
    const td = token.document;
    if (!td.actor) continue;
    const cfg = getSounds(td.actor);
    const loops = cfg.list.filter(e => e.src && e.mode !== "random");
    if (!loops.length) continue;
    seen.add(td.id);
    let p = players.get(td.id);
    const key = JSON.stringify(loops);
    if (p && p.key !== key) { stopToken(td.id); p = null; }
    if (!p) players.set(td.id, p = { key, slots: loops.map(entry => ({ entry })) });
    const on = audible(td, cfg);
    for (const slot of p.slots) {
      if (slot.failed) continue;
      const heard = on && (slot.entry.mode === "always" || isMoving(td)) ? volumeFor(token, slot.entry, ears) : { volume: 0 };
      const target = heard.volume;
      if (target > 0.001) {
        slot.zeroSince = null;
        if (!slot.sound) { startLoop(slot); continue; }
        setMuffled(slot.sound, slot, heard.muffled);
        slot.sound.fade(target, { duration: 250 });
      } else if (slot.sound) {
        slot.sound.fade(0, { duration: 400 });
        slot.zeroSince ??= now;
        // Long silent: let it go (it starts again when needed).
        if (now - slot.zeroSince > 4000) stopSlot(slot);
      }
    }
  }
  for (const id of [...players.keys()]) if (!seen.has(id)) stopToken(id);
}

/** A one-shot sound of a token, heard by this client at its distance. */
async function playOnce({ sceneId, tokenId, index, src }) {
  if (!canvas.ready || canvas.scene?.id !== sceneId) return;
  const token = canvas.tokens.get(tokenId);
  if (!token?.actor) return;
  const cfg = getSounds(token.actor);
  const entry = cfg.list[index];
  if (!entry || !audible(token.document, cfg)) return;
  const { volume, muffled } = volumeFor(token, entry, listeners());
  if (volume <= 0.001) return;
  await game.audio.unlock;
  const sound = new foundry.audio.Sound(src, { context: game.audio.environment });
  try {
    await sound.load();
    if (muffled) setMuffled(sound, {}, true);
    await sound.play({ volume });
  } catch (err) { console.warn(`${MODULE_ID} | sound`, src, err); }
}

/* -------------------------------------------- */
/*  GM: "now and then" sounds                   */
/* -------------------------------------------- */

const nextAt = new Map(); // `${tokenId}:${index}` -> time

function gmTick() {
  if (!isActiveGM() || !canvas.ready || game.paused || setting("soundsMuted")) return;
  const scene = canvas.scene;
  const now = Date.now();
  for (const td of scene.tokens) {
    if (!td.actor) continue;
    const cfg = getSounds(td.actor);
    cfg.list.forEach((entry, index) => {
      if (entry.mode !== "random" || !entry.src) return;
      const key = `${td.id}:${index}`;
      const min = Math.max(2, Number(entry.min) || 20), max = Math.max(min, Number(entry.max) || 60);
      if (!nextAt.has(key)) return nextAt.set(key, now + (min + Math.random() * (max - min)) * 1000);
      if (now < nextAt.get(key)) return;
      nextAt.set(key, now + (min + Math.random() * (max - min)) * 1000);
      if (!cfg.enabled || isMuted(td) || td.hidden) return;
      const src = resolveSrc(entry.src);
      if (!src) return;
      const msg = { type: "tokenSound", sceneId: scene.id, tokenId: td.id, index, src };
      game.socket.emit(SOCKET, msg);
      playOnce(msg);
    });
  }
}

export function startSounds() {
  clearInterval(timer);
  timer = setInterval(() => {
    try { hearTick(); gmTick(); } catch (err) { console.error(`${MODULE_ID} | sounds`, err); }
  }, 200);
}

export function stopSounds() {
  clearInterval(timer);
  timer = null;
  stopAllSounds();
}

/** GM: mute or unmute one token for everyone. */
export function toggleMute(td) {
  return td.update({ [`flags.${MODULE_ID}.soundMuted`]: !isMuted(td) });
}

/* -------------------------------------------- */
/*  Reach on the map (GM, while editing)        */
/* -------------------------------------------- */

/** A token of this actor on the viewed scene (the token itself for an unlinked sheet). */
function tokenFor(actor) {
  if (actor?.isToken) return actor.token?.object ?? null;
  return actor?.getActiveTokens?.()[0] ?? null;
}

let range = null; // { editor, index, token, radius, layer, area, ring, until, drag }
const BLUE = 0x3a8dde;

function hideRange() {
  if (!range) return;
  canvas.app?.ticker.remove(range.tick);
  const board = canvas.app?.view?.parentElement;
  board?.removeEventListener("pointerdown", range.onDown, true);
  window.removeEventListener("pointermove", range.onMove, true);
  window.removeEventListener("pointerup", range.onUp, true);
  if (!range.layer.destroyed) range.layer.destroy({ children: true });
  range = null;
}

function toggleRange(editor, index) {
  if (range?.editor === editor && range.index === index && !range.until) return hideRange();
  showRange(editor, index);
}

/** Draw where a sound of the editor's actor is heard; `ms` hides it again after a while (the ▶ preview). */
function showRange(editor, index, ms = null) {
  hideRange();
  const token = tokenFor(editor.actor);
  if (!token) return ui.notifications.warn("Put a token of this actor on the scene you are viewing.");
  const entry = getSounds(editor.actor).list[index];
  if (!entry) return;
  const layer = new PIXI.Container();
  layer.eventMode = "none";
  layer.zIndex = 900;
  const area = new PIXI.Graphics();
  const ring = new PIXI.Graphics();
  layer.addChild(area, ring);
  canvas.controls.addChild(layer);
  range = { editor, index, token, entry, radius: Number(entry.radius) || 40, layer, area, ring, until: ms ? Date.now() + ms : null, key: null };

  const px = () => range.radius * canvas.dimensions.distancePixels;
  const draw = () => {
    const r = px();
    const c = token.center;
    const walls = wallMode(range.entry);
    area.clear();
    // Faint disc: the whole reach (heard only muffled where walls are in the way).
    area.beginFill(BLUE, walls === "block" ? 0 : walls === "ignore" ? 1 : 0.35).drawCircle(c.x, c.y, r).endFill();
    if (walls !== "ignore") {
      const poly = soundArea(token, r);
      if (poly) area.beginFill(BLUE, 1).drawPolygon(poly.points).endFill();
    }
    ring.clear();
    const w = 3 / canvas.stage.scale.x;
    ring.lineStyle(w, 0x5aa8ff, 0.95).drawCircle(c.x, c.y, r);
    ring.lineStyle(w, 0xffffff, 0.9).beginFill(0x5aa8ff, 1).drawCircle(c.x + r, c.y, 7 / canvas.stage.scale.x).endFill();
    range.key = `${Math.round(c.x)},${Math.round(c.y)},${range.radius},${canvas.stage.scale.x.toFixed(2)}`;
  };
  // A very slow pulse: only the transparency of one drawing changes, the shape is redrawn only when something moves.
  range.tick = () => {
    if (!range || token.destroyed) return hideRange();
    if (range.until && Date.now() > range.until) return hideRange();
    const c = token.center;
    if (range.key !== `${Math.round(c.x)},${Math.round(c.y)},${range.radius},${canvas.stage.scale.x.toFixed(2)}`) draw();
    area.alpha = 0.1 + 0.08 * (0.5 + 0.5 * Math.sin((performance.now() / 4500) * 2 * Math.PI));
  };
  const point = ev => canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
  range.onDown = ev => {
    if (ev.button !== 0 || ev.target !== canvas.app.view) return;
    const p = point(ev);
    const c = token.center;
    const tolerance = 12 / canvas.stage.scale.x;
    if (Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - px()) > tolerance) return;
    ev.stopPropagation(); ev.preventDefault();
    range.drag = true;
    range.until = null; // dragging keeps it on screen
  };
  range.onMove = ev => {
    if (!range?.drag) return;
    ev.stopPropagation();
    const p = point(ev);
    const c = token.center;
    const step = canvas.dimensions.distance || 5;
    range.radius = Math.max(step, Math.round(Math.hypot(p.x - c.x, p.y - c.y) / canvas.dimensions.distancePixels / step) * step);
    const input = editor.element?.querySelector(`[data-i="${index}"][data-k="radius"]`);
    if (input) input.value = range.radius;
  };
  range.onUp = async ev => {
    if (!range?.drag) return;
    ev.stopPropagation();
    range.drag = false;
    const cfg = editor._read();
    cfg.list[index].radius = range.radius;
    range.entry = cfg.list[index];
    await editor._save(cfg);
  };
  canvas.app.view.parentElement.addEventListener("pointerdown", range.onDown, true);
  window.addEventListener("pointermove", range.onMove, true);
  window.addEventListener("pointerup", range.onUp, true);
  draw();
  canvas.app.ticker.add(range.tick);
}

/* -------------------------------------------- */
/*  Editor                                      */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

export class SoundsEditor extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["cw-sounds"],
    window: { title: "Sounds", icon: "fa-solid fa-volume-high", resizable: true },
    position: { width: 600, height: "auto" }
  };

  static open(actor) {
    const id = `cw-sounds-${actor.uuid.replace(/\./g, "-")}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.render({ force: true });
    return new SoundsEditor(actor, id).render(true);
  }

  constructor(actor, id) {
    super({ id, window: { title: `Sounds — ${actor.isToken ? `${actor.name} (token)` : actor.name}` } });
    this.actor = actor;
  }

  _onClose(options) {
    if (range?.editor === this) hideRange();
    return super._onClose?.(options);
  }

  async _save(cfg) {
    await this.actor.update({ [`flags.${MODULE_ID}.sounds`]: cfg });
    // Keep the reach drawing in step with what was just saved.
    if (range?.editor === this) {
      range.entry = cfg.list[range.index] ?? range.entry;
      range.radius = Number(range.entry.radius) || range.radius;
      range.key = null;
    }
    this.render();
  }

  async _renderHTML() {
    const cfg = getSounds(this.actor);
    const opt = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}" ${k === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
    const presets = Object.entries(PRESETS).filter(([, p]) => !p.module || game.modules.get(p.module)?.active)
      .map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join("");
    const root = document.createElement("div");
    root.className = "cw-sounds-root";
    root.innerHTML = `
      <p class="cw-token"><img src="${esc(this.actor.img)}" alt=""> <b>${esc(this.actor.name)}</b>
        <span class="cw-hint">${this.actor.isToken ? "only this token" : "every token of this actor"}</span></p>
      <div class="cw-row">
        <label class="cw-check"><input type="checkbox" data-c="enabled" ${cfg.enabled ? "checked" : ""}> Makes sounds</label>
        <span class="cw-hint">Silent while hidden by the GM; invisible or hiding creatures are still heard.</span>
      </div>
      <div class="cw-sound-list">
        ${cfg.list.map((e, i) => `
          <div class="cw-sound">
            <div class="cw-row">
              <input type="text" data-i="${i}" data-k="src" value="${esc(e.src)}" placeholder="file, several files separated by | , or a Sequencer key">
              <button type="button" data-browse="${i}" data-tooltip="Pick a file"><i class="fa-solid fa-file-audio"></i></button>
              <button type="button" data-test="${i}" data-tooltip="Listen (only you) — shows how far it reaches"><i class="fa-solid fa-play"></i></button>
              <button type="button" data-range="${i}" class="${range?.editor === this && range.index === i ? "active" : ""}" data-tooltip="Show how far it is heard (drag the blue edge to change it)"><i class="fa-solid fa-bullseye"></i></button>
              <button type="button" data-del="${i}" data-tooltip="Remove"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cw-row cw-sound-opts">
              <select data-i="${i}" data-k="mode">${opt(MODES, e.mode)}</select>
              <label>vol <input type="range" min="0" max="1" step="0.05" data-i="${i}" data-k="volume" value="${esc(e.volume)}"></label>
              <label>heard up to <input type="number" min="5" step="5" data-i="${i}" data-k="radius" value="${esc(e.radius)}"> ft</label>
              ${e.mode === "random" ? `<label>every <input type="number" min="2" data-i="${i}" data-k="min" value="${esc(e.min)}">–<input type="number" min="2" data-i="${i}" data-k="max" value="${esc(e.max)}"> s</label>` : ""}
              <select data-i="${i}" data-k="walls" class="cw-walls">${opt(WALLS, wallMode(e))}</select>
              <label class="cw-check" data-tooltip="Quieter the farther away (off: same volume up to the edge)"><input type="checkbox" data-i="${i}" data-k="easing" ${e.easing !== false ? "checked" : ""}> fades with distance</label>
            </div>
          </div>`).join("") || `<p class="cw-hint">No sounds yet.</p>`}
      </div>
      <div class="cw-row">
        <select class="cw-preset"><option value="">Add a ready sound…</option>${presets}</select>
        <button type="button" data-do="add"><i class="fa-solid fa-plus"></i> Empty</button>
      </div>
      <p class="cw-hint">Environment channel. Each player hears it from their tokens (the GM: from the selected token, or the middle of the screen).
        Several sounds play together. Mute a token from its HUD; mute all from the left toolbar.
        <i class="fa-solid fa-bullseye"></i> shows the reach on the map: bright blue = heard clearly, faint = only muffled through walls.</p>`;
    return root;
  }

  _read() {
    const cfg = getSounds(this.actor);
    this.element.querySelectorAll("[data-c]").forEach(inp => { cfg[inp.dataset.c] = inp.checked; });
    this.element.querySelectorAll("[data-i]").forEach(inp => {
      const e = cfg.list[Number(inp.dataset.i)];
      const k = inp.dataset.k;
      e[k] = inp.type === "checkbox" ? inp.checked : ["volume", "radius", "min", "max"].includes(k) ? Number(inp.value) : inp.value;
    });
    cfg.list.forEach(e => { e.walls = wallMode(e); });
    return cfg;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    content.querySelectorAll("[data-c], [data-i]").forEach(inp => inp.addEventListener("change", () => this._save(this._read())));
    content.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
      const cfg = this._read();
      cfg.list.splice(Number(b.dataset.del), 1);
      this._save(cfg);
    }));
    content.querySelectorAll("[data-browse]").forEach(b => b.addEventListener("click", () => {
      const i = Number(b.dataset.browse);
      const FP = foundry.applications.apps.FilePicker.implementation;
      new FP({ type: "audio", current: this._read().list[i]?.src?.split("|")[0]?.trim() ?? "", callback: path => {
        const cfg = this._read();
        cfg.list[i].src = path;
        this._save(cfg);
      } }).render(true);
    }));
    content.querySelectorAll("[data-range]").forEach(b => b.addEventListener("click", () => {
      toggleRange(this, Number(b.dataset.range));
      this.render();
    }));
    content.querySelectorAll("[data-test]").forEach(b => b.addEventListener("click", async () => {
      const e = this._read().list[Number(b.dataset.test)];
      const src = resolveSrc(e?.src);
      if (!src) return;
      // The reach shows while it plays.
      if (!(range?.editor === this && range.index === Number(b.dataset.test))) showRange(this, Number(b.dataset.test), 6000);
      const sound = new foundry.audio.Sound(src, { context: game.audio.environment });
      await sound.load();
      await sound.play({ volume: Number(e.volume) || 0.7 });
      // A loop: a few seconds are enough to judge it.
      if (e.mode !== "random") setTimeout(() => sound.fade(0, { duration: 500 }).then(() => sound.stop()), 4000);
    }));
    content.querySelector(".cw-preset")?.addEventListener("change", ev => {
      const p = PRESETS[ev.target.value];
      if (!p) return;
      const cfg = this._read();
      const { label, module, ...entry } = p;
      cfg.list.push({ ...DEFAULT_ENTRY, ...entry });
      this._save(cfg);
    });
    content.querySelector('[data-do="add"]')?.addEventListener("click", () => {
      const cfg = this._read();
      cfg.list.push({ ...DEFAULT_ENTRY });
      this._save(cfg);
    });
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerSounds() {
  game.socket.on(SOCKET, msg => { if (msg?.type === "tokenSound") playOnce(msg); });
  Hooks.on("updateToken", (td, changes) => {
    if ("x" in changes || "y" in changes) lastMoved.set(td.id, Date.now());
  });
  Hooks.on("canvasTearDown", () => { stopAllSounds(); nextAt.clear(); });
  Hooks.on("deleteToken", td => stopToken(td.id));
}
