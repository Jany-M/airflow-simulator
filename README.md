# 🌬️ Airflow Simulator

Interactive web app to **simulate natural cross-ventilation**. Draw rooms, place windows and doors, get live wind and weather conditions, watch particles flow, and find the optmimal configuration that keeps air moving through the floorplan, lowering rooms temperature and humidity.

Static app — no backend. Plans autosave to `localStorage` and export/import as JSON.

**Live:** [airflowsimulator.netlify.app](https://airflowsimulator.netlify.app/)

[![Netlify Status](https://api.netlify.com/api/v1/badges/ed135e10-b4bd-4683-ae2a-8d3e46ff95ac/deploy-status)](https://app.netlify.com/projects/airflowsimulator/deploys)

<img width="1120" height="480" alt="AirFlowSimulator" src="https://github.com/user-attachments/assets/ee6b8112-4a8f-450f-956d-bf93949c2353" />


## Features

- **Floor-plan editor** — grid rooms (1 cell = 0.5 m, plan 28×18 m), windows/doors on any wall, scale bar, W×L metre inputs, sample plan, erase/rename. Canvas frames and centers the building with minimal padding (scales with the window); on mobile also pinch-zoom / two-finger pan (Ctrl/Cmd+0 resets; mouse wheel zooms).
- **Select & edit** — click room to select (yellow); drag interior to move, drag wall to resize. Click opening to open (**green**) / close (**red**); hold ~0.2 s to select (yellow ring) and drag along walls.
- **Live airflow** — pressure-network solver + wind particles; dead zones tinted red.
- **Best configuration** — searches open/closed sets so wind reaches as many rooms as possible (distributed cross-ventilation for the current wind).
- **Weather** — [Open-Meteo](https://open-meteo.com) via geolocation or town search.
- **Climate views** — Airflow / Temp / Humidity based on live location; outdoor air advects through inlets; Environment baselines customizable in a collapsible panel.
- **Sidebar** — Simulation → Wind & weather → Environment (collapsed) → Floorplan (collapsed) → Save & export.
- **Export** — PNG (streamlines, markers, legend) and JSON backup under **Save & export**.

![AirFlow Simulator Export](public/Sample_apartment_airflow.png)

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + dist/
npm run preview
```

Fully static — open `dist/index.html` directly, or host `dist/` (Netlify: build `npm run build`, publish `dist`; `netlify.toml` included).

## Limits

2-D steady potential-flow approx (not CFD) — compares configurations and stagnant zones, not absolute air speeds. Climate is a comfort visualisation (advected scalars), not full building physics.
