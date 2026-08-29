// Regression: vertical wall resize must move horizontal openings on that wall (same as E/W for vertical openings).
import { onRoomBoundary } from '../src/model/geometry.ts';

function moveOpeningsOnResize(room, others, side, oldLine, newLine, openings) {
  return openings.map(o => {
    const exclusive = onRoomBoundary(room, o) && !others.some(r => onRoomBoundary(r, o));
    if (!exclusive) return o;
    if ((side === 'w' || side === 'e') && o.orient === 'v' && o.x === oldLine) return { ...o, x: newLine };
    if ((side === 'n' || side === 's') && o.orient === 'h' && o.y === oldLine) return { ...o, y: newLine };
    return o;
  });
}

const room = { id: 'r1', name: 'Room', x: 10, y: 10, w: 8, h: 6 };
const southWindow = { id: 'w1', kind: 'window', orient: 'h', x: 12, y: 16, len: 3, open: true };
const eastDoor = { id: 'd1', kind: 'door', orient: 'v', x: 18, y: 12, len: 2, open: true };

// South wall: y 16 → 18
let openings = moveOpeningsOnResize(room, [], 's', 16, 18, [southWindow]);
let resized = { ...room, h: 8 };
if (!onRoomBoundary(resized, openings[0])) {
  throw new Error('horizontal opening on south wall should follow vertical resize');
}

// North wall: y 10 → 8
const northWindow = { id: 'w2', kind: 'window', orient: 'h', x: 12, y: 10, len: 3, open: true };
openings = moveOpeningsOnResize(room, [], 'n', 10, 8, [northWindow]);
resized = { ...room, y: 8, h: 8 };
if (!onRoomBoundary(resized, openings[0])) {
  throw new Error('horizontal opening on north wall should follow vertical resize');
}

// East wall sanity (horizontal resize)
openings = moveOpeningsOnResize(room, [], 'e', 18, 20, [eastDoor]);
resized = { ...room, w: 10 };
if (!onRoomBoundary(resized, openings[0])) {
  throw new Error('vertical opening on east wall should follow horizontal resize');
}

console.log('resize-openings: ok');
