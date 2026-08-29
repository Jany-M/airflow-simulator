import Sidebar from './ui/Sidebar';
import EditorCanvas from './ui/EditorCanvas';
import RoomMeasureBox from './ui/RoomMeasureBox';
import { useApp } from './model/store';

export default function App() {
  const mobilePanelOpen = useApp(s => s.mobilePanelOpen);
  const tool = useApp(s => s.tool);
  const canvasToast = useApp(s => s.canvasToast);

  return (
    <div className={`app-shell ${mobilePanelOpen ? 'panel-open' : ''}`} data-tool={tool}>
      <header className="top-bar">
        <div className="top-bar-brand">
          <span className="logo" aria-hidden>🌬️</span>
          <div>
            <strong>Airflow Simulator</strong>
            <span>natural cross-ventilation</span>
          </div>
        </div>
        <button
          type="button"
          className="btn panel-toggle"
          aria-expanded={mobilePanelOpen}
          aria-controls="app-sidebar"
          onClick={() => useApp.getState().setMobilePanelOpen(!mobilePanelOpen)}
        >
          {mobilePanelOpen ? 'Close' : 'Controls'}
        </button>
      </header>

      <main className="canvas-area">
        <EditorCanvas />
        <div className="canvas-overlay">
          {canvasToast && (
            <div className="canvas-toast" role="status" aria-live="polite">
              {canvasToast}
            </div>
          )}
          <div className="mobile-only-measure"><RoomMeasureBox /></div>
        </div>
      </main>

      <div
        className="panel-backdrop"
        hidden={!mobilePanelOpen}
        onClick={() => useApp.getState().setMobilePanelOpen(false)}
      />
      <Sidebar />
    </div>
  );
}
