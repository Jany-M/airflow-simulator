# 🌬️ Airflow Simulator

Interactive web app to **simulate natural cross-ventilation**. Draw rooms, place windows and doors, get live wind and weather conditions, watch particles flow, and find the optimal configuration that keeps air moving through the floorplan, lowering rooms temperature and humidity.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-shambinx-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/shambinx)

> How and why I built this: [From a Real Problem to a Working Web App](https://www.shambix.com/from-a-real-problem-to-a-working-web-app?utm_source=airflow-simulator&utm_medium=github)

**Live App:** [airflowsimulator.netlify.app](https://airflowsimulator.netlify.app/)

[![Netlify Status](https://api.netlify.com/api/v1/badges/ed135e10-b4bd-4683-ae2a-8d3e46ff95ac/deploy-status)](https://app.netlify.com/projects/airflowsimulator/deploys)


<img width="1120" height="480" alt="AirFlowSimulator" src="https://github.com/user-attachments/assets/ee6b8112-4a8f-450f-956d-bf93949c2353" />


## Features

- **Floor-plan editor** — grid rooms (1 cell = 0.5 m, plan 28×18 m), windows/doors on any wall, scale bar, W×L metre inputs, sample plan, erase/rename. Canvas frames the building with minimal padding. **Navigation:** click-drag empty canvas (outside rooms) to pan; middle-mouse or Space+drag anywhere; mouse wheel zoom; Shift+wheel pan; Ctrl/Cmd+0 resets; pinch-zoom and two-finger pan on touch. Room tool still draws on empty grid; other tools pan when not over a room or opening.
- **Select & edit** — short click any door/window to open (**green**) / close (**red**); long press (~0.2 s) to select (yellow ring), then drag the body to move along the wall or the **centre dot** to resize. Click a room to select; drag interior to move, drag a wall to resize. New windows default to 3 cells (1.5 m), doors to 2 cells (1 m). Collapsible **Tools Help** in Floorplan lists all gestures.
- **Live airflow** — pressure-network solver + wind particles; percentile heatmap; **hover any cell** for a live readout (airflow / temp / RH by view mode); per-opening inflow panel labelled by room and wall — click a row to select that opening on the plan. Animated wind arrows around the building on the live canvas.
- **Best configuration** — searches open/closed sets so wind reaches as many rooms as possible with **even cross-ventilation** (not one corridor or window hogging inflow); result persists until you edit the plan (synced with live solver metrics). Help (?) explains the objective.
- **Weather** — [Open-Meteo](https://open-meteo.com) via geolocation or manual town search (🔍 lens button beside **Use my current weather**; help (?) explains wrong-location on desktop tethering). Wind compass dial uses a visible grab-hand cursor on the dark UI.
- **Climate views** — Airflow / Temp / Humidity based on live location; outdoor air advects through inlets; Environment baselines customizable in a collapsible panel.
- **Sidebar** — **Floorplan** (center-view target, grid opacity, draw tools, **Tools Help**, selection) → **Simulation** (view mode, live toggle, optimizer, flux panel) → **Wind & weather** → **Environment** (collapsed) → **Save & export** (collapsed). Plan name row includes save (opens export) and reset-to-sample icons.
- **Export** — PNG (streamlines, markers, legend) and JSON backup under **Save & export** (plans autosave to `localStorage` and export/import as JSON).

<img width="1800" height="1300" alt="Sample_apartment_airflow" src="https://github.com/user-attachments/assets/21e86d50-83a9-45fb-b07b-c3efff17fbe8" />

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + dist/
npm run preview  # http://localhost:4173 (built dist)
```

## Tests

```bash
npm test               # build + unit (tsx) + e2e + interaction (static dist on :4173)
npm run test:unit      # solver, climate, resize-openings (imports from src/)
npm run test:e2e
npm run test:interaction
```

## Model & methods

This section describes the simulation and optimisation algorithms implemented in `src/sim/`. The app is designed for **interactive comparison of ventilation strategies**, not certified airflow prediction.

### Overview

The floor plan is treated as a **two-dimensional pressure network** on a staggered grid. Wind imposes fixed pressures on exterior openings; air flows from high-pressure (windward) to low-pressure (leeward) regions through open doors and windows. The approach belongs to the same *family* as multizone / airflow-network models used in building science (e.g. CONTAM, EnergyPlus Airflow Network), but uses **custom, simplified coefficients** tuned for real-time browser performance rather than calibrated engineering output.

The solver is **not** computational fluid dynamics (CFD): there is no Navier–Stokes integration, no turbulence model, and no third dimension.

### Geometry discretisation

| Parameter | Value |
|-----------|-------|
| Cell size | 0.5 m |
| Plan extent | 28 m × 18 m (56 × 36 cells) |
| Rooms | Axis-aligned rectangles of cells |
| Openings | Doors and windows on cell edges (`h` or `v` orientation) |

Interior cells that belong to any room are marked as *inside*. Adjacent inside cells are connected unless separated by a room boundary (wall). An **open** opening punches through that wall and assigns face conductance **scaled by opening span** (cells along the wall): base **1.0 × len** for doors, **0.9 × len** for windows. A **closed** opening leaves conductance at zero (impermeable wall).

### Wind boundary conditions

Wind is specified as meteorological direction (degrees, direction wind comes *from*) and speed (m/s). Each exterior opening face receives a **wind pressure coefficient** derived from the angle between the wind vector and the facade outward normal:

- **Windward** facades (facing the wind): positive coefficient, up to +0.8
- **Leeward** facades: negative coefficient, down to −0.4
- **Flank** facades: slight suction (−0.15)

These coefficients are **heuristic** — they reproduce the qualitative pattern of building aerodynamics (positive stagnation pressure windward, negative wake pressure leeward) but are not taken from a specific standard such as EN 1991-1-4 or ASHRAE tables.

Exterior openings act as **Dirichlet pressure boundaries** in the solve. Interior openings connect rooms without imposing an external pressure.

### Pressure-network solver

The steady incompressible potential-flow equation is solved on the cell network:

```math
\nabla \cdot (c \nabla p) = 0
```

where $p$ is relative pressure and $c$ is face conductance (zero at walls and closed openings). Interior cells are unknowns; exterior opening faces are fixed to their wind pressure coefficient.

**Method:** Gauss–Seidel iteration with over-relaxation ($\omega = 1.7$) and early exit on convergence. Iteration counts are defined in `src/sim/constants.ts`: **420** live, **200** optimizer what-if, **900** PNG export.

### Flow field and dead zones

Face velocity is proportional to conductance and the pressure difference across the face, scaled by wind speed for display:

```math
u \propto c \cdot \Delta p \cdot (6 \cdot v_{\text{wind}})
```

Cell-centred speed is the average of adjacent face velocities. This is analogous to **Darcy-type flow** through resistive edges rather than a full momentum equation.

A cell is classified as a **dead zone** when its speed falls below a threshold of 8 % of a reference breeze, scaled by wind speed. Dead zones are highlighted in the airflow heatmap. Per-opening inflow flux is accumulated to seed particle streams and climate inlet sources.

### Climate layer

Temperature and relative humidity are carried as scalar fields on the same grid. Each animation frame applies, in order:

1. **Semi-Lagrangian advection** along the airflow velocity field (wall-aware sampling)
2. **Inlet blending** toward outdoor conditions at cells adjacent to inflowing openings
3. **Speed-proportional air exchange** with outdoor air in moving regions
4. **Slow relaxation** toward an indoor baseline (thermal-mass metaphor)
5. **Diffusion** through open faces only

RH is mixed as a simple scalar, there is no psychrometric coupling, and temperature does not drive buoyancy-driven flow (no stack effect).

### Best-configuration optimiser

The optimiser searches over open/closed states of **unlocked** openings to maximise **distributed cross-ventilation** for the current wind direction. Locked openings are held fixed. It avoids recommending “wind tunnel” setups where one or two openings carry most of the inflow while other rooms stay stagnant.

#### Objective function

Each candidate configuration is evaluated by running the solver and computing a composite **score** (`scoreField` in `src/sim/solver.ts`) that prioritises:

| Term | Weight | Intent |
|------|--------|--------|
| Rooms reached | × 50 | Fraction of rooms where **≥ 28 %** of floor area exceeds the dead-zone threshold (was 12 % in 1.1.x) |
| Minimum room coverage | × 30 | Lifts the worst-performing room (weight increased from × 18) |
| Room balance | × 22 | Mean per-room coverage — avoids one well-ventilated room masking dead neighbours |
| Overall coverage | × 10 | Total ventilated floor area |
| Mean speed / total inflow | capped at 4 / 2 | Tie-breakers only — reduced so high throughput alone cannot win |
| Corridor concentration | − × 20 | Penalises high mean speed when few rooms are reached |
| Opening flux spread | − × 24 | Penalises lopsided inflow: $(f_\max - f_\min) / f_\max$ across active openings |
| Flux dominance | − × 35 | Penalises when one opening exceeds **~38 %** of total inflow |
| Number of active openings | − 0.2 each | Slight preference for simpler configurations |

#### Search strategy

| Free openings | Algorithm |
|---------------|-----------|
| ≤ 10 | **Exhaustive** enumeration of all $2^n$ combinations |
| > 10 | **Backward elimination** starting from all open, then **forward refinement** |

For larger plans, backward elimination is used because a greedy forward-only search cannot discover ventilation paths that require multiple openings to open together (e.g. a door *and* a window must both be open before a downstream room receives airflow). The algorithm closes openings one at a time as long as the score does not decrease, then re-opens any closed opening that strictly improves the result.

The objective and search strategy are **original**, they are not based on a published optimisation model. Results are qualitative recommendations for the displayed wind direction.

### Scope and limitations

**The model captures:**

- Cross-ventilation paths through a 2D floor plan
- Relative differences between opening configurations
- Which rooms receive airflow for a given wind direction and speed
- Stagnant (dead) zones

**The model does not capture:**

- Three-dimensional effects, room height, or volume
- Turbulence, inertia, or time-varying wind
- Stack effect / buoyancy (temperature does not affect airflow)
- Bernoulli orifice flow or discharge coefficients tied to opening area
- Absolute air-change rates or certified ventilation rates
- Full building energy or moisture physics

Use the simulator to **compare strategies and identify dead zones**, not to size openings or predict measured air speeds.

See [CHANGELOG.md](CHANGELOG.md) for release notes (current version **1.2.1**).
