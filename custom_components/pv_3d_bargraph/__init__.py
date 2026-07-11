"""The PV 3D Bar-Graph integration.

This integration is intentionally light-weight: it does not create any
entities. Its only job is to serve the Lovelace card, its rendering engine and
the bundled GLB model to the frontend, and to register the card as an extra JS
module so it is available on every dashboard without manual resource setup.

All visual configuration (which panel maps to which sensor) is done in the
``custom:pv-3d-bargraph-card`` card itself.
"""

from __future__ import annotations

import logging
import os

import yaml

from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, PANELS_FILE, URL_BASE

_LOGGER = logging.getLogger(__name__)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "frontend")
CARD_URL = f"{URL_BASE}/pv-3d-bargraph-card.js"


def _panels_path(hass: HomeAssistant) -> str:
    """Absolute path of the panel-mapping YAML file in the HA config dir."""
    return hass.config.path(PANELS_FILE)


def _load_config(path: str) -> dict:
    """Read the whole mapping document (blocking).

    Returns a dict that may contain ``model_url`` and ``panels``.
    """
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    return data if isinstance(data, dict) else {}


def _save_config(path: str, model_url: str | None, panels: list[dict]) -> None:
    """Persist the mapping document to the YAML file (blocking)."""
    doc: dict = {}
    if model_url:
        doc["model_url"] = model_url
    doc["panels"] = panels
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("# PV 3D Bar-Graph — configuratie (beheerd via de kaart/mock-up)\n")
        yaml.safe_dump(doc, handle, allow_unicode=True, sort_keys=False)


class PanelsView(HomeAssistantView):
    """REST endpoint to load/save the panel -> sensor mapping as YAML.

    ``GET``  returns the stored config (``model_url`` + ``panels``) so the card
    can restore it.
    ``POST`` writes the mapping (e.g. from the card editor or the mock-up's
    exported file), keeping everything in a single human-editable YAML file.
    """

    url = "/api/pv_3d_bargraph/panels"
    name = "api:pv_3d_bargraph:panels"
    requires_auth = True

    async def get(self, request):
        """Return the stored config (model + panel mapping)."""
        hass: HomeAssistant = request.app["hass"]
        path = _panels_path(hass)
        data = await hass.async_add_executor_job(_load_config, path)
        panels = data.get("panels")
        result = {"panels": panels if isinstance(panels, list) else []}
        model_url = data.get("model_url")
        if isinstance(model_url, str) and model_url:
            result["model_url"] = model_url
        return self.json(result)

    async def post(self, request):
        """Store the posted config (panel mapping, optional model_url)."""
        hass: HomeAssistant = request.app["hass"]
        try:
            body = await request.json()
        except ValueError:
            return self.json_message("Invalid JSON", status_code=400)
        panels = body.get("panels")
        if not isinstance(panels, list):
            return self.json_message("`panels` must be a list", status_code=400)
        path = _panels_path(hass)
        # Preserve an existing model_url unless a new one is supplied.
        existing = await hass.async_add_executor_job(_load_config, path)
        model_url = body.get("model_url") or existing.get("model_url")
        await hass.async_add_executor_job(_save_config, path, model_url, panels)
        return self.json({"ok": True, "count": len(panels)})


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the frontend folder, register the API and load the card module."""
    if hass.data.get(f"{DOMAIN}_frontend_registered"):
        return

    await hass.http.async_register_static_paths(
        [StaticPathConfig(URL_BASE, FRONTEND_DIR, cache_headers=False)]
    )
    hass.http.register_view(PanelsView())
    add_extra_js_url(hass, CARD_URL)

    hass.data[f"{DOMAIN}_frontend_registered"] = True
    _LOGGER.debug("Registered PV 3D Bar-Graph frontend at %s", URL_BASE)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up via YAML (also covers the case of no config entry)."""
    await _async_register_frontend(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up from a config entry created through the UI."""
    await _async_register_frontend(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry.

    The static path and JS URL stay registered for the lifetime of the running
    instance; nothing entry-specific needs tearing down.
    """
    return True
