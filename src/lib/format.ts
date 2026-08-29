/** Meteorological compass label for a from-direction in degrees. */
export function dirName(deg: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/** Clamp wind-from direction to 0-359 inclusive. */
export function clampWindDeg(deg: number): number {
  return ((Math.round(deg) % 360) + 360) % 360;
}
