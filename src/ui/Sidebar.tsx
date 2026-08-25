import { useRef, useState } from 'react';
import { useApp, exportPlanJSON, importPlanJSON } from '../model/store';
import { Tool, ViewMode } from '../model/types';
import { optimize } from '../sim/optimizer';
import { exportPNG, dirName } from '../export/exportImage';
import {
  fetchLocalWeather, fetchWeatherAt, searchPlaces,
  loadSavedLocation, saveLocation, GeoPlace, LocalWeather,
} from '../services/weather';
import WindDial from './WindDial';
import RoomMeasureBox from './RoomMeasureBox';

const TOOLS: Array<{ id: Tool; label: string; icon: string; hint: string }> = [
  { id: 'select', label: 'Select', icon: '⇱', hint: 'Click a window/door to open (green) or close (red). Hold ~0.2 s to select it (yellow ring) and drag along walls. Click a room to select; drag inside to move; drag a wall to resize' },
  { id: 'room', label: 'Room', icon: '▭', hint: 'Drag on the grid to draw a room — a yellow ghost follows the cursor' },
  { id: 'window', label: 'Window', icon: '◫', hint: 'Move near a wall to snap a window preview, then click to place' },
  { id: 'door', label: 'Door', icon: '⎡⎦', hint: 'Move near a wall (including shared walls) to snap a door preview, then click to place' },
  { id: 'erase', label: 'Erase', icon: '✕', hint: 'Click a room or opening to delete it' },
];

export default function Sidebar() {
  const plan = useApp(s => s.plan);
  const tool = useApp(s => s.tool);
  const setTool = useApp(s => s.setTool);
  const selectedId = useApp(s => s.selectedId);
  const optimizing = useApp(s => s.optimizing);
  const optProgress = useApp(s => s.optProgress);
  const scoreLabel = useApp(s => s.lastScoreLabel);
  const simRunning = useApp(s => s.simRunning);

  const viewMode = useApp(s => s.viewMode);
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const [optResultMsg, setOptResultMsg] = useState<string | null>(null);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [weatherMsg, setWeatherMsg] = useState<string | null>(null);
  const [savedLoc, setSavedLoc] = useState<GeoPlace | null>(() => loadSavedLocation());
  const [locQuery, setLocQuery] = useState('');
  const [locResults, setLocResults] = useState<GeoPlace[]>([]);
  const [locSearching, setLocSearching] = useState(false);

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

  const runOptimizer = async () => {
    const st = useApp.getState();
    if (st.plan.openings.length === 0 || st.plan.rooms.length === 0) {
      setOptResultMsg('Add rooms and some windows/doors first.');
      return;
    }
    cancelRef.current = false;
    st.setOptimizing(true, { done: 0, total: 1 });
    setOptResultMsg(null);
    try {
      const best = await optimize(
        st.plan,
        p => useApp.getState().setOptimizing(true, { done: p.done, total: p.total }),
        () => cancelRef.current,
      );
      if (best) {
        useApp.getState().applyOpenSet(best.openIds);
        setOptResultMsg(`Best found: ${best.openIds.length} opening(s) open → ${(best.coverage * 100).toFixed(0)}% of floor area ventilated. Applied ✓`);
      } else {
        setOptResultMsg('No configuration found — add some openings.');
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
            <a href="https://www.shambix.com" target="_blank" rel="noopener noreferrer">
              Jany Martelli
            </a>
          </p>
        </div>
      </header>

      <div className="sidebar-sheet-handle mobile-only" aria-hidden />

      <input
        className="plan-name"
        value={plan.name}
        onChange={e => useApp.getState().setPlanName(e.target.value)}
        placeholder="Plan name"
      />

      <section>
        <h2>Simulation</h2>
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
        <label className="row-check">
          <input
            type="checkbox"
            checked={simRunning}
            onChange={e => useApp.getState().setSimRunning(e.target.checked)}
          />
          Live simulation
        </label>
        <button type="button" className="btn primary" onClick={runOptimizer} disabled={optimizing}>
          {optimizing
            ? `Searching… ${optProgress ? Math.round((optProgress.done / Math.max(optProgress.total, 1)) * 100) : 0}%`
            : '✨ Suggest best configuration'}
        </button>
        {optimizing && (
          <button type="button" className="btn" onClick={() => { cancelRef.current = true; }}>Cancel</button>
        )}
        {optResultMsg && <p className="opt-result">{optResultMsg}</p>}
        {scoreLabel && <p className="score">{scoreLabel}</p>}
      </section>

      <section>
        <h2>Wind &amp; weather</h2>
        <WindDial />
        <button type="button" className="btn wide" onClick={getWeather} disabled={weatherBusy}>
          {weatherBusy ? 'Fetching your weather…' : '📍 Use my current weather'}
        </button>
        {weatherMsg && <p className="hint weather-msg">{weatherMsg}</p>}
        {savedLoc ? (
          <p className="hint">
            📌 Location set to <b>{savedLoc.label}</b>{' '}
            <button type="button" className="linkish" onClick={clearPlace}>use auto instead</button>
          </p>
        ) : (
          <p className="hint">Wrong location? (Common on desktops using a phone connection.) Set your town:</p>
        )}
        <div className="loc-search">
          <input
            value={locQuery}
            placeholder="Search town / city…"
            onChange={e => setLocQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doLocSearch(); }}
          />
          <button type="button" className="btn" onClick={doLocSearch} disabled={locSearching || !locQuery.trim()}>
            {locSearching ? '…' : '🔍'}
          </button>
        </div>
        {locResults.map((r, i) => (
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
          <p className="hint">Rooms with airflow drift toward outdoor conditions; stagnant rooms stay near the indoor baseline.</p>
        </div>
      </details>

      {(selRoom || selOpening) && (
        <section className="selection">
          <h2>Selection</h2>
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
        </section>
      )}

      <details className="fold">
        <summary>
          <span className="fold-label">Floorplan</span>
          <span className="fold-meta">{activeTool?.icon} {activeTool?.label}</span>
          <span className="fold-chevron" aria-hidden>▸</span>
        </summary>
        <div className="fold-body">
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
          <p className="hint">{activeTool?.hint}</p>
        </div>
      </details>

      <section>
        <h2>Save &amp; export</h2>
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
      </section>
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
