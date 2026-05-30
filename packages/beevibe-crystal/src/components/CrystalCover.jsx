import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Float, OrbitControls, Sparkles } from "@react-three/drei";
import { Component, useMemo, useRef } from "react";
import * as THREE from "three";
import { crystalParams } from "../lib/crystalMetrics.js";

// Canvas can fail (no WebGL, throttled tab, etc.). Don't let it take the page down.
class CrystalBoundary extends Component {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err) { console.warn("crystal canvas failed:", err?.message || err); }
  render() { return this.state.hasError ? null : this.props.children; }
}

// Generic "presence" capsule for empty states (Upload page).
const PRESENCE_CAPSULE = {
  id: "presence",
  title: "presence",
  metadata: {
    messageCount: 14,
    toolCallCount: 6,
    fileChangeCount: 2,
    abandonedCount: 1,
    outcome: "in-progress",
    topics: ["design"],
  },
};

function Crystal({ capsule, pulse }) {
  const params = useMemo(() => crystalParams(capsule || PRESENCE_CAPSULE), [capsule]);
  const group = useRef();
  const inner = useRef();
  const outer = useRef();

  useFrame((state, delta) => {
    if (!group.current) return;
    group.current.rotation.y += delta * 0.12;
    group.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.3) * 0.08;
    const t = pulse ? 1 + Math.sin(state.clock.elapsedTime * 3) * 0.04 : 1;
    if (outer.current) outer.current.scale.setScalar(t);
    if (inner.current) {
      inner.current.rotation.y -= delta * 0.6;
      inner.current.rotation.x += delta * 0.3;
    }
  });

  const color = new THREE.Color().setHSL(params.hue, 0.72, 0.58);
  const accent = new THREE.Color().setHSL(params.accent, 0.7, 0.62);
  const emissive = color.clone().multiplyScalar(params.emissive);

  return (
    <Float speed={1.0} rotationIntensity={0.3} floatIntensity={0.7}>
      <group ref={group} scale={params.size * 1.15}>
        {/* Outer shell — translucent crystal */}
        <mesh ref={outer}>
          <icosahedronGeometry args={[1, 6]} />
          <meshPhysicalMaterial
            color={color}
            emissive={emissive}
            emissiveIntensity={1.0}
            roughness={params.roughness}
            metalness={0.05}
            transmission={0.85}
            thickness={1.6}
            ior={1.5}
            attenuationColor={accent}
            attenuationDistance={2.2}
            clearcoat={1}
            clearcoatRoughness={0.05}
            envMapIntensity={1.3}
          />
        </mesh>

        {/* Inner core */}
        <mesh ref={inner} scale={0.52}>
          <icosahedronGeometry args={[1, 3]} />
          <meshStandardMaterial
            color={accent}
            emissive={accent}
            emissiveIntensity={1.4}
            roughness={0.25}
            metalness={0.5}
            toneMapped={false}
          />
        </mesh>

        {/* Faint outer halo */}
        <mesh scale={1.18}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.06}
            depthWrite={false}
          />
        </mesh>

        {/* Cracks — slim great-circle rings, jittered orientations */}
        {Array.from({ length: params.cracks }).map((_, i) => {
          const seed = (i + 1) * 1.7;
          return (
            <mesh
              key={i}
              rotation={[
                Math.PI / 2 + Math.sin(seed) * 0.6,
                Math.cos(seed * 0.8) * 1.2,
                Math.sin(seed * 1.3) * 0.7,
              ]}
            >
              <torusGeometry args={[1.005, 0.004, 8, 96]} />
              <meshBasicMaterial
                color="#ffffff"
                transparent
                opacity={0.45}
                toneMapped={false}
              />
            </mesh>
          );
        })}

        {/* Inner sparkles — the "compressed thinking" */}
        <Sparkles
          count={28}
          scale={1.4}
          size={2}
          speed={0.4}
          opacity={0.6}
          color={accent}
        />
      </group>
    </Float>
  );
}

// Stage = fullbleed 3D canvas. Page content sits on top via z-index.
export function CrystalStage({ capsule, pulse, intensity = 1 }) {
  return (
    <div className="cb-stage" aria-hidden>
      <CrystalBoundary>
      <Canvas
        camera={{ position: [0, 0, 3.4], fov: 42 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.35 * intensity} />
        <directionalLight position={[4, 5, 6]} intensity={0.9 * intensity} />
        <directionalLight position={[-4, -3, -5]} intensity={0.5 * intensity} color="#7d9bff" />
        <pointLight position={[0, 0, 3]} intensity={0.5 * intensity} color="#ffffff" />
        <Crystal capsule={capsule} pulse={pulse} />
        <Environment preset="night" />
      </Canvas>
      </CrystalBoundary>
    </div>
  );
}

// Inline = bounded canvas for use inside a layout block (e.g. recent cards).
// Camera sits further back than CrystalStage so the sphere fits the bounded
// viewport even at max size (params.size 1.6 × scale 1.15 = radius 1.84) plus
// the 1.18 halo. Otherwise the sphere clips to the box edges and looks square.
export function CrystalInline({ capsule, height = 220, interactive = false }) {
  return (
    <div className="cb-inline" style={{ height }}>
      <CrystalBoundary>
      <Canvas camera={{ position: [0, 0, 7], fov: 42 }} dpr={[1, 2]} gl={{ alpha: true }}>
        <ambientLight intensity={1.1} />
        <directionalLight position={[3, 4, 5]} intensity={1.6} />
        <directionalLight position={[-3, -2, -4]} intensity={0.8} color="#7d9bff" />
        <pointLight position={[0, 0, 3]} intensity={0.6} color="#ffffff" />
        <Crystal capsule={capsule} />
        <Environment preset="night" />
        {interactive && <OrbitControls enablePan={false} enableZoom={false} />}
      </Canvas>
      </CrystalBoundary>
    </div>
  );
}

export default CrystalStage;
