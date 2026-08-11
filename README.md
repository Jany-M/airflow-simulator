# 🌬️ Airflow Simulator

Interactive web app to **simulate natural cross-ventilation** for an apartment or a floor of a house.
Draw your rooms, place windows and doors, set where the wind comes from — and watch live wind
particles flow through your floor plan. Find the opening configuration that keeps air *moving
through* rooms instead of dying inside them, then export a marked-up PNG of the best setup.

No backend, no database: plans autosave to browser `localStorage` and can be exported/imported
as JSON files.

## Features

- **Grid floor-plan editor** — drag to draw rooms (1 cell = 0.5 m), click walls to place windows
  and doors (doors also work on walls shared by two rooms), rename rooms, erase anything.
- **Wind dial** — drag the compass handle to set wind direction; adjust speed with the slider.
- **Move & resize** — long-press (~0.28 s) a room or an opening to drag it: rooms move around the
  plan and snap to nearby room walls (their exclusive openings travel with them); openings can be
  dropped onto any wall. With a room selected, drag one of its walls to resize from that side —
  the wall snaps to neighbouring rooms' walls, and openings on the dragged wall follow it.
  Positions that would overlap another room show a red ghost and are rejected (touching walls is
  how you attach rooms). A short click stays a click: select a room, toggle an opening.
- **Live airflow simulation** — a pressure-network / potential-flow solver assigns wind pressure
  to each facade opening (windward +, leeward −), solves the flow through the connected rooms,
  and animates wind particles riding the field in real time. Changes to walls, openings, wind
  direction or speed re-solve instantly.
- **Dead-zone detection** — floor areas with little airflow are tinted red so you can see where
  the breeze dies.
- **One-click open/close** — with the Select tool, clicking any window/door toggles it and the
  flow updates live. Lock (🔒) an opening to keep it as-is during optimization.
- **✨ Suggest best configuration** — searches open/closed combinations (exhaustive up to 10
  free openings, backward-elimination + refinement beyond that) and applies the configuration
  that maximizes ventilated floor area.
- **📍 Use my current weather** — one click gets your position (browser Geolocation API, high
  accuracy) and pulls live wind speed/direction, temperature and humidity from
  [Open-Meteo](https://open-meteo.com) (free, open-source-friendly, no API key), then applies
  them to the simulation. Requires HTTPS (or localhost) for geolocation.
- **Manual location** — desktop browsers without GPS fall back to IP-based positioning, which
  can land in the wrong city (especially on tethered/mobile connections). Search your town in
  the Wind section (Open-Meteo geocoding, free, no key) and it's pinned for all future weather
  fetches — with one click to go back to automatic.
- **🌡️💧 Indoor climate mapping** — every cell of every room carries temperature and humidity.
  Outdoor air advects in through inlet openings and rides the airflow: ventilated rooms visibly
  drift toward outdoor conditions while dead zones stay stale near the indoor baseline. Switch
  between Airflow / Temperature / Humidity views; climate views show a colormap, per-room
  average readouts, and a legend. Outdoor & indoor baseline temp/RH are adjustable sliders.
- **PNG export** — high-res image with airflow streamline arrows, open (✓) / keep-shut (✕)
  markers, dead zones, wind rose and legend.
- **JSON export/import** — back up or share floor plans as plain files.
- **Sample plan & new plan** — start from a furnished sample apartment or a blank grid; rename the
  plan inline in the sidebar.
- **Live simulation toggle** — pause or resume the particle animation and climate evolution without
  changing the solved flow field.

## Run locally

```bash
npm install
npm run dev      # dev server with hot reload
npm run build    # type-check + production build into dist/
npm run preview  # serve the production build
```

You can also just open `dist/index.html` directly in a browser — the build is fully static and path-relative.

## Deploy (free static hosting)

The app is a pure static bundle — no server code, no database.

**Netlify:** connect the repo (or drag-and-drop the `dist/` folder). Build command
`npm run build`, publish directory `dist`. A `netlify.toml` with these settings is included.

**Render:** create a *Static Site*, build command `npm run build`, publish directory `dist`.

**GitHub Pages / any static host:** upload the contents of `dist/`.

## Architecture (for extending)

```
src/
  model/types.ts       data model: rooms, openings (on cell edges), wind, env — 1 cell = 0.5 m (28×18 m plan)
  model/store.ts       zustand store, localStorage autosave, JSON import/export
  model/geometry.ts    move/resize/snap helpers, overlap checks, opening validation
  model/samples.ts     sample apartment + empty plan
  sim/solver.ts        grid rasterizer + pressure solve (Gauss–Seidel) + velocity field + scoring
  sim/particles.ts     wind particle system for the live visualization
  sim/climate.ts       per-cell temperature/humidity: advection + inlet sources + exchange
  sim/optimizer.ts     best-configuration search (async, cancellable, progress-reporting)
  services/weather.ts  geolocation + Open-Meteo weather fetch + manual location search/persist
  ui/render.ts         shared canvas drawing (editor AND export use the same code)
  ui/EditorCanvas.tsx  interactive canvas: draw/select/toggle/move/resize + animation loop
  ui/Sidebar.tsx       tools, environment sliders, simulation & plan controls
  ui/WindDial.tsx      draggable compass for wind direction
  export/exportImage.ts  2×-resolution PNG export with streamlines and legend
test/e2e.mjs           headless Playwright smoke test (build first, then: node test/e2e.mjs)
```

Ideas that slot in cleanly: multiple saved plans, opening sizes/partial opening, temperature-driven
stack effect, non-rectangular rooms (the solver already works per-cell), a wind-rose sweep that
scores a configuration across all wind directions.

## Simulation notes (and limits)

The solver is a 2-D steady-state approximation, not CFD: facade openings get wind-pressure
coefficients based on their orientation to the wind, interior flow follows the pressure gradient
through open doors/windows, and walls block flow. It captures which openings create through-flow
and where air stagnates — good for comparing configurations, not for absolute air-speed numbers.

The climate layer is a comfort visualisation, not building physics: temperature and relative
humidity are advected as simple scalars (semi-Lagrangian along the flow field), refreshed by
outdoor air proportionally to local airflow, and slowly pulled back toward the indoor baseline
(standing in for thermal mass and internal moisture sources). No psychrometrics, solar gains, or
vertical stratification — it shows *which rooms the breeze actually freshens*, which is the
question the app answers.
