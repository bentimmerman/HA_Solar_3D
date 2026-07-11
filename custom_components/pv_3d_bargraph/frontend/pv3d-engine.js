/**
 * PV 3D Bar-Graph engine
 * =======================
 * Framework-agnostic rendering core, shared by the Home Assistant Lovelace
 * card and the standalone mock-up. It:
 *
 *   1. Loads a GLB model of a building.
 *   2. Auto-detects the (black) PV panels by clustering connected
 *      black-material geometry into individual panels.
 *   3. Draws a 3D bar on top of each panel whose height + colour represent
 *      a value (e.g. the live power of a Home Assistant sensor).
 *
 * The engine only knows about panel *ids* and *values*; the mapping between a
 * panel and a Home Assistant entity lives in the card / mock-up configuration.
 *
 * Three.js is loaded from a CDN as an ES module so the file works both inside
 * Home Assistant and in a plain browser.
 */

// The `+esm` endpoints let jsDelivr resolve the bare `three` imports that the
// example modules (GLTFLoader/OrbitControls) use, so this works both in a
// plain browser and inside Home Assistant without an import map.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js/+esm';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js/+esm';

/**
 * Shaders for the flat "fill from the bottom" overlay that is laid directly on
 * top of each PV panel. At 0 W the panel is (near) black; as the value rises
 * the value-colour fills the panel proportionally from the lower edge upward.
 */
const FILL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FILL_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uFill;   // 0..1 fill fraction (bottom -> top)
  uniform vec3  uColor;  // fill colour for the current value
  void main() {
    vec3 col = vec3(0.015);                    // empty area: near black
    if (vUv.y <= uFill) {
      float g = 0.65 + 0.35 * (vUv.y / max(uFill, 0.001));
      col = uColor * g;                         // subtle vertical sheen
    }
    // bright line at the fill level
    float d = uFill - vUv.y;
    if (uFill > 0.002 && d >= 0.0 && d < 0.02) {
      col = mix(vec3(1.0), col, d / 0.02);
    }
    // faint PV-cell grid so the surface reads as a panel
    vec2 grid = abs(fract(vUv * vec2(6.0, 10.0)) - 0.5);
    float line = smoothstep(0.46, 0.5, max(grid.x, grid.y));
    col *= (1.0 - 0.22 * line);
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** Quantise a coordinate so vertices that are visually identical weld together. */
const WELD = 1e-3;
const q = (v) => Math.round(v / WELD);

/** Simple union-find used to group connected black geometry into panels. */
class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // path compression
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Power gradient from dim blue (low) up to green (high). Yellow/red are
 * intentionally omitted: green now represents a full panel (max value).
 * `t` is expected in the 0..1 range.
 */
function powerColor(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0.0, [0x21, 0x96, 0xf3]], // blue
    [0.58, [0x00, 0xe5, 0xd1]], // teal
    [1.0, [0x76, 0xff, 0x03]], // green (= max)
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      const r = c0[0] + (c1[0] - c0[0]) * f;
      const g = c0[1] + (c1[1] - c0[1]) * f;
      const b = c0[2] + (c1[2] - c0[2]) * f;
      return new THREE.Color(r / 255, g / 255, b / 255);
    }
  }
  return new THREE.Color(0x76 / 255, 0xff / 255, 0x03 / 255);
}

export class PV3DScene {
  /**
   * @param {HTMLElement} container Element the canvas is mounted into.
   * @param {object} [options]
   * @param {number} [options.maxValue=350]  Value mapped to a full-height bar.
   * @param {number} [options.barHeight=2.2]  Max bar length in model units.
   * @param {boolean} [options.autoRotate=false]
   * @param {boolean} [options.tintPanels=true] Tint panels by value.
   * @param {boolean} [options.showLabels=true] Draw a value label on each bar.
   * @param {string} [options.unit='W']
   */
  constructor(container, options = {}) {
    this.container = container;
    this.opts = Object.assign(
      {
        maxValue: 350,
        barHeight: 1.8,
        autoRotate: false,
        tintPanels: true,
        showLabels: true,
        unit: 'W',
      },
      options,
    );

    this.panels = []; // [{ id, center, normal, size, meshes, bar, label, tintMats }]
    this._raf = null;
    this._disposed = false;

    this._initRenderer();
    this._initScene();
    this._initLights();
    this._bindEvents();
    this._loop();
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);
  }

  _initScene() {
    this.scene = new THREE.Scene();

    // Soft vertical gradient sky as background.
    this.scene.background = this._gradientTexture('#0b1b2b', '#18344d');

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    this.camera.position.set(14, 11, 16);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = this.opts.autoRotate;
    this.controls.autoRotateSpeed = 0.6;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 120;
    this.controls.maxPolarAngle = Math.PI * 0.495; // stay above the ground

    this.modelRoot = new THREE.Group();
    this.scene.add(this.modelRoot);

    this.overlayRoot = new THREE.Group();
    this.scene.add(this.overlayRoot);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._resize();
  }

  _initLights() {
    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x2b2a26, 0.9);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(18, 26, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 90;
    const s = 26;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
    this.sun = sun;

    const fill = new THREE.DirectionalLight(0x9fbaff, 0.5);
    fill.position.set(-16, 10, -12);
    this.scene.add(fill);
  }

  _gradientTexture(top, bottom) {
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 8, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _bindEvents() {
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);

    this._onPointerMove = (e) => this._handleHover(e);
    this.renderer.domElement.addEventListener('pointermove', this._onPointerMove);

    // Tooltip element.
    this.tooltip = document.createElement('div');
    Object.assign(this.tooltip.style, {
      position: 'absolute',
      pointerEvents: 'none',
      padding: '6px 10px',
      borderRadius: '8px',
      font: '600 12px/1.35 system-ui, sans-serif',
      color: '#fff',
      background: 'rgba(15,25,40,0.92)',
      border: '1px solid rgba(120,170,255,0.35)',
      boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
      transform: 'translate(-50%, calc(-100% - 12px))',
      whiteSpace: 'nowrap',
      opacity: '0',
      transition: 'opacity 0.12s ease',
      zIndex: '10',
    });
    if (getComputedStyle(this.container).position === 'static') {
      this.container.style.position = 'relative';
    }
    this.container.appendChild(this.tooltip);
  }

  _resize() {
    const w = this.container.clientWidth || 640;
    const h = this.container.clientHeight || 420;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------------ */
  /* Model loading & panel detection                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Load a GLB model and detect its PV panels.
   * @param {string} url
   * @returns {Promise<Array>} detected panels (id + geometry info)
   */
  async loadModel(url) {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;

    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          m.side = THREE.DoubleSide;
          m.roughness = m.roughness ?? 0.85;
          // Some exporters (e.g. Onshape) encode transparency in the base
          // colour's alpha but leave alphaMode = OPAQUE, so glTF renderers
          // ignore it. Honour that alpha here so glass/windows show through.
          if (typeof m.opacity === 'number' && m.opacity < 1) {
            m.transparent = true;
            m.depthWrite = false;
          }
        }
      }
    });

    this.modelRoot.add(model);
    // The GLB is authored Z-up (exported from CAD), so it "lies down" in
    // Three.js' Y-up world. Rotate it -90° about X so the building stands on
    // the X-Y plane (i.e. the X-Y plane rests on the ground).
    model.rotation.x = -Math.PI / 2;
    this._frameModel(model);
    this._addGroundPlane(model);

    this.panels = this._detectPanels(model);
    this._buildOverlays();
    return this.panels;
  }

  /** Centre the model at the origin and fit the camera / controls to it. */
  _frameModel(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center); // recentre on origin
    this.modelSize = size;

    const radius = Math.max(size.x, size.y, size.z);
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(radius * 1.1, radius * 0.9, radius * 1.25);
    this.controls.maxDistance = radius * 6;
    this.controls.update();
  }

  _addGroundPlane(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z) * 2.2;
    const geo = new THREE.CircleGeometry(r, 64);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x14212f,
      roughness: 1,
      metalness: 0,
    });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = box.min.y - 0.02;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;

    const grid = new THREE.GridHelper(r * 2, 40, 0x2c5679, 0x1b3350);
    grid.position.y = box.min.y - 0.01;
    grid.material.opacity = 0.25;
    grid.material.transparent = true;
    this.scene.add(grid);
    this.grid = grid;
  }

  /**
   * Detect PV panels: every mesh whose material is (near) black is a piece of
   * a panel. Pieces that share welded vertices belong to the same panel, so we
   * group them with union-find. For each group we compute a centroid, an
   * outward normal (from the largest face) and a size.
   */
  _detectPanels(model) {
    const blackMeshes = [];
    model.updateWorldMatrix(true, true);
    model.traverse((o) => {
      if (o.isMesh && this._isBlack(o.material)) blackMeshes.push(o);
    });

    // 1. Union-find over welded vertex positions.
    const uf = new UnionFind();
    const meshKeys = new Map(); // mesh -> representative vertex key

    const keyOf = (x, y, z) => `${q(x)}|${q(y)}|${q(z)}`;
    const v = new THREE.Vector3();

    for (const mesh of blackMeshes) {
      const pos = mesh.geometry.attributes.position;
      let firstKey = null;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        const key = keyOf(v.x, v.y, v.z);
        if (firstKey === null) firstKey = key;
        uf.union(firstKey, key); // all verts of a mesh are connected
      }
      meshKeys.set(mesh, firstKey);
    }

    // 2. Bucket meshes by their cluster root.
    const clusters = new Map();
    for (const mesh of blackMeshes) {
      const root = uf.find(meshKeys.get(mesh));
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(mesh);
    }

    // 3. Build a panel descriptor per cluster.
    const panels = [];
    for (const meshes of clusters.values()) {
      const panel = this._describeCluster(meshes);
      if (panel) panels.push(panel);
    }

    // 4. Stable, human-friendly ordering: back-to-front, left-to-right.
    panels.sort((a, b) => a.center.z - b.center.z || a.center.x - b.center.x);
    panels.forEach((p, i) => {
      p.index = i;
      p.id = `panel_${String(i + 1).padStart(2, '0')}`;
    });
    return panels;
  }

  _isBlack(material) {
    const mats = Array.isArray(material) ? material : [material];
    return mats.some((m) => {
      if (!m) return false;
      if (typeof m.name === 'string' && m.name.startsWith('0.000000_0.000000_0.000000')) {
        return true;
      }
      const c = m.color;
      return c && c.r < 0.06 && c.g < 0.06 && c.b < 0.06;
    });
  }

  /** Compute centroid, dominant outward normal and size for a cluster. */
  _describeCluster(meshes) {
    const box = new THREE.Box3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const n = new THREE.Vector3();

    let bestArea = 0;
    const bestNormal = new THREE.Vector3(0, 1, 0);
    const bestCentroid = new THREE.Vector3();
    const verts = []; // all world-space vertices, for the in-plane bounds

    const readTri = (mesh, i0, i1, i2) => {
      const pos = mesh.geometry.attributes.position;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
      verts.push(a.clone(), b.clone(), c.clone());
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      n.crossVectors(ab, ac);
      const area = n.length() * 0.5;
      if (area > bestArea) {
        bestArea = area;
        bestNormal.copy(n).normalize();
        bestCentroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      }
    };

    for (const mesh of meshes) {
      const geo = mesh.geometry;
      const index = geo.index;
      if (index) {
        for (let i = 0; i < index.count; i += 3) {
          readTri(mesh, index.getX(i), index.getX(i + 1), index.getX(i + 2));
        }
      } else {
        const cnt = geo.attributes.position.count;
        for (let i = 0; i < cnt; i += 3) readTri(mesh, i, i + 1, i + 2);
      }
    }

    if (bestArea === 0) return null;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // Ensure the normal points "up/outward", away from the building interior.
    if (bestNormal.y < 0) bestNormal.negate();
    const normal = bestNormal.clone();

    // In-plane basis: `up` is the up-slope direction (world-up projected onto
    // the panel), `right` is perpendicular to it within the panel plane. These
    // let us lay a flat "fill from the bottom" overlay on the panel surface.
    let ref = new THREE.Vector3(0, 1, 0);
    if (Math.abs(ref.dot(normal)) > 0.98) ref = new THREE.Vector3(0, 0, 1);
    const up = ref.clone().addScaledVector(normal, -ref.dot(normal)).normalize();
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();

    // Bounds of the panel along the in-plane axes -> overlay width/height.
    let minR = Infinity;
    let maxR = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    const rel = new THREE.Vector3();
    for (const p of verts) {
      rel.subVectors(p, center);
      const dr = rel.dot(right);
      const du = rel.dot(up);
      if (dr < minR) minR = dr;
      if (dr > maxR) maxR = dr;
      if (du < minU) minU = du;
      if (du > maxU) maxU = du;
    }
    const width = Math.max(0.05, maxR - minR);
    const height = Math.max(0.05, maxU - minU);
    const planarCenter = center
      .clone()
      .addScaledVector(right, (minR + maxR) / 2)
      .addScaledVector(up, (minU + maxU) / 2);

    return {
      meshes,
      center, // bounding-box centre of the panel
      base: bestCentroid, // centre of the largest face
      normal,
      right,
      up,
      width,
      height,
      planarCenter,
      size,
      footprint: Math.max(size.x, size.z), // rough panel width
      tintMats: meshes.map((m) => m.material),
      value: 0,
      name: null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Bars                                                                 */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* Flat fill overlays                                                   */
  /* ------------------------------------------------------------------ */

  _buildOverlays() {
    for (const panel of this.panels) {
      // A flat plane laid exactly on the panel surface. A shader fills it from
      // the bottom edge upward, proportional to the value.
      const geo = new THREE.PlaneGeometry(panel.width, panel.height);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uFill: { value: 0 },
          uColor: { value: new THREE.Color(0x2196f3) },
        },
        vertexShader: FILL_VERT,
        fragmentShader: FILL_FRAG,
        side: THREE.DoubleSide,
      });
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -1;

      const fill = new THREE.Mesh(geo, mat);
      fill.renderOrder = 2;
      fill.userData.panel = panel;

      // Orient so local +X = right, +Y = up-slope, +Z = outward normal.
      const basis = new THREE.Matrix4().makeBasis(panel.right, panel.up, panel.normal);
      fill.quaternion.setFromRotationMatrix(basis);
      const eps = Math.max(panel.width, panel.height) * 0.01 + 0.008;
      fill.position.copy(panel.planarCenter).addScaledVector(panel.normal, eps);
      fill.visible = this.opts.tintPanels;

      this.overlayRoot.add(fill);
      panel.fill = fill;

      if (this.opts.showLabels) {
        const label = this._makeLabel('');
        // Anchor the value read-out in the top-right corner of the panel.
        const inset = 0.14;
        label.position
          .copy(panel.planarCenter)
          .addScaledVector(panel.right, panel.width * (0.5 - inset))
          .addScaledVector(panel.up, panel.height * (0.5 - inset))
          .addScaledVector(panel.normal, eps + 0.01);
        label.center.set(1, 1); // pin the sprite's top-right to that corner
        this.overlayRoot.add(label);
        panel.label = label;
      }
    }
  }

  _makeLabel(text) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ depthTest: false, transparent: true }),
    );
    sprite.renderOrder = 999;
    sprite.userData.text = null;
    this._paintLabel(sprite, text);
    return sprite;
  }

  _paintLabel(sprite, text) {
    if (sprite.userData.text === text) return;
    sprite.userData.text = text;
    const pad = 10;
    const font = '600 30px system-ui, sans-serif';
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    const h = 44;
    c.width = w;
    c.height = h;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    // pill background
    ctx.fillStyle = 'rgba(8,14,24,0.78)';
    this._roundRect(ctx, 1, 1, w - 2, h - 2, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(130,180,255,0.4)';
    ctx.lineWidth = 1.5;
    this._roundRect(ctx, 1, 1, w - 2, h - 2, 12);
    ctx.stroke();
    ctx.fillStyle = '#eaf3ff';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2 + 1);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (sprite.material.map) sprite.material.map.dispose();
    sprite.material.map = tex;
    sprite.material.needsUpdate = true;
    const scale = 0.0052;
    sprite.scale.set(w * scale, h * scale, 1);
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ------------------------------------------------------------------ */
  /* Public API: assign config + values                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Attach display names (and any metadata) to detected panels.
   * @param {Array<{id:string,name?:string}>} config
   */
  applyPanelConfig(config = []) {
    const byId = new Map(config.map((p) => [p.id, p]));
    for (const panel of this.panels) {
      const cfg = byId.get(panel.id);
      panel.name = (cfg && cfg.name) || panel.id;
    }
  }

  /** Show or hide the flat value-fill overlays (leaving the bare panels). */
  setTintEnabled(on) {
    this.opts.tintPanels = !!on;
    for (const panel of this.panels) {
      if (panel.fill) panel.fill.visible = !!on;
    }
  }

  /**
   * Update the bars.
   * @param {Object<string,{value:number,name?:string,unit?:string,max?:number}>} values
   *        keyed by panel id.
   */
  setValues(values = {}) {
    for (const panel of this.panels) {
      const entry = values[panel.id];
      const value = entry ? Number(entry.value) || 0 : 0;
      panel.value = value;
      panel.name = (entry && entry.name) || panel.name || panel.id;
      panel.unit = (entry && entry.unit) || this.opts.unit;
      panel._max = (entry && entry.max) || this.opts.maxValue;
      this._applyPanel(panel);
    }
  }

  _applyPanel(panel) {
    const t = Math.max(0, Math.min(1, panel.value / (panel._max || this.opts.maxValue)));
    const color = powerColor(t);

    // Animate the flat fill towards the target level + colour (see _loop).
    panel._targetFill = t;
    panel._targetColor = color;

    if (panel.label) {
      const txt = `${this._fmt(panel.value)} ${panel.unit || this.opts.unit}`;
      this._paintLabel(panel.label, txt);
    }
  }

  _fmt(n) {
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'k';
    return Math.round(n).toString();
  }

  /* ------------------------------------------------------------------ */
  /* Interaction + animation                                             */
  /* ------------------------------------------------------------------ */

  _handleHover(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.overlayRoot.children, false);
    const hit = hits.find((h) => h.object.userData.panel);
    if (hit) {
      const p = hit.object.userData.panel;
      this.tooltip.innerHTML =
        `<b>${p.name || p.id}</b><br>${this._fmt(p.value)} ${p.unit || this.opts.unit}`;
      this.tooltip.style.left = `${e.clientX - rect.left}px`;
      this.tooltip.style.top = `${e.clientY - rect.top}px`;
      this.tooltip.style.opacity = '1';
    } else {
      this.tooltip.style.opacity = '0';
    }
  }

  _loop() {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(() => this._loop());
    this.controls.update();

    // Smoothly animate each panel's fill level + colour towards its target.
    for (const panel of this.panels) {
      if (!panel.fill) continue;
      const u = panel.fill.material.uniforms;
      const target = panel._targetFill ?? 0;
      u.uFill.value += (target - u.uFill.value) * 0.15;
      if (panel._targetColor) u.uColor.value.lerp(panel._targetColor, 0.15);
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    this.renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    if (this.tooltip && this.tooltip.parentNode) {
      this.tooltip.parentNode.removeChild(this.tooltip);
    }
  }
}

export { powerColor };
