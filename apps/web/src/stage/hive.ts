/**
 * The studio floor behind the shared screen: a honeycomb of tiles running back into the haze, with
 * a slow swell rolling through it, pools of coloured light, and ripples that cross it when
 * something happens in the game.
 *
 * It is one mesh drawn in one call. The tiles never move on the CPU: where each one stands, how
 * high the swell and the ripples lift it and how it is lit are all worked out in the shaders from a
 * handful of uniforms, so a frame costs the same whether nothing is happening or everything is.
 * This is the only file that imports three, and it is loaded after the screen is up.
 */
import {
  BufferAttribute, BufferGeometry, CylinderGeometry, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, PerspectiveCamera, Scene, ShaderMaterial, Vector2, Vector3, Vector4, WebGLRenderer,
} from 'three';
import type { Look, Rgb } from './lighting';

/** How the floor is being drawn: every frame at full size, every frame at a smaller one, or only when the lights change. */
export type Quality = 'full' | 'lean' | 'still';

export interface Hive {
  /** Light the floor this way from now on. `dimmed` holds it low and stops the swell, for a game that is paused. */
  light(look: Look, dimmed: boolean): void;
  /** Send a ripple out from a point on the screen, given as fractions of its width and height from the top left. */
  ripple(x: number, y: number, color: Rgb, strength: number): void;
  dispose(): void;
}

export interface HiveOptions {
  /** Draw single frames and never animate: for anyone who has asked their device for less motion. */
  still: boolean;
  onQuality: (quality: Quality) => void;
  /** The browser has taken the graphics context away. The floor does not wait to see whether it comes back. */
  onLost: () => void;
}

const RIPPLES = 6;
/** The most pixels drawn per frame, a little over a 1080p screen's worth: a backdrop does not need a 4K television's every pixel. */
const MAX_PIXELS = 2_400_000;
/** Each step down in size when frames are late, as a share of the full size. */
const SCALES = [1, 0.7, 0.5];

/** The backdrop of base.css, in the same colours, so the floor fades into what every other page has behind it. */
const SKY = /* glsl */ `
  uniform vec3 uGlow;
  uniform float uDim;
  vec3 sky(vec2 uv) {
    vec3 ink = mix(vec3(0.027, 0.024, 0.102), vec3(0.082, 0.071, 0.2), uv.y);
    vec2 d = (uv - vec2(0.5, 1.1)) / vec2(1.2, 0.8);
    return ink + uGlow * 0.38 * max(0.0, 1.0 - length(d) / 0.6);
  }
`;

const FLOOR_VERTEX = /* glsl */ `
  attribute vec3 aCell;
  uniform float uTime;
  uniform float uNow;
  uniform float uSwell;
  uniform float uSparkle;
  uniform vec4 uRipple[${RIPPLES}];
  uniform vec3 uRippleColor[${RIPPLES}];
  varying vec3 vLocal;
  varying vec3 vWorld;
  varying vec3 vFlash;
  varying float vTop;
  varying float vLift;
  varying float vTwinkle;
  varying float vDepth;

  void main() {
    vec2 cell = aCell.xy;
    float seed = aCell.z;

    // Two long waves crossing each other: a swell with no pattern the eye can catch repeating.
    float wave = sin(cell.x * 0.43 + uTime * 0.5) * cos(cell.y * 0.37 - uTime * 0.38) * 0.55 + sin((cell.x - cell.y) * 0.23 + uTime * 0.27 + 1.7) * 0.45;
    float lift = uSwell * (0.65 + 0.65 * wave);

    // A ripple is a ring that widens and fades as it travels out from where it started.
    vec3 flash = vec3(0.0);
    for (int i = 0; i < ${RIPPLES}; i++) {
      float age = uNow - uRipple[i].z;
      if (uRipple[i].w <= 0.0 || age < 0.0) continue;
      float ring = (distance(cell, uRipple[i].xy) - age * 10.0) / (1.8 + age * 0.9);
      float k = exp(-ring * ring) * exp(-age * 0.75) * uRipple[i].w;
      lift += k * 0.9;
      flash += uRippleColor[i] * k;
    }

    // Some tiles, each in its own time, light up for a moment.
    float chosen = smoothstep(1.0 - uSparkle, 1.08 - uSparkle, fract(seed * 7.31));
    float twinkle = chosen * pow(max(0.0, sin(uTime * (0.5 + seed) + seed * 40.0)), 20.0);
    lift += twinkle * 0.22;

    float top = step(0.0, position.y);
    vec3 world = vec3(position.x * 0.95 + cell.x, mix(-4.0, lift + seed * 0.1, top), position.z * 0.95 + cell.y);
    vec4 view = viewMatrix * vec4(world, 1.0);

    vLocal = position;
    vWorld = world;
    vFlash = flash;
    vTop = step(0.5, normal.y);
    vLift = lift;
    vTwinkle = twinkle;
    vDepth = -view.z;
    gl_Position = projectionMatrix * view;
  }
`;

const FLOOR_FRAGMENT = /* glsl */ `
  ${SKY}
  uniform vec2 uResolution;
  uniform vec3 uKey;
  uniform vec3 uLeft;
  uniform vec3 uRight;
  uniform float uLevel;
  varying vec3 vLocal;
  varying vec3 vWorld;
  varying vec3 vFlash;
  varying float vTop;
  varying float vLift;
  varying float vTwinkle;
  varying float vDepth;

  float pool(vec2 at, float reach) {
    float k = max(0.0, 1.0 - distance(vWorld.xz, at) / reach);
    return k * k;
  }

  void main() {
    // How far across the top of its tile this pixel is: 0 in the middle, 1 on the edge.
    vec2 p = abs(vLocal.xz);
    float across = max(p.x, 0.5 * p.x + 0.8660254 * p.y) / 0.8660254;
    float rim = smoothstep(0.8, 0.97, across) * vTop;

    vec3 facet = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    float side = (1.0 - vTop) * (0.4 + 0.6 * max(0.0, dot(facet, vec3(-0.37, 0.28, 0.89))));

    vec3 light = (uKey * 0.5 * pool(vec2(0.0, -6.0), 22.0) + uLeft * pool(vec2(-14.0, 6.0), 16.0) + uRight * pool(vec2(14.0, 6.0), 16.0)) * uLevel;
    vec3 color = mix(vec3(0.034, 0.03, 0.1) * side, vec3(0.062, 0.053, 0.165), vTop);
    color += light * (vTop * (0.11 + 0.26 * rim + 0.2 * vLift) + side * 0.12);
    color += vec3(0.75, 0.72, 1.0) * (rim * 0.035 + vTop * vLift * 0.02);
    color += (uKey * 0.4 + 0.06) * vTwinkle * vTop * uLevel;
    color += vFlash * (vTop * (0.13 + 0.42 * rim) + side * 0.3);

    float haze = smoothstep(14.0, 35.0, vDepth);
    gl_FragColor = vec4(mix(color, sky(gl_FragCoord.xy / uResolution), haze) * uDim, 1.0);
  }
`;

const SKY_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  ${SKY}
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(sky(vUv) * uDim, 1.0);
  }
`;

/** A honeycomb of tile positions wide and deep enough to fill the view of the widest screen. Each also gets a number of its own, for what should differ from tile to tile. */
function cells(): Float32Array {
  const out: number[] = [];
  const across = Math.sqrt(3);
  for (let row = 0, z = 10; z > -31; row++, z -= 1.5) {
    for (let x = -36 + (row % 2 ? across / 2 : 0); x < 36; x += across) {
      // A hash of where it stands: the same floor on every screen, with no pattern to it.
      const hash = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      out.push(x, z, hash - Math.floor(hash));
    }
  }
  return new Float32Array(out);
}

export function createHive(canvas: HTMLCanvasElement, { still, onQuality, onLost }: HiveOptions): Hive {
  // Throws where there is no WebGL to be had; whoever asked for a floor falls back to the flat backdrop.
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(0x0d0b22);

  const camera = new PerspectiveCamera(36, 1, 1, 80);
  camera.position.set(0, 16, 15);
  camera.lookAt(0, 0, -3);

  const shared = {
    uGlow: { value: new Vector3() },
    uDim: { value: 1 },
  };
  const uniforms = {
    ...shared,
    uTime: { value: 0 },
    uNow: { value: 0 },
    uSwell: { value: 0 },
    uSparkle: { value: 0 },
    uLevel: { value: 0 },
    uKey: { value: new Vector3() },
    uLeft: { value: new Vector3() },
    uRight: { value: new Vector3() },
    uResolution: { value: new Vector2(1, 1) },
    // x, z, when it started and how strong. None has started yet, so none has any strength (a Vector4 starts with a w of 1).
    uRipple: { value: Array.from({ length: RIPPLES }, () => new Vector4(0, 0, 0, 0)) },
    uRippleColor: { value: Array.from({ length: RIPPLES }, () => new Vector3()) },
  };

  const tile = new CylinderGeometry(1, 1, 1, 6, 1);
  const floorGeometry = new InstancedBufferGeometry();
  floorGeometry.index = tile.index;
  floorGeometry.setAttribute('position', tile.getAttribute('position'));
  floorGeometry.setAttribute('normal', tile.getAttribute('normal'));
  const places = cells();
  floorGeometry.setAttribute('aCell', new InstancedBufferAttribute(places, 3));
  floorGeometry.instanceCount = places.length / 3;
  const floorMaterial = new ShaderMaterial({ uniforms, vertexShader: FLOOR_VERTEX, fragmentShader: FLOOR_FRAGMENT });
  const floor = new Mesh(floorGeometry, floorMaterial);
  // Its tiles are placed in the shader, so the bounds three would cull it by mean nothing.
  floor.frustumCulled = false;

  // One triangle that covers the screen, drawn first and behind everything.
  const skyGeometry = new BufferGeometry();
  skyGeometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const skyMaterial = new ShaderMaterial({ uniforms: shared, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT, depthTest: false, depthWrite: false });
  const sky = new Mesh(skyGeometry, skyMaterial);
  sky.frustumCulled = false;
  sky.renderOrder = -1;

  const scene = new Scene();
  scene.add(sky, floor);

  // ---------------------------------------------------------------- lights

  let target: Look | null = null;
  let dim = 1;
  let pace = 1;
  /** Move every light a share of the way to where it should be; all the way, given 1. */
  const ease = (share: number) => {
    if (!target) return;
    const to = (v: Vector3, [r, g, b]: Rgb) => v.set(v.x + (r - v.x) * share, v.y + (g - v.y) * share, v.z + (b - v.z) * share);
    to(uniforms.uGlow.value, target.glow);
    to(uniforms.uKey.value, target.key);
    to(uniforms.uLeft.value, target.left);
    to(uniforms.uRight.value, target.right);
    uniforms.uLevel.value += (target.level - uniforms.uLevel.value) * share;
    uniforms.uSwell.value += (target.swell - uniforms.uSwell.value) * share;
    uniforms.uSparkle.value += (target.sparkle - uniforms.uSparkle.value) * share;
    uniforms.uDim.value += (dim - uniforms.uDim.value) * share;
    pace += ((dim < 1 ? 0 : target.pace) - pace) * share;
  };

  // ---------------------------------------------------------------- size

  let scale = 0;
  const fit = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (width * height))) * SCALES[scale];
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    renderer.getDrawingBufferSize(uniforms.uResolution.value);
    camera.aspect = width / height;
    // A screen taller than it is wide sees a narrow strip of floor; from further back it sees enough of it.
    camera.fov = camera.aspect < 1 ? 54 : 36;
    camera.updateProjectionMatrix();
  };

  // ---------------------------------------------------------------- frames

  let quality: Quality = still ? 'still' : 'full';
  let frame = 0;
  let last = 0;
  let disposed = false;
  let lost = false;
  /** How long the display takes between frames when nothing is being drawn, and how many frames have gone into finding out. */
  let rest = 0;
  let rested = 0;
  let late = 0;
  let counted = 0;
  /** Seconds since anything changed, while paused: a floor that has stopped moving has no need to be drawn again. */
  let idle = 0;

  const draw = () => renderer.render(scene, camera);
  const running = () => frame !== 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const start = () => {
    if (disposed || lost || running() || quality === 'still' || document.hidden) return;
    last = 0;
    idle = 0;
    frame = requestAnimationFrame(tick);
  };

  function tick(now: number) {
    frame = requestAnimationFrame(tick);
    const dt = last ? now - last : 0;
    last = now;
    // The first few frames draw nothing: they find the display's own pace, which is what "late" is measured against.
    if (rested < 6) {
      if (dt) {
        rest += dt;
        rested++;
      }
      return;
    }
    // A long gap is a tab that was in the background, not a slow frame.
    const step = Math.min(dt, 100) / 1000;
    ease(1 - Math.exp(-step * 2.4));
    uniforms.uTime.value += step * pace;
    uniforms.uNow.value += step;
    draw();

    if (dim < 1 && (idle += step) > 2) return stop();
    if (dt && dt < 250) {
      late += dt;
      if (++counted >= 40) govern();
    }
  }

  /** Frames keep arriving late: draw fewer pixels, and when that is not enough, stop animating and hold a still floor. */
  function govern() {
    const average = late / counted;
    late = counted = 0;
    if (average < Math.max(24, Math.min(rest / 6, 34) * 1.6)) return;
    if (scale < SCALES.length - 1) {
      scale++;
      fit();
      quality = 'lean';
    } else {
      quality = 'still';
      stop();
      ease(1);
      draw();
    }
    onQuality(quality);
  }

  const resized = new ResizeObserver(() => {
    fit();
    if (!running()) draw();
  });
  resized.observe(canvas);

  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);

  const onContextLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    stop();
    onLost();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  fit();
  onQuality(quality);

  let slot = 0;
  const ground = new Vector3();
  return {
    light(look, dimmed) {
      const first = target === null;
      target = look;
      dim = dimmed ? 0.5 : 1;
      if (first || quality === 'still') {
        ease(1);
        if (!disposed && !lost) draw();
      }
      start();
    },
    ripple(x, y, color, strength) {
      if (quality === 'still' || disposed || lost) return;
      // Where on the floor the eye sees that point of the screen; a point above the far edge counts as the far edge.
      ground.set(x * 2 - 1, 1 - y * 2, 0.5).unproject(camera).sub(camera.position).normalize();
      const reach = ground.y < -0.05 ? Math.min(-camera.position.y / ground.y, 46) : 46;
      ground.multiplyScalar(reach).add(camera.position);
      uniforms.uRipple.value[slot].set(ground.x, ground.z, uniforms.uNow.value, strength);
      uniforms.uRippleColor.value[slot].set(...color);
      slot = (slot + 1) % RIPPLES;
      start();
    },
    dispose() {
      disposed = true;
      stop();
      resized.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      tile.dispose();
      floorGeometry.dispose();
      floorMaterial.dispose();
      skyGeometry.dispose();
      skyMaterial.dispose();
      renderer.dispose();
    },
  };
}
