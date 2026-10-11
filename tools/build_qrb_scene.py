"""
build_qrb_scene.py
Procedural Blender 5.2 generator for the QRB Containment Chamber
Matching the Arweave artwork (QgoGIF.gif / ar://MbJXaZJwc0PjrCK2iwBblrR6m0aAYIUJ7xsIIpQpHQk)
"""
import bpy
import bmesh
import math
import os

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # Ensure a collection exists
    if not bpy.data.collections:
        col = bpy.data.collections.new("QRB_Chamber")
        bpy.context.scene.collection.children.link(col)
    else:
        col = bpy.data.collections[0]
    return col

def create_pbr_material(name, base_color, metallic, roughness, emission_color=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new(type="ShaderNodeOutputMaterial")
    bsdf = nodes.new(type="ShaderNodeBsdfPrincipled")
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness

    if emission_color and emission_strength > 0:
        bsdf.inputs["Emission Color"].default_value = emission_color
        bsdf.inputs["Emission Strength"].default_value = emission_strength

    return mat

def build_materials():
    mats = {}
    # Dark metallic chamber hull
    mats["hull"] = create_pbr_material(
        "Mat_ChamberHull",
        base_color=(0.035, 0.035, 0.045, 1.0),
        metallic=0.92,
        roughness=0.35
    )
    # Floor dais metal
    mats["floor"] = create_pbr_material(
        "Mat_ReactorFloor",
        base_color=(0.025, 0.025, 0.032, 1.0),
        metallic=0.88,
        roughness=0.42
    )
    # Crimson neon emitter strips
    mats["neon_red"] = create_pbr_material(
        "Mat_NeonRed",
        base_color=(1.0, 0.08, 0.04, 1.0),
        metallic=0.1,
        roughness=0.1,
        emission_color=(1.0, 0.08, 0.04, 1.0),
        emission_strength=25.0
    )
    # Obsidian glossy QRB core
    mats["core"] = create_pbr_material(
        "Mat_QRBCore",
        base_color=(0.012, 0.012, 0.018, 1.0),
        metallic=0.96,
        roughness=0.05
    )
    # Electric plasma energy ribbons
    mats["plasma"] = create_pbr_material(
        "Mat_PlasmaRibbon",
        base_color=(1.0, 0.15, 0.06, 1.0),
        metallic=0.0,
        roughness=0.05,
        emission_color=(1.0, 0.18, 0.06, 1.0),
        emission_strength=35.0
    )
    return mats

def build_octagonal_walls(col, mats, radius=7.5, height=7.0):
    bm = bmesh.new()
    sides = 8
    angle_step = 2 * math.pi / sides

    # Create vertices for outer wall octagon
    verts_bottom = []
    verts_top = []
    for i in range(sides):
        a = i * angle_step + (angle_step / 2.0)
        x = radius * math.cos(a)
        y = radius * math.sin(a)
        verts_bottom.append(bm.verts.new((x, y, 0.0)))
        verts_top.append(bm.verts.new((x, y, height)))

    bm.verts.ensure_lookup_table()

    # Wall quads
    for i in range(sides):
        i_next = (i + 1) % sides
        bm.faces.new([
            verts_bottom[i],
            verts_bottom[i_next],
            verts_top[i_next],
            verts_top[i]
        ])

    # Ceiling cap with beveled rim
    verts_ceil_in = []
    inner_rad = radius * 0.65
    for i in range(sides):
        a = i * angle_step + (angle_step / 2.0)
        x = inner_rad * math.cos(a)
        y = inner_rad * math.sin(a)
        verts_ceil_in.append(bm.verts.new((x, y, height - 0.6)))

    for i in range(sides):
        i_next = (i + 1) % sides
        bm.faces.new([
            verts_top[i],
            verts_top[i_next],
            verts_ceil_in[i_next],
            verts_ceil_in[i]
        ])

    mesh = bpy.data.meshes.new("ChamberWallsMesh")
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new("ChamberWalls", mesh)
    obj.data.materials.append(mats["hull"])
    col.objects.link(obj)

    # Recalculate normals to point inward
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.flip_normals()
    bpy.ops.object.mode_set(mode='OBJECT')

    return obj

def build_reactor_floor(col, mats, radius=7.5):
    bm = bmesh.new()
    rings = [
        (0.0, 0.05),
        (1.2, 0.05),
        (1.8, 0.12),
        (2.6, 0.08),
        (3.4, 0.18),
        (4.5, 0.10),
        (5.8, 0.22),
        (radius, 0.0)
    ]
    segments = 48

    prev_verts = []
    for r, z in rings:
        cur_verts = []
        for i in range(segments):
            angle = (2 * math.pi / segments) * i
            x = r * math.cos(angle)
            y = r * math.sin(angle)
            cur_verts.append(bm.verts.new((x, y, z)))
        if prev_verts:
            for i in range(segments):
                i_next = (i + 1) % segments
                bm.faces.new([
                    prev_verts[i],
                    prev_verts[i_next],
                    cur_verts[i_next],
                    cur_verts[i]
                ])
        else:
            # Center disc
            center_vert = bm.verts.new((0, 0, z))
            for i in range(segments):
                i_next = (i + 1) % segments
                bm.faces.new([center_vert, cur_verts[i], cur_verts[i_next]])
        prev_verts = cur_verts

    mesh = bpy.data.meshes.new("ReactorFloorMesh")
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new("ReactorFloor", mesh)
    obj.data.materials.append(mats["floor"])
    col.objects.link(obj)
    return obj

def build_light_strips(col, mats, radius=7.3, height=7.0):
    # Construct the iconic crimson light bars on the octagonal walls
    sides = 8
    angle_step = 2 * math.pi / sides

    for i in range(sides):
        a = i * angle_step + (angle_step / 2.0)
        x = radius * math.cos(a)
        y = radius * math.sin(a)
        rot_z = a + math.pi / 2.0

        # Don't put light directly blocking camera front (around -Y)
        if -1.8 < y < -6.0:
            continue

        # Horizontal upper strip
        bpy.ops.mesh.primitive_cube_add(
            size=1.0,
            location=(x * 0.96, y * 0.96, height * 0.68),
            rotation=(0, 0, rot_z)
        )
        strip_h1 = bpy.context.active_object
        strip_h1.scale = (2.2, 0.12, 0.25)
        strip_h1.data.materials.append(mats["neon_red"])
        strip_h1.name = f"LightStrip_H1_{i}"

        # Horizontal lower strip
        bpy.ops.mesh.primitive_cube_add(
            size=1.0,
            location=(x * 0.96, y * 0.96, height * 0.28),
            rotation=(0, 0, rot_z)
        )
        strip_h2 = bpy.context.active_object
        strip_h2.scale = (2.0, 0.12, 0.22)
        strip_h2.data.materials.append(mats["neon_red"])
        strip_h2.name = f"LightStrip_H2_{i}"

        # Vertical strip flanking the bay
        offset_ang = 0.22
        for side_sign in [-1, 1]:
            vx = radius * 0.97 * math.cos(a + side_sign * offset_ang)
            vy = radius * 0.97 * math.sin(a + side_sign * offset_ang)
            bpy.ops.mesh.primitive_cube_add(
                size=1.0,
                location=(vx, vy, height * 0.48),
                rotation=(0, 0, a + math.pi / 2.0)
            )
            strip_v = bpy.context.active_object
            strip_v.scale = (0.16, 0.12, 1.8)
            strip_v.data.materials.append(mats["neon_red"])
            strip_v.name = f"LightStrip_V_{i}_{side_sign}"

def build_qrb_core(col, mats, core_radius=1.35, core_z=2.85):
    # Obsidian glossy black sphere
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=core_radius,
        location=(0, 0, core_z),
        segments=64,
        ring_count=32
    )
    core = bpy.context.active_object
    core.name = "QRB_Core_Sphere"
    core.data.materials.append(mats["core"])
    bpy.ops.object.shade_smooth()

    # Floating keyframed animation (subtle breathing hover)
    core.location = (0, 0, core_z)
    core.keyframe_insert(data_path="location", frame=1)
    core.location = (0, 0, core_z + 0.18)
    core.keyframe_insert(data_path="location", frame=60)
    core.location = (0, 0, core_z)
    core.keyframe_insert(data_path="location", frame=120)

    return core

def build_plasma_cage(col, mats, core_radius=1.35, core_z=2.85):
    # Procedural helical plasma arcs wrapping the sphere
    plasma_parent = bpy.data.objects.new("PlasmaCage", None)
    plasma_parent.location = (0, 0, core_z)
    col.objects.link(plasma_parent)

    num_arcs = 12
    for arc_idx in range(num_arcs):
        curve_data = bpy.data.curves.new(f"PlasmaCurve_{arc_idx}", type='CURVE')
        curve_data.dimensions = '3D'
        curve_data.bevel_depth = 0.038
        curve_data.bevel_resolution = 4

        spline = curve_data.splines.new('BEZIER')
        spline.resolution_u = 16
        num_points = 8
        spline.bezier_points.add(num_points - 1)

        base_angle = (2 * math.pi / num_arcs) * arc_idx
        tilt_factor = (arc_idx % 3 - 1) * 0.65

        for p_idx in range(num_points):
            t = p_idx / (num_points - 1)  # 0 to 1
            phi = (t - 0.5) * math.pi * 0.9 + tilt_factor * (1.0 - t)
            theta = base_angle + t * 2.4 * math.pi

            r = core_radius * (1.06 + 0.18 * math.sin(t * math.pi * 3.0 + arc_idx))
            x = r * math.cos(phi) * math.cos(theta)
            y = r * math.cos(phi) * math.sin(theta)
            z = r * math.sin(phi)

            bp = spline.bezier_points[p_idx]
            bp.co = (x, y, z)
            bp.handle_left_type = 'AUTO'
            bp.handle_right_type = 'AUTO'

        curve_obj = bpy.data.objects.new(f"PlasmaArc_{arc_idx}", curve_data)
        curve_obj.data.materials.append(mats["plasma"])
        curve_obj.parent = plasma_parent
        col.objects.link(curve_obj)

    # Animate plasma cage rotation 360 degrees over 120 frames
    plasma_parent.rotation_euler = (0, 0, 0)
    plasma_parent.keyframe_insert(data_path="rotation_euler", frame=1)
    plasma_parent.rotation_euler = (0, 0, 2.0 * math.pi)
    plasma_parent.keyframe_insert(data_path="rotation_euler", frame=120)

    return plasma_parent

def setup_lighting(col, core_z=2.85):
    # Central radiant red point light inside plasma
    light_core = bpy.data.lights.new(name="Light_CorePulse", type='POINT')
    light_core.energy = 450.0
    light_core.color = (1.0, 0.12, 0.05)
    light_core.shadow_soft_size = 0.8
    obj_lc = bpy.data.objects.new("Light_CorePulse", light_core)
    obj_lc.location = (0, 0, core_z)
    col.objects.link(obj_lc)

    # Floor up-light
    light_floor = bpy.data.lights.new(name="Light_FloorRing", type='SPOT')
    light_floor.energy = 180.0
    light_floor.color = (1.0, 0.18, 0.08)
    light_floor.spot_size = math.radians(75)
    obj_lf = bpy.data.objects.new("Light_FloorRing", light_floor)
    obj_lf.location = (0, 0, 0.1)
    obj_lf.rotation_euler = (0, 0, 0)
    col.objects.link(obj_lf)

    # Subtle fill rim light
    light_rim = bpy.data.lights.new(name="Light_CinematicRim", type='AREA')
    light_rim.energy = 85.0
    light_rim.color = (0.25, 0.35, 0.55)
    light_rim.size = 3.5
    obj_lr = bpy.data.objects.new("Light_CinematicRim", light_rim)
    obj_lr.location = (0, 5.5, 5.0)
    obj_lr.rotation_euler = (math.radians(-45), 0, math.radians(180))
    col.objects.link(obj_lr)

def setup_camera(col, core_z=2.85):
    cam = bpy.data.cameras.new(name="Main_Camera")
    cam.lens = 32.0
    cam.clip_start = 0.1
    cam.clip_end = 100.0

    cam_obj = bpy.data.objects.new("Main_Camera", cam)
    cam_obj.location = (0.0, -6.8, core_z - 0.1)
    cam_obj.rotation_euler = (math.radians(90), 0, 0)
    col.objects.link(cam_obj)
    bpy.context.scene.camera = cam_obj
    return cam_obj

def main():
    print(">>> Starting procedural build of QRB Containment Chamber...")
    col = clear_scene()
    mats = build_materials()

    build_octagonal_walls(col, mats, radius=7.5, height=6.8)
    build_reactor_floor(col, mats, radius=7.5)
    build_light_strips(col, mats, radius=7.3, height=6.8)
    build_qrb_core(col, mats, core_radius=1.35, core_z=2.85)
    build_plasma_cage(col, mats, core_radius=1.35, core_z=2.85)
    setup_lighting(col, core_z=2.85)
    setup_camera(col, core_z=2.85)

    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 120

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_blend = os.path.join(base_dir, "assets", "3d", "qrb_chamber.blend")
    out_glb = os.path.join(base_dir, "assets", "3d", "qrb_chamber.glb")

    os.makedirs(os.path.dirname(out_blend), exist_ok=True)

    # Save .blend
    bpy.ops.wm.save_as_mainfile(filepath=out_blend)
    print(f">>> Successfully saved .blend to: {out_blend}")

    # Export .glb
    bpy.ops.export_scene.gltf(
        filepath=out_glb,
        export_format='GLB',
        export_apply=True,
        export_animations=True,
        export_cameras=True,
        export_lights=True
    )
    print(f">>> Successfully exported .glb to: {out_glb}")

if __name__ == "__main__":
    main()
