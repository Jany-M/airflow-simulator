import { useRef } from 'react';
import { useApp } from '../model/store';
import { dirName } from '../export/exportImage';

/** Draggable compass: drag the handle to set where the wind comes FROM. */
export default function WindDial() {
  const wind = useApp(s => s.plan.wind);
  const setWind = useApp(s => s.setWind);
  const svgRef = useRef<SVGSVGElement>(null);

  const R = 54, C = 64;
  const rad = (wind.fromDeg - 90) * (Math.PI / 180);
  const hx = C + Math.cos(rad) * R * 0.78;
  const hy = C + Math.sin(rad) * R * 0.78;

  const setFromEvent = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left - (rect.width / 2);
    const y = e.clientY - rect.top - (rect.height / 2);
    const deg = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 90 + 360) % 360);
    setWind({ fromDeg: deg });
  };

  return (
    <div className="wind-dial">
      <svg
        ref={svgRef}
        viewBox="0 0 128 128"
        onPointerDown={e => { (e.target as Element).setPointerCapture?.(e.pointerId); setFromEvent(e); }}
        onPointerMove={e => { if (e.buttons & 1) setFromEvent(e); }}
      >
        <circle cx={C} cy={C} r={R} fill="rgba(255,255,255,0.03)" stroke="rgba(150,175,205,0.35)" />
        {['N', 'E', 'S', 'W'].map((l, i) => {
          const a = (i * 90 - 90) * (Math.PI / 180);
          return (
            <text key={l} x={C + Math.cos(a) * (R - 12)} y={C + Math.sin(a) * (R - 12)}
              fill={l === 'N' ? '#dfe8f5' : 'rgba(160,180,205,0.6)'} fontSize={l === 'N' ? 13 : 11}
              fontWeight={l === 'N' ? 600 : 400} textAnchor="middle" dominantBaseline="central">{l}</text>
          );
        })}
        {/* arrow from the handle through centre = wind travel direction */}
        <line x1={hx} y1={hy} x2={C - (hx - C) * 0.7} y2={C - (hy - C) * 0.7}
          stroke="#37d0ff" strokeWidth="3.5" strokeLinecap="round" />
        <polygon
          points={`${C - (hx - C) * 0.92},${C - (hy - C) * 0.92} ${C - (hx - C) * 0.62 - (hy - C) * 0.14},${C - (hy - C) * 0.62 + (hx - C) * 0.14} ${C - (hx - C) * 0.62 + (hy - C) * 0.14},${C - (hy - C) * 0.62 - (hx - C) * 0.14}`}
          fill="#37d0ff" />
        <circle cx={hx} cy={hy} r="9" fill="#1d2531" stroke="#37d0ff" strokeWidth="2.5" style={{ cursor: 'grab' }} />
      </svg>
      <div className="wind-readout">
        <div className="wind-dir">from <b>{dirName(wind.fromDeg)}</b> ({wind.fromDeg}°)</div>
        <input
          type="range" min={0.5} max={10} step={0.5} value={wind.speed}
          onChange={e => setWind({ speed: Number(e.target.value) })}
        />
        <div className="wind-speed">{wind.speed.toFixed(1)} m/s</div>
      </div>
    </div>
  );
}
