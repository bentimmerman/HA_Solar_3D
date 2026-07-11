/**
 * PV 3D Bar-Graph — Home Assistant Lovelace card
 * ==============================================
 * A custom dashboard card that renders a 3D building model and plots the live
 * output of individual PV panels as bars on top of each panel.
 *
 * It reuses the exact same rendering engine as the standalone mock-up
 * (./pv3d-engine.js); the only card-specific job is to translate Home
 * Assistant entity states into panel values.
 *
 * Example configuration:
 *
 *   type: custom:pv-3d-bargraph-card
 *   title: Zonnepanelen
 *   model_url: /pv_3d_bargraph/house2.glb  # default, served by the integration
 *   max_value: 350        # value (in `unit`) that maps to a full-height bar
 *   unit: W
 *   auto_rotate: false
 *   tint_panels: true
 *   show_labels: true
 *   panels:
 *     - id: panel_01
 *       entity: sensor.pv_paneel_1_power
 *       name: Paneel Zuid 1
 *     - id: panel_02
 *       entity: sensor.pv_paneel_2_power
 *
 * Don't know the panel ids yet? Add the card without a `panels:` list and the
 * card overlays the auto-detected ids on the model so you can copy them.
 */

import { PV3DScene } from './pv3d-engine.js';

const DEFAULTS = {
  model_url: '/pv_3d_bargraph/house2.glb',
  max_value: 350,
  unit: 'W',
  auto_rotate: false,
  tint_panels: true,
  show_labels: true,
};

class PV3DBarGraphCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._scene = null;
    this._panels = [];
    this._ready = false;
    this._panelsResolved = false;
    this._modelUrlInline = false;
    this._stored = null;
    this._storedFetched = false;
    this._config = null;
    this._hass = null;
  }

  /* -- Lovelace lifecycle ------------------------------------------------ */

  setConfig(config) {
    this._modelUrlInline = !!(config && config.model_url);
    this._config = Object.assign({}, DEFAULTS, config || {});
    if (!Array.isArray(this._config.panels)) this._config.panels = [];
    this._panelsResolved = this._config.panels.length > 0;
    this._render();
    // If a scene already exists (config changed at runtime), rebuild it.
    if (this._scene) {
      this._teardownScene();
      this._initScene();
    }
  }

  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;
    if (this._ready) this._pushValues();
    // The scene may have been built before `hass` was available, so we could
    // not yet read the stored YAML config (model_url + panel mapping). Fetch
    // it now and rebuild once if something is still unresolved.
    if (
      firstHass &&
      this._ready &&
      !this._storedFetched &&
      this._hass &&
      this._hass.callApi &&
      (!this._modelUrlInline || !this._panelsResolved)
    ) {
      this._teardownScene();
      this._initScene();
    }
  }

  getCardSize() {
    return 8;
  }

  static getStubConfig() {
    // No model_url here on purpose: that lets a model_url set in
    // <config>/pv_3d_bargraph.yaml drive the model for picker-created cards.
    return {
      title: 'Zonnepanelen',
      panels: [],
    };
  }

  connectedCallback() {
    if (!this._scene && this._config) this._initScene();
  }

  disconnectedCallback() {
    this._teardownScene();
  }

  /* -- Rendering --------------------------------------------------------- */

  _render() {
    const title = this._config.title
      ? `<div class="title">${this._config.title}</div>`
      : '';
    this.shadowRoot.innerHTML = `
      <style>
        ha-card {
          overflow: hidden;
          height: 100%;
        }
        .title {
          padding: 12px 16px 4px;
          font-size: 1.2rem;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        .stage {
          position: relative;
          width: 100%;
          height: var(--pv3d-height, 420px);
          background: radial-gradient(circle at 50% 30%, #14263a, #0a1420);
        }
        .overlay {
          position: absolute;
          left: 12px;
          bottom: 12px;
          padding: 10px 12px;
          font: 12px/1.4 var(--paper-font-body1_-_font-family, sans-serif);
          color: #dfe9f7;
          background: rgba(12, 22, 36, 0.82);
          border: 1px solid rgba(120, 170, 255, 0.28);
          border-radius: 10px;
          max-width: 60%;
          display: none;
        }
        .overlay code {
          color: #7cc0ff;
        }
        .error {
          position: absolute;
          inset: 0;
          display: none;
          place-items: center;
          text-align: center;
          padding: 24px;
          color: #ff9b8a;
        }
      </style>
      <ha-card>
        ${title}
        <div class="stage">
          <div class="stage-canvas"></div>
          <div class="overlay"></div>
          <div class="error"></div>
        </div>
      </ha-card>
    `;
    this._stage = this.shadowRoot.querySelector('.stage-canvas');
    this._overlay = this.shadowRoot.querySelector('.overlay');
    this._errorBox = this.shadowRoot.querySelector('.error');
  }

  async _initScene() {
    if (!this._stage || this._scene) return;
    try {
      // Read the stored YAML config first (model_url + panel mapping) so we
      // can honour a configured model before loading anything.
      const stored = await this._fetchStored();

      // Model file precedence: inline card `model_url` > stored YAML > default.
      let modelUrl = this._config.model_url;
      if (!this._modelUrlInline && stored && stored.model_url) {
        modelUrl = stored.model_url;
        this._config.model_url = modelUrl;
      }

      this._scene = new PV3DScene(this._stage, {
        maxValue: Number(this._config.max_value) || DEFAULTS.max_value,
        unit: this._config.unit || DEFAULTS.unit,
        autoRotate: !!this._config.auto_rotate,
        tintPanels: this._config.tint_panels !== false,
        showLabels: this._config.show_labels !== false,
      });
      // The engine always applies the same fixed orientation to the GLB, so a
      // different model exported with the original orientation lands identically.
      this._panels = await this._scene.loadModel(modelUrl);

      // Panel mapping precedence: inline `panels:` > stored YAML mapping.
      if (
        !this._panelsResolved &&
        stored &&
        Array.isArray(stored.panels) &&
        stored.panels.length
      ) {
        this._config.panels = stored.panels;
        this._panelsResolved = true;
      }
      this._scene.applyPanelConfig(
        this._config.panels.map((p) => ({ id: p.id, name: p.name })),
      );

      this._ready = true;
      this._maybeShowDiscovery();
      this._pushValues();
    } catch (err) {
      this._showError(err);
    }
  }

  /**
   * Fetch the config the integration stored in its YAML file (model_url +
   * panel mapping) via the REST endpoint. Cached; safe to call before `hass`
   * is available (returns null in that case). This is the same file the
   * mock-up exports, so a mapping made there works here too.
   */
  async _fetchStored() {
    if (this._storedFetched) return this._stored;
    if (!this._hass || !this._hass.callApi) return null;
    try {
      const res = await this._hass.callApi('GET', 'pv_3d_bargraph/panels');
      this._stored = res && typeof res === 'object' ? res : {};
    } catch (err) {
      this._stored = {};
      // Endpoint is optional; fall back to inline config / auto-detected ids.
      // eslint-disable-next-line no-console
      console.debug('[pv-3d-bargraph] no stored config:', err);
    }
    this._storedFetched = true;
    return this._stored;
  }

  /**
   * When no panels are configured yet, list the auto-detected ids so the user
   * can copy them straight into their card configuration.
   */
  _maybeShowDiscovery() {
    if (this._config.panels.length > 0) return;
    const ids = this._panels.map((p) => p.id);
    this._overlay.style.display = 'block';
    this._overlay.innerHTML =
      `<b>${ids.length} panelen gedetecteerd.</b><br>` +
      `Koppel ze in de kaartconfiguratie:<br>` +
      ids.map((id) => `&bull; <code>${id}</code>`).join('<br>');
    // Also log so it can be copied from dev tools.
    // eslint-disable-next-line no-console
    console.info('[pv-3d-bargraph] detected panels:', ids);
  }

  _showError(err) {
    if (!this._errorBox) return;
    this._errorBox.style.display = 'grid';
    this._errorBox.innerHTML =
      `Kon het model niet laden.<br><small>${err}</small>`;
  }

  /* -- Data -------------------------------------------------------------- */

  _pushValues() {
    if (!this._scene || !this._hass) return;
    const values = {};
    for (const p of this._config.panels) {
      if (!p.id || !p.entity) continue;
      const st = this._hass.states[p.entity];
      const raw = st ? Number(st.state) : NaN;
      const unit =
        p.unit ||
        (st && st.attributes && st.attributes.unit_of_measurement) ||
        this._config.unit;
      values[p.id] = {
        value: Number.isFinite(raw) ? raw : 0,
        name: p.name || (st && st.attributes && st.attributes.friendly_name) || p.id,
        unit,
        max: Number(p.max_value) || Number(this._config.max_value) || DEFAULTS.max_value,
      };
    }
    this._scene.setValues(values);
  }

  _teardownScene() {
    if (this._scene) {
      this._scene.dispose();
      this._scene = null;
    }
    this._ready = false;
  }
}

customElements.define('pv-3d-bargraph-card', PV3DBarGraphCard);

// Register in the card picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'pv-3d-bargraph-card',
  name: 'PV 3D Bar-Graph',
  description: 'Toont de opbrengst van individuele PV-panelen als 3D-staafgrafiek op een GLB-model.',
  preview: false,
});

// eslint-disable-next-line no-console
console.info('%c PV-3D-BARGRAPH %c loaded ', 'background:#2196f3;color:#fff;border-radius:3px 0 0 3px;padding:2px 4px', 'background:#0a1420;color:#7cc0ff;border-radius:0 3px 3px 0;padding:2px 4px');
