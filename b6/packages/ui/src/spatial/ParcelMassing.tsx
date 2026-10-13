import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { parseParcelGeoJson, toLocalMetres } from '@darkquestate/core';
import { cx } from '../components/primitives.js';

export interface ParcelMassingProps {
  geoJson: string;
  /** Height of the illustrative building envelope in storeys (0 = bare land). */
  storeys: number;
  className?: string;
}

const STOREY_M = 3.4;

/**
 * An illustrative 3D massing: the lot as a slab and, unless it is land, a building envelope set
 * back from the boundary. It shows scale and shape, not the actual building. Drag to turn it.
 * One WebGL context, created on mount and fully released on unmount.
 */
export const ParcelMassing: React.FC<ParcelMassingProps> = ({ geoJson, storeys, className }) => {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const parsed = parseParcelGeoJson(geoJson);
    if (!parsed.ok || !parsed.polygon) {
      setFailed('No boundary on record.');
      return;
    }
    const ring = toLocalMetres(parsed.polygon).slice(0, -1);
    const span = Math.max(...ring.map((p) => Math.hypot(p.x, p.z)), 1);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed('3D view needs WebGL, which this browser has turned off.');
      return;
    }
    const width = el.clientWidth || 480;
    const height = el.clientHeight || 300;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, width / height, span / 100, span * 40);
    scene.add(new THREE.AmbientLight(0xf3f1ec, 0.55));
    const sun = new THREE.DirectionalLight(0xffe6b8, 1.4);
    sun.position.set(span, span * 1.6, span * 0.6);
    scene.add(sun);

    const disposables: { dispose: () => void }[] = [];
    const shapeOf = (pts: { x: number; z: number }[]) => {
      const s = new THREE.Shape();
      pts.forEach((p, i) => (i === 0 ? s.moveTo(p.x, -p.z) : s.lineTo(p.x, -p.z)));
      return s;
    };

    // The lot: a thin slab with gold edges.
    const lotGeo = new THREE.ExtrudeGeometry(shapeOf(ring), { depth: span * 0.02, bevelEnabled: false });
    lotGeo.rotateX(-Math.PI / 2);
    const lotMat = new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.95 });
    const lot = new THREE.Mesh(lotGeo, lotMat);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(lotGeo), new THREE.LineBasicMaterial({ color: 0xc9a45c }));
    disposables.push(lotGeo, lotMat, edges.geometry, edges.material as THREE.Material);
    const group = new THREE.Group();
    group.add(lot, edges);

    // The envelope: the boundary pulled 18% toward its centre, raised by storey count.
    if (storeys > 0) {
      const inset = ring.map((p) => ({ x: p.x * 0.82, z: p.z * 0.82 }));
      const h = Math.min(storeys * STOREY_M, span * 1.6);
      const massGeo = new THREE.ExtrudeGeometry(shapeOf(inset), { depth: h, bevelEnabled: false });
      massGeo.rotateX(-Math.PI / 2);
      massGeo.translate(0, span * 0.02, 0);
      const massMat = new THREE.MeshStandardMaterial({ color: 0xc9a45c, roughness: 0.45, metalness: 0.25, transparent: true, opacity: 0.82 });
      const mass = new THREE.Mesh(massGeo, massMat);
      const massEdges = new THREE.LineSegments(new THREE.EdgesGeometry(massGeo), new THREE.LineBasicMaterial({ color: 0xefe3c6 }));
      disposables.push(massGeo, massMat, massEdges.geometry, massEdges.material as THREE.Material);
      group.add(mass, massEdges);
    }
    scene.add(group);

    const grid = new THREE.GridHelper(span * 4, 24, 0x323843, 0x1a1d22);
    grid.position.y = -0.01;
    scene.add(grid);
    disposables.push(grid.geometry, grid.material as THREE.Material);

    let yaw = 0.7;
    const pitch = 0.62;
    const radius = span * 3.1;
    const place = () => {
      camera.position.set(Math.sin(yaw) * Math.cos(pitch) * radius, Math.sin(pitch) * radius, Math.cos(yaw) * Math.cos(pitch) * radius);
      camera.lookAt(0, span * 0.1, 0);
    };

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let dragging = false;
    let lastX = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      yaw -= (e.clientX - lastX) * 0.008;
      lastX = e.clientX;
    };
    const up = () => {
      dragging = false;
    };
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointermove', move);
    renderer.domElement.addEventListener('pointerup', up);
    renderer.domElement.style.touchAction = 'pan-y';
    renderer.domElement.style.cursor = 'grab';

    let frame = 0;
    const tick = () => {
      if (!dragging && !reduceMotion) yaw += 0.0025;
      place();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    tick();

    const resize = () => {
      const w = el.clientWidth || width;
      const h = el.clientHeight || height;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(el);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      renderer.domElement.removeEventListener('pointerdown', down);
      renderer.domElement.removeEventListener('pointermove', move);
      renderer.domElement.removeEventListener('pointerup', up);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [geoJson, storeys]);

  return (
    <div className={cx('blueprint relative overflow-hidden', className)} style={{ aspectRatio: '400 / 260' }}>
      <div ref={host} className="absolute inset-0" aria-label="Illustrative 3D massing of the parcel. Drag to rotate." role="img" />
      {failed && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-bone-mute">{failed}</div>}
      <div className="pointer-events-none absolute bottom-2.5 left-3 rounded border border-line bg-ink/80 px-2 py-0.5 text-[10px] text-bone-mute backdrop-blur">
        Illustrative massing · drag to turn
      </div>
    </div>
  );
};
