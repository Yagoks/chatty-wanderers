# Chatty Wanderers

Gives life to tokens in Foundry VTT v13: patrol routes, vision cones, spotting and per-scene alert levels. Speech bubbles
come next.

## Patrol routes
- **Token HUD → route button** (GM) opens the route editor for that token.
- **Points are drawn by the module itself** on a GM-only overlay: no tiles, no drawings, invisible to players.
  - *Add points*, then left-click the map. Points snap to the grid.
  - Drag a point to move it; right-click a point to remove it.
- **The walked path is computed around walls** and shown between the points. A red dashed leg means there is no way
  through (a locked door, a closed room).
- **Doors:** closed, unlocked doors are opened by the patroller (and closed behind it, optional). Locked doors block.
- **Modes:** loop, back and forth, random points. Each point can have a wait (seconds).
- **One shared clock:** each tick, every patroller that has built up enough movement takes one square, and all steps go
  out in a single update. Speed comes from the creature's walking speed, times a per-token and a global multiplier.
- **Moving a patroller by hand:** while you hold it, it stays put. Dropped on one of its route points, it carries on from
  there; dropped anywhere else, it leaves the route and waits.
- **Global pause:** a walker button in the **Token controls** on the left (GM, only on scenes with patrols).
- Patrols stop during combat and while the game is paused. They run on the scene the active GM is viewing.
- Creatures can't share a square (dnd5e): a patroller waits for a blocker to move, then goes around.

Settings: clock (ms), global speed, show the route of a selected patroller.

## Vision cones
- Each patroller sees through a cone clipped by walls, facing the way it walks. Angle and range per token (route editor)
  with global defaults.
- Settings: show cones, players also see them, color and opacity.
- A target is seen when it is inside the cone, lit or within the patroller's darkvision, and not invisible (truesight
  and blindsight see through invisibility).

## Who is noticed
- Player characters, by default.
- Summons of the players follow a rule: Tiny/Small beasts blend in as local fauna (ignored), or always noticed, or
  always ignored. Other player-owned creatures (companions, mounts): noticed or ignored.
- **Token HUD → eye button** on any token: automatic, always noticed, always ignored.

## When someone is spotted
- The patroller stops and faces the target; the game can pause.
- The GM gets a card: **Standing** (DC = passive Perception), **Searching** (roll Perception, DC = result), or
  **False alarm**.
- The targets roll Stealth: each player from their own client (GM rolls on timeout), through Epic Rolls, or all by the
  GM. Anyone who fails is **discovered**: the patroller becomes *alerted*, the `chatty-wanderers.discovered` hook fires
  and an optional macro runs. Otherwise it carries on, and won't spot the same target again for a while.

## Scene alert
- Enable it from **Scene Configuration → Alert of this scene…**; afterwards a bell button in the **Token controls** on the left opens it (orange above level 0).
- **Setup:** title, levels (name and what happens), minutes of game time before offering to lower, minimum after an
  intrusion, manual reasons, signals that can be switched off, bell sound (path or Sequencer key), the Ambient Sound it
  rings from (position, radius, easing, walls) and a tile that swings.
- **Status:** current level, what each level means, +1 / −1 / reset, +1 at a point you click (where the noise was),
  who is reacting and how, signals and history.
- A patrol that discovers someone raises it (optional). Each raise rings the bell and whispers the GM the new level.
- After a quiet stretch of game time the GM gets a "Lower the alert" button; never below the minimum after an intrusion.
- API for traps, puzzles and macros: `game.modules.get("chatty-wanderers").api.alert.raise(scene, { source, reason })`,
  plus `lower`, `set`, `get`, `config`, `open`. Pass `origin` (a tile, token or `{x, y}`) so investigators know where
  to go. Hook: `chatty-wanderers.alertChanged` (scene, level, before, reason, opts).

## Reactions to the alert
In the token's window (Token HUD → route button), **On alert** lists the levels of the scene. For each one:
- **Usual behavior:** walks back to where it was and carries on (its route or its post).
- **Patrol another route:** joins the route at its closest point.
- **Go to a point:** set the point on the map; it stays there, or hides when it arrives (someone leaving the place).
- **Investigate the alarm:** walks to where the alarm came from (the `origin` of the raise, the point clicked on the
  panel, the spot of a discovered intruder, else the bell), looks around for some seconds and goes back.
- **Stop where it is.**
- Optional speed × for the reaction. A level left empty keeps the reaction of the level below.

Before its first reaction the token's usual state is saved; when the alert drops to a level without a reaction it walks
back and resumes. Points to go to show as red diamonds (A1, A2…) while the token is selected. Moving a reacting token
by hand makes it stay there. Tokens holding a post or following the alert also keep watch with their vision cone.
