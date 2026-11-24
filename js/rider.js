import * as THREE from '../vendor/three.module.min.js';

// A cyclist and road bike built from shaped primitives: tapered limbs with
// joints, a rounded back, helmet and glasses, drop bars, spoked wheels and a
// crankset. Local axes: +Z forward, +X left, +Y up. The drive side is -X.

const UP = new THREE.Vector3(0, 1, 0);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const tmp = new THREE.Vector3();
const UNIT_TUBE = new THREE.CylinderGeometry(1, 1, 1, 10);
const BALL = new THREE.SphereGeometry(1, 14, 10);

// A straight tube from a to b.
function setTube(mesh, a, b, r) {
  tmp.subVectors(b, a);
  const len = tmp.length();
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, tmp.divideScalar(len || 1));
  mesh.scale.set(r, len, r);
}
// A tapered limb (its own geometry carries the radii) from a to b; sx/sz flatten or widen it.
function setLimb(mesh, a, b, sx = 1, sz = 1) {
  tmp.subVectors(b, a);
  const len = tmp.length();
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, tmp.divideScalar(len || 1));
  mesh.scale.set(sx, len, sz);
}

// gender: 'man' | 'woman' changes the build (shoulders, torso, hips, a ponytail).
export function createRider({ jersey = 0xe8412c, shorts = 0x15171c, helmet = 0xffffff, frame = 0x2b6fd6, gender = 'man' } = {}) {
  const woman = gender === 'woman';
  const group = new THREE.Group();
  const std = (color, roughness = 0.62, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const mFrame = std(frame, 0.35, 0.25), mDark = std(0x131417, 0.7), mRubber = std(0x0d0d0f, 0.9), mAlloy = std(0xaeb3ba, 0.35, 0.85);
  const mSkin = std(0xd6a07c, 0.7), mJersey = std(jersey, 0.75), mShorts = std(shorts, 0.8), mHelmet = std(helmet, 0.35), mWhite = std(0xf1f1ee, 0.6);
  const mHair = std(0x4a3020, 0.85), mLens = std(0x0c1016, 0.15, 0.6);

  const add = (parent, mesh) => { parent.add(mesh); return mesh; };
  const tube = (a, b, r, m, parent = group) => { const mesh = new THREE.Mesh(UNIT_TUBE, m); setTube(mesh, a, b, r); return add(parent, mesh); };
  const limb = (rA, rB, m, parent = group) => add(parent, new THREE.Mesh(new THREE.CylinderGeometry(rB, rA, 1, 12), m)); // rA at the start point
  const ball = (p, r, m, parent = group, sx = 1, sy = 1, sz = 1) => { const mesh = new THREE.Mesh(BALL, m); mesh.position.copy(p); mesh.scale.set(r * sx, r * sy, r * sz); return add(parent, mesh); };

  // ---------- bike ----------
  const R = 0.34;
  const rear = V(0, R, -0.5), front = V(0, R, 0.52), bb = V(0, 0.29, -0.07);
  const seatCluster = V(0, 0.84, -0.22), seatTop = V(0, 0.955, -0.25);
  const headTop = V(0, 0.9, 0.36), headBot = V(0, 0.76, 0.39);
  tube(bb, seatCluster, 0.019, mFrame); // seat tube
  tube(seatCluster, seatTop, 0.0135, mDark); // seat post
  tube(seatCluster, headTop, 0.0185, mFrame); // top tube
  tube(bb, headBot, 0.026, mFrame); // down tube
  tube(headBot, headTop, 0.024, mFrame); // head tube
  for (const s of [-1, 1]) {
    tube(V(0.055 * s, R, -0.5), V(0.03 * s, bb.y, bb.z), 0.011, mFrame); // chain stay
    tube(V(0.055 * s, R, -0.5), V(0.02 * s, 0.82, -0.215), 0.009, mFrame); // seat stay
    tube(V(0.02 * s, 0.745, 0.395), V(0.05 * s, R, 0.52), 0.0125, mFrame); // fork blade
  }
  tube(headTop, V(0, 0.925, 0.375), 0.016, mDark); // spacers
  tube(V(0, 0.925, 0.375), V(0, 0.95, 0.46), 0.015, mDark); // stem
  tube(V(-0.2, 0.95, 0.46), V(0.2, 0.95, 0.46), 0.0125, mDark); // bar tops
  for (const s of [-1, 1]) {
    const x = 0.2 * s;
    const curve = new THREE.CatmullRomCurve3([V(x, 0.95, 0.46), V(x, 0.953, 0.53), V(x, 0.925, 0.578), V(x, 0.865, 0.575), V(x, 0.82, 0.535), V(x, 0.81, 0.47)]);
    add(group, new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.012, 7), mDark)); // drops
    const hood = ball(V(x, 0.975, 0.553), 0.022, mRubber, group, 1, 1.9, 1.3); // brake hood
    hood.rotation.x = -0.5;
    tube(V(x, 0.95, 0.575), V(x, 0.85, 0.6), 0.005, mAlloy); // brake lever
  }
  const saddle = ball(V(0, 0.972, -0.255), 1, mDark, group, 0.066, 0.02, 0.135);
  saddle.rotation.x = -0.03;
  ball(V(0, 0.972, -0.15), 1, mDark, group, 0.026, 0.017, 0.06);
  // bottle on the seat tube
  tube(V(0, 0.44, -0.1), V(0, 0.63, -0.148), 0.034, mWhite);
  tube(V(0, 0.63, -0.148), V(0, 0.67, -0.158), 0.02, mDark);

  const tyre = new THREE.TorusGeometry(R - 0.013, 0.013, 8, 36).rotateY(Math.PI / 2);
  const rim = new THREE.TorusGeometry(R - 0.036, 0.013, 6, 36).rotateY(Math.PI / 2);
  const spoke = new THREE.CylinderGeometry(0.0016, 0.0016, (R - 0.04) * 2, 4);
  const hub = new THREE.CylinderGeometry(0.02, 0.02, 0.1, 10).rotateZ(Math.PI / 2);
  const wheels = [rear, front].map((p) => {
    const w = new THREE.Group();
    w.position.copy(p);
    w.add(new THREE.Mesh(tyre, mRubber), new THREE.Mesh(rim, mDark), new THREE.Mesh(hub, mAlloy));
    for (let i = 0; i < 9; i++) {
      const s = new THREE.Mesh(spoke, mAlloy);
      s.rotation.x = (i * Math.PI) / 9;
      w.add(s);
    }
    return add(group, w);
  });
  // drivetrain: chainring and cranks turn together, the cassette sits at the rear axle
  const drive = add(group, new THREE.Group());
  drive.position.copy(bb);
  drive.add(new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.006, 28).rotateZ(Math.PI / 2).translate(-0.048, 0, 0), mAlloy));
  drive.add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.15, 10).rotateZ(Math.PI / 2), mDark));
  add(group, new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 18).rotateZ(Math.PI / 2).translate(-0.05, R, -0.5), mAlloy));
  tube(V(-0.048, bb.y + 0.094, bb.z), V(-0.05, R + 0.048, -0.5), 0.004, mDark); // chain, top run
  tube(V(-0.048, bb.y - 0.094, bb.z), V(-0.05, R - 0.06, -0.5), 0.004, mDark); // chain, bottom run
  tube(V(-0.05, R - 0.02, -0.5), V(-0.05, R - 0.11, -0.47), 0.008, mDark); // rear derailleur

  // ---------- rider ----------
  // The upper body sits in its own group, pivoting at the hips, so it can rock.
  const hip = V(0, 1.0, -0.215);
  const upper = add(group, new THREE.Group());
  upper.position.copy(hip);
  const rel = (x, y, z) => V(x, y - hip.y, z - hip.z);
  const shW = woman ? 0.15 : 0.178, chest = woman ? 0.108 : 0.122, waist = woman ? 0.092 : 0.108, hipW = woman ? 0.103 : 0.094;
  const mid = rel(0, 1.215, -0.075), shoulder = rel(0, 1.365, 0.135), neckBase = rel(0, 1.39, 0.165), headC = rel(0, 1.5, 0.262);

  ball(V(0, 0.985, -0.21), 1, mShorts, group, hipW + 0.052, 0.105, 0.125); // pelvis
  setLimb(limb(waist + 0.012, waist, mJersey, upper), V(0, 0, 0), mid, 1.22, 0.9); // lower back
  setLimb(limb(waist, chest, mJersey, upper), mid, shoulder, 1.3, 0.86); // chest
  ball(mid, waist, mJersey, upper, 1.22, 1, 0.9);
  ball(shoulder, chest, mJersey, upper, 1.3, 0.8, 0.86);
  tube(shoulder, neckBase.clone().lerp(headC, 0.55), 0.043, mSkin, upper); // neck
  const head = ball(headC, 0.096, mSkin, upper, 0.93, 1.05, 1.05);
  head.rotation.x = 0.35;
  // helmet: a shell, longer at the back, with dark vents
  const shell = add(upper, new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.56), mHelmet));
  shell.position.copy(headC).add(V(0, 0.022, -0.012));
  shell.scale.set(0.108, 0.105, 0.142);
  shell.rotation.x = 0.3;
  for (const x of [-0.045, 0, 0.045]) {
    const vent = add(upper, new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.012, 0.15), mDark));
    vent.position.copy(headC).add(V(x, 0.118 - Math.abs(x) * 0.5, -0.012));
    vent.rotation.x = 0.3;
  }
  const lens = add(upper, new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.04, 0.03), mLens)); // glasses
  lens.position.copy(headC).add(V(0, -0.012, 0.088));
  lens.rotation.x = 0.35;
  if (woman) {
    tube(headC.clone().add(V(0, -0.02, -0.095)), headC.clone().add(V(0, -0.1, -0.17)), 0.036, mHair, upper);
    tube(headC.clone().add(V(0, -0.1, -0.17)), headC.clone().add(V(0, -0.23, -0.2)), 0.026, mHair, upper);
  }
  for (const s of [-1, 1]) {
    const sh = rel(shW * s, 1.345, 0.13), elbow = rel((shW + 0.03) * s, 1.155, 0.335), hand = rel(0.2 * s, 0.995, 0.545);
    ball(sh, woman ? 0.05 : 0.058, mJersey, upper);
    setLimb(limb(woman ? 0.045 : 0.052, woman ? 0.037 : 0.043, mJersey, upper), sh, sh.clone().lerp(elbow, 0.62)); // sleeve
    setLimb(limb(woman ? 0.036 : 0.041, woman ? 0.034 : 0.039, mSkin, upper), sh.clone().lerp(elbow, 0.6), elbow);
    ball(elbow, woman ? 0.035 : 0.04, mSkin, upper);
    setLimb(limb(woman ? 0.034 : 0.039, woman ? 0.026 : 0.03, mSkin, upper), elbow, hand); // forearm
    ball(hand, 0.034, mDark, upper, 1, 0.8, 1.25); // glove
  }

  const CRANK = 0.17, THIGH = 0.45, SHIN = 0.455;
  const thighR = woman ? [0.082, 0.052] : [0.086, 0.056], calfR = woman ? [0.05, 0.03] : [0.054, 0.033];
  const legs = [-1, 1].map((s) => {
    const shoe = add(group, new THREE.Group());
    const body = add(shoe, new THREE.Mesh(BALL, mWhite));
    body.scale.set(0.044, 0.036, 0.132);
    body.position.set(0, 0.012, 0.035);
    const sole = add(shoe, new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.014, 0.24), mDark));
    sole.position.set(0, -0.018, 0.035);
    const pedal = add(shoe, new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.016, 0.07), mDark));
    pedal.position.set(0, -0.034, 0);
    return {
      side: s, shoe,
      hip: V(hipW * s, 0.985, -0.2),
      thigh: limb(thighR[0], thighR[1], mShorts),
      knee: ball(V(0, 0, 0), thighR[1], mSkin),
      calf: limb(calfR[0], calfR[1], mSkin),
      sock: limb(calfR[1] + 0.006, calfR[1] + 0.004, mWhite),
      crank: tube(V(0, 0, 0), V(0, 1, 0), 0.011, mDark),
    };
  });

  const foot = V(0, 0, 0), ankle = V(0, 0, 0), knee = V(0, 0, 0), dir = V(0, 0, 0), perp = V(0, 0, 0), axle = V(0, 0, 0), mixA = V(0, 0, 0);

  function pose(crankAngle, wheelAngle) {
    wheels[0].rotation.x = wheelAngle;
    wheels[1].rotation.x = wheelAngle;
    drive.rotation.x = crankAngle;
    // the body rocks a little with each pedal stroke, the head stays level
    upper.rotation.z = Math.sin(crankAngle) * 0.035;
    upper.rotation.y = Math.sin(crankAngle) * 0.02;
    for (const leg of legs) {
      const a = crankAngle + (leg.side > 0 ? Math.PI : 0);
      axle.set(0.075 * leg.side, bb.y, bb.z);
      foot.set(0.115 * leg.side, bb.y + CRANK * Math.cos(a), bb.z + CRANK * Math.sin(a));
      setTube(leg.crank, axle, foot, 0.011);
      // ankling: toes drop through the bottom of the stroke, heel drops over the top
      const tilt = 0.2 - 0.3 * Math.cos(a - 0.5);
      leg.shoe.position.set(foot.x, foot.y + 0.045, foot.z);
      leg.shoe.rotation.x = tilt;
      // two-bone IK in the vertical plane, knee forward
      ankle.set(foot.x, foot.y + 0.1 + Math.sin(tilt) * 0.06, foot.z - 0.065 * Math.cos(tilt));
      dir.subVectors(ankle, leg.hip);
      const d = Math.min(dir.length(), THIGH + SHIN - 0.001);
      dir.normalize();
      const along = (THIGH * THIGH - SHIN * SHIN + d * d) / (2 * d);
      const out = Math.sqrt(Math.max(0, THIGH * THIGH - along * along));
      perp.set(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
      knee.copy(leg.hip).addScaledVector(dir, along).addScaledVector(perp, out);
      setLimb(leg.thigh, leg.hip, knee);
      leg.knee.position.copy(knee);
      setLimb(leg.calf, knee, ankle);
      setLimb(leg.sock, mixA.copy(knee).lerp(ankle, 0.74), ankle);
    }
  }
  pose(0.6, 0);

  return { group, pose };
}
