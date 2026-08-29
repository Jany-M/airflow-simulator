import { GRAB_HAND_CLOSED, GRAB_HAND_OPEN } from './grabHand';

/** Light grab-hand glyph for SVG overlays (matches canvas drawEmptyCanvasGrabHint). */
export default function GrabHandSvg({
  x,
  y,
  grabbing = false,
}: {
  x: number;
  y: number;
  grabbing?: boolean;
}) {
  return (
    <g transform={`translate(${x + 2}, ${y + 2}) scale(0.92)`} pointerEvents="none">
      <path
        d={grabbing ? GRAB_HAND_CLOSED : GRAB_HAND_OPEN}
        fill="rgba(8, 12, 18, 0.88)"
        stroke="#e2ecf5"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}
