#!/usr/bin/env node
// verify_qrb_assets.mjs -- structural gate for assets/3d/qrb_chamber.glb (no dependencies).
//
//   node tools/verify_qrb_assets.mjs [path/to/qrb_chamber.glb]
//
// Each check exists because the first build of this asset shipped with that exact defect:
//   - lights exported in physical units (~24 000 cd) that white out every surface
//   - an "up-light" that pointed into the floor
//   - a Z-up page driving a Y-up model (core, camera and plasma in different spaces)
//   - an orb ~3x too large for the room, so the chamber never matched the artwork
//   - a rotation loop with ease-in/out, so it stalled at the seam
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || join(here, '..', 'assets', '3d', 'qrb_chamber.glb');

const failures = [];
const notes = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// --- container ------------------------------------------------------------------
const buf = readFileSync(path);
check(buf.length > 20, 'file too small');
check(buf.toString('ascii', 0, 4) === 'glTF', 'bad magic');
check(buf.readUInt32LE(4) === 2, 'not glTF 2.0');
check(buf.readUInt32LE(8) === buf.length, `header length ${buf.readUInt32LE(8)} != file length ${buf.length}`);

let json = null;
let off = 12;
while (off + 8 <= buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  if (type === 'JSON') json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len));
  off += 8 + len;
}
if (!json) { console.error('FAIL no JSON chunk'); process.exit(1); }

const nodes = json.nodes || [];
const meshes = json.meshes || [];
const acc = json.accessors || [];
const mats = json.materials || [];
const byName = new Map(nodes.map((n, i) => [n.name, i]));
const lights = json.extensions?.KHR_lights_punctual?.lights || [];

// --- size / budget --------------------------------------------------------------
const bytes = statSync(path).size;
check(bytes <= 2 * 1024 * 1024, `file is ${bytes} bytes (budget 2 MiB)`);
let tris = 0;
for (const m of meshes) {
  for (const p of m.primitives) {
    const mode = p.mode ?? 4;
    check(mode === 4, `mesh ${m.name}: primitive mode ${mode} (expected triangles)`);
    const n = p.indices != null ? acc[p.indices].count : acc[p.attributes.POSITION].count;
    tris += Math.floor(n / 3);
    check(p.attributes.NORMAL != null, `mesh ${m.name}: no NORMAL attribute`);
  }
}
check(tris <= 60000, `${tris} triangles (budget 60 000)`);
notes.push(`${bytes} bytes, ${nodes.length} nodes, ${meshes.length} meshes, ${tris} triangles`);

// --- accessors must be finite --------------------------------------------------------
for (const a of acc) {
  for (const k of ['min', 'max']) {
    if (a[k]) check(a[k].every(Number.isFinite), `accessor with non-finite ${k}`);
  }
}

// --- required scene structure ---------------------------------------------------------
for (const n of ['QRB_Core_Sphere', 'PlasmaFront', 'PlasmaCage', 'Main_Camera',
  'Chamber_Hull', 'Chamber_LightBars', 'Chamber_Floor', 'Light_CorePulse', 'Light_FloorRing']) {
  check(byName.has(n), `missing node ${n}`);
}

// --- orientation + proportions (Y-up, metres) -------------------------------------------
const core = nodes[byName.get('QRB_Core_Sphere')];
if (core?.translation) {
  const [x, y, z] = core.translation;
  check(Math.abs(x) < 1e-4 && Math.abs(z) < 1e-4, `core off the vertical axis: ${core.translation}`);
  check(Math.abs(y - 1.7) < 0.05, `core height ${y} (expected 1.7: Y-up export)`);
}
function worldBox() {
  // only identity-rotation top-level meshes are used for the room box
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const name of ['Chamber_Hull', 'Chamber_Floor']) {
    const n = nodes[byName.get(name)];
    if (!n || n.mesh == null) continue;
    for (const p of meshes[n.mesh].primitives) {
      const a = acc[p.attributes.POSITION];
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a.min[i]); hi[i] = Math.max(hi[i], a.max[i]); }
    }
  }
  return { lo, hi };
}
const box = worldBox();
check(Math.abs(box.lo[1]) < 0.05, `floor at y=${box.lo[1]} (expected 0)`);
check(box.hi[1] > 4.0 && box.hi[1] < 6.5, `room height ${box.hi[1]} outside 4..6.5 m`);
check(box.hi[0] > 6.5 && box.hi[0] < 8.0, `room half-width ${box.hi[0]} outside 6.5..8 m`);
const coreMesh = meshes[core.mesh];
const ca = acc[coreMesh.primitives[0].attributes.POSITION];
const orbR = (ca.max[0] - ca.min[0]) / 2;
check(Math.abs(orbR - 0.5) < 0.02, `orb radius ${orbR.toFixed(3)} (reference scale is ~0.5 m)`);
notes.push(`room ${(box.hi[0] * 2).toFixed(1)} x ${box.hi[1].toFixed(1)} x ${(box.hi[2] * 2).toFixed(1)} m, orb r=${orbR.toFixed(2)} m`);

// --- materials ---------------------------------------------------------------------
const mat = Object.fromEntries(mats.map((m) => [m.name, m]));
for (const n of ['Mat_NeonRed', 'Mat_PlasmaRibbon', 'Mat_QRBCore', 'Mat_ChamberHull', 'Mat_ReactorFloor']) {
  check(mat[n], `missing material ${n}`);
}
for (const n of ['Mat_NeonRed', 'Mat_PlasmaRibbon']) {
  const m = mat[n];
  if (!m) continue;
  const s = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
  const e = m.emissiveFactor || [0, 0, 0];
  check(Math.max(...e) > 0.9, `${n}: emissive colour too dim`);
  check(e[0] > 3 * Math.max(e[1], e[2], 1e-6), `${n}: emissive not red-dominant (${e})`);
  check(s >= 2 && s <= 30, `${n}: emissive strength ${s} outside 2..30`);
}
if (mat.Mat_QRBCore) {
  const r = mat.Mat_QRBCore.pbrMetallicRoughness;
  check(r.metallicFactor >= 0.9, `core metallic ${r.metallicFactor} < 0.9`);
  check(r.roughnessFactor <= 0.12, `core roughness ${r.roughnessFactor} > 0.12`);
}
// the design is texture-free by construction; if textures ever appear they need UVs
const hasTex = (json.textures || []).length > 0;
if (!hasTex) {
  for (const m of meshes) for (const p of m.primitives) {
    check(p.attributes.TEXCOORD_0 == null, `mesh ${m.name}: UVs shipped with no texture`);
  }
}
notes.push(`${mats.length} materials, ${(json.textures || []).length} textures, ${(json.images || []).length} images`);

// --- lights --------------------------------------------------------------------------
check(lights.length >= 3, `only ${lights.length} punctual lights`);
for (const l of lights) {
  check(l.intensity > 0.5 && l.intensity < 2000, `light ${l.name}: ${l.intensity} cd outside 0.5..2000 (SPEC-mode export?)`);
}
function qrot(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
const floorNode = nodes.find((n) => n.name === 'Light_FloorRing');
if (floorNode) {
  const dir = qrot(floorNode.rotation || [0, 0, 0, 1], [0, 0, -1]);
  check(dir[1] > 0.9, `Light_FloorRing points ${dir.map((d) => d.toFixed(2))} (must point up, +Y)`);
}
const hatchNode = nodes.find((n) => n.name === 'Light_Hatch');
if (hatchNode) {
  const dir = qrot(hatchNode.rotation || [0, 0, 0, 1], [0, 0, -1]);
  check(dir[1] < -0.9, `Light_Hatch points ${dir.map((d) => d.toFixed(2))} (must point down)`);
}
notes.push(`${lights.length} lights (${lights.map((l) => Math.round(l.intensity) + 'cd').join(', ')})`);

// --- animation ----------------------------------------------------------------------
const anims = json.animations || [];
check(anims.length >= 3, `${anims.length} animation clips (expected hover, plasma spin, camera)`);
for (const a of anims) {
  let end = 0;
  for (const s of a.samplers) end = Math.max(end, acc[s.input].max[0]);
  check(Math.abs(end - 5.0) < 0.05, `clip ${a.name}: duration ${end.toFixed(3)} s (expected 5.0 -- one 120-frame loop at 24 fps)`);
  for (const c of a.channels) check(nodes[c.target.node] != null, `clip ${a.name}: channel targets missing node`);
  if (/Plasma/.test(a.name)) {
    for (const s of a.samplers) {
      check(s.interpolation === 'LINEAR', `clip ${a.name}: interpolation ${s.interpolation} (spin must be LINEAR or the loop stalls)`);
    }
  }
}
notes.push(`${anims.length} clips: ${anims.map((a) => a.name).join(', ')}`);
check((json.cameras || []).length >= 1, 'no camera exported');

// --- report -------------------------------------------------------------------------
for (const n of notes) console.log('  ' + n);
if (failures.length) {
  console.error(`\nFAIL ${path}`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`PASS ${path}`);
