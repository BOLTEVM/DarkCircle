"""
build_qrb_scene.py -- QRB Containment Chamber, procedural Blender (5.x) builder.

Reference: QgoGIF.gif / ar://MbJXaZJwc0PjrCK2iwBblrR6m0aAYIUJ7xsIIpQpHQk

Reference measurements this scene is built from (QgoGIF.gif is 280x211 but was
squeezed from 16:9; stretched back to 16:9 the orb is a true sphere):
  * the camera stands ~5.9 m in front of the orb, looking straight at one wall of
    an octagon, horizontal FOV ~43 degrees (46 mm on a 36 mm sensor);
  * each wall carries two tiers of short horizontal bars (centred at +/-0.35 W,
    0.15 W long) at orb height +/-1.15 m, and a vertical bar on every corner pillar;
  * the orb is ~1 m across -- the room is large around it, with a recessed
    circular ceiling hatch above and a stepped circular dais below;
  * the plasma is a ring of branching lightning hugging the orb, plus filaments.

Conventions (single source of truth for the web page, see index.html):
  * built Z-up in Blender, exported Y-up (glTF default). Orb centre = (0, 0, 1.7)
    in Blender = (0, 1.7, 0) in glTF.  1 unit = 1 m.
  * geometry is deterministic: one seeded RNG, no wall-clock input. Two exports differ
    only in the orb's index-buffer order (the exporter's vertex-merge order), so compare
    builds with tools/verify_qrb_assets.mjs rather than by file hash.

Usage:
    blender --background --python tools/build_qrb_scene.py
    blender --background --python tools/build_qrb_scene.py -- --preview out.png [--frame 30]
    blender --background --python tools/build_qrb_scene.py -- --no-export
"""
import math
import os
import random
import sys
import warnings

import bmesh
import bpy
from mathutils import Matrix, Vector

warnings.simplefilter("ignore", DeprecationWarning)

# ----------------------------------------------------------------------------
# Dimensions (metres)
# ----------------------------------------------------------------------------
APOTHEM = 7.2          # centre -> wall plane distance
WALL_H = 4.6           # floor -> ceiling
ORB_R = 0.5
ORB_Z = 1.7            # orb centre height == camera height in the reference
TIER_LOW = ORB_Z - 1.15
TIER_HIGH = ORB_Z + 1.15
BAR_U = 0.345 * (2.0 * APOTHEM * math.tan(math.pi / 8.0))   # bar centre offset from wall centre
BAR_LEN = 0.15 * (2.0 * APOTHEM * math.tan(math.pi / 8.0))
HATCH_R = 1.4
CAM_POS = (0.0, -5.9, ORB_Z)
CAM_LENS = 46.0
FRAMES = 120           # one loop, 24 fps -> 5 s
# plan: neon (1.0, 0.08, 0.05) @ 25.  25 clips to white-pink under every view transform,
# which the reference does not (salmon core, red halo); the page restores the glow with bloom
NEON_STRENGTH = 5.0
PLASMA_STRENGTH = 4.5

CIRC_R = APOTHEM / math.cos(math.pi / 8.0)   # octagon corner radius


# ----------------------------------------------------------------------------
# Small geometry helpers (all write into a bmesh)
# ----------------------------------------------------------------------------
def _newell(points):
    n = Vector((0.0, 0.0, 0.0))
    for i, p in enumerate(points):
        q = points[(i + 1) % len(points)]
        n.x += (p.y - q.y) * (p.z + q.z)
        n.y += (p.z - q.z) * (p.x + q.x)
        n.z += (p.x - q.x) * (p.y + q.y)
    return n


def face(bm, pts, want):
    """Add a polygon whose normal points along `want` (winding fixed up for us)."""
    pts = [Vector(p) for p in pts]
    if _newell(pts).dot(want) < 0.0:
        pts.reverse()
    return bm.faces.new([bm.verts.new(p) for p in pts])


def box(bm, center, size, rot_z=0.0):
    m = (Matrix.Translation(center)
         @ Matrix.Rotation(rot_z, 4, "Z")
         @ Matrix.Diagonal(Vector((size[0], size[1], size[2], 1.0))))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


def cylinder(bm, center, radius, depth, axis=(0, 0, 1), segments=24, radius2=None):
    rot = Vector((0, 0, 1)).rotation_difference(Vector(axis).normalized()).to_matrix().to_4x4()
    m = Matrix.Translation(center) @ rot
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments,
        radius1=radius, radius2=radius if radius2 is None else radius2,
        depth=depth, matrix=m)


def ring_wall(bm, radius, z0, z1, segments, inward=True):
    """Open cylindrical band; normals face the axis when inward."""
    for j in range(segments):
        a0 = 2 * math.pi * j / segments
        a1 = 2 * math.pi * (j + 1) / segments
        p = [(radius * math.cos(a0), radius * math.sin(a0), z0),
             (radius * math.cos(a1), radius * math.sin(a1), z0),
             (radius * math.cos(a1), radius * math.sin(a1), z1),
             (radius * math.cos(a0), radius * math.sin(a0), z1)]
        mid = Vector((math.cos((a0 + a1) / 2), math.sin((a0 + a1) / 2), 0.0))
        face(bm, p, -mid if inward else mid)


def annulus(bm, r_in, r_out, z, segments, up=True):
    for j in range(segments):
        a0 = 2 * math.pi * j / segments
        a1 = 2 * math.pi * (j + 1) / segments
        p = [(r_in * math.cos(a0), r_in * math.sin(a0), z),
             (r_out * math.cos(a0), r_out * math.sin(a0), z),
             (r_out * math.cos(a1), r_out * math.sin(a1), z),
             (r_in * math.cos(a1), r_in * math.sin(a1), z)]
        face(bm, p, Vector((0, 0, 1 if up else -1)))


def disc(bm, r, z, segments, up=True):
    c = (0.0, 0.0, z)
    for j in range(segments):
        a0 = 2 * math.pi * j / segments
        a1 = 2 * math.pi * (j + 1) / segments
        face(bm, [c, (r * math.cos(a0), r * math.sin(a0), z),
                  (r * math.cos(a1), r * math.sin(a1), z)], Vector((0, 0, 1 if up else -1)))


def octagon_radius_at(angle):
    """Distance from the centre to the octagon perimeter at `angle`."""
    k = round(angle / (math.pi / 4.0))
    return APOTHEM / math.cos(angle - k * math.pi / 4.0)


# ----- wall-local frame: u along the wall (tangent), z up, w inward from the wall plane
def wall_point(theta, u, z, w):
    n = Vector((math.cos(theta), math.sin(theta), 0.0))
    t = Vector((-math.sin(theta), math.cos(theta), 0.0))
    return n * (APOTHEM - w) + t * u + Vector((0.0, 0.0, z))


def wall_box(bm, theta, u, z, width, height, depth, w0=-0.02):
    """Box standing on the wall: `depth` metres proud of the plane (w0 embeds it slightly)."""
    c = wall_point(theta, u, z, w0 + depth / 2.0)
    box(bm, c, (width, depth, height), rot_z=theta + math.pi / 2.0)


def wall_pipe(bm, theta, u0, u1, z, radius, w=0.12):
    a = wall_point(theta, u0, z, w)
    b = wall_point(theta, u1, z, w)
    cylinder(bm, (a + b) / 2.0, radius, (b - a).length, axis=(b - a), segments=10)


# ----------------------------------------------------------------------------
# Materials
# ----------------------------------------------------------------------------
def make_material(name, base, metallic, roughness, emit=None, strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = base
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emit is not None and strength > 0.0:
        bsdf.inputs["Emission Color"].default_value = emit
        bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def build_materials():
    return {
        # dark gunmetal hull; the red tint in the reference is light, not paint
        "hull": make_material("Mat_ChamberHull", (0.050, 0.044, 0.046, 1), 0.85, 0.50),
        "plate": make_material("Mat_ChamberPlate", (0.085, 0.066, 0.064, 1), 0.80, 0.36),
        "trim": make_material("Mat_ChamberTrim", (0.020, 0.020, 0.024, 1), 0.70, 0.30),
        "recess": make_material("Mat_ChamberRecess", (0.008, 0.008, 0.010, 1), 0.50, 0.80),
        "floor": make_material("Mat_ReactorFloor", (0.040, 0.034, 0.036, 1), 0.85, 0.40),
        # plan: color=(1.0, 0.08, 0.05), emission_strength=25.0 -- reads salmon after tone mapping
        "neon": make_material("Mat_NeonRed", (0.02, 0.0, 0.0, 1), 0.10, 0.10,
                              emit=(1.0, 0.05, 0.04, 1), strength=NEON_STRENGTH),
        "vent": make_material("Mat_ReactorVent", (0.02, 0.0, 0.0, 1), 0.10, 0.20,
                              emit=(1.0, 0.10, 0.05, 1), strength=3.0),
        # plan: metallic=0.95, roughness=0.08, base_color=(0.02, 0.02, 0.02)
        "core": make_material("Mat_QRBCore", (0.02, 0.02, 0.02, 1), 0.95, 0.08),
        "cap": make_material("Mat_CoreCap", (0.10, 0.09, 0.09, 1), 1.0, 0.25),
        "plasma": make_material("Mat_PlasmaRibbon", (0.05, 0.0, 0.0, 1), 0.0, 0.10,
                                emit=(1.0, 0.06, 0.03, 1), strength=PLASMA_STRENGTH),
    }


# ----------------------------------------------------------------------------
# Scene content
# ----------------------------------------------------------------------------
def build_architecture(col, mats, rng):
    buckets = {k: bmesh.new() for k in ("hull", "plate", "trim", "recess", "floor", "neon", "vent")}
    hull, plate, trim = buckets["hull"], buckets["plate"], buckets["trim"]
    recess, floor, neon, vent = buckets["recess"], buckets["floor"], buckets["neon"], buckets["vent"]
    wall_w = 2.0 * APOTHEM * math.tan(math.pi / 8.0)

    # --- wall shell: eight quads, normals inward ------------------------------------
    for i in range(8):
        a0 = math.pi / 8.0 + i * math.pi / 4.0
        a1 = a0 + math.pi / 4.0
        mid = Vector((math.cos((a0 + a1) / 2), math.sin((a0 + a1) / 2), 0.0))
        p0 = (CIRC_R * math.cos(a0), CIRC_R * math.sin(a0))
        p1 = (CIRC_R * math.cos(a1), CIRC_R * math.sin(a1))
        face(hull, [(p0[0], p0[1], 0.0), (p1[0], p1[1], 0.0),
                    (p1[0], p1[1], WALL_H), (p0[0], p0[1], WALL_H)], -mid)

    for k in range(8):
        theta = k * math.pi / 4.0          # wall k faces the centre along -n(theta)

        # plinth + cornice bands
        wall_box(trim, theta, 0.0, 0.22, wall_w, 0.44, 0.22)
        wall_box(trim, theta, 0.0, WALL_H - 0.28, wall_w, 0.56, 0.26)
        wall_box(trim, theta, 0.0, WALL_H - 0.62, wall_w, 0.07, 0.34)

        # central bay: dark recessed door panel with a raised frame
        bay_w, bay_h, bay_z = 2.3, 2.9, 0.62 + 1.45
        wall_box(recess, theta, 0.0, bay_z, bay_w, bay_h, 0.05)
        for du, dz, sw, sh in ((-bay_w / 2, 0.0, 0.14, bay_h + 0.14), (bay_w / 2, 0.0, 0.14, bay_h + 0.14),
                               (0.0, bay_h / 2, bay_w + 0.14, 0.14), (0.0, -bay_h / 2, bay_w + 0.14, 0.14)):
            wall_box(trim, theta, du, bay_z + dz, sw, sh, 0.14)
        wall_box(plate, theta, 0.0, bay_z, 0.06, bay_h, 0.09)     # door seam
        wall_box(plate, theta, 0.0, bay_z + 0.4, 0.8, 0.5, 0.08)  # lock plate

        # two tiers of short bars, each in a dark housing
        for z in (TIER_LOW, TIER_HIGH):
            for side in (-1.0, 1.0):
                u = side * BAR_U
                wall_box(trim, theta, u, z, BAR_LEN + 0.16, 0.34, 0.09)
                wall_box(neon, theta, u, z, BAR_LEN, 0.17, 0.05, w0=0.06)

        # conduits and cable trays run between the bars
        for z in (ORB_Z - 0.62, ORB_Z + 0.62):
            wall_pipe(trim, theta, -wall_w / 2 + 0.5, wall_w / 2 - 0.5, z, 0.045)
        wall_pipe(trim, theta, -wall_w / 2 + 0.45, wall_w / 2 - 0.45, 0.78, 0.07)

        # paneling: a grid of slightly proud plates either side of the bay and above it,
        # skipping the cells that hold the light bars
        for (u0, u1, z0, z1, cols, rows) in ((1.28, 2.42, 0.55, 3.55, 3, 6),
                                             (-2.42, -1.28, 0.55, 3.55, 3, 6),
                                             (-1.20, 1.20, 3.45, 3.75, 4, 1)):
            cw, rh = (u1 - u0) / cols, (z1 - z0) / rows
            for c in range(cols):
                for r in range(rows):
                    u = u0 + (c + 0.5) * cw
                    z = z0 + (r + 0.5) * rh
                    on_bar = (abs(abs(u) - BAR_U) < BAR_LEN / 2 + 0.12 and
                              (abs(z - TIER_LOW) < rh / 2 + 0.20 or abs(z - TIER_HIGH) < rh / 2 + 0.20))
                    if on_bar:
                        continue
                    depth = rng.choice((0.025, 0.025, 0.045, 0.085))
                    target = plate if rng.random() < 0.45 else hull
                    wall_box(target, theta, u, z, cw - 0.05, rh - 0.05, depth)
                    if rng.random() < 0.18:                       # small vent slot on some plates
                        wall_box(recess, theta, u, z, cw * 0.5, 0.05, depth + 0.02)
        # porthole above the bay (reads as the dark round hatch at the top of the reference frame)
        c = wall_point(theta, 0.0, WALL_H - 0.82, 0.04)
        cylinder(trim, c, 0.46, 0.08, axis=(math.cos(theta), math.sin(theta), 0.0), segments=32)
        c = wall_point(theta, 0.0, WALL_H - 0.82, 0.075)
        cylinder(recess, c, 0.36, 0.05, axis=(math.cos(theta), math.sin(theta), 0.0), segments=32)

        # small status vents under the bay
        for n in range(3):
            wall_box(vent, theta, -0.35 + 0.35 * n, 0.58, 0.12, 0.05, 0.03)

    # --- corner pillars with a vertical bar each ---------------------------------------
    for i in range(8):
        phi = math.pi / 8.0 + i * math.pi / 4.0
        n = Vector((math.cos(phi), math.sin(phi), 0.0))
        rot = phi + math.pi / 2.0
        box(hull, n * (CIRC_R - 0.22) + Vector((0, 0, WALL_H / 2)), (0.62, 0.66, WALL_H), rot_z=rot)
        box(trim, n * (CIRC_R - 0.60) + Vector((0, 0, WALL_H / 2)), (0.20, 0.10, WALL_H - 0.5), rot_z=rot)
        box(neon, n * (CIRC_R - 0.67) + Vector((0, 0, ORB_Z + 0.02)), (0.075, 0.05, 1.05), rot_z=rot)
        for z in (TIER_LOW, TIER_HIGH):
            box(trim, n * (CIRC_R - 0.55) + Vector((0, 0, z)), (0.50, 0.30, 0.26), rot_z=rot)

    # --- ceiling: octagon plate with a circular hole + recessed hatch -------------------
    segs = 32
    for j in range(segs):
        a0 = 2 * math.pi * j / segs
        a1 = 2 * math.pi * (j + 1) / segs
        ro0, ro1 = octagon_radius_at(a0), octagon_radius_at(a1)
        # a1 can wrap past a corner; both ends are on the perimeter so the quad stays planar
        face(hull, [(ro0 * math.cos(a0), ro0 * math.sin(a0), WALL_H),
                    (ro1 * math.cos(a1), ro1 * math.sin(a1), WALL_H),
                    (HATCH_R * math.cos(a1), HATCH_R * math.sin(a1), WALL_H),
                    (HATCH_R * math.cos(a0), HATCH_R * math.sin(a0), WALL_H)], Vector((0, 0, -1)))
    ring_wall(trim, HATCH_R, WALL_H, WALL_H + 0.7, 32, inward=True)
    annulus(plate, HATCH_R - 0.45, HATCH_R, WALL_H + 0.35, 32, up=False)
    annulus(trim, HATCH_R - 0.85, HATCH_R - 0.45, WALL_H + 0.55, 32, up=False)
    disc(recess, HATCH_R - 0.85, WALL_H + 0.70, 32, up=False)
    annulus(vent, HATCH_R - 0.50, HATCH_R - 0.46, WALL_H + 0.34, 32, up=False)
    # radial rafters from the hatch to the corners
    for i in range(8):
        phi = math.pi / 8.0 + i * math.pi / 4.0
        mid = (HATCH_R + CIRC_R) / 2.0
        c = Vector((math.cos(phi) * mid, math.sin(phi) * mid, WALL_H - 0.08))
        box(trim, c, (CIRC_R - HATCH_R, 0.22, 0.16), rot_z=phi)

    # --- floor: octagon fan hidden under a three-tier dais with engraved rings ----------
    for j in range(segs):
        a0 = 2 * math.pi * j / segs
        a1 = 2 * math.pi * (j + 1) / segs
        ro0, ro1 = octagon_radius_at(a0), octagon_radius_at(a1)
        face(floor, [(0.0, 0.0, 0.0),
                     (ro0 * math.cos(a0), ro0 * math.sin(a0), 0.0),
                     (ro1 * math.cos(a1), ro1 * math.sin(a1), 0.0)], Vector((0, 0, 1)))
    for r0, r1 in ((3.6, 3.72), (4.7, 4.82), (5.9, 6.02)):       # engraved rings
        annulus(trim, r0, r1, 0.012, 64, up=True)
    for i in range(16):                                           # plate seams
        a = i * math.pi / 8.0
        box(trim, Vector((math.cos(a) * 5.2, math.sin(a) * 5.2, 0.008)), (3.4, 0.05, 0.016), rot_z=a)
    for (r_lo, r_hi, h0, h1) in ((2.25, 2.10, 0.0, 0.12), (1.95, 1.82, 0.12, 0.26), (1.60, 1.50, 0.26, 0.40)):
        cylinder(floor, (0, 0, (h0 + h1) / 2.0), r_lo, h1 - h0, segments=48, radius2=r_hi)
    annulus(vent, 1.00, 1.06, 0.402, 48, up=True)                 # dais light ring
    annulus(trim, 1.06, 1.12, 0.402, 48, up=True)
    disc(recess, 0.62, 0.403, 32, up=True)                        # vent well under the orb
    for i in range(6):
        a = i * math.pi / 3.0 + math.pi / 6.0
        box(plate, Vector((math.cos(a) * 1.38, math.sin(a) * 1.38, 0.43)), (0.28, 0.12, 0.06), rot_z=a)

    # --- write buckets out as objects ---------------------------------------------------
    names = {"hull": "Chamber_Hull", "plate": "Chamber_Plates", "trim": "Chamber_Trim",
             "recess": "Chamber_Recess", "floor": "Chamber_Floor", "neon": "Chamber_LightBars",
             "vent": "Chamber_Vents"}
    objs = {}
    for key, bm in buckets.items():
        me = bpy.data.meshes.new(names[key] + "_mesh")
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(names[key], me)
        ob.data.materials.append(mats[key])
        col.objects.link(ob)
        objs[key] = ob
    return objs


def build_core(col, mats):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=32, radius=ORB_R)
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new("QRB_Core_mesh")
    bm.to_mesh(me)
    bm.free()
    core = bpy.data.objects.new("QRB_Core_Sphere", me)
    core.data.materials.append(mats["core"])
    core.location = (0.0, 0.0, ORB_Z)
    col.objects.link(core)

    # emitter caps on the poles (the reference orb shows machined fittings top and bottom)
    for sign, label in ((1.0, "Top"), (-1.0, "Bottom")):
        bm = bmesh.new()
        cylinder(bm, (0, 0, sign * (ORB_R + 0.015)), 0.13, 0.05, segments=6, radius2=0.09)
        me = bpy.data.meshes.new(f"QRB_Cap{label}_mesh")
        bm.to_mesh(me)
        bm.free()
        cap = bpy.data.objects.new(f"QRB_Cap{label}", me)
        cap.data.materials.append(mats["cap"])
        cap.parent = core
        col.objects.link(cap)
    return core


def _poly_curve(col, name, pts, mat, bevel, cyclic, parent):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = bevel
    cu.bevel_resolution = 1
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (p.x, p.y, p.z, 1.0)
    sp.use_cyclic_u = cyclic
    ob = bpy.data.objects.new(name, cu)
    ob.data.materials.append(mat)
    ob.parent = parent
    col.objects.link(ob)
    return ob


def _loop_points(rng, radius, e1, e2, n):
    nrm = e1.cross(e2)
    ph = [rng.uniform(0.0, 2.0 * math.pi) for _ in range(4)]
    pts = []
    for i in range(n):
        s = 2.0 * math.pi * i / n
        jr = (0.030 * math.sin(5 * s + ph[0]) + 0.018 * math.sin(11 * s + ph[1])
              + 0.010 * math.sin(23 * s + ph[2]) + rng.uniform(-0.006, 0.006))
        jn = (0.040 * math.sin(7 * s + ph[3]) + 0.020 * math.sin(13 * s + ph[0])
              + 0.008 * math.sin(29 * s + ph[1]) + rng.uniform(-0.006, 0.006))
        if i % 17 == 0:                                  # forked tips
            jr += rng.uniform(0.03, 0.07)
        r = radius + jr
        pts.append(e1 * (math.cos(s) * r) + e2 * (math.sin(s) * r) + nrm * jn)
    return pts


def build_plasma(col, mats, rng):
    """Jagged lightning loops + bolts. Front ring faces the camera (as in the reference)."""
    ring_r = ORB_R * 1.34
    front = bpy.data.objects.new("PlasmaFront", None)     # spins in the ring's own plane
    front.location = (0.0, 0.0, ORB_Z)
    col.objects.link(front)
    cage = bpy.data.objects.new("PlasmaCage", None)       # slow sweep about the vertical
    cage.location = (0.0, 0.0, ORB_Z)
    col.objects.link(cage)

    ex, ey, ez = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
    # main face-on ring lies in the XZ plane (normal = Y, towards the camera)
    pts = _loop_points(rng, ring_r, ex, ez, 160)
    _poly_curve(col, "PlasmaRing_Front", pts, mats["plasma"], 0.011, True, front)
    pts = _loop_points(rng, ring_r * 1.05, ex, ez, 128)
    _poly_curve(col, "PlasmaRing_FrontOuter", pts, mats["plasma"], 0.006, True, front)

    # bolts leaving the front ring
    for b in range(16):
        s0 = rng.uniform(0.0, 2.0 * math.pi)
        radial = ex * math.cos(s0) + ez * math.sin(s0)
        tang = ex * -math.sin(s0) + ez * math.cos(s0)
        p = radial * ring_r
        d = (radial + tang * rng.uniform(-0.8, 0.8) + ey * rng.uniform(-0.5, 0.5)).normalized()
        bolt = [p.copy()]
        for _ in range(12):
            d = (d + Vector((rng.uniform(-0.40, 0.40), rng.uniform(-0.40, 0.40), rng.uniform(-0.40, 0.40)))).normalized()
            p = p + d * rng.uniform(0.035, 0.065)
            bolt.append(p.copy())
        _poly_curve(col, f"PlasmaBolt_{b}", bolt, mats["plasma"], 0.004, False, front)

    # two tilted loops sweeping around the vertical give the shell its volume
    for idx, tilt in enumerate((math.radians(58.0), math.radians(-58.0))):
        e1 = Vector((math.cos(tilt), math.sin(tilt), 0.0))
        pts = _loop_points(rng, ring_r * 0.97, e1, ez, 128)
        _poly_curve(col, f"PlasmaLoop_{idx}", pts, mats["plasma"], 0.007, True, cage)

    return front, cage


def setup_lights(col):
    def add(name, kind, loc, color, energy, rot=(0, 0, 0), **kw):
        ld = bpy.data.lights.new(name, kind)
        ld.color = color
        ld.energy = energy
        for k, v in kw.items():
            setattr(ld, k, v)
        ob = bpy.data.objects.new(name, ld)
        ob.location = loc
        ob.rotation_euler = rot
        col.objects.link(ob)
        return ob

    # orb: radiant red point light inside the plasma
    add("Light_CorePulse", "POINT", (0, 0, ORB_Z), (1.0, 0.13, 0.06), 900.0, shadow_soft_size=0.35)
    # floor ring: an UP-light (rotation 180 deg about X -> shines along +Z); the shipped
    # build left rotation at zero, so the "up-light" pointed into the floor
    add("Light_FloorRing", "SPOT", (0, 0, 0.45), (1.0, 0.16, 0.07), 600.0,
        rot=(math.radians(180.0), 0, 0), spot_size=math.radians(110.0), spot_blend=0.6)
    # ceiling hatch: faint downlight
    add("Light_Hatch", "SPOT", (0, 0, WALL_H + 0.5), (1.0, 0.35, 0.25), 250.0,
        spot_size=math.radians(70.0), spot_blend=0.8)
    # interior fills: four red washes at the diagonal corners, wall height
    for i in range(4):
        a = math.pi / 4.0 + i * math.pi / 2.0
        add(f"Light_Fill_{i}", "POINT",
            (math.cos(a) * 5.4, math.sin(a) * 5.4, ORB_Z + 0.6), (1.0, 0.10, 0.05), 420.0,
            shadow_soft_size=0.6)


def setup_camera(col):
    cam = bpy.data.cameras.new("Main_Camera")
    cam.lens = CAM_LENS
    cam.sensor_width = 36.0
    cam.clip_start = 0.1
    cam.clip_end = 60.0
    ob = bpy.data.objects.new("Main_Camera", cam)
    ob.location = CAM_POS
    ob.rotation_euler = (math.radians(90.0), 0.0, 0.0)       # looks along +Y
    col.objects.link(ob)
    bpy.context.scene.camera = ob
    return ob


def animate(core, front, cage, cam):
    prefs = bpy.context.preferences.edit
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 1, FRAMES
    sc.render.fps = 24

    # smooth loops (bezier): orb hover, camera push-in/out. Key 1 == key 121 so the loop is closed.
    prefs.keyframe_new_interpolation_type = "BEZIER"
    for frame, dz in ((1, 0.0), (61, 0.10), (121, 0.0)):
        core.location = (0.0, 0.0, ORB_Z + dz)
        core.keyframe_insert("location", frame=frame)
    for frame, dy in ((1, 0.0), (61, 0.55), (121, 0.0)):
        cam.location = (CAM_POS[0], CAM_POS[1] + dy, CAM_POS[2] + 0.08 * (dy / 0.55 if dy else 0.0))
        cam.keyframe_insert("location", frame=frame)

    # constant-speed spins (linear), so the loop has no ease-in/out stall at the seam
    prefs.keyframe_new_interpolation_type = "LINEAR"
    front.rotation_euler = (0.0, 0.0, 0.0)
    front.keyframe_insert("rotation_euler", frame=1)
    front.rotation_euler = (0.0, 2.0 * math.pi, 0.0)       # about Y == the ring's normal
    front.keyframe_insert("rotation_euler", frame=121)
    cage.rotation_euler = (0.0, 0.0, 0.0)
    cage.keyframe_insert("rotation_euler", frame=1)
    cage.rotation_euler = (0.0, 0.0, -2.0 * math.pi)
    cage.keyframe_insert("rotation_euler", frame=121)
    prefs.keyframe_new_interpolation_type = "BEZIER"


def setup_world():
    world = bpy.data.worlds.new("QRB_World")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (0.030, 0.005, 0.004, 1.0)
        bg.inputs["Strength"].default_value = 1.0
    bpy.context.scene.world = world


def report(objs_extra):
    tris = 0
    out = []
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in bpy.data.objects:
        if ob.type in {"MESH", "CURVE"}:
            ev = ob.evaluated_get(dg)
            me = ev.to_mesh()
            n = sum(max(len(p.vertices) - 2, 0) for p in me.polygons)
            ev.to_mesh_clear()
            tris += n
            out.append((ob.name, n))
    out.sort(key=lambda t: -t[1])
    print(">>> triangles total:", tris)
    for name, n in out[:10]:
        print(f"      {n:7d}  {name}")
    return tris


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"preview": None, "frame": 1, "export": True}
    i = 0
    while i < len(argv):
        if argv[i] == "--preview":
            opts["preview"] = argv[i + 1]
            i += 1
        elif argv[i] == "--frame":
            opts["frame"] = int(argv[i + 1])
            i += 1
        elif argv[i] == "--no-export":
            opts["export"] = False
        i += 1
    return opts


def main():
    opts = parse_args()
    print(">>> building QRB containment chamber")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.data.collections.new("QRB_Chamber")
    bpy.context.scene.collection.children.link(col)

    rng = random.Random(0x0BA7)
    mats = build_materials()
    build_architecture(col, mats, rng)
    core = build_core(col, mats)
    front, cage = build_plasma(col, mats, rng)
    setup_lights(col)
    cam = setup_camera(col)
    setup_world()
    animate(core, front, cage, cam)

    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    bpy.context.view_layer.update()
    report(None)

    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(base, "assets", "3d")
    out_blend = os.path.join(out_dir, "qrb_chamber.blend")
    out_glb = os.path.join(out_dir, "qrb_chamber.glb")

    if opts["preview"]:
        try:
            sc.view_settings.view_transform = "Standard"
        except TypeError:
            pass
        sc.frame_set(opts["frame"])
        sc.render.resolution_x, sc.render.resolution_y = 1280, 720
        sc.render.image_settings.file_format = "PNG"
        sc.render.filepath = opts["preview"]
        bpy.ops.render.render(write_still=True)
        print(f">>> preview written: {opts['preview']}")
        sc.frame_set(1)

    if opts["export"]:
        os.makedirs(out_dir, exist_ok=True)
        bpy.context.preferences.filepaths.save_version = 0      # no stray .blend1 backups
        bpy.ops.wm.save_as_mainfile(filepath=out_blend)
        print(f">>> saved {out_blend}")
        bpy.ops.export_scene.gltf(
            filepath=out_glb,
            export_format="GLB",
            export_yup=True,
            export_apply=True,
            export_animations=True,
            export_animation_mode="ACTIONS",
            export_cameras=True,
            export_lights=True,
            # the scene is texture-free (flat PBR factors + geometry detail); Blender still
            # auto-generates a UV map on every bevelled curve, which is dead weight in the GLB.
            # Flip this back on together with adding textures.
            export_texcoords=False,
            # COMPAT = unitless candela (W / 4pi); SPEC would ship ~24000 cd lights that
            # blow every surface out in three.js's physical light model
            export_import_convert_lighting_mode="COMPAT",
        )
        print(f">>> exported {out_glb} ({os.path.getsize(out_glb)} bytes)")


if __name__ == "__main__":
    main()
