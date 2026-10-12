"use client";
/* eslint-disable react-hooks/immutability -- three.js objects (clip plane, geometries, camera) are mutated per frame by design in react-three-fiber. */

import { Component, createContext, Suspense, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { createToyCat, plushFibre, type CatMode } from "./toy-cat";

export type GlbLook = "original" | "clay" | "resin" | "primer";
export type CellSubject =
  | { kind: "cat"; mode: CatMode; ears: number; tail: number; mix?: number }
  | { kind: "glb"; url: string; id: string; look: GlbLook }
  | { kind: "none" };

export interface CellProps {
  subject: CellSubject;
  /** 0..1 while a print is running, null otherwise. */
  print?: number | null;
  dims?: { height: string; width: string } | null;
  autoRotate?: boolean;
  label: string;
}

const ClipContext = createContext<THREE.Plane | null>(null);
const HEIGHT = 3;
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function WorkCell({ subject, print = null, dims = null, autoRotate = true, label }: CellProps) {
  const clip = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), 50), []);
  const topRef = useRef(HEIGHT);
  const hRef = useRef<HTMLSpanElement>(null);
  const wRef = useRef<HTMLSpanElement>(null);
  const subjectId = subject.kind === "glb" ? subject.id : subject.kind;
  const [failedId, setFailedId] = useState<string | null>(null);
  const chip = "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-clay px-2 py-px text-[13px] font-bold tabular-nums whitespace-nowrap text-clay-ink";
  return (
    <div className="relative h-full w-full">
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [1.6, 3.2, 10.6], fov: 27, near: 0.1, far: 100 }}
      gl={{ antialias: true, alpha: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.95 }}
      onCreated={({ gl }) => { gl.localClippingEnabled = true; }}
      aria-label={label}
      role="img"
    >
      <ClipContext.Provider value={clip}>
        <Environment />
        <Lights />
        <Floor />
        <Suspense fallback={null}>
          <SubjectView subject={subject} topRef={topRef} onFail={() => setFailedId(subjectId)} />
        </Suspense>
        <PrintSlice print={print} topRef={topRef} />
        {dims && <Dims topRef={topRef} hRef={hRef} wRef={wRef} />}
        <Framing />
        <OrbitControls
          makeDefault
          target={[0, 1.5, 0]}
          enableDamping
          enablePan={false}
          minDistance={6.5}
          maxDistance={16}
          minPolarAngle={0.4}
          maxPolarAngle={1.5}
          autoRotate={autoRotate && !reducedMotion()}
          autoRotateSpeed={0.9}
        />
      </ClipContext.Provider>
    </Canvas>
      <span ref={hRef} className={chip} hidden={!dims}>{dims?.height}</span>
      <span ref={wRef} className={chip} hidden={!dims}>{dims?.width}</span>
      {failedId === subjectId && (
        <p className="absolute inset-x-6 top-1/2 m-0 -translate-y-1/2 text-center text-sm text-stage-ink">The model file could not be loaded. Reload the run to get a fresh link.</p>
      )}
    </div>
  );
}

function Framing() {
  const { camera, size } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = size.width / size.height < 0.8 ? 34 : 27;
    cam.updateProjectionMatrix();
  }, [camera, size]);
  return null;
}

function Environment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    return () => { scene.environment = null; env.dispose(); pmrem.dispose(); };
  }, [gl, scene]);
  return null;
}

function Lights() {
  return (
    <>
      <directionalLight
        position={[3.5, 6.5, 4.5]}
        intensity={2.4}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0006}
        shadow-camera-left={-3}
        shadow-camera-right={3}
        shadow-camera-top={4}
        shadow-camera-bottom={-2}
        shadow-camera-near={1}
        shadow-camera-far={20}
      />
      <directionalLight position={[-4, 3.5, -4]} intensity={1.3} color="#bcd2ff" />
      <pointLight position={[-2.5, 1.2, 2.8]} intensity={6} distance={9} color="#ffd27a" />
    </>
  );
}

function Floor() {
  const glow = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const g = canvas.getContext("2d");
    if (g) {
      const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      grd.addColorStop(0, "rgba(255,255,255,0.55)");
      grd.addColorStop(0.6, "rgba(255,255,255,0.18)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    }
    return new THREE.CanvasTexture(canvas);
  }, []);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[16, 16]} />
        <shadowMaterial opacity={0.22} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.001}>
        <circleGeometry args={[3.4, 64]} />
        <meshBasicMaterial map={glow} transparent depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.002}>
        <ringGeometry args={[1.8, 1.86, 128]} />
        <meshBasicMaterial color="#5056d6" transparent opacity={0.55} />
      </mesh>
      {Array.from({ length: 24 }, (_, k) => {
        const a = (k / 24) * Math.PI * 2;
        return (
          <mesh key={k} rotation-x={-Math.PI / 2} position={[Math.cos(a) * 2.2, 0.002, Math.sin(a) * 2.2]}>
            <circleGeometry args={[0.045, 16]} />
            <meshBasicMaterial color="#5056d6" transparent opacity={0.45} />
          </mesh>
        );
      })}
    </group>
  );
}

function SubjectView({ subject, topRef, onFail }: { subject: CellSubject; topRef: RefObject<number>; onFail: () => void }) {
  if (subject.kind === "none") return null;
  if (subject.kind === "cat") return <CatView {...subject} topRef={topRef} />;
  return (
    <ModelBoundary key={subject.id} onFail={onFail}>
      <GlbView url={subject.url} look={subject.look} topRef={topRef} />
    </ModelBoundary>
  );
}

function CatView({ mode, ears, tail, mix = 1, topRef }: { mode: CatMode; ears: number; tail: number; mix?: number; topRef: RefObject<number> }) {
  const clip = useContext(ClipContext)!;
  const cat = useMemo(() => createToyCat(clip), [clip]);
  const first = useRef(true);
  useEffect(() => () => cat.dispose(), [cat]);
  useFrame((_, dt) => {
    const k = first.current || reducedMotion() ? 1 : 1 - Math.exp(-dt * 5);
    first.current = false;
    cat.setEars(cat.earScale + (ears - cat.earScale) * k);
    cat.setTail(cat.tailRadius + (tail - cat.tailRadius) * k);
    cat.setLook(mode, mix);
    topRef.current = cat.top();
  });
  return <primitive object={cat.group} />;
}

const LOOKS: Record<Exclude<GlbLook, "original">, { color: string; roughness: number; env: number }> = {
  clay: { color: "#bdb5a9", roughness: 0.92, env: 0.5 },
  resin: { color: "#8f969f", roughness: 0.38, env: 0.45 },
  primer: { color: "#a9acb1", roughness: 0.78, env: 0.45 },
};

function GlbView({ url, look, topRef }: { url: string; look: GlbLook; topRef: RefObject<number> }) {
  const clip = useContext(ClipContext)!;
  const gltf = useGLTF(url);
  const { object, originals } = useMemo(() => {
    const root = gltf.scene.clone(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const scale = size.y > 0 ? HEIGHT / size.y : 1;
    const holder = new THREE.Group();
    root.scale.setScalar(scale);
    const center = box.getCenter(new THREE.Vector3());
    root.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    holder.add(root);
    const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true; mesh.receiveShadow = true;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = mats.map((m) => { const c = m.clone(); c.clippingPlanes = [clip]; return c; });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
      originals.set(mesh, mesh.material);
    });
    return { object: holder, originals };
  }, [gltf.scene, clip]);

  const override = useMemo(() => new THREE.MeshPhysicalMaterial({ clippingPlanes: [clip], clipShadows: true, bumpMap: plushFibre(), sheenRoughness: 0.5 }), [clip]);
  useEffect(() => {
    topRef.current = HEIGHT;
    if (look === "original") originals.forEach((mat, mesh) => { mesh.material = mat; });
    else {
      const l = LOOKS[look];
      override.color.set(l.color); override.roughness = l.roughness; override.envMapIntensity = l.env; override.clearcoat = look === "resin" ? 0.3 : 0;
      override.sheen = look === "resin" ? 0 : 1; override.sheenColor.set(l.color).lerp(new THREE.Color(0xffffff), 0.55); override.bumpScale = look === "resin" ? 0 : 0.6;
      originals.forEach((_, mesh) => { mesh.material = override; });
    }
  }, [look, originals, override, topRef]);
  useEffect(() => () => override.dispose(), [override]);
  return <primitive object={object} />;
}

function PrintSlice({ print, topRef }: { print: number | null; topRef: RefObject<number> }) {
  const clip = useContext(ClipContext)!;
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const active = print !== null && print !== undefined;
    const h = active ? (reducedMotion() ? topRef.current + 0.1 : print * (topRef.current + 0.1)) : 50;
    clip.constant = h;
    if (group.current) { group.current.visible = active && print < 1 && !reducedMotion(); group.current.position.y = h; }
  });
  return (
    <group ref={group} visible={false}>
      <mesh rotation-x={-Math.PI / 2}>
        <circleGeometry args={[1.32, 96]} />
        <meshBasicMaterial color="#8b5cff" transparent opacity={0.2} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2}>
        <ringGeometry args={[1.3, 1.36, 128]} />
        <meshBasicMaterial color="#b18cff" transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function Dims({ topRef, hRef, wRef }: { topRef: RefObject<number>; hRef: RefObject<HTMLSpanElement | null>; wRef: RefObject<HTMLSpanElement | null> }) {
  const geo = useMemo(() => new THREE.BufferGeometry(), []);
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const top = topRef.current, x = 1.55, w = 1.14, z = 1.45;
    geo.setFromPoints([
      new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, top, 0), new THREE.Vector3(x - 0.14, 0, 0), new THREE.Vector3(x + 0.14, 0, 0),
      new THREE.Vector3(x - 0.14, top, 0), new THREE.Vector3(x + 0.14, top, 0),
      new THREE.Vector3(-w, 0.01, z), new THREE.Vector3(w, 0.01, z), new THREE.Vector3(-w, 0.01, z - 0.12), new THREE.Vector3(-w, 0.01, z + 0.12),
      new THREE.Vector3(w, 0.01, z - 0.12), new THREE.Vector3(w, 0.01, z + 0.12),
    ]);
    const place = (el: HTMLSpanElement | null, px: number, py: number, pz: number) => {
      if (!el) return;
      v.set(px, py, pz).project(camera);
      el.style.left = `${((v.x + 1) / 2) * size.width}px`;
      el.style.top = `${((1 - v.y) / 2) * size.height}px`;
    };
    place(hRef.current, x, top / 2, 0);
    place(wRef.current, 0, 0.01, z);
  });
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#5056d6" />
    </lineSegments>
  );
}

class ModelBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFail(); }
  render() { return this.state.failed ? null : this.props.children; }
}
