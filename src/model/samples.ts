import { Plan, uid, DEFAULT_ENV } from './types';

/** A 2-bedroom apartment sample so first-time users see something working. */
export function samplePlan(): Plan {
  const living = { id: uid(), name: 'Living room', x: 8, y: 8, w: 16, h: 12 };
  const kitchen = { id: uid(), name: 'Kitchen', x: 24, y: 8, w: 10, h: 8 };
  const hall = { id: uid(), name: 'Hallway', x: 24, y: 16, w: 10, h: 4 };
  const bed1 = { id: uid(), name: 'Bedroom 1', x: 34, y: 8, w: 12, h: 8 };
  const bed2 = { id: uid(), name: 'Bedroom 2', x: 34, y: 16, w: 12, h: 10 };
  const bath = { id: uid(), name: 'Bathroom', x: 24, y: 20, w: 10, h: 6 };

  return {
    version: 1,
    name: 'Sample apartment',
    rooms: [living, kitchen, hall, bed1, bed2, bath],
    openings: [
      // Exterior windows
      { id: uid(), kind: 'window', orient: 'v', x: 8, y: 12, len: 3, open: true },   // living W
      { id: uid(), kind: 'window', orient: 'h', x: 14, y: 20, len: 3, open: false }, // living S
      { id: uid(), kind: 'window', orient: 'h', x: 27, y: 8, len: 3, open: true },   // kitchen N
      { id: uid(), kind: 'window', orient: 'h', x: 38, y: 8, len: 3, open: false },  // bed1 N
      { id: uid(), kind: 'window', orient: 'v', x: 46, y: 10, len: 3, open: true },  // bed1 E
      { id: uid(), kind: 'window', orient: 'v', x: 46, y: 20, len: 3, open: false }, // bed2 E
      { id: uid(), kind: 'window', orient: 'h', x: 38, y: 26, len: 3, open: false }, // bed2 S
      { id: uid(), kind: 'window', orient: 'h', x: 27, y: 26, len: 2, open: false }, // bath S
      // Interior doors
      { id: uid(), kind: 'door', orient: 'v', x: 24, y: 12, len: 2, open: true },  // living↔kitchen
      { id: uid(), kind: 'door', orient: 'v', x: 24, y: 17, len: 2, open: true },  // living↔hall
      { id: uid(), kind: 'door', orient: 'h', x: 27, y: 16, len: 2, open: true },  // kitchen↔hall
      { id: uid(), kind: 'door', orient: 'h', x: 39, y: 16, len: 2, open: true },  // bed1↔bed2
      { id: uid(), kind: 'door', orient: 'v', x: 34, y: 17, len: 2, open: true },  // hall↔bed2
      { id: uid(), kind: 'door', orient: 'h', x: 28, y: 20, len: 2, open: false }, // hall↔bath
    ],
    wind: { fromDeg: 270, speed: 3 },
    env: { ...DEFAULT_ENV },
  };
}

export function emptyPlan(): Plan {
  return { version: 1, name: 'My floor plan', rooms: [], openings: [], wind: { fromDeg: 270, speed: 3 }, env: { ...DEFAULT_ENV } };
}
