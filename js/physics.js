// Outdoor cycling physics: turns watts into speed on a given gradient.

const G = 9.8067;
export const CRR = 0.004; // rolling resistance, good tarmac
export const CDA = 0.32; // drag area, climbing on the hoods

// Thinner air with height, denser air when it is cold.
const airDensity = (ele, temp = 15) => 1.225 * Math.exp(-ele / 8400) * (288.15 / (273.15 + temp));

// Aerodynamic drag in newtons. `wind` is the headwind in m/s (negative = tailwind).
export function drag(v, ele, wind = 0, temp = 15) {
  const va = v + wind;
  return 0.5 * airDensity(ele, temp) * CDA * va * Math.abs(va);
}

function resistance(v, gradePct, mass, ele, wind, temp) {
  const slope = Math.atan(gradePct / 100);
  return mass * G * (Math.sin(slope) + CRR * Math.cos(slope)) + drag(v, ele, wind, temp);
}

// Advance speed (m/s) by dt seconds for a given power.
export function stepSpeed(v, power, gradePct, mass, ele, dt, wind = 0, temp = 15) {
  const drive = power > 0 ? power / Math.max(v, 0.3) : 0;
  const a = (drive - resistance(v, gradePct, mass, ele, wind, temp)) / mass;
  v += a * dt;
  return v > 0 ? v : 0;
}

// Speed you would settle at for a constant power on a constant gradient.
export function steadySpeed(power, gradePct, mass, ele, wind = 0, temp = 15) {
  if (power <= 0 && gradePct >= 0) return 0;
  let lo = 0, hi = 35;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (mid * resistance(mid, gradePct, mass, ele, wind, temp) < power) lo = mid;
    else hi = mid;
  }
  return lo;
}

// The gradient that would cost as much as this wind does at speed v.
export function windAsGrade(v, mass, ele, wind, temp) {
  return ((drag(v, ele, wind, temp) - drag(v, ele, 0, temp)) / (mass * G)) * 100;
}

// Seconds to ride from `from` to the end of the route at constant power.
// `weather` (optional) adds the average wind along the way.
export function estimateTime(route, from, power, mass, weather) {
  if (power < 20) return Infinity;
  let t = 0;
  const seg = 100, w = { head: 0, temp: 15 };
  for (let d = from; d < route.total; d += seg) {
    const len = Math.min(seg, route.total - d);
    if (weather) weather.at(d + len / 2, undefined, w);
    const v = steadySpeed(power, route.grade(d + len / 2, len), mass, route.ele(d), w.head, w.temp);
    if (v < 0.3) return Infinity;
    t += len / v;
  }
  return t;
}
