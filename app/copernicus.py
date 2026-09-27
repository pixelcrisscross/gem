"""Copernicus Marine WMTS tile URL builders."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

# Base WMTS endpoint (no authentication required).
_WMTS_BASE = "https://wmts.marine.copernicus.eu/teroWmts"

# Global layers that cover Indian waters. L4 = gap-filled, L3 = daily clear-sky.
# We use L4 for chlorophyll so cloud gaps don't blank the map, and daily
# mean SST from the global physics analysis for temperature.
LAYERS: dict[str, dict] = {
    "CHL": {
        # Global Ocean Colour (Copernicus-GlobColour), L4 gap-filled, 4 km, monthly.
        "product": "OCEANCOLOUR_GLO_BGC_L4_NRT_009_102",
        "layer": "cmems_obs-oc_glo_bgc-plankton_nrt_l4-multi-4km_P1M_202311",
        "variable": "CHL",
        "time_offset_days": 7,           # L4 updates weekly with a lag
        "units": "mg/m³",
        "title": "Chlorophyll-a concentration",
        "legend": [
            {"color": "#3b0f70", "label": "0.01"},
            {"color": "#2c7fb8", "label": "0.1"},
            {"color": "#41b6c4", "label": "0.3"},
            {"color": "#c7e9b4", "label": "1.0"},
            {"color": "#ffffcc", "label": "10+"},
        ],
        "source": "Copernicus Marine · GlobColour L4",
    },
    "SST": {
        # Global Ocean Physics Analysis and Forecast — daily mean SST.
        "product": "GLOBAL_ANALYSISFORECAST_PHY_001_024",
        "layer": "cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m",
        "variable": "thetao",
        "time_offset_days": 2,
        "units": "°C",
        "title": "Sea Surface Temperature",
        "legend": [
            {"color": "#042333", "label": "0"},
            {"color": "#2278b5", "label": "10"},
            {"color": "#7ac7a4", "label": "20"},
            {"color": "#f4d166", "label": "25"},
            {"color": "#e55c3c", "label": "30+"},
        ],
        "source": "Copernicus Marine · GLO PHY 001/024",
    },
    # PFZ uses chlorophyll as the visual layer since chlorophyll fronts
    # are the primary PFZ indicator.
    "PFZ": {
        "product": "OCEANCOLOUR_GLO_BGC_L4_NRT_009_102",
        "layer": "cmems_obs-oc_glo_bgc-plankton_nrt_l4-multi-4km_P1M_202311",
        "variable": "CHL",
        "time_offset_days": 7,
        "units": "mg/m³",
        "title": "Chlorophyll (PFZ indicator)",
        "legend": [
            {"color": "#3b0f70", "label": "0.01"},
            {"color": "#2c7fb8", "label": "0.1"},
            {"color": "#41b6c4", "label": "0.3"},
            {"color": "#c7e9b4", "label": "1.0"},
            {"color": "#ffffcc", "label": "10+"},
        ],
        "source": "Copernicus Marine · GlobColour L4",
    },
}


def _latest_time_iso(days_ago: int) -> str:
    """Copernicus WMTS expects an ISO 8601 time string."""
    dt = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return dt.strftime("%Y-%m-%dT00:00:00.000Z")


def get_layer_info(layer_type: str) -> dict:
    """Return the WMTS metadata for a given layer type, with a fresh time."""
    key = (layer_type or "").upper()
    spec = LAYERS.get(key)
    if not spec:
        return {"available": False, "reason": f"No WMTS layer for {layer_type}"}

    layer_path = f"{spec['product']}/{spec['layer']}/{spec['variable']}"
    time_iso = _latest_time_iso(spec["time_offset_days"])

    # Google Maps ImageMapType substitutes {z}, {x}, {y}. We pass the
    # template straight to the frontend so no URL-encoding drift occurs.
    tile_template = (
        f"{_WMTS_BASE}/{layer_path}"
        f"?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
        f"&LAYER={layer_path}"
        f"&STYLE=&FORMAT=image/png"
        f"&TILEMATRIXSET=EPSG:3857"
        f"&TILEMATRIX={{z}}&TILEROW={{y}}&TILECOL={{x}}"
        f"&time={time_iso}"
    )

    return {
        "available": True,
        "layer_type": key,
        "product": spec["product"],
        "layer": spec["layer"],
        "variable": spec["variable"],
        "units": spec["units"],
        "title": spec["title"],
        "source": spec["source"],
        "time": time_iso,
        "legend": spec["legend"],
        "tile_template": tile_template,
    }