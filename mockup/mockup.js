/**
 * Standalone mock-up driver.
 *
 * Loads the shared PV3D engine, detects the panels in house2.glb and feeds them
 * with *simulated* sensor data so the visualisation can be evaluated without a
 * running Home Assistant. The exact same engine is used by the Lovelace card
 * (see ../custom_components/pv_3d_bargraph/frontend/pv-3d-bargraph-card.js),
 * the only difference is where the values come from.
 */

import { PV3DScene } from '../custom_components/pv_3d_bargraph/frontend/pv3d-engine.js';

const MAX_W = 370; // Wp per panel at full sun (mock)
const STORE_KEY = 'pv3d-panel-map'; // { [panelId]: entityId }

const scene = new PV3DScene(document.getElementById('scene'), {
  maxValue: MAX_W,
  unit: 'W',
  autoRotate: false,
  tintPanels: true,
  showLabels: true,
});
// Exposed for debugging in the browser console.
window.pv3d = scene;

const els = {
  count: document.getElementById('s-count'),
  total: document.getElementById('s-total'),
  peak: document.getElementById('s-peak'),
  loading: document.getElementById('loading'),
  legMax: document.getElementById('leg-max'),
  btnSim: document.getElementById('btn-sim'),
  btnRotate: document.getElementById('btn-rotate'),
  btnTint: document.getElementById('btn-tint'),
  rows: document.getElementById('panel-rows'),
  btnYaml: document.getElementById('btn-yaml'),
  mapStatus: document.getElementById('map-status'),
};
els.legMax.textContent = `${MAX_W} W`;

let panels = [];
let simulate = true;
let entityMap = loadMap(); // { panelId: entityId }
const rowEls = new Map(); // panelId -> { power, input }

/**
 * Per-panel simulation profile. Each panel gets a slightly different
 * orientation factor + phase so the little "sun sweep" looks organic.
 */
const profiles = [];

init();

async function init() {
  try {
    panels = await scene.loadModel('./house2.glb');
  } catch (err) {
    els.loading.innerHTML =
      `<div style="max-width:360px;text-align:center;color:#ff9b8a">` +
      `Kon het model niet laden.<br><small>${err}</small><br><br>` +
      `Start een lokale webserver in de projectmap, bijv.:<br>` +
      `<code>python -m http.server 8000</code><br>en open ` +
      `<code>http://localhost:8000/mockup/</code></div>`;
    return;
  }

  els.loading.style.display = 'none';
  els.count.textContent = panels.length;

  // Give every detected panel an id + friendly name. In Home Assistant this
  // is where you would instead map panel.id -> a sensor entity_id.
  scene.applyPanelConfig(
    panels.map((p, i) => ({ id: p.id, name: `Paneel ${i + 1}` })),
  );

  panels.forEach((p, i) => {
    profiles.push({
      // orientation efficiency 0.6..1.0, random phase, base offset
      eff: 0.6 + Math.random() * 0.4,
      phase: Math.random() * Math.PI * 2,
      jitter: 0.85 + Math.random() * 0.3,
    });
  });

  buildTable();
  tick();
  setInterval(tick, 1000);
}

/** One simulation step: compute a value per panel and push it to the engine. */
function tick() {
  if (!simulate) return;
  // Compress a day into ~40s so the sweep is visible during a demo.
  const dayPhase = ((Date.now() / 40000) % 1) * Math.PI; // 0..pi (sunrise->sunset)
  const sun = Math.sin(dayPhase); // 0..1..0

  const values = {};
  let total = 0;
  let peak = { id: null, v: -1 };

  panels.forEach((p, i) => {
    const pr = profiles[i];
    const cloud = 0.75 + 0.25 * Math.sin(Date.now() / 5000 + pr.phase);
    let v = MAX_W * sun * pr.eff * cloud * pr.jitter;
    v = Math.max(0, v + (Math.random() - 0.5) * 8);
    values[p.id] = { value: v, name: p.name, unit: 'W', max: MAX_W };
    total += v;
    if (v > peak.v) peak = { id: p.id, name: p.name, v };
    updateRowPower(p.id, v);
  });

  scene.setValues(values);

  els.total.textContent = `${Math.round(total)} W`;
  els.peak.textContent = peak.id
    ? `${peak.name} · ${Math.round(peak.v)} W`
    : '–';
}

/* ---- Panel mapping table ---- */

/** Build one row per detected panel: id, live power and an entity input. */
function buildTable() {
  els.rows.innerHTML = '';
  rowEls.clear();
  panels.forEach((p, i) => {
    const tr = document.createElement('tr');

    const tdId = document.createElement('td');
    tdId.className = 'id';
    tdId.textContent = p.id;

    const tdPower = document.createElement('td');
    tdPower.className = 'power';
    tdPower.innerHTML = '<span class="dot"></span>0 W';

    const tdEntity = document.createElement('td');
    const input = document.createElement('input');
    input.className = 'entity';
    input.type = 'text';
    input.placeholder = 'sensor.pv_...';
    input.value = entityMap[p.id] || '';
    input.spellcheck = false;
    input.addEventListener('input', () => {
      const val = input.value.trim();
      if (val) entityMap[p.id] = val;
      else delete entityMap[p.id];
      saveMap();
    });
    tdEntity.appendChild(input);

    tr.append(tdId, tdPower, tdEntity);
    els.rows.appendChild(tr);
    rowEls.set(p.id, { power: tdPower, input });
  });
  updateMapStatus();
}

/** Update a single row's live power cell + its indicator colour. */
function updateRowPower(id, value) {
  const row = rowEls.get(id);
  if (!row) return;
  const t = Math.max(0, Math.min(1, value / MAX_W));
  row.power.innerHTML =
    `<span class="dot" style="background:${colorFor(t)}"></span>${Math.round(value)} W`;
}

/** Match the engine's power gradient for the row indicator dots. */
function colorFor(t) {
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
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
      return `rgb(${r},${g},${b})`;
    }
  }
  return 'rgb(118,255,3)';
}

function updateMapStatus() {
  const mapped = panels.filter((p) => entityMap[p.id]).length;
  els.mapStatus.textContent = `${mapped}/${panels.length} gekoppeld`;
}

/* ---- Persistence: browser + downloadable YAML for Home Assistant ---- */

function loadMap() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveMap() {
  localStorage.setItem(STORE_KEY, JSON.stringify(entityMap));
  updateMapStatus();
}

/**
 * Build a YAML document that the Home Assistant integration understands
 * (custom_components/pv_3d_bargraph reads the same `panels:` schema as the
 * Lovelace card). Only mapped panels are written; unmapped ones are listed as
 * comments so nothing is silently lost.
 */
function buildYaml() {
  const lines = [
    '# PV 3D Bar-Graph — paneel-koppeling',
    '# Gegenereerd door de mock-up. Plaats dit bestand als',
    '#   <config>/pv_3d_bargraph.yaml',
    '# of neem de `panels:`-lijst over in je Lovelace-kaart.',
    '',
    '# Welke GLB de integratie gebruikt. Exporteer eigen modellen met dezelfde',
    '# oriëntatie als house2.glb; de vaste rotatie blijft altijd behouden.',
    'model_url: /pv_3d_bargraph/house2.glb',
    'panels:',
  ];
  panels.forEach((p, i) => {
    const entity = entityMap[p.id];
    const name = `Paneel ${i + 1}`;
    if (entity) {
      lines.push(`  - id: ${p.id}`);
      lines.push(`    entity: ${entity}`);
      lines.push(`    name: ${name}`);
      lines.push(`    max_value: ${MAX_W}`);
    } else {
      lines.push(`  # - id: ${p.id}        # nog niet gekoppeld`);
      lines.push(`  #   entity: sensor.____`);
      lines.push(`  #   name: ${name}`);
    }
  });
  return lines.join('\n') + '\n';
}

function downloadYaml() {
  const blob = new Blob([buildYaml()], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pv_3d_bargraph.yaml';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---- HUD controls ---- */
els.btnSim.addEventListener('click', () => {
  simulate = !simulate;
  els.btnSim.classList.toggle('active', simulate);
  els.btnSim.textContent = `Simulatie: ${simulate ? 'aan' : 'uit'}`;
  if (!simulate) {
    // freeze current values (already displayed)
  } else {
    tick();
  }
});

els.btnRotate.addEventListener('click', () => {
  scene.controls.autoRotate = !scene.controls.autoRotate;
  els.btnRotate.classList.toggle('active', scene.controls.autoRotate);
});

els.btnTint.addEventListener('click', () => {
  const on = !scene.opts.tintPanels;
  scene.setTintEnabled(on);
  els.btnTint.classList.toggle('active', on);
});

els.btnYaml.addEventListener('click', downloadYaml);
