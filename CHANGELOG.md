# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.1] - 2026-08-29

### Added

- **Hover cell probe** — while live simulation runs, hover any room cell to see a tooltip beside the cursor: airflow speed (Airflow view), °C (Temp), or % RH (Humidity); updates with wind and plan changes
- **Tools Help** — collapsible interaction guide in the Floorplan panel (short/long click, drag, pan/zoom)
- Drawn grab-hand cursor on the wind compass dial (OS cursor hidden on dark background, same approach as empty-canvas pan)
- Animated ambient wind arrows on the live canvas (sliding/fading; PNG export stays static)
- Unit test `test/resize-openings.mjs` — openings stay on walls when resizing north/south/east edges

### Changed

- **Opening interaction** — short click anywhere on a door/window toggles open/closed; long press (~0.2 s) selects; drag body (when selected) moves along the wall; drag centre dot (when selected) resizes width
- Ambient wind arrows sit farther from the building centre (auto-shrink on tight canvases)

### Fixed

- Short click on the opening centre marker selected instead of toggling open/closed
- Resizing a room on the **north** or **south** wall removed horizontal windows/doors on that wall (horizontal E/W resize was unaffected)

## [1.2.0] - 2026-08-29

### Added

- Optimizer result message persisted in store until the user edits the plan; metrics synced with live solver (420 iter)
- Per-opening inflow flux panel with **room · wall** labels; click a row to select that opening on the canvas
- Numeric wind direction input (0–359°) alongside the compass dial
- Configurable door/window width in the selection panel (range slider)
- Plan boundary outline and adjustable grid opacity (in Floorplan panel)
- Center-view control (target icon) to shift the floorplan on the grid without resizing rooms
- Plan name row: save icon (opens Save & export) and reset-to-sample icon (clears browser autosave)
- Canvas panning: middle-mouse drag, Space+drag, empty-canvas drag (Select), Shift+wheel; grab cursor on empty canvas; improved two-finger pan on touch
- Wind & weather: help (?) for wrong location on desktop tethering; 🔍 lens button toggles town/city search with inline Find
- Unit tests (`npm test`) for solver, climate, e2e, and interaction flows
- Shared solver iteration constants and flow display helpers

### Changed

- **Optimizer scoring retuned** for even cross-ventilation instead of short-circuit wind tunnels:
  - Room “reached” threshold **12 % → 28 %** of floor area above dead-zone speed
  - Worst-room weight **× 18 → × 30**; mean-speed / total-inflow tie-break caps reduced
  - New penalties for **opening flux spread** (− × 24) and **flux dominance** when one opening exceeds ~38 % of inflow (− × 35)
  - Unit test in `test/solver.mjs` verifies optimizer beats a wind-tunnel config on the sample plan
- Opening conductance scales with span length (wider openings carry more flow)
- Airflow heatmap uses percentile normalization for better contrast
- Particle advection is wall-aware; particles reset on field change
- Default window placement width is 3 cells (1.5 m); doors remain 2 cells
- Overlapping rooms rejected on create/import; legacy overlapping saves warn on load
- PNG export and editor share heatmap normalization
- Desktop: room measure controls only in sidebar; mobile: canvas overlay only
- Sidebar order: **Floorplan** above **Simulation**; Save & export collapsed like Environment
- Live simulation toggle inline with Simulation heading
- Optimizer explanation moved to a help (?) popover (mentions even cross-ventilation)

### Fixed

- Stale optimizer UI vs live score line (async solve race)
- Particles and PNG streamlines passing through walls
- Opening max-width calculation on walls with neighbouring openings (`openingWallSpan`)
- E2e/interaction tests use built dist and editor-aware click coordinates

## [1.1.0] - initial release

Baseline interactive natural cross-ventilation simulator with floor-plan editor, live solver, optimizer, climate views, weather integration, and PNG/JSON export.
