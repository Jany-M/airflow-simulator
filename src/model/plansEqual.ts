import { Plan } from './types';

function envEqual(a: Plan['env'], b: Plan['env']) {
  return a.outdoorTemp === b.outdoorTemp && a.outdoorRH === b.outdoorRH
    && a.indoorTemp === b.indoorTemp && a.indoorRH === b.indoorRH;
}

function roomEqual(a: Plan['rooms'][0], b: Plan['rooms'][0]) {
  return a.id === b.id && a.name === b.name && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function openingEqual(a: Plan['openings'][0], b: Plan['openings'][0]) {
  return a.id === b.id && a.kind === b.kind && a.orient === b.orient
    && a.x === b.x && a.y === b.y && a.len === b.len && a.open === b.open && !!a.locked === !!b.locked;
}

export function plansEqual(a: Plan, b: Plan): boolean {
  if (a.version !== b.version || a.name !== b.name) return false;
  if (a.wind.fromDeg !== b.wind.fromDeg || a.wind.speed !== b.wind.speed) return false;
  if (!envEqual(a.env, b.env)) return false;
  if (a.rooms.length !== b.rooms.length || a.openings.length !== b.openings.length) return false;
  for (let i = 0; i < a.rooms.length; i++) if (!roomEqual(a.rooms[i], b.rooms[i])) return false;
  for (let i = 0; i < a.openings.length; i++) if (!openingEqual(a.openings[i], b.openings[i])) return false;
  return true;
}
