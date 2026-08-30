import { useRef, useState, useEffect } from 'react';
import { useApp, exportPlanJSON, importPlanJSON } from '../model/store';
import { Tool, ViewMode, CELL_METERS } from '../model/types';
import { openingWallSpan } from '../model/geometry';
import { optimize } from '../sim/optimizer';
import { solve, scoreField } from '../sim/solver';
import { SOLVE_ITER_LIVE } from '../sim/constants';
import { exportPNG } from '../export/exportImage';
import { dirName } from '../lib/format';
import {
  fetchLocalWeather, fetchWeatherAt, searchPlaces,
  loadSavedLocation, saveLocation, GeoPlace, LocalWeather,
} from '../services/weather';
import WindDial from './WindDial';
import RoomMeasureBox from './RoomMeasureBox';

const TOOLS: Array<{ id: Tool; label: string; icon: string; hint: string }> = [
  { id: 'select', label: 'Select', icon: '⇱', hint: 'Select tool — expand Tools Help below' },
  { id: 'room', label: 'Room', icon: '▭', hint: 'Drag on the grid to draw a room' },
  { id: 'window', label: 'Window', icon: '◫', hint: 'Move near a wall, then click to place a window' },
  { id: 'door', label: 'Door', icon: '⎡⎦', hint: 'Move near a wall, then click to place a door' },
  { id: 'erase', label: 'Erase', icon: '✕', hint: 'Click a room or opening to delete it' },
];

function SelectToolLegend() {
  return (
    <div className="tool-legend" aria-label="Select tool interactions">
      <p className="tool-legend-heading">Doors &amp; windows</p>
      <ul>
        <li><b>Short click</b> — open <span className="legend-open">green</span> / close <span className="legend-closed">red</span></li>
        <li><b>Long press</b> (~0.2 s) — select <span className="legend-selected">yellow ring</span></li>
        <li><b>Drag body</b> (when selected) — move along wall</li>
        <li><b>Drag centre dot</b> (when selected) — resize width</li>
      </ul>
      <p className="tool-legend-heading">Rooms</p>
      <ul>
        <li><b>Click</b> — select</li>
        <li><b>Drag inside</b> — move room</li>
        <li><b>Drag wall edge</b> — resize room</li>
      </ul>
      <p className="tool-legend-heading">Canvas</p>
      <ul>
        <li><b>Drag empty area</b> — pan view</li>
        <li><b>Scroll / pinch</b> — zoom</li>
      </ul>
    </div>
  );
}

export default function Sidebar() {
  const plan = useApp(s => s.plan);
  const tool = useApp(s => s.tool);
  const setTool = useApp(s => s.setTool);
  const selectedId = useApp(s => s.selectedId);
  const optimizing = useApp(s => s.optimizing);
  const optProgress = useApp(s => s.optProgress);
  const scoreLabel = useApp(s => s.lastScoreLabel);
  const lastOptResult = useApp(s => s.lastOptResult);
  const lastFlowStats = useApp(s => s.lastFlowStats);
  const gridOpacity = useApp(s => s.gridOpacity);
  const simRunning = useApp(s => s.simRunning);
  const viewMode = useApp(s => s.viewMode);
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [weatherMsg, setWeatherMsg] = useState<string | null>(null);
  const [savedLoc, setSavedLoc] = useState<GeoPlace | null>(() => loadSavedLocation());
  const [locQuery, setLocQuery] = useState('');
  const [locResults, setLocResults] = useState<GeoPlace[]>([]);
  const [locSearching, setLocSearching] = useState(false);
  const [locSearchOpen, setLocSearchOpen] = useState(false);
  const [locHelpOpen, setLocHelpOpen] = useState(false);
  const [optHelpOpen, setOptHelpOpen] = useState(false);
  const optHelpRef = useRef<HTMLDivElement>(null);
  const locHelpRef = useRef<HTMLDivElement>(null);
  const locSearchInputRef = useRef<HTMLInputElement>(null);
  const floorplanRef = useRef<HTMLDetailsElement>(null);
  const saveExportRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!optHelpOpen) return;
    const close = (e: MouseEvent) => {
      if (optHelpRef.current && !optHelpRef.current.contains(e.target as Node)) {
        setOptHelpOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [optHelpOpen]);

  useEffect(() => {
    if (!locHelpOpen) return;
    const close = (e: MouseEvent) => {
      if (locHelpRef.current && !locHelpRef.current.contains(e.target as Node)) {
        setLocHelpOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [locHelpOpen]);

  useEffect(() => {
    if (locSearchOpen) locSearchInputRef.current?.focus();
  }, [locSearchOpen]);

  useEffect(() => {
    if (selectedId && floorplanRef.current) {
      floorplanRef.current.open = true;
    }
  }, [selectedId]);

  const applyWeather = (w: LocalWeather) => {
    const st = useApp.getState();
    st.setWind({ fromDeg: w.windFromDeg, speed: Math.min(Math.max(w.windSpeed, 0.5), 10) });
    st.setEnv({ outdoorTemp: w.temperature, outdoorRH: w.humidity });
    setWeatherMsg(
      `Now at ${w.place ?? 'your location'}: wind ${w.windSpeed.toFixed(1)} m/s from ${dirName(w.windFromDeg)}, ` +
      `${w.temperature.toFixed(1)} °C, ${w.humidity.toFixed(0)}% RH — applied ✓ (data: Open-Meteo)`,
    );
  };

  const getWeather = async () => {
    setWeatherBusy(true);
    setWeatherMsg(null);
    try {
      // A manually set location beats browser geolocation (which can land in
      // the wrong city on desktops with tethered/mobile connections).
      applyWeather(savedLoc
        ? await fetchWeatherAt(savedLoc.latitude, savedLoc.longitude, savedLoc.label)
        : await fetchLocalWeather());
    } catch (e) {
      setWeatherMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setWeatherBusy(false);
    }
  };

  const doLocSearch = async () => {
    const q = locQuery.trim();
    if (!q) return;
    setLocSearching(true);
    try {
      const results = await searchPlaces(q);
      setLocResults(results);
      if (results.length === 0) setWeatherMsg(`No places found for “${q}”.`);
    } catch (e) {
      setWeatherMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLocSearching(false);
    }
  };

  const pickPlace = async (p: GeoPlace) => {
    saveLocation(p);
    setSavedLoc(p);
    setLocResults([]);
    setLocQuery('');
    setLocSearchOpen(false);
    setWeatherBusy(true);
    try {
      applyWeather(await fetchWeatherAt(p.latitude, p.longitude, p.label));
    } catch (e) {
      setWeatherMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setWeatherBusy(false);
    }
  };

  const clearPlace = () => {
    saveLocation(null);
    setSavedLoc(null);
    setWeatherMsg('Back to automatic geolocation.');
  };

  const selRoom = plan.rooms.find(r => r.id === selectedId) ?? null;
  const selOpening = plan.openings.find(o => o.id === selectedId) ?? null;
  const openingMaxLen = selOpening ? openingWallSpan(plan, selOpening) : 1;

  const envEqual = plan.env.outdoorTemp === plan.env.indoorTemp
    && plan.env.outdoorRH === plan.env.indoorRH;

  const runOptimizer = async () => {
    const st = useApp.getState();
    st.setLastOptResult(null);
    if (st.plan.openings.length === 0 || st.plan.rooms.length === 0) {
      st.setLastOptResult('Add rooms and some windows/doors first.');
      return;
    }
    cancelRef.current = false;
    st.setOptimizing(true, { done: 0, total: 1 });
    try {
      const best = await optimize(
        st.plan,
        p => useApp.getState().setOptimizing(true, { done: p.done, total: p.total }),
        () => cancelRef.current,
      );
      if (best) {
        st.applyOpenSet(best.openIds);
        const planNow = useApp.getState().plan;
        const t0 = performance.now();
        const f = solve(planNow, { iterations: SOLVE_ITER_LIVE });
        const sc = scoreField(f, planNow.wind.speed, planNow.rooms);
        const solveMs = performance.now() - t0;
        st.publishFlowResults(f, sc, solveMs);
        const locked = planNow.openings.filter(o => o.locked).length;
        const lockedNote = locked ? ` · ${locked} locked kept fixed` : '';
        const roomsPct = sc.roomsReached != null
          ? ` · ${(sc.roomsReached * 100).toFixed(0)}% of rooms reached`
          : '';
        st.setLastOptResult(
          `Best distributed flow: ${best.openIds.length} opening(s) open → ${(sc.coverage * 100).toFixed(0)}% floor ventilated${roomsPct}${lockedNote}. Applied ✓`,
        );
      } else {
        st.setLastOptResult('No configuration found — add some openings (or unlock more).');
      }
    } finally {
      useApp.getState().setOptimizing(false);
    }
  };

  const onImport = async (f: File | null) => {
    if (!f) return;
    try {
      const p = await importPlanJSON(f);
      const st = useApp.getState();
      st.loadPlan(p);
      const label = (p.name || 'Untitled').trim() || 'Untitled';
      st.flashCanvasToast(`Plan “${label}” loaded`);
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const activeTool = TOOLS.find(t => t.id === tool);

  const openSaveExport = () => {
    useApp.getState().setMobilePanelOpen(true);
    requestAnimationFrame(() => {
      const el = saveExportRef.current;
      if (!el) return;
      el.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const resetPlan = () => {
    if (!confirm('Reset to the sample apartment? Your autosaved floorplan in this browser will be cleared.')) return;
    useApp.getState().resetPlanToSample();
  };

  return (
    <aside className="sidebar" id="app-sidebar">
      <header className="app-title">
        <div className="logo">🌬️</div>
        <div>
          <div className="app-title-row">
            <h1>Airflow Simulator</h1>
            <a
              className="github-link"
              href="https://github.com/Jany-M/airflow-simulator"
              target="_blank"
              rel="noopener noreferrer"
              title="View on GitHub"
              aria-label="View on GitHub"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
                />
              </svg>
            </a>
          </div>
          <p>natural cross-ventilation simulator</p>
          <p className="app-credit">
            by{' '}
            <a href="https://www.shambix.com??utm_source=airflow-simulator&utm_medium=referral&utm_campaign=projects&utm_content=app-sidebar" target="_blank" title="Custom web and mobile apps development">
              Jany Martelli
            </a>
          </p>
        </div>
      </header>

      <div className="sidebar-sheet-handle mobile-only" aria-hidden />

      <div className="plan-name-row">
        <input
          className="plan-name"
          value={plan.name}
          onChange={e => useApp.getState().setPlanName(e.target.value)}
          placeholder="Plan name"
        />
        <button
          type="button"
          className="btn icon-btn"
          title="Save & export floorplan"
          aria-label="Save and export floorplan"
          onClick={openSaveExport}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3-9H5V5h10v3z" />
          </svg>
        </button>
        <button
          type="button"
          className="btn icon-btn"
          title="Reset to sample apartment (clears browser autosave)"
          aria-label="Reset to sample apartment"
          onClick={resetPlan}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M20 9A8 8 0 0 0 7 5.3M4 15a8 8 0 0 0 13 3.7" />
          </svg>
        </button>
      </div>

      <details className="fold" ref={floorplanRef}>
        <summary>
          <span className="fold-label">Floorplan</span>
          <span className="fold-meta">
            {selRoom
              ? selRoom.name
              : selOpening
                ? `${selOpening.kind === 'window' ? 'Window' : 'Door'} · ${selOpening.open ? 'open' : 'closed'}`
                : `${activeTool?.icon} ${activeTool?.label}`}
          </span>
          <span className="fold-chevron" aria-hidden>▸</span>
        </summary>
        <div className="fold-body">
          <div className="plan-view-row">
            <button
              type="button"
              className="btn icon-btn"
              title="Center floorplan in view"
              aria-label="Center floorplan in view"
              onClick={() => useApp.getState().recenterPlan()}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.75" />
                <circle cx="12" cy="12" r="1.75" fill="currentColor" />
                <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
              </svg>
            </button>
            <div className="env-slider">
              <div className="env-label">
                <span>Grid opacity</span>
                <b>{Math.round(gridOpacity * 100)}%</b>
              </div>
              <input
                type="range"
                min={0.02}
                max={0.35}
                step={0.01}
                value={gridOpacity}
                onChange={e => useApp.getState().setGridOpacity(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="tool-grid">
            {TOOLS.map(t => (
              <button
                key={t.id}
                type="button"
                className={`tool-btn ${tool === t.id ? 'active' : ''}`}
                onClick={() => setTool(t.id)}
                title={t.hint}
              >
                <span className="tool-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
          {tool !== 'select' && <p className="hint">{activeTool?.hint}</p>}
          <details className="fold tool-help-fold">
            <summary>
              <span className="fold-label">Tools Help</span>
              <span className="fold-chevron" aria-hidden>▸</span>
            </summary>
            <div className="fold-body">
              <SelectToolLegend />
            </div>
          </details>
          {(selRoom || selOpening) && (
            <div className="selection">
              <p className="flux-title">Selection</p>
              {selRoom && (
                <>
                  <input
                    value={selRoom.name}
                    onChange={e => useApp.getState().renameRoom(selRoom.id, e.target.value)}
                    aria-label="Room name"
                  />
                  <div className="selection-measure">
                    <RoomMeasureBox embedded />
                  </div>
                  <button type="button" className="btn danger" onClick={() => { useApp.getState().deleteRoom(selRoom.id); useApp.getState().setSelected(null); }}>
                    Delete room
                  </button>
                </>
              )}
              {selOpening && (
                <>
                  <p className="sel-info">
                    {selOpening.kind === 'window' ? 'Window' : 'Door'} · {selOpening.open ? 'open' : 'closed'}
                    {selOpening.locked ? ' · locked' : ''}
                  </p>
                  <div className="env-slider">
                    <div className="env-label">
                      <span>Width (cells)</span>
                      <b>{selOpening.len} / {openingMaxLen}</b>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={Math.max(1, openingMaxLen)}
                      step={1}
                      value={Math.min(selOpening.len, openingMaxLen)}
                      aria-label="Opening width (cells)"
                      onChange={e => useApp.getState().setOpeningLen(selOpening.id, Number(e.target.value))}
                    />
                  </div>
                  <p className="hint">Width: drag the <b>centre dot</b> on the plan, or use the slider above. Move: drag elsewhere on the fixture.</p>
                  <div className="btn-row">
                    <button type="button" className="btn" onClick={() => useApp.getState().toggleOpening(selOpening.id)}>
                      {selOpening.open ? 'Close it' : 'Open it'}
                    </button>
                    <button type="button" className="btn" title="Locked openings keep their state during optimization"
                      onClick={() => useApp.getState().toggleLock(selOpening.id)}>
                      {selOpening.locked ? '🔓 Unlock' : '🔒 Lock'}
                    </button>
                    <button type="button" className="btn danger" onClick={() => { useApp.getState().deleteOpening(selOpening.id); useApp.getState().setSelected(null); }}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </details>

      <section>
        <div className="section-head">
          <h2>Simulation</h2>
          <label className="row-check row-check-inline">
            <input
              type="checkbox"
              checked={simRunning}
              onChange={e => useApp.getState().setSimRunning(e.target.checked)}
            />
            Live
          </label>
        </div>
        <div className="seg">
          {(['flow', 'temp', 'rh'] as ViewMode[]).map(m => (
            <button key={m}
              type="button"
              className={`seg-btn ${viewMode === m ? 'active' : ''}`}
              onClick={() => useApp.getState().setViewMode(m)}>
              {m === 'flow' ? '💨 Airflow' : m === 'temp' ? '🌡️ Temp' : '💧 Humidity'}
            </button>
          ))}
        </div>
        <div className="btn-with-help">
          <button type="button" className="btn primary" onClick={runOptimizer} disabled={optimizing}>
            {optimizing
              ? `Searching… ${optProgress ? Math.round((optProgress.done / Math.max(optProgress.total, 1)) * 100) : 0}%`
              : '✨ Find best configuration'}
          </button>
          <div className="help-wrap" ref={optHelpRef}>
            <button
              type="button"
              className="help-btn"
              aria-label="How best configuration works"
              aria-expanded={optHelpOpen}
              onClick={() => setOptHelpOpen(o => !o)}
            >
              ?
            </button>
            {optHelpOpen && (
              <div className="help-popover" role="tooltip">
                Finds open/closed doors &amp; windows for the <b>current wind and floor plan</b> so air reaches as many rooms as possible with <b>even cross-ventilation</b> — not a strong breeze trapped in one corridor or one window hogging inflow. Re-run after changing wind or the plan. Temp/humidity don&rsquo;t affect this. Lock openings to keep them fixed.
              </div>
            )}
          </div>
        </div>
        {optimizing && (
          <button type="button" className="btn" onClick={() => { cancelRef.current = true; }}>Cancel</button>
        )}
        {lastOptResult && <p className="opt-result">{lastOptResult}</p>}
        {scoreLabel && <p className="score">{scoreLabel}</p>}
        {lastFlowStats && lastFlowStats.topOpenings.length > 0 && (
          <div className="flux-panel">
            <p className="flux-title">Top opening inflow</p>
            <p className="hint flux-hint">Click a row to select it on the plan.</p>
            <ul className="flux-list">
              {lastFlowStats.topOpenings.map(o => (
                <li key={o.id}>
                  <button
                    type="button"
                    className={`flux-item${selectedId === o.id ? ' selected' : ''}`}
                    title="Select on canvas"
                    onClick={() => {
                      const st = useApp.getState();
                      st.setTool('select');
                      st.setSelected(o.id);
                    }}
                  >
                    <span>{o.label}</span>
                    <span>{o.flux.toFixed(3)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Wind &amp; weather</h2>
          <div className="help-wrap" ref={locHelpRef}>
            <button
              type="button"
              className="help-btn help-btn-sm"
              aria-label="About location and manual search"
              aria-expanded={locHelpOpen}
              onClick={() => setLocHelpOpen(o => !o)}
            >
              ?
            </button>
            {locHelpOpen && (
              <div className="help-popover help-popover-left" role="tooltip">
                Wrong location? (Common on desktops using a phone connection.) Find and set your town manually with the lens button.
              </div>
            )}
          </div>
        </div>
        <WindDial />
        <div className="weather-actions">
          <button type="button" className="btn wide weather-loc-btn" onClick={getWeather} disabled={weatherBusy}>
            {weatherBusy ? 'Fetching your weather…' : '📍 Use my current weather'}
          </button>
          <button
            type="button"
            className={`btn icon-btn${locSearchOpen ? ' active' : ''}`}
            title="Search town / city manually"
            aria-label="Search town / city manually"
            aria-expanded={locSearchOpen}
            onClick={() => setLocSearchOpen(o => !o)}
          >
            🔍
          </button>
        </div>
        {weatherMsg && <p className="hint weather-msg">{weatherMsg}</p>}
        {savedLoc && (
          <p className="hint">
            📌 Location set to <b>{savedLoc.label}</b>{' '}
            <button type="button" className="linkish" onClick={clearPlace}>use auto instead</button>
          </p>
        )}
        {locSearchOpen && (
          <div className="loc-search-field">
            <input
              ref={locSearchInputRef}
              value={locQuery}
              placeholder="Search town / city…"
              onChange={e => setLocQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') doLocSearch(); }}
            />
            <button
              type="button"
              className="loc-search-find"
              onClick={doLocSearch}
              disabled={locSearching || !locQuery.trim()}
            >
              {locSearching ? '…' : 'Find'}
            </button>
          </div>
        )}
        {locSearchOpen && locResults.map((r, i) => (
          <button key={i} type="button" className="loc-result" onClick={() => pickPlace(r)}>{r.label}</button>
        ))}
      </section>

      <details className="fold">
        <summary>
          <span className="fold-label">Environment</span>
          <span className="fold-chevron" aria-hidden>▸</span>
        </summary>
        <div className="fold-body">
          <EnvSlider label="Outdoor temp" value={plan.env.outdoorTemp} min={-10} max={45} step={0.5} unit="°C"
            onChange={v => useApp.getState().setEnv({ outdoorTemp: v })} />
          <EnvSlider label="Outdoor humidity" value={plan.env.outdoorRH} min={0} max={100} step={1} unit="%"
            onChange={v => useApp.getState().setEnv({ outdoorRH: v })} />
          <EnvSlider label="Indoor baseline temp" value={plan.env.indoorTemp} min={-10} max={45} step={0.5} unit="°C"
            onChange={v => useApp.getState().setEnv({ indoorTemp: v })} />
          <EnvSlider label="Indoor baseline humidity" value={plan.env.indoorRH} min={0} max={100} step={1} unit="%"
            onChange={v => useApp.getState().setEnv({ indoorRH: v })} />
          {envEqual && (
            <p className="hint">Outdoor and indoor baselines match — climate view stays nearly uniform until you change temp or humidity.</p>
          )}
          <p className="hint">Rooms with airflow drift toward outdoor conditions; stagnant rooms stay near the indoor baseline.</p>
        </div>
      </details>

      <details className="fold" ref={saveExportRef}>
        <summary>
          <span className="fold-label">Save &amp; export</span>
          <span className="fold-chevron" aria-hidden>▸</span>
        </summary>
        <div className="fold-body">
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => exportPNG(useApp.getState().plan)}>🖼️ Export PNG</button>
            <button type="button" className="btn" onClick={() => exportPlanJSON(useApp.getState().plan)}>⬇ JSON</button>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>⬆ Import</button>
          </div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => { if (confirm('Start a new empty plan?')) useApp.getState().newPlan(); }}>New</button>
            <button type="button" className="btn" onClick={() => { if (confirm('Replace current plan with the sample apartment?')) useApp.getState().loadSample(); }}>Load sample</button>
          </div>
          <input
            ref={fileRef} type="file" accept=".json,application/json" hidden
            onChange={e => { onImport(e.target.files?.[0] ?? null); e.target.value = ''; }}
          />
          <p className="hint">Plans autosave to your browser (localStorage). Use JSON export to back up or share.</p>
        </div>
      </details>
    </aside>
  );
}

function EnvSlider(props: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="env-slider">
      <div className="env-label">
        <span>{props.label}</span>
        <b>{props.value.toFixed(props.step < 1 ? 1 : 0)}{props.unit}</b>
      </div>
      <input
        type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={e => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}
