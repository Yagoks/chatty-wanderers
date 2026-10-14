# Chatty Wanderers

Gives life to tokens in Foundry VTT v13. **Stage 1: patrol routes.** Vision cones, spotting, alert levels and speech
bubbles come next.

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
- **Global pause:** a button next to the chat controls (GM, only on scenes with patrols).
- Patrols stop during combat and while the game is paused. They run on the scene the active GM is viewing.
- Creatures can't share a square (dnd5e): a patroller waits for a blocker to move, then goes around.

Settings: clock (ms), global speed, show the route of a selected patroller.
