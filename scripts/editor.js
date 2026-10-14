// Chatty Wanderers — route editor (GM). Routes are drawn by the module itself on a GM-only overlay: no tiles, no
// drawings. Left click adds a point (while "Add points" is on), drag moves a point, right click removes it.

import { MODULE_ID, cellOf, centerOf, findPath } from "./pathing.js";
import { getPatrol, getRoute, getRoutes, setStatus } from "./patrol.js";
import { ACTIONS, getReactions, hasReactions } from "./reactions.js";
import { getConfig as getAlertConfig, getState as getAlertState } from "./alert.js";

const { ApplicationV2 } = foundry.applications.api;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const MODES = { loop: "Loop (1 → 2 → 3 → 1)", pingpong: "Back and forth (1 → 2 → 3 → 2)", random: "Random points" };
const COLORS = ["#e8b84a", "#4ac2e8", "#e85a4a", "#7be84a", "#c44ae8", "#e8884a"];

/* -------------------------------------------- */
/*  Overlay                                     */
/* -------------------------------------------- */

let overlay = null;

function ensureOverlay() {
  if (overlay && !overlay.destroyed && overlay.parent) return overlay;
  overlay = new PIXI.Container();
  overlay.eventMode = "none";
  overlay.zIndex = 1000;
  canvas.controls.addChild(overlay);
  return overlay;
}

export function clearOverlay() {
  if (overlay && !overlay.destroyed) overlay.removeChildren().forEach(c => c.destroy({ children: true }));
}

/** Draw a route: the walked path between its points (red dashes where there is no way through) and numbered points. */
export function drawRoute(route, { strong = true, drag = null } = {}) {
  const layer = ensureOverlay();
  clearOverlay();
  if (!route?.points?.length) return;
  const color = Number(foundry.utils.Color.from(route.color ?? COLORS[0]));
  const g = new PIXI.Graphics();
  const size = canvas.grid.size;
  const points = route.points.map((p, i) => (drag?.index === i ? drag.point : p));
  const legs = points.map((p, i) => [p, points[i + 1]]).slice(0, -1);
  if (route.mode !== "pingpong" && points.length > 2) legs.push([points.at(-1), points[0]]);
  for (const [a, b] of legs) {
    const path = findPath(cellOf(a), cellOf(b));
    if (path) {
      g.lineStyle(size * 0.06, color, strong ? 0.85 : 0.45);
      const start = centerOf(cellOf(a));
      g.moveTo(start.x, start.y);
      for (const c of path) { const p = centerOf(c); g.lineTo(p.x, p.y); }
    } else {
      g.lineStyle(size * 0.06, 0xff3030, 0.9);
      const steps = 14;
      for (let s = 0; s < steps; s += 2) {
        g.moveTo(a.x + (b.x - a.x) * s / steps, a.y + (b.y - a.y) * s / steps);
        g.lineTo(a.x + (b.x - a.x) * (s + 1) / steps, a.y + (b.y - a.y) * (s + 1) / steps);
      }
    }
  }
  layer.addChild(g);
  points.forEach((p, i) => {
    const dot = new PIXI.Graphics();
    dot.lineStyle(size * 0.04, 0x000000, 0.8).beginFill(color, strong ? 0.95 : 0.6).drawCircle(p.x, p.y, size * 0.22).endFill();
    layer.addChild(dot);
    const label = new PIXI.Text(String(i + 1), { fontFamily: "Signika", fontSize: size * 0.24, fontWeight: "bold", fill: 0x111111 });
    label.anchor.set(0.5);
    label.position.set(p.x, p.y);
    layer.addChild(label);
    if (Number(p.wait) > 0) {
      const w = new PIXI.Text(`${p.wait}s`, { fontFamily: "Signika", fontSize: size * 0.16, fill: 0xffffff, stroke: 0x000000, strokeThickness: 3 });
      w.anchor.set(0.5, 0);
      w.position.set(p.x, p.y + size * 0.24);
      layer.addChild(w);
    }
  });
}

/** Where a token goes at each alert level ("Go to a point"): a diamond with the level number. */
export function drawReactionPoints(td) {
  const reactions = getReactions(td);
  const marks = Object.entries(reactions).filter(([, r]) => r?.action === "goto" && r.point);
  if (!marks.length) return;
  const layer = ensureOverlay();
  const size = canvas.grid.size;
  for (const [level, r] of marks) {
    const { x, y } = r.point;
    const s = size * 0.26;
    const g = new PIXI.Graphics();
    g.lineStyle(size * 0.04, 0x000000, 0.8).beginFill(0xe85a4a, 0.9).drawPolygon([x, y - s, x + s, y, x, y + s, x - s, y]).endFill();
    layer.addChild(g);
    const label = new PIXI.Text(`A${level}`, { fontFamily: "Signika", fontSize: size * 0.2, fontWeight: "bold", fill: 0xffffff });
    label.anchor.set(0.5);
    label.position.set(x, y);
    layer.addChild(label);
  }
}

/* -------------------------------------------- */
/*  Editor window                               */
/* -------------------------------------------- */

export class RouteEditor extends ApplicationV2 {
  static current = null;

  static DEFAULT_OPTIONS = {
    classes: ["cw-editor"],
    window: { title: "Patrol route", icon: "fa-solid fa-route", resizable: true },
    position: { width: 420, height: "auto", top: 80, left: 120 }
  };

  static open(td) {
    RouteEditor.current?.close();
    const app = new RouteEditor(td);
    RouteEditor.current = app;
    app.render(true);
    return app;
  }

  constructor(td) {
    super({ id: "chatty-wanderers-editor" });
    this.td = td;
    this.adding = false;
    this.picking = null;
    this.drag = null;
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onContext = ev => { if (this._pointAt(ev) !== null) ev.preventDefault(); };
  }

  get scene() { return this.td.parent; }
  get patrol() { return getPatrol(this.td) ?? {}; }
  get route() { return this.patrol.route ? getRoute(this.scene, this.patrol.route) : null; }

  async _saveRoute(route) {
    await this.scene.update({ [`flags.${MODULE_ID}.routes.${route.id}`]: route });
  }

  async _renderHTML() {
    const routes = getRoutes(this.scene);
    const route = this.route;
    const patrol = this.patrol;
    const status = patrol.status ?? "stopped";
    const statusLabel = { patrolling: "Patrolling", stopped: "Stopped", detached: "Off its route (stopped)", spotted: "Spotted someone", alerted: "Alerted",
      moving: "Following the alert", holding: "Holding position" }[status] ?? status;
    const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
    const root = document.createElement("div");
    root.className = "cw-root";
    root.innerHTML = `
      <p class="cw-token"><img src="${esc(this.td.texture.src)}" alt=""> <b>${esc(this.td.name)}</b> <span class="cw-status cw-${status}">${statusLabel}</span></p>
      <div class="cw-row">
        <select class="cw-route-select">
          <option value="">— no route —</option>
          ${Object.values(routes).map(r => `<option value="${r.id}" ${r.id === route?.id ? "selected" : ""}>${esc(r.name)} (${r.points.length})</option>`).join("")}
        </select>
        <button type="button" data-do="new" data-tooltip="New route for this token"><i class="fa-solid fa-plus"></i></button>
        ${route ? `<button type="button" data-do="delete" data-tooltip="Delete this route"><i class="fa-solid fa-trash"></i></button>` : ""}
      </div>
      ${route ? `
      <label class="cw-field"><span>Name</span><input type="text" data-r="name" value="${esc(route.name)}"></label>
      <label class="cw-field"><span>Color</span><input type="color" data-r="color" value="${esc(route.color ?? COLORS[0])}"></label>
      <label class="cw-field"><span>Mode</span><select data-r="mode">${opts(MODES, route.mode ?? "loop")}</select></label>
      <label class="cw-check"><input type="checkbox" data-r="openDoors" ${route.openDoors !== false ? "checked" : ""}> Opens unlocked doors</label>
      <label class="cw-check"><input type="checkbox" data-r="closeDoors" ${route.closeDoors !== false ? "checked" : ""}> Closes them behind it</label>
      <label class="cw-field"><span>Speed ×</span><input type="number" step="0.1" min="0.1" data-p="speed" value="${esc(patrol.speed ?? 1)}"></label>
      <fieldset class="cw-vision"><legend>Vision</legend>
        <label class="cw-check"><input type="checkbox" data-v="enabled" ${patrol.vision?.enabled !== false ? "checked" : ""}> Spots intruders</label>
        <label class="cw-field"><span>Angle (°)</span><input type="number" min="10" max="360" step="5" data-v="angle" value="${esc(patrol.vision?.angle ?? "")}" placeholder="${setting("coneAngle")}"></label>
        <label class="cw-field"><span>Range (ft)</span><input type="number" min="5" step="5" data-v="range" value="${esc(patrol.vision?.range ?? "")}" placeholder="${setting("coneRange")}"></label>
      </fieldset>
      <div class="cw-points">
        ${route.points.map((p, i) => `
          <div class="cw-point"><b>${i + 1}</b>
            <label>wait <input type="number" min="0" step="1" data-wait="${i}" value="${esc(p.wait ?? 0)}"> s</label>
            <button type="button" data-del="${i}" data-tooltip="Remove point"><i class="fa-solid fa-xmark"></i></button>
          </div>`).join("") || "<p class=\"cw-hint\">No points yet.</p>"}
      </div>
      <button type="button" data-do="add" class="${this.adding ? "active" : ""}"><i class="fa-solid fa-location-dot"></i> ${this.adding ? "Adding points — click the map" : "Add points"}</button>
      <p class="cw-hint">Left click: add a point (while adding) • drag a point to move it • right click a point to remove it.</p>
      <div class="cw-row cw-controls">
        ${status === "patrolling"
          ? `<button type="button" data-do="stop"><i class="fa-solid fa-pause"></i> Stop</button>`
          : `<button type="button" data-do="start" ${route.points.length ? "" : "disabled"}><i class="fa-solid fa-play"></i> Start from point 1</button>`}
      </div>` : `<p class="cw-hint">Pick a route of this scene or create a new one.</p>`}
      ${this._reactionsHTML(routes)}`;
    return root;
  }

  /** What this token does at each alert level of the scene. */
  _reactionsHTML(routes) {
    const c = getAlertConfig(this.scene);
    if (!c.enabled) return `<p class="cw-hint">Reactions to the alert: enable an alert for this scene (Scene configuration).</p>`;
    const reactions = getReactions(this.td);
    const level = getAlertState(this.scene).level;
    const patrol = this.patrol;
    const opt = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === (cur ?? "") ? "selected" : ""}>${esc(v)}</option>`).join("");
    const rows = c.levels.slice(1).map((l, i) => {
      const n = i + 1;
      const r = reactions[n] ?? {};
      const a = r.action ?? "";
      let extra = "";
      if (a === "route") extra = `<select data-react="${n}" data-k="route"><option value="">— route —</option>${Object.values(routes).map(x => `<option value="${x.id}" ${x.id === r.route ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`;
      if (a === "goto") extra = `<button type="button" data-pick="${n}" class="${this.picking === n ? "active" : ""}"><i class="fa-solid fa-location-dot"></i> ${this.picking === n ? "Click the map…" : r.point ? "Move the point" : "Set the point"}</button>
        <select data-react="${n}" data-k="then">${opt({ stay: "and stays there", hide: "and hides (leaves)" }, r.then ?? "stay")}</select>`;
      if (a === "investigate") extra = `<label>looks around <input type="number" min="0" step="5" data-react="${n}" data-k="wait" value="${esc(r.wait ?? 30)}"> s, then goes back</label>`;
      const speed = a && a !== "normal" && a !== "hold" ? `<label>speed × <input type="number" min="0.1" step="0.1" data-react="${n}" data-k="speed" value="${esc(r.speed ?? "")}" placeholder="1"></label>` : "";
      return `<div class="cw-react-row ${n === level ? "current" : ""}">
        <span class="cw-react-lvl">${n} — ${esc(l.name)}</span>
        <select data-react="${n}" data-k="action">${opt(ACTIONS, a)}</select>
        ${extra || speed ? `<div class="cw-react-extra">${extra}${speed}</div>` : ""}</div>`;
    }).join("");
    const following = patrol.home ? `<div class="cw-row"><span class="cw-hint">Following the alert (level ${patrol.react ?? "?"}).</span>
      <button type="button" data-do="goHome"><i class="fa-solid fa-house"></i> Back to usual now</button></div>` : "";
    return `<fieldset class="cw-vision cw-reactions"><legend>On alert — ${esc(c.title)} (now ${level})</legend>${rows}${following}
      <p class="cw-hint">A level left empty keeps the reaction of the level below. When the alert drops, the token walks back and carries on.</p></fieldset>`;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    const el = content;
    el.querySelector(".cw-route-select")?.addEventListener("change", async ev => {
      await this.td.update({ [`flags.${MODULE_ID}.patrol.route`]: ev.target.value || null, [`flags.${MODULE_ID}.patrol.index`]: 0 }, { [MODULE_ID]: true });
      this.render();
    });
    el.querySelectorAll("[data-r]").forEach(inp => inp.addEventListener("change", async () => {
      const route = this.route;
      route[inp.dataset.r] = inp.type === "checkbox" ? inp.checked : inp.value;
      await this._saveRoute(route);
      this.render();
    }));
    el.querySelectorAll("[data-p]").forEach(inp => inp.addEventListener("change", async () => {
      await this.td.update({ [`flags.${MODULE_ID}.patrol.${inp.dataset.p}`]: Number(inp.value) || 1 }, { [MODULE_ID]: true });
    }));
    el.querySelectorAll("[data-v]").forEach(inp => inp.addEventListener("change", async () => {
      const value = inp.type === "checkbox" ? inp.checked : (inp.value === "" ? null : Number(inp.value));
      await this.td.update({ [`flags.${MODULE_ID}.patrol.vision.${inp.dataset.v}`]: value }, { [MODULE_ID]: true });
    }));
    el.querySelectorAll("[data-wait]").forEach(inp => inp.addEventListener("change", async () => {
      const route = this.route;
      route.points[Number(inp.dataset.wait)].wait = Math.max(0, Number(inp.value) || 0);
      await this._saveRoute(route);
      this.render();
    }));
    el.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => this._removePoint(Number(b.dataset.del))));
    el.querySelectorAll("[data-react]").forEach(inp => inp.addEventListener("change", async () => {
      const k = inp.dataset.k;
      let value = inp.value;
      if (k === "wait" || k === "speed") value = value === "" ? null : Number(value);
      const key = `flags.${MODULE_ID}.reactions.${inp.dataset.react}`;
      if (k === "action" && !value) await this.td.update({ [`flags.${MODULE_ID}.reactions.-=${inp.dataset.react}`]: null });
      else await this.td.update({ [`${key}.${k}`]: value });
      if (k === "action" && value === "goto" && !getReactions(this.td)[inp.dataset.react]?.point) this.picking = Number(inp.dataset.react);
      this.render();
    }));
    el.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => {
      const n = Number(b.dataset.pick);
      this.picking = this.picking === n ? null : n;
      this.adding = false;
      this.render();
    }));
    el.querySelectorAll("[data-do]").forEach(b => b.addEventListener("click", () => this._do(b.dataset.do)));
    drawRoute(this.route);
    drawReactionPoints(this.td);
  }

  async _do(action) {
    switch (action) {
      case "new": {
        const id = foundry.utils.randomID(8);
        const n = Object.keys(getRoutes(this.scene)).length;
        const route = { id, name: `${this.td.name} route`, color: COLORS[n % COLORS.length], mode: "loop", openDoors: true, closeDoors: true, points: [] };
        await this._saveRoute(route);
        await this.td.update({ [`flags.${MODULE_ID}.patrol`]: { route: id, index: 0, dir: 1, status: "stopped", speed: this.patrol.speed ?? 1 } }, { [MODULE_ID]: true });
        this.adding = true;
        break;
      }
      case "delete": {
        const route = this.route;
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Delete route" }, content: `<p>Delete the route <b>${esc(route.name)}</b>? Tokens using it stop.</p>` });
        if (!ok) return;
        await this.scene.update({ [`flags.${MODULE_ID}.routes.-=${route.id}`]: null });
        for (const t of this.scene.tokens) if (getPatrol(t)?.route === route.id) await t.update({ [`flags.${MODULE_ID}.patrol.route`]: null, [`flags.${MODULE_ID}.patrol.status`]: "stopped" }, { [MODULE_ID]: true });
        break;
      }
      case "add": this.adding = !this.adding; this.picking = null; break;
      case "goHome": {
        const home = this.patrol.home;
        if (home) await this.td.update({ [`flags.${MODULE_ID}.patrol.goal`]: { x: home.x, y: home.y, then: "home" }, [`flags.${MODULE_ID}.patrol.status`]: "moving",
          [`flags.${MODULE_ID}.patrol.react`]: 0 }, { [MODULE_ID]: true });
        break;
      }
      case "start": await setStatus(this.td, "patrolling", { index: 0, dir: 1 }); break;
      case "stop": await setStatus(this.td, "stopped"); break;
    }
    this.render();
  }

  async _removePoint(i) {
    const route = this.route;
    route.points.splice(i, 1);
    await this._saveRoute(route);
    this.render();
  }

  /* ---------------- canvas input ---------------- */

  _worldPoint(ev) {
    return canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
  }

  _snapped(p) {
    return centerOf(cellOf(p));
  }

  _pointAt(ev) {
    const route = this.route;
    if (!route) return null;
    const p = this._worldPoint(ev);
    const r = canvas.grid.size * 0.3;
    const i = route.points.findIndex(q => Math.hypot(q.x - p.x, q.y - p.y) <= r);
    return i >= 0 ? i : null;
  }

  _onPointerDown(ev) {
    if (ev.target !== canvas.app.view) return;
    if (this.picking !== null && ev.button === 0) {
      ev.stopPropagation(); ev.preventDefault();
      const n = this.picking;
      this.picking = null;
      this.td.update({ [`flags.${MODULE_ID}.reactions.${n}.point`]: this._snapped(this._worldPoint(ev)) }).then(() => this.render());
      return;
    }
    if (!this.route) return;
    const i = this._pointAt(ev);
    if (ev.button === 2 && i !== null) {
      ev.stopPropagation(); ev.preventDefault();
      return this._removePoint(i);
    }
    if (ev.button !== 0) return;
    if (i !== null) {
      ev.stopPropagation(); ev.preventDefault();
      this.drag = { index: i, point: this.route.points[i] };
      return;
    }
    if (this.adding) {
      ev.stopPropagation(); ev.preventDefault();
      const route = this.route;
      route.points.push({ ...this._snapped(this._worldPoint(ev)), wait: 0 });
      this._saveRoute(route).then(() => this.render());
    }
  }

  _onPointerMove(ev) {
    if (!this.drag) return;
    ev.stopPropagation();
    this.drag.point = { ...this.route.points[this.drag.index], ...this._snapped(this._worldPoint(ev)) };
    drawRoute(this.route, { drag: this.drag });
  }

  _onPointerUp(ev) {
    if (!this.drag) return;
    ev.stopPropagation();
    const route = this.route;
    route.points[this.drag.index] = this.drag.point;
    this.drag = null;
    this._saveRoute(route).then(() => this.render());
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const board = canvas.app.view.parentElement;
    board.addEventListener("pointerdown", this._onPointerDown, true);
    window.addEventListener("pointermove", this._onPointerMove, true);
    window.addEventListener("pointerup", this._onPointerUp, true);
    board.addEventListener("contextmenu", this._onContext, true);
  }

  _onClose(options) {
    const board = canvas.app?.view?.parentElement;
    board?.removeEventListener("pointerdown", this._onPointerDown, true);
    window.removeEventListener("pointermove", this._onPointerMove, true);
    window.removeEventListener("pointerup", this._onPointerUp, true);
    board?.removeEventListener("contextmenu", this._onContext, true);
    if (RouteEditor.current === this) RouteEditor.current = null;
    clearOverlay();
    return super._onClose?.(options);
  }
}

/** While no editor is open, show the route of a selected patroller (faint) to the GM. */
export function showSelectedRoute() {
  if (!game.user.isGM || RouteEditor.current) return;
  const td = canvas.tokens.controlled.map(t => t.document).find(d => getPatrol(d)?.route || hasReactions(d));
  if (!td || !setting("showSelected")) return clearOverlay();
  const route = getPatrol(td)?.route;
  if (route) drawRoute(getRoute(td.parent, route), { strong: false });
  else clearOverlay();
  drawReactionPoints(td);
}

const setting = key => game.settings.get(MODULE_ID, key);

