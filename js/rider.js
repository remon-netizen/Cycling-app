import * as THREE from '../vendor/three.module.min.js';

// A low-poly cyclist built from primitives. Local axes: +Z forward, +X left, +Y up.

const UP = new THREE.Vector3(0, 1, 0);
const UNIT_TUBE = new THREE.CylinderGeometry(1, 1, 1, 7);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const tmp = new THREE.Vector3();

function setTube(mesh, a, b, r) {
  tmp.subVectors(b, a);
  const len = tmp.length();
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, tmp.divideScalar(len || 1));
  mesh.scale.set(r, len, r);
}

export function createRider({ jersey = 0xe8412c, shorts = 0x1c1f26, helmet = 0xffffff, frame = 0x2b6fd6 } = {}) {
  const group = new THREE.Group();
  const mat = (color) => new THREE.MeshLambertMaterial({ color });
  const mFrame = mat(frame), mDark = mat(0x16181c), mSkin = mat(0xd9a27e), mJersey = mat(jersey);
  const mShorts = mat(shorts), mHelmet = mat(helmet), mMetal = mat(0x9aa0a8);

  const tube = (a, b, r, m) => {
    const mesh = new THREE.Mesh(UNIT_TUBE, m);
    setTube(mesh, a, b, r);
    group.add(mesh);
    return mesh;
  };

  // Bike
  const R = 0.34;
  const rear = V(0, R, -0.5), front = V(0, R, 0.52), bb = V(0, 0.29, -0.07);
  const seatCluster = V(0, 0.84, -0.22), seatTop = V(0, 0.95, -0.25);
  const headTop = V(0, 0.9, 0.36), headBot = V(0, 0.76, 0.39);
  tube(bb, seatTop, 0.017, mFrame);
  tube(seatCluster, headTop, 0.017, mFrame);
  tube(bb, headBot, 0.021, mFrame);
  tube(headBot, headTop, 0.02, mFrame);
  tube(rear, bb, 0.012, mFrame);
  tube(rear, seatCluster, 0.011, mFrame);
  tube(headBot, front, 0.014, mFrame);
  tube(headTop, V(0, 0.95, 0.45), 0.014, mDark);
  tube(V(-0.2, 0.95, 0.46), V(0.2, 0.95, 0.46), 0.013, mDark);
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.25), mDark);
  saddle.position.set(0, 0.965, -0.25);
  group.add(saddle);

  const tyre = new THREE.TorusGeometry(R - 0.02, 0.02, 6, 22);
  tyre.rotateY(Math.PI / 2);
  const spoke = new THREE.BoxGeometry(0.006, (R - 0.03) * 2, 0.012);
  const wheels = [rear, front].map((p) => {
    const w = new THREE.Group();
    w.position.copy(p);
    w.add(new THREE.Mesh(tyre, mDark));
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(spoke, mMetal);
      s.rotation.x = (i * Math.PI) / 3;
      w.add(s);
    }
    group.add(w);
    return w;
  });

  // Rider
  const hip = V(0, 1.0, -0.22), shoulder = V(0, 1.36, 0.14);
  tube(hip, shoulder, 0.125, mJersey);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), mSkin);
  head.position.set(0, 1.5, 0.25);
  group.add(head);
  const lid = new THREE.Mesh(new THREE.SphereGeometry(0.112, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), mHelmet);
  lid.position.set(0, 1.515, 0.24);
  lid.scale.set(1, 0.95, 1.2);
  lid.rotation.x = 0.25;
  group.add(lid);
  for (const s of [-1, 1]) {
    const sh = V(0.17 * s, 1.33, 0.13), elbow = V(0.2 * s, 1.14, 0.33), hand = V(0.19 * s, 0.98, 0.47);
    tube(sh, elbow, 0.045, mJersey);
    tube(elbow, hand, 0.036, mSkin);
  }

  const CRANK = 0.17, THIGH = 0.45, SHIN = 0.46;
  const legs = [-1, 1].map((s) => ({
    side: s,
    hip: V(0.09 * s, 0.99, -0.2),
    thigh: tube(V(0, 0, 0), V(0, 1, 0), 0.066, mShorts),
    shin: tube(V(0, 0, 0), V(0, 1, 0), 0.044, mSkin),
    crank: tube(V(0, 0, 0), V(0, 1, 0), 0.012, mMetal),
    shoe: (() => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.05, 0.24), mat(0xf2f2f2));
      group.add(m);
      return m;
    })(),
  }));

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.75, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(0.55, 1.5, 1);
  shadow.position.y = 0.02;
  group.add(shadow);

  const foot = V(0, 0, 0), knee = V(0, 0, 0), dir = V(0, 0, 0), perp = V(0, 0, 0), axle = V(0, 0, 0);

  function pose(crankAngle, wheelAngle) {
    wheels[0].rotation.x = wheelAngle;
    wheels[1].rotation.x = wheelAngle;
    for (const leg of legs) {
      const a = crankAngle + (leg.side > 0 ? Math.PI : 0);
      axle.set(0.07 * leg.side, bb.y, bb.z);
      foot.set(0.11 * leg.side, bb.y + CRANK * Math.cos(a), bb.z + CRANK * Math.sin(a));
      setTube(leg.crank, axle, foot, 0.012);
      leg.shoe.position.set(foot.x, foot.y + 0.03, foot.z + 0.03);
      // two-bone IK in the vertical plane, knee forward
      foot.y += 0.06;
      dir.subVectors(foot, leg.hip);
      const d = Math.min(dir.length(), THIGH + SHIN - 0.001);
      dir.normalize();
      const along = (THIGH * THIGH - SHIN * SHIN + d * d) / (2 * d);
      const out = Math.sqrt(Math.max(0, THIGH * THIGH - along * along));
      perp.set(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
      knee.copy(leg.hip).addScaledVector(dir, along).addScaledVector(perp, out);
      setTube(leg.thigh, leg.hip, knee, 0.066);
      setTube(leg.shin, knee, foot, 0.044);
    }
  }
  pose(0.6, 0);

  return { group, pose };
}
