import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const loader = document.getElementById('loader');
const hideLoader = () => loader.classList.add('done');

// ---------- Page UI (works even without WebGL) ----------
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

document.querySelectorAll('.card').forEach((card) => {
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
});

const canvas = document.getElementById('gotham');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = matchMedia('(max-width: 768px), (pointer: coarse)').matches;

let renderer;
try {
  // No MSAA: the bloom composer renders off-screen, so canvas antialiasing only cost memory.
  // failIfMajorPerformanceCaveat drops software renderers (SwiftShader, llvmpipe) to the static fallback.
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true,
  });
} catch (err) {
  document.body.classList.add('no-webgl');
  canvas.remove();
  hideLoader();
}

// ---------- Quality levels ----------
// Each step trades fidelity for speed. We start from a guess based on the GPU,
// then step down at runtime if the frame rate can't keep up.
// octaves/warp drive the cloud shader, by far the heaviest per-pixel cost.
const QUALITY = [
  { dpr: 1.6, bloom: true, octaves: 5, warp: true, rain: 1, lite: false },
  { dpr: 1.25, bloom: true, octaves: 4, warp: true, rain: 1, lite: true },
  { dpr: 1, bloom: false, octaves: 3, warp: true, rain: 0.6, lite: true },
  { dpr: 0.75, bloom: false, octaves: 3, warp: false, rain: 0.4, lite: true },
];

function initialQuality() {
  let level = isMobile ? 1 : 0;
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    if (/intel.*(hd|uhd)|mali|adreno \(?tm\)? [1-5]\d\d|powervr|videocore/i.test(gpu)) level = 2;
    else if (/intel|adreno|radeon.*vega/i.test(gpu)) level = Math.max(level, 1);
  } catch (_) { /* unknown GPU, rely on the runtime monitor */ }
  if ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4) level = Math.max(level, 1);
  return level;
}

if (renderer) initGotham();

function initGotham() {
  let level = initialQuality();
  renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY[level].dpr));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;

  const SKY = new THREE.Color(0x05070b);
  const scene = new THREE.Scene();
  scene.background = SKY;
  scene.fog = new THREE.FogExp2(0x070a10, 0.0085);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 1200);

  // ---------- Lights ----------
  const ambient = new THREE.AmbientLight(0x3a4560, 0.6);
  scene.add(ambient);
  const moon = new THREE.DirectionalLight(0x8fa3c8, 0.5);
  moon.position.set(-60, 120, 40);
  scene.add(moon);

  // ---------- Window texture ----------
  function windowTexture(litChance) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    const cell = 32;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const r = Math.random();
        if (r < litChance) {
          const warm = Math.random() < 0.8;
          const l = 30 + Math.random() * 28;
          g.fillStyle = warm ? `hsl(${38 + Math.random() * 10}, 90%, ${l}%)` : `hsl(205, 60%, ${l}%)`;
        } else {
          g.fillStyle = `rgb(${8 + r * 6}, ${10 + r * 8}, ${16 + r * 10})`;
        }
        g.fillRect(x * cell + 9, y * cell + 7, cell - 18, cell - 12);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  // Box whose UVs are in world units so windows don't stretch with building size.
  const WINDOW_UNIT = 1 / 14; // one texture repeat = 14 world units (8 floors)
  function buildingGeometry(w, h, d, x, z) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const uv = geo.attributes.uv;
    // Face order: +x, -x, +y, -y, +z, -z (4 vertices each)
    for (let f = 0; f < 6; f++) {
      for (let i = 0; i < 4; i++) {
        const idx = f * 4 + i;
        const u = uv.getX(idx), v = uv.getY(idx);
        if (f === 2 || f === 3) { uv.setXY(idx, 0.005, 0.005); continue; } // roofs: dark gap of texture
        const span = f < 2 ? d : w;
        uv.setXY(idx, u * span * WINDOW_UNIT, v * h * WINDOW_UNIT);
      }
    }
    geo.translate(x, h / 2, z);
    return geo;
  }

  // ---------- City ----------
  const BLOCK = 14;
  const AVENUE = 11; // half-width of the central avenue kept empty
  const groups = [[], [], []];
  const rand = (a, b) => a + Math.random() * (b - a);
  const gxMax = isMobile ? 9 : 12;
  for (let gx = -gxMax; gx <= gxMax; gx++) {
    for (let gz = -26; gz <= 6; gz++) {
      const cx = gx * BLOCK, cz = gz * BLOCK;
      if (Math.abs(cx) < AVENUE + BLOCK / 2) continue;
      const nearAvenue = Math.abs(cx) < AVENUE + BLOCK * 2.5;
      const w = rand(6, 11), d = rand(6, 11);
      let h = 8 + Math.pow(Math.random(), 2.6) * (nearAvenue ? 70 : 55);
      if (Math.random() < 0.04) h += 40; // occasional tower
      const x = cx + rand(-1.2, 1.2), z = cz + rand(-1.2, 1.2);
      const k = Math.floor(Math.random() * 3);
      groups[k].push(buildingGeometry(w, h, d, x, z));
      // stepped crown on tall towers
      if (h > 55) groups[k].push(buildingGeometry(w * 0.6, h * 0.12, d * 0.6, x, z).translate(0, h, 0));
      if (h > 75) groups[k].push(buildingGeometry(0.4, 10, 0.4, x, z).translate(0, h * 1.12, 0));
    }
  }
  const litChances = [0.05, 0.1, 0.17];
  const city = new THREE.Group();
  groups.forEach((list, i) => {
    if (!list.length) return;
    const geo = mergeGeometries(list);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0c0f15,
      roughness: 0.85,
      metalness: 0.2,
      emissive: 0xffffff,
      emissiveMap: windowTexture(litChances[i]),
      emissiveIntensity: 0.55,
    });
    city.add(new THREE.Mesh(geo, mat));
    list.forEach((g) => g.dispose());
  });
  scene.add(city);

  // GCPD rooftop with the searchlight
  const SOURCE = new THREE.Vector3(24, 34, -150);
  const gcpd = new THREE.Mesh(
    new THREE.BoxGeometry(16, 34, 16),
    new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.9, emissive: 0xffffff, emissiveMap: windowTexture(0.2), emissiveIntensity: 1 })
  );
  gcpd.position.set(SOURCE.x, 17, SOURCE.z);
  scene.add(gcpd);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.8, 2, 16), new THREE.MeshBasicMaterial({ color: 0xfff1b0 }));
  lamp.position.copy(SOURCE).add(new THREE.Vector3(0, 1, 0));
  scene.add(lamp);

  // Wet street
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 2400),
    new THREE.MeshStandardMaterial({ color: 0x06080c, roughness: 0.35, metalness: 0.7 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Street lamps (glow points along the avenue)
  const glowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,220,150,1)');
    grd.addColorStop(0.25, 'rgba(255,190,90,0.5)');
    grd.addColorStop(1, 'rgba(255,170,60,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const lampPos = [];
  for (let z = 40; z > -360; z -= 18) lampPos.push(-AVENUE + 1.5, 6, z, AVENUE - 1.5, 6, z);
  const lampGeo = new THREE.BufferGeometry();
  lampGeo.setAttribute('position', new THREE.Float32BufferAttribute(lampPos, 3));
  scene.add(new THREE.Points(lampGeo, new THREE.PointsMaterial({
    size: 2.6, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff,
  })));

  // ---------- Bat symbol texture ----------
  const batTex = (() => {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 512, 256);
    const p = new Path2D('M50 12l-3-3-2-8-3 9C30 10 20 2 2 8c8 3 11 9 11 15 6-3 12-1 15 5 4-5 10-6 14-2 3 4 5 10 8 22 3-12 5-18 8-22 4-4 10-3 14 2 3-6 9-8 15-5 0-6 3-12 11-15C80 2 70 10 58 10l-3-9-2 8z');
    g.translate(256 - 50 * 4.2, 128 - 25 * 4.2);
    g.scale(4.2, 4.2);
    g.fillStyle = '#fff';
    g.fill(p);
    const t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.LinearFilter;
    return t;
  })();

  // ---------- Clouds with the Bat-Signal ----------
  const CLOUD_Y = 95, CLOUD_W = 1400, CLOUD_CZ = -150;
  const cloudUniforms = {
    uTime: { value: 0 },
    uSignal: { value: new THREE.Vector2(0.5, 0.4) },
    uBat: { value: batTex },
    uFlash: { value: 0 },
    uOctaves: { value: 5 },
    uWarp: { value: 1 },
  };
  const clouds = new THREE.Mesh(
    new THREE.PlaneGeometry(CLOUD_W, CLOUD_W, 1, 1),
    new THREE.ShaderMaterial({
      uniforms: cloudUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform vec2 uSignal;
        uniform sampler2D uBat;
        uniform float uFlash;
        uniform int uOctaves;
        uniform float uWarp;
        varying vec2 vUv;
        varying vec3 vWorld;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) {
            if (i >= uOctaves) break;
            v += a * noise(p); p *= 2.03; a *= 0.5;
          }
          return v;
        }
        void main() {
          vec2 p = vUv * 7.0;
          float n = fbm(p + vec2(uTime * 0.015, uTime * 0.006));
          // Domain warp doubles the cost; on the lowest level the single pass is stretched to a similar range.
          if (uWarp > 0.5) n = fbm(p + n * 1.6 - vec2(0.0, uTime * 0.01));
          else n = n * 1.1 - 0.02;
          float density = smoothstep(0.32, 0.85, n);

          // Bat-Signal: ellipse of light with the bat cut out of it
          vec2 d = (vUv - uSignal) / vec2(0.07, 0.045);
          float r = length(d);
          float disc = smoothstep(1.0, 0.86, r);
          vec2 bUv = vec2(d.x * 0.62 + 0.5, 0.5 + d.y * 0.62);
          float bat = texture2D(uBat, clamp(bUv, 0.0, 1.0)).r * step(abs(d.x), 0.8) * step(abs(d.y), 0.8);
          float halo = exp(-r * r * 0.35) * 0.12;
          float lit = (disc * (1.0 - bat) * 0.75 + halo) * (0.45 + density * 0.7);

          vec3 base = mix(vec3(0.025, 0.03, 0.045), vec3(0.11, 0.12, 0.15), density);
          base += vec3(0.55, 0.6, 0.75) * uFlash * density;
          vec3 col = base + vec3(1.0, 0.86, 0.45) * lit;

          // fade edges into the sky
          float edge = smoothstep(0.5, 0.32, length(vUv - 0.5));
          float alpha = (0.35 + density * 0.65) * edge;
          alpha = max(alpha, lit * edge);
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
  );
  clouds.rotation.x = Math.PI / 2;
  clouds.position.set(0, CLOUD_Y, CLOUD_CZ);
  clouds.renderOrder = 1;
  scene.add(clouds);

  // ---------- Searchlight beam ----------
  const beamGeo = new THREE.CylinderGeometry(1, 0.08, 1, 48, 1, true);
  beamGeo.translate(0, 0.5, 0);   // narrow end at the origin, wide end at y = 1
  beamGeo.rotateX(Math.PI / 2);   // now along +z, which lookAt() aims at the clouds
  const beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uFlicker: { value: 1 } },
    vertexShader: /* glsl */`
      varying float vLen;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vLen = position.z; // 0 at source, 1 at clouds
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uFlicker;
      varying float vLen;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        float facing = pow(abs(dot(normalize(vN), normalize(vView))), 1.6);
        float a = facing * (0.1 - vLen * 0.07) * uFlicker;
        gl_FragColor = vec4(vec3(1.0, 0.9, 0.6) * a, a);
      }`,
  }));
  beam.position.copy(SOURCE).add(new THREE.Vector3(0, 2, 0));
  scene.add(beam);

  // ---------- Rain ----------
  const RAIN = isMobile ? 1800 : 4500;
  const rainPos = new Float32Array(RAIN * 2 * 3);
  const rainTop = new Float32Array(RAIN * 2);
  const rainSpeed = new Float32Array(RAIN * 2);
  for (let i = 0; i < RAIN; i++) {
    const x = rand(-70, 70), y = rand(0, 90), z = rand(-90, 30), s = rand(0.8, 1.3);
    for (let j = 0; j < 2; j++) {
      rainPos.set([x, y, z], (i * 2 + j) * 3);
      rainTop[i * 2 + j] = j;
      rainSpeed[i * 2 + j] = s;
    }
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  rainGeo.setAttribute('aTop', new THREE.BufferAttribute(rainTop, 1));
  rainGeo.setAttribute('aSpeed', new THREE.BufferAttribute(rainSpeed, 1));
  const rainUniforms = { uTime: { value: 0 } };
  const rain = new THREE.LineSegments(rainGeo, new THREE.ShaderMaterial({
    uniforms: rainUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */`
      attribute float aTop;
      attribute float aSpeed;
      uniform float uTime;
      varying float vTop;
      void main() {
        vec3 p = position;
        p.y = mod(p.y - uTime * 55.0 * aSpeed, 90.0);
        p.y += aTop * 1.6;
        p.x += aTop * 0.25;
        vTop = aTop;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying float vTop;
      void main() { gl_FragColor = vec4(0.62, 0.7, 0.85, 0.12 + vTop * 0.18); }`,
  }));
  rain.frustumCulled = false;
  scene.add(rain);

  // ---------- Post-processing ----------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.55, 0.5, 0.82);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Without bloom we render straight to the canvas and skip the composer's full-screen passes.
  function applyQuality() {
    const Q = QUALITY[level];
    const dpr = Math.min(devicePixelRatio, Q.dpr);
    renderer.setPixelRatio(dpr);
    composer.setPixelRatio(dpr);
    cloudUniforms.uOctaves.value = Q.octaves;
    cloudUniforms.uWarp.value = Q.warp ? 1 : 0;
    rainGeo.setDrawRange(0, Math.round(RAIN * Q.rain) * 2);
    // Blurring the page over a canvas that redraws every frame is costly; use solid panels instead.
    document.body.classList.toggle('lite', Q.lite);
  }
  applyQuality();

  // Frame-rate monitor: if we average under ~45 fps, drop one quality level.
  let perfStart = 0, perfFrames = 0, perfTime = 0;
  function monitor(rawDt, t) {
    if (level >= QUALITY.length - 1) return;
    if (rawDt > 0.25) { perfFrames = perfTime = 0; return; } // tab switch or hitch, not a steady cost
    if (t < 2) return; // ignore shader compile and the first frames
    if (!perfStart) perfStart = t;
    perfFrames++; perfTime += rawDt;
    if (t - perfStart < 1.5) return;
    if (perfTime / perfFrames > 1 / 45) { level++; applyQuality(); }
    perfStart = t; perfFrames = perfTime = 0;
  }

  // ---------- Interaction ----------
  const mouse = new THREE.Vector2(0.45, 0.1);
  const mouseSmooth = mouse.clone();
  let lastPointer = -Infinity;
  const onPointer = (e) => {
    mouse.set((e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2);
    lastPointer = performance.now();
  };
  addEventListener('pointermove', onPointer);
  addEventListener('pointerdown', onPointer);

  let scrollT = 0, scrollSmooth = 0;
  const readScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    scrollT = max > 0 ? Math.min(1, scrollY / max) : 0;
  };
  addEventListener('scroll', readScroll, { passive: true });
  readScroll();

  // Lock the horizontal field of view to what a 16:9 screen sees at 60°, so phones in portrait
  // still see the avenue and ultrawide screens don't reveal the edge of the city.
  const H_TAN = Math.tan(THREE.MathUtils.degToRad(30)) * (16 / 9);
  let signalRange = 140;
  function fitCamera() {
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(H_TAN / camera.aspect)), 45, 80);
    camera.updateProjectionMatrix();
    // Keep the Bat-Signal's sweep inside the view (it sits ~160 units ahead of the camera).
    const halfWidth = 160 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    signalRange = Math.min(140, halfWidth * 0.8);
  }
  fitCamera();

  // The canvas is sized in CSS to the large viewport (100lvh), so the mobile address bar sliding
  // in and out while scrolling doesn't change it and we skip a full re-render setup.
  let viewW = canvas.clientWidth, viewH = canvas.clientHeight;
  addEventListener('resize', () => {
    readScroll();
    if (canvas.clientWidth === viewW && canvas.clientHeight === viewH) return;
    viewW = canvas.clientWidth; viewH = canvas.clientHeight;
    fitCamera();
    renderer.setSize(viewW, viewH, false);
    composer.setSize(viewW, viewH);
  });

  // ---------- Animation ----------
  const target = new THREE.Vector3();
  const look = new THREE.Vector3();
  const signalWorld = new THREE.Vector3();
  let nextFlash = 6 + Math.random() * 8, flash = 0;
  const clock = new THREE.Clock();
  let first = true;

  function frame() {
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const t = clock.elapsedTime;
    monitor(rawDt, t);
    const ease = 1 - Math.pow(0.001, dt);

    // With no recent pointer (touch screens, or a still mouse) the signal sweeps the sky on its own.
    if (!reducedMotion && performance.now() - lastPointer > 4000) {
      mouse.set(Math.sin(t * 0.23) * 0.7, 0.15 + Math.sin(t * 0.37 + 1) * 0.35);
    }
    scrollSmooth += (scrollT - scrollSmooth) * (reducedMotion ? 1 : ease * 1.6);
    mouseSmooth.lerp(mouse, reducedMotion ? 1 : ease * 2);
    const s = scrollSmooth;

    // Camera flies up the avenue toward GCPD and rises above the rooftops.
    target.set(
      Math.sin(s * Math.PI) * 6 + mouseSmooth.x * 2.5,
      6 + Math.pow(s, 1.4) * 52 + mouseSmooth.y * 1.5,
      75 - s * 175
    );
    camera.position.lerp(target, reducedMotion ? 1 : 0.12);
    look.set(camera.position.x * 0.3 + mouseSmooth.x * 8, 30 + s * 10 + mouseSmooth.y * 6, camera.position.z - 90);
    camera.lookAt(look);

    // Bat-Signal follows the cursor across the clouds, always ahead of the camera.
    signalWorld.set(
      mouseSmooth.x * signalRange,
      CLOUD_Y,
      camera.position.z - 160 + mouseSmooth.y * 35
    );
    cloudUniforms.uSignal.value.set(
      (signalWorld.x) / CLOUD_W + 0.5,
      (signalWorld.z - CLOUD_CZ) / CLOUD_W + 0.5
    );
    const len = signalWorld.distanceTo(beam.position);
    beam.lookAt(signalWorld);
    beam.scale.set(48, 48, len);
    beam.material.uniforms.uFlicker.value = 0.92 + Math.sin(t * 13.0) * 0.03 + Math.sin(t * 2.3) * 0.05;

    // Rain stays around the camera.
    rain.position.set(camera.position.x, 0, camera.position.z - 30);
    rainUniforms.uTime.value = reducedMotion ? 0 : t;
    cloudUniforms.uTime.value = t;

    // Lightning
    if (!reducedMotion) {
      nextFlash -= dt;
      if (nextFlash < 0) { flash = 1; nextFlash = 9 + Math.random() * 14; }
      flash *= Math.pow(0.02, dt);
      const strobe = flash > 0.05 ? flash * (0.6 + 0.4 * Math.sin(t * 60)) : 0;
      cloudUniforms.uFlash.value = strobe;
      ambient.intensity = 0.6 + strobe * 2.2;
    }

    if (QUALITY[level].bloom) composer.render();
    else renderer.render(scene, camera);
    if (first) { first = false; requestAnimationFrame(hideLoader); }
    requestAnimationFrame(frame);
  }
  frame();
}
