// Outdoor cycling physics: turns watts into speed on a given gradient, in a
// given wind, behind (or not behind) other riders.
//
// `air` everywhere is { head, side, temp, draft }:
//   head  m/s of wind against the rider (negative = tailwind)
//   side  m/s of wind across the road
//   temp  °C
//   draft 0..0.45, share of the drag taken away by riders in front

const G = 9.8067;
export const CRR = 0.004; // rolling resistance, good tarmac
export const CDA = 0.32; // drag area on the hoods
const CDA_UPRIGHT = 0.365; // hands on the tops, grinding uphill
const CDA_TUCK = 0.26; // freewheeling downhill in a tuck
const WHEEL_MASS = 1.4; // extra kg the spinning wheels add when accelerating
const CALM = { head: 0, side: 0, temp: 15, draft: 0 };

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Thinner air with height, denser air when it is cold.
const airDensity = (ele, temp = 15) => 1.225 * Math.exp(-ele / 8400) * (288.15 / (273.15 + temp));

// Riders sit up when climbing slowly and tuck when they stop pedalling downhill.
export function cdaFor(v, gradePct, power) {
  const cda = CDA + (CDA_UPRIGHT - CDA) * (1 - smooth(4, 8, v));
  const tuck = smooth(11, 15, v) * smooth(2, 5, -gradePct) * (1 - smooth(120, 250, power));
  return cda + (CDA_TUCK - cda) * tuck;
}

// Aerodynamic drag in newtons along the road. A crosswind does not push you
// back directly, but it does raise the speed of the air you ride through.
export function drag(v, ele, air = CALM, cda = CDA) {
  const along = v + (air.head || 0);
  const apparent = Math.hypot(along, air.side || 0);
  return 0.5 * airDensity(ele, air.temp) * cda * (1 - (air.draft || 0)) * apparent * along;
}

function resistance(v, gradePct, mass, ele, air, power) {
  const slope = Math.atan(gradePct / 100);
  return mass * G * (Math.sin(slope) + CRR * Math.cos(slope)) + drag(v, ele, air, cdaFor(v, gradePct, power));
}

// Advance speed (m/s) by dt seconds for a given power. `limit` is the fastest
// the road allows here (bends); above it the rider brakes.
export function stepSpeed(v, power, gradePct, mass, ele, dt, air = CALM, limit = Infinity) {
  const drive = power > 0 ? power / Math.max(v, 0.3) : 0;
  const a = (drive - resistance(v, gradePct, mass, ele, air, power)) / (mass + WHEEL_MASS);
  v += a * dt;
  if (v > limit) v = limit;
  return v > 0 ? v : 0;
}

// Speed you would settle at for a constant power on a constant gradient.
export function steadySpeed(power, gradePct, mass, ele, air = CALM) {
  if (power <= 0 && gradePct >= 0) return 0;
  let lo = 0, hi = 35;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (mid * resistance(mid, gradePct, mass, ele, air, power) < power) lo = mid;
    else hi = mid;
  }
  return lo;
}

// How much drag the riders in front take away. `ahead` holds the distances
// (m, wheel centre to wheel centre) to riders in front; anything further than
// 20 m gives nothing, sitting right on a wheel gives about a third.
export function draftSaving(ahead) {
  let best = 0, second = 0;
  for (const gap of ahead) {
    if (gap < 0.8 || gap > 20) continue; // alongside, or too far
    const s = 0.34 * Math.exp(-Math.max(0, gap - 1.9) / 3.5);
    if (s > best) { second = best; best = s; }
    else if (s > second) second = s;
  }
  return Math.min(0.45, best + 0.4 * second);
}

// Everything the air does differently from a calm, solo ride on the hoods,
// expressed as the gradient that would feel the same. This is what lets the
// trainer make a headwind heavier and a wheel to follow lighter.
export function airAsGrade(v, mass, ele, air, gradePct, power) {
  const ref = drag(v, ele, { temp: air.temp }, CDA);
  return ((drag(v, ele, air, cdaFor(v, gradePct, power)) - ref) / (mass * G)) * 100;
}

// Seconds to ride from `from` to the end of the route at constant power.
// `weather` (optional) adds the average wind along the way.
export function estimateTime(route, from, power, mass, weather) {
  if (power < 20) return Infinity;
  let t = 0;
  const seg = 100, air = { head: 0, side: 0, temp: 15, draft: 0 };
  for (let d = from; d < route.total; d += seg) {
    const len = Math.min(seg, route.total - d);
    if (weather) weather.at(d + len / 2, undefined, air);
    const v = Math.min(steadySpeed(power, route.grade(d + len / 2, len), mass, route.ele(d), air), route.speedLimit(d + len / 2));
    if (v < 0.3) return Infinity;
    t += len / v;
  }
  return t;
}
