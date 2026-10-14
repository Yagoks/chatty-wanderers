// Chatty Wanderers — speech bubbles. Lines live on the actor (flags.chatty-wanderers.speech); the sheet of a token
// (unlinked) keeps its own. Only bubbles over the head: nothing goes to the chat and the camera never moves.
// Each client draws the bubble itself, so the language is checked per player: who knows it reads the line, who
// doesn't sees it scrambled (Polyglot's fonts when Polyglot is active).

import { MODULE_ID } from "./pathing.js";
import { isActiveGM, setting } from "./patrol.js";

const SOCKET = `module.${MODULE_ID}`;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

export const WHEN = {
  idle: "Idle chatter",
  near: "When players come near",
  spotted: "When it spots someone",
  discovered: "When it discovers someone",
  alert: "When the alert goes up"
};
export const IDLE = { always: "Always", near: "Only with players nearby", off: "Never (only events / macros)" };

const DEFAULT_SPEECH = { enabled: true, language: "", idle: "near", radius: 30, gap: 10, order: "sequence", lines: [] };

export function getSpeech(actor) {
  const saved = foundry.utils.getProperty(actor?.flags ?? {}, `${MODULE_ID}.speech`);
  return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_SPEECH), foundry.utils.deepClone(saved ?? {}), { inplace: false });
}

const hasLines = actor => getSpeech(actor).lines.some(l => l.text?.trim());

/** Seconds a line stays up when none is given: about the time to read it. */
const autoSeconds = text => Math.max(3, Math.min(15, Math.round(String(text).split(/\s+/).length * 0.45 + 1.5)));

/* -------------------------------------------- */
/*  Languages                                   */
/* -------------------------------------------- */

const polyglot = () => (game.modules.get("polyglot")?.active ? game.polyglot : null);

export function languages() {
  const pg = polyglot();
  if (pg?.languageProvider?.languages) {
    return Object.fromEntries(Object.entries(pg.languageProvider.languages).map(([k, v]) => [k, v.label ?? k]));
  }
  const out = {};
  const walk = obj => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (typeof v === "string") out[k] = game.i18n.localize(v);
      else {
        if (v?.label && !v.children) out[k] = game.i18n.localize(v.label);
        if (v?.children) walk(v.children);
      }
    }
  };
  walk(CONFIG.DND5E?.languages);
  return out;
}

const languageLabel = key => languages()[key] ?? key;

/** Does this user understand the language? The GM always does; players by their characters (or Polyglot). */
function understands(lang) {
  if (!lang || game.user.isGM) return true;
  const pg = polyglot();
  if (pg) {
    try { return pg.isLanguageKnown(lang) || pg.isLanguageUnderstood(lang); } catch { /* fall through */ }
  }
  const actors = canvas.tokens?.controlled.map(t => t.actor).filter(Boolean) ?? [];
  if (!actors.length && game.user.character) actors.push(game.user.character);
  return actors.some(a => a.system?.traits?.languages?.value?.has?.(lang));
}

function scramble(text, lang, salt) {
  const pg = polyglot();
  if (pg) {
    try { return { text: pg.scrambleString(text, salt, lang), font: pg._getFontStyle(lang) }; } catch { /* fall through */ }
  }
  // No Polyglot: same length, letters shuffled from a seed so a line always scrambles the same way.
  let seed = [...(text + salt)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const abc = "aeiouklmnrstvzgdhx";
  return { text: text.replace(/\p{L}/gu, () => abc[Math.floor(rand() * abc.length)]), font: "" };
}

/* -------------------------------------------- */
/*  Bubbles (every client)                      */
/* -------------------------------------------- */

const bubbles = new Map(); // tokenId -> { el, timer }

function container() {
  let el = document.getElementById("chat-bubbles");
  if (!el) {
    el = document.createElement("div");
    el.id = "chat-bubbles";
    document.getElementById("hud")?.append(el);
  }
  return el;
}

function place(token, el) {
  el.style.left = `${token.document.x}px`;
  el.style.top = `${token.document.y - el.offsetHeight - 8}px`;
}

function clearBubble(tokenId) {
  const b = bubbles.get(tokenId);
  if (!b) return;
  clearTimeout(b.timer);
  b.el.remove();
  bubbles.delete(tokenId);
}

/** Draw a line over a token on this client. */
export function showBubble({ sceneId, tokenId, text, language, seconds }) {
  if (!setting("showBubbles") || !canvas.ready || canvas.scene?.id !== sceneId) return;
  const token = canvas.tokens.get(tokenId);
  if (!token || !text) return;
  if (!game.user.isGM && (token.document.hidden || !token.visible)) return;
  clearBubble(tokenId);

  let body = text;
  let font = "";
  if (language && !understands(language)) ({ text: body, font } = scramble(text, language, tokenId));
  body = esc(body);
  const tag = language ? `<span class="cw-lang">${esc(languageLabel(language))}</span>` : "";
  const el = document.createElement("div");
  el.className = `chat-bubble left cw-bubble ${token.document.hidden ? "cw-hidden" : ""}`;
  el.dataset.tokenId = tokenId;
  el.innerHTML = `<div class="bubble-content">${tag}<span class="cw-text" ${font ? `style="font: ${esc(font)}"` : ""}>${body}</span></div>`;
  container().append(el);
  place(token, el);
  el.animate({ opacity: [0, 1] }, { duration: 250, easing: "ease" });
  const ms = (Number(seconds) || autoSeconds(text)) * 1000;
  const timer = setTimeout(() => {
    el.animate({ opacity: [1, 0] }, { duration: 400, easing: "ease" }).finished.then(() => {
      if (bubbles.get(tokenId)?.el === el) bubbles.delete(tokenId);
      el.remove();
    });
  }, ms);
  bubbles.set(tokenId, { el, timer });
}

/** Say a line over a token, for everyone (any client can call it). */
export function say(token, text, { language = "", seconds = null, local = false } = {}) {
  const td = token?.document ?? token;
  if (!td?.parent || !text) return;
  const msg = { type: "say", sceneId: td.parent.id, tokenId: td.id, text: String(text), language, seconds: Number(seconds) || autoSeconds(text) };
  if (!local) game.socket.emit(SOCKET, msg);
  showBubble(msg);
}

/** Say one of the lines of a token (its language when the line has none). */
function sayLine(td, sp, line, opts = {}) {
  say(td, line.text, { language: line.language || sp.language || "", seconds: line.seconds, ...opts });
  return (Number(line.seconds) || autoSeconds(line.text));
}

/* -------------------------------------------- */
/*  GM: who says what, when                     */
/* -------------------------------------------- */

const runtime = new Map(); // tokenId -> { next, idx: {}, near, last: {} }
let timer = null;

function rt(td, sp) {
  let r = runtime.get(td.id);
  // A first line comes at a random moment, so a room doesn't start talking all at once.
  if (!r) runtime.set(td.id, r = { next: Date.now() + Math.random() * (Number(sp.gap) || 10) * 1000, idx: {}, near: false, last: {} });
  return r;
}

function pick(td, sp, when) {
  const lines = sp.lines.filter(l => (l.when || "idle") === when && l.text?.trim());
  if (!lines.length) return null;
  const r = rt(td, sp);
  if (sp.order === "random" && lines.length > 1) {
    let i;
    do i = Math.floor(Math.random() * lines.length); while (i === r.last[when]);
    r.last[when] = i;
    return lines[i];
  }
  const i = (r.idx[when] ?? 0) % lines.length;
  r.idx[when] = i + 1;
  return lines[i];
}

/** An event line (spotted, discovered, alert…) of a token, if it has one. */
export function sayEvent(td, when) {
  if (!isActiveGM() || !setting("speechEnabled") || !td?.actor) return;
  const sp = getSpeech(td.actor);
  if (!sp.enabled) return;
  const line = pick(td, sp, when);
  if (!line) return;
  const secs = sayLine(td, sp, line);
  const r = rt(td, sp);
  r.next = Math.max(r.next, Date.now() + (secs + (Number(sp.gap) || 10)) * 1000);
}

function playerTokens(scene) {
  return scene.tokens.filter(t => t.actor?.hasPlayerOwner && !t.hidden && t.object);
}

function speechTick() {
  if (!isActiveGM() || !canvas.ready || game.paused || !setting("speechEnabled")) return;
  const scene = canvas.scene;
  if (!scene) return;
  if (!setting("speechInCombat") && game.combats.some(c => c.active && c.scene === scene && c.started)) return;
  const now = Date.now();
  const players = playerTokens(scene).map(t => t.object.center);
  const perFt = canvas.dimensions.distancePixels;
  for (const td of scene.tokens) {
    if (!td.actor || td.hidden || td.actor.hasPlayerOwner) continue;
    const sp = getSpeech(td.actor);
    if (!sp.enabled || !sp.lines.length) continue;
    const r = rt(td, sp);
    const c = td.object?.center;
    if (!c) continue;
    const radius = (Number(sp.radius) || 30) * perFt + td.object.w / 2;
    const near = players.some(p => Math.hypot(p.x - c.x, p.y - c.y) <= radius);
    // Players just arrived: a greeting, if it has one.
    if (near && !r.near) {
      r.near = true;
      const line = pick(td, sp, "near");
      if (line) {
        r.next = now + (sayLine(td, sp, line) + (Number(sp.gap) || 10)) * 1000;
        continue;
      }
    }
    r.near = near;
    if (sp.idle === "off" || (sp.idle === "near" && !near) || now < r.next) continue;
    const line = pick(td, sp, "idle");
    if (!line) continue;
    const gap = (Number(sp.gap) || 10) * (0.6 + Math.random() * 0.8);
    r.next = now + (sayLine(td, sp, line) + gap) * 1000;
  }
}

export function startSpeech() {
  clearInterval(timer);
  timer = setInterval(() => { try { speechTick(); } catch (err) { console.error(`${MODULE_ID} | speech`, err); } }, 1000);
}

export function stopSpeech() {
  clearInterval(timer);
  timer = null;
}

/* -------------------------------------------- */
/*  Editor (on the sheet)                       */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

/** A token of this actor on the viewed scene (the token itself for an unlinked sheet). */
function tokenFor(actor) {
  if (actor?.isToken) return actor.token?.object ?? null;
  return actor?.getActiveTokens?.()[0] ?? null;
}

export class SpeechEditor extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["cw-speech"],
    window: { title: "Speech", icon: "fa-solid fa-comment-dots", resizable: true },
    position: { width: 640, height: "auto" }
  };

  static open(actor) {
    const id = `cw-speech-${actor.uuid.replace(/\./g, "-")}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.render({ force: true });
    return new SpeechEditor(actor, id).render(true);
  }

  constructor(actor, id) {
    super({ id, window: { title: `Speech — ${actor.isToken ? `${actor.name} (token)` : actor.name}` } });
    this.actor = actor;
  }

  async _save(sp) {
    await this.actor.update({ [`flags.${MODULE_ID}.speech`]: sp });
    runtime.clear();
    this.render();
  }

  async _renderHTML() {
    const sp = getSpeech(this.actor);
    const langs = languages();
    const opt = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}" ${k === (cur ?? "") ? "selected" : ""}>${esc(v)}</option>`).join("");
    const langOpts = cur => `<option value="">— ${sp.language ? `default (${esc(languageLabel(sp.language))})` : "understood by all"} —</option>${opt(langs, cur)}`;
    const root = document.createElement("div");
    root.className = "cw-speech-root";
    root.innerHTML = `
      <p class="cw-token"><img src="${esc(this.actor.img)}" alt=""> <b>${esc(this.actor.name)}</b>
        ${this.actor.isToken ? `<span class="cw-hint">only this token</span>` : `<span class="cw-hint">every token of this actor (linked or new)</span>`}</p>
      <div class="cw-grid">
        <label class="cw-check"><input type="checkbox" data-s="enabled" ${sp.enabled ? "checked" : ""}> Talks</label>
        <label class="cw-field"><span>Language</span><select data-s="language"><option value="">— understood by all —</option>${opt(langs, sp.language)}</select></label>
        <label class="cw-field"><span>Idle chatter</span><select data-s="idle">${opt(IDLE, sp.idle)}</select></label>
        <label class="cw-field"><span>"Nearby" (ft)</span><input type="number" min="5" step="5" data-s="radius" value="${esc(sp.radius)}"></label>
        <label class="cw-field"><span>Pause between lines (s)</span><input type="number" min="1" step="1" data-s="gap" value="${esc(sp.gap)}"></label>
        <label class="cw-field"><span>Order</span><select data-s="order">${opt({ sequence: "In order", random: "Random" }, sp.order)}</select></label>
      </div>
      <div class="cw-lines">
        ${sp.lines.map((l, i) => `
          <div class="cw-line">
            <textarea data-line="${i}" data-k="text" rows="2" placeholder="What it says">${esc(l.text)}</textarea>
            <div class="cw-line-opts">
              <select data-line="${i}" data-k="when">${opt(WHEN, l.when || "idle")}</select>
              <select data-line="${i}" data-k="language">${langOpts(l.language)}</select>
              <label><input type="number" min="1" step="1" data-line="${i}" data-k="seconds" value="${esc(l.seconds ?? "")}" placeholder="${autoSeconds(l.text ?? "")}"> s</label>
              <button type="button" data-preview="${i}" data-tooltip="Preview (only you)"><i class="fa-solid fa-eye"></i></button>
              <button type="button" data-say="${i}" data-tooltip="Say it now (everyone)"><i class="fa-solid fa-comment"></i></button>
              <button type="button" data-del="${i}" data-tooltip="Remove"><i class="fa-solid fa-xmark"></i></button>
            </div>
          </div>`).join("") || `<p class="cw-hint">No lines yet.</p>`}
      </div>
      <button type="button" data-do="add"><i class="fa-solid fa-plus"></i> Line</button>
      <p class="cw-hint">Bubbles only (never the chat, never moves the camera). Seconds empty = time to read it. Players who don't know
        the language see it scrambled${polyglot() ? " in Polyglot's font" : ""}. Idle lines need the token on the scene you are viewing.</p>`;
    return root;
  }

  _read() {
    const sp = getSpeech(this.actor);
    const el = this.element;
    el.querySelectorAll("[data-s]").forEach(inp => {
      const k = inp.dataset.s;
      sp[k] = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? Number(inp.value) : inp.value;
    });
    el.querySelectorAll("[data-line]").forEach(inp => {
      const line = sp.lines[Number(inp.dataset.line)];
      const k = inp.dataset.k;
      line[k] = k === "seconds" ? (inp.value === "" ? null : Number(inp.value)) : inp.value;
    });
    return sp;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    content.querySelectorAll("[data-s], [data-line]").forEach(inp => inp.addEventListener("change", () => this._save(this._read())));
    content.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
      const sp = this._read();
      sp.lines.splice(Number(b.dataset.del), 1);
      this._save(sp);
    }));
    const speak = (i, local) => {
      const sp = this._read();
      const line = sp.lines[i];
      const token = tokenFor(this.actor);
      if (!token) return ui.notifications.warn("Put a token of this actor on the scene you are viewing.");
      if (!line?.text?.trim()) return;
      sayLine(token.document, sp, line, { local });
    };
    content.querySelectorAll("[data-preview]").forEach(b => b.addEventListener("click", () => speak(Number(b.dataset.preview), true)));
    content.querySelectorAll("[data-say]").forEach(b => b.addEventListener("click", () => speak(Number(b.dataset.say), false)));
    content.querySelector('[data-do="add"]')?.addEventListener("click", () => {
      const sp = this._read();
      sp.lines.push({ text: "", when: "idle", language: "", seconds: null });
      this._save(sp);
    });
  }
}

/** A speech button in the tab column of dnd5e sheets (or the window header of other sheets). GM only. */
function onRenderActorSheet(app, html) {
  if (!game.user.isGM) return;
  const actor = app.document ?? app.actor;
  if (!actor || actor.documentName !== "Actor") return;
  const root = html instanceof HTMLElement ? html : html?.[0] ?? app.element;
  if (!root || root.querySelector(".cw-speech-tab")) return;
  const nav = root.querySelector("nav.tabs-right, nav.tabs");
  const btn = document.createElement(nav ? "a" : "button");
  btn.className = nav ? "item control cw-speech-tab" : "header-control icon fa-solid fa-comment-dots cw-speech-tab";
  btn.dataset.tooltip = "Speech bubbles";
  btn.setAttribute("aria-label", "Speech bubbles");
  if (nav) btn.innerHTML = `<i class="fa-solid fa-comment-dots" inert></i>`;
  if (hasLines(actor)) btn.classList.add("cw-has-lines");
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    SpeechEditor.open(actor);
  });
  if (nav) nav.append(btn);
  else root.querySelector(".window-header .window-title")?.after(btn);
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerSpeech() {
  game.socket.on(SOCKET, msg => { if (msg?.type === "say") showBubble(msg); });
  Hooks.on("renderActorSheetV2", onRenderActorSheet);
  // Bubbles follow walking tokens.
  Hooks.on("refreshToken", token => {
    const b = bubbles.get(token.id);
    if (b) place(token, b.el);
  });
  Hooks.on("canvasTearDown", () => { for (const id of [...bubbles.keys()]) clearBubble(id); runtime.clear(); });
  Hooks.on("deleteToken", td => { clearBubble(td.id); runtime.delete(td.id); });
  Hooks.on(`${MODULE_ID}.spotted`, td => sayEvent(td, "spotted"));
  Hooks.on(`${MODULE_ID}.discovered`, td => sayEvent(td, "discovered"));
  Hooks.on(`${MODULE_ID}.alertChanged`, (scene, level, before) => {
    if (level <= before || scene !== canvas.scene) return;
    // Not everyone at once: a short stagger.
    scene.tokens.filter(t => t.actor && !t.hidden && getSpeech(t.actor).lines.some(l => l.when === "alert"))
      .forEach((td, i) => setTimeout(() => sayEvent(td, "alert"), 300 + i * 900 + Math.random() * 600));
  });
}
