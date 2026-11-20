# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Game

Open `index.html` directly in a browser — no build step required. For local HTTPS (required for gyroscope on iOS), serve via a simple HTTP server:

```bash
# Python 3
python -m http.server 8000

# Node.js (npx)
npx serve .
```

Then open `http://localhost:8000`.

## Architecture

### File Structure
- `index.html` — Entry point with start screen UI, loads all scripts
- `game.js` — Main entry: game config, state machine, input handling, render callbacks
- `sensor.js` — `SensorInput` class wrapping DeviceOrientation/DeviceMotion with low-pass filtering and shake detection
- `particles.js` — 7 particle emitters (glow, trail, spark, collect, explode, shockwave, stardust)
- `littlejs.js` — LittleJS engine v1.18.0 (local copy, no CDN)
- `levels/` — Level data as string arrays

### State Machine
```
splash → calibrate → play → levelcomplete → win
                        ↘ gameover
```

### Tile Map System
Maps are string arrays where each character is a tile (`tileSize = 1` world unit):
- `'0'` = path, `'1'` = wall, `'2'` = crystal, `'3'` = hazard, `'4'` = exit, `'5'` = player start

Collision tests the ball against nearby wall tiles, resolving each movement axis separately.

### Rendering & Coordinate Systems
- World coordinates — game objects, camera, tiles
- Screen coordinates — HUD, text overlays via `drawTextScreen()`
- Camera: `cameraPos` (world), `cameraScale fits the maze on desktop and follows the ball on mobile`

## LittleJS API Notes

| Need | Correct API |
|------|-------------|
| Mouse/touch press | `mouseWasPressed(0)` |
| Spacebar press | `keyWasPressed('Space')` |
| Screen text | `drawTextScreen(text, vec2(pixelsX, pixelsY), size, color)` |
| Screen pixel size | `mainCanvas.width / mainCanvas.height` |
| Engine config | Set **before** `engineInit()` — `canvasMaxSize`, `showSplashScreen`, `touchGamepadEnable`, etc. |
| Random sign | Use `randSign()` (engine global), avoid naming conflicts |

## Ball Physics Pattern

`Ball.updatePhysics()` is overridden to be empty. The Ball manages its own physics in `update()` (velocity, damping, axis-separated collision) to prevent LittleJS from double-displacing it:

```javascript
// In Ball class
updatePhysics() {} // Empty — prevents engine double-displacement

update() {
    // Manual: apply acceleration → damping → velocity cap → axis-separated collision
    // Then manual position update
}
```

## Input Priority

1. Dragging takes over steering while a finger is down
2. Gyroscope (mobile) via `SensorInput.getTiltVector()`
3. Keyboard (WASD / Arrow keys for movement, Space for shockwave)

Sensor availability: `SensorInput.isAvailable()` — returns false if not HTTPS and not localhost.

## Performance

- Particle budget: 1500 per frame (`CONFIG.particleBudget`)
- Low-power mode triggers after 3 consecutive frames < 30fps — reduces trail/glow intervals
- Mobile-specific intervals in `CONFIG.mobileTrailInterval` / `mobileGlowInterval`
- Static maze walls are baked into one CanvasLayer per level. LittleJS handles object and particle rendering.

## Adding a New Level

1. Create `levels/levelN.js` exporting `LEVEL_N` with `{ name, width, height, map, crystals, hazards }`
2. Add to `LEVELS` array in `game.js`
3. Map specs: tile size 1, `map` is string array matching `height` rows of `width` chars each
