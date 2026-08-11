import Sidebar from './ui/Sidebar';
import EditorCanvas from './ui/EditorCanvas';

export default function App() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="canvas-area">
        <EditorCanvas />
      </main>
    </div>
  );
}
