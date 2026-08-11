// ── Geometry helpers for editing (move / resize / validate) ────────────────

import { Plan, Room, Opening } from './types';

/** True if the opening's whole span lies on this room's boundary rectangle. */
export function onRoomBoundary(room: Room, o: Opening): boolean {
  if (o.orient === 'h') {
    return (o.y === room.y || o.y === room.y + room.h)
      && o.x >= room.x && o.x + o.len <= room.x + room.w;
  }
  return (o.x === room.x || o.x === room.x + room.w)
    && o.y >= room.y && o.y + o.len <= room.y + room.h;
}

/** Drop openings that no longer sit fully on any room's wall. */
export function validateOpenings(p: Plan): Plan {
  const openings = p.openings.filter(o => p.rooms.some(r => onRoomBoundary(r, o)));
  return openings.length === p.openings.length ? p : { ...p, openings };
}

/** True if two room rects overlap in their interiors (sharing a wall is fine). */
export function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Would this rect overlap any room other than `excludeId`? */
export function overlapsAnyRoom(plan: Plan, rect: { x: number; y: number; w: number; h: number }, excludeId?: string): boolean {
  return plan.rooms.some(r => r.id !== excludeId && rectsOverlap(rect, r));
}

/** Nearest value among candidates within `thresh`, else null. */
export function snapCoord(cands: number[], v: number, thresh = 0.8): number | null {
  let best: number | null = null;
  let bestD = thresh;
  for (const c of cands) {
    const d = Math.abs(c - v);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** Vertical wall lines (x coords) of all rooms except `excludeId`. */
export function wallLinesX(plan: Plan, excludeId?: string): number[] {
  const out: number[] = [];
  for (const r of plan.rooms) {
    if (r.id === excludeId) continue;
    out.push(r.x, r.x + r.w);
  }
  return out;
}

/** Horizontal wall lines (y coords) of all rooms except `excludeId`. */
export function wallLinesY(plan: Plan, excludeId?: string): number[] {
  const out: number[] = [];
  for (const r of plan.rooms) {
    if (r.id === excludeId) continue;
    out.push(r.y, r.y + r.h);
  }
  return out;
}

export type Side = 'n' | 's' | 'e' | 'w';

/** Which wall of the room is near the world point (within tol), if any. */
export function hitRoomWall(room: Room, wxp: number, wyp: number, tol = 0.45): Side | null {
  const withinX = wxp >= room.x - tol && wxp <= room.x + room.w + tol;
  const withinY = wyp >= room.y - tol && wyp <= room.y + room.h + tol;
  const cands: Array<{ side: Side; d: number }> = [];
  if (withinY && Math.abs(wxp - room.x) <= tol) cands.push({ side: 'w', d: Math.abs(wxp - room.x) });
  if (withinY && Math.abs(wxp - (room.x + room.w)) <= tol) cands.push({ side: 'e', d: Math.abs(wxp - (room.x + room.w)) });
  if (withinX && Math.abs(wyp - room.y) <= tol) cands.push({ side: 'n', d: Math.abs(wyp - room.y) });
  if (withinX && Math.abs(wyp - (room.y + room.h)) <= tol) cands.push({ side: 's', d: Math.abs(wyp - (room.y + room.h)) });
  cands.sort((a, b) => a.d - b.d);
  return cands[0]?.side ?? null;
}
