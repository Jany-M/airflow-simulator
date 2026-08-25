import { useEffect, useState } from 'react';
import { CELL_METERS } from '../model/types';
import { useApp } from '../model/store';

function formatM(m: number) {
  return (Math.round(m * 10) / 10).toFixed(1);
}

/** Editable metre field that commits on blur / Enter. */
function MetreField(props: {
  label: string;
  metres: number;
  onCommit: (m: number) => void;
}) {
  const [text, setText] = useState(formatM(props.metres));
  useEffect(() => { setText(formatM(props.metres)); }, [props.metres]);

  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0) {
      setText(formatM(props.metres));
      return;
    }
    props.onCommit(v);
  };

  return (
    <label className="dim-field">
      <span>{props.label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        aria-label={props.label}
      />
      <span className="dim-unit">m</span>
    </label>
  );
}

/** Width × Length (metres) editor for the selected room. */
export default function RoomMeasureBox(props: { embedded?: boolean }) {
  const plan = useApp(s => s.plan);
  const selectedId = useApp(s => s.selectedId);
  const room = plan.rooms.find(r => r.id === selectedId) ?? null;
  if (!room) return null;

  const widthM = room.w * CELL_METERS;
  const lengthM = room.h * CELL_METERS;

  const apply = (nextW: number, nextL: number) => {
    useApp.getState().setRoomSizeM(room.id, nextW, nextL);
  };

  return (
    <div className={`measure-box ${props.embedded ? 'embedded' : ''}`} role="group" aria-label="Room measurements">
      {!props.embedded && (
        <div className="measure-box-head">
          <strong>{room.name}</strong>
          <span className="measure-box-hint">W × L</span>
        </div>
      )}
      <div className="measure-row">
        <MetreField label="Width" metres={widthM} onCommit={v => apply(v, lengthM)} />
        <span className="measure-times" aria-hidden>×</span>
        <MetreField label="Length" metres={lengthM} onCommit={v => apply(widthM, v)} />
      </div>
      <p className="measure-note">Snaps to 0.5 m · grows from top-left</p>
    </div>
  );
}
