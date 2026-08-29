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

/** True if any pair of rooms overlap in their interiors. */
export function planHasOverlaps(p: Plan): boolean {
  for (let i = 0; i < p.rooms.length; i++) {
    for (let j = i + 1; j < p.rooms.length; j++) {
      if (rectsOverlap(p.rooms[i], p.rooms[j])) return true;
    }
  }
  return false;
}

/** Non-destructive import helper: drop invalid openings only. */
export function sanitizePlan(p: Plan): Plan {
  return validateOpenings(p);
}

export function validateOpeningsWithNotice(p: Plan): { plan: Plan; dropped: number } {
  const before = p.openings.length;
  const plan = validateOpenings(p);
  return { plan, dropped: before - plan.openings.length };
}

/** Which wall of this room the opening lies on. */
export function openingRoomSide(room: Room, o: Opening): Side | null {
  if (!onRoomBoundary(room, o)) return null;
  if (o.orient === 'h') {
    if (o.y === room.y) return 'n';
    if (o.y === room.y + room.h) return 's';
  } else {
    if (o.x === room.x) return 'w';
    if (o.x === room.x + room.w) return 'e';
  }
  return null;
}

const SIDE_WORD: Record<Side, string> = { n: 'north', s: 'south', e: 'east', w: 'west' };

/** Human label for sidebar / flux readouts: room, wall, and kind. */
export function openingLabel(plan: Plan, o: Opening): string {
  const kind = o.kind === 'window' ? 'window' : 'door';
  const rooms = plan.rooms.filter(r => openingRoomSide(r, o) != null);
  if (rooms.length === 0) return `${kind} (${o.len} cells)`;
  if (rooms.length === 1) {
    const side = openingRoomSide(rooms[0], o)!;
    return `${rooms[0].name} · ${SIDE_WORD[side]} ${kind}`;
  }
  const names = rooms.map(r => r.name);
  return `${names[0]} ↔ ${names[1]} · ${kind}`;
}

/** Max length this opening can have at its current anchor on the wall. */
export function openingWallSpan(plan: Plan, o: Opening): number {
  let maxLen = 0;
  for (const r of plan.rooms) {
    if (!onRoomBoundary(r, o)) continue;
    if (o.orient === 'h') maxLen = Math.max(maxLen, r.x + r.w - o.x);
    else maxLen = Math.max(maxLen, r.y + r.h - o.y);
  }
  for (const other of plan.openings) {
    if (other.id === o.id || other.orient !== o.orient) continue;
    if (o.orient === 'h' && other.y === o.y && other.x > o.x) {
      maxLen = Math.min(maxLen, other.x - o.x);
    }
    if (o.orient === 'v' && other.x === o.x && other.y > o.y) {
      maxLen = Math.min(maxLen, other.y - o.y);
    }
  }
  return Math.max(1, maxLen);
}