"""Config flow for PV 3D Bar-Graph.

A single, data-less config entry. It exists purely so the integration can be
added from the UI (Settings -> Devices & Services -> Add Integration) and to
guarantee the frontend assets get registered on startup.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigFlow

from .const import DOMAIN


class PV3DBarGraphConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for PV 3D Bar-Graph."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Handle the initial step."""
        # Only a single instance is required.
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(title="PV 3D Bar-Graph", data={})

        return self.async_show_form(step_id="user")
