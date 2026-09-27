"""Copernicus WMTS overlay metadata with ERDDAP WMS fallback."""

from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone
import httpx

logger = logging.getLogger(__name__)

_WMTS = "https://wmts.marine.copernicus.eu/teroWmts"

_COPERNICUS = {
    "CHL": {
        "product": "OCEANCOLOUR_GLO_BGC_L4_NRT_009_102",
        "dataset": "cmems_obs-oc_glo_bgc-plankton_nrt_l4-multi-4km_P1M",
        "variable": "CHL", "offset_days": 7,
        "units": "mg/m³", "title": "Chlorophyll-a",
        "source": "Copernicus Marine · GlobColour L4",
        "legend": [{"color": "#3b0f70", "label": "0.01"},
                   {"color": "#2c7fb8", "label": "0.1"},
                   {"color": "#41b6c4", "label": "0.3"},
                   {"color": "#c7e9b4", "label": "1.0"},
                   {"color": "#ffffcc", "label": "10+"}],
    },
    "SST": {
        "product": "GLOBAL_ANALYSISFORECAST_PHY_001_024",
        "dataset": "cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m",
        "variable": "thetao", "offset_days": 1,
        "units": "°C", "title": "Sea Surface Temperature",
        "source": "Copernicus Marine · GLO PHY 001/024",
        "legend": [{"color": "#042333", "label": "0"},
                   {"color": "#2278b5", "label": "10"},
                   {"color": "#7ac7a4", "label": "20"},
                   {"color": "#f4d166", "label": "25"},
                   {"color": "#e55c3c", "label": "30+"}],
    },
}
_COPERNICUS["PFZ"] = {**_COPERNICUS["CHL"], "title": "Chlorophyll (PFZ indicator)"}

_ERDDAP = {
    "CHL": {"dataset_id": "erdMH1chlamday", "variable": "chlorophyll",
            "units": "mg/m³", "title": "Chlorophyll-a (MODIS-Aqua)",
            "source": "NOAA CoastWatch · ERDDAP WMS",
            "legend": _COPERNICUS["CHL"]["legend"]},
    "SST": {"dataset_id": "jplMURSST41", "variable": "analysed_sst",
            "units": "K", "title": "Sea Surface Temperature (MUR)",
            "source": "NOAA CoastWatch · ERDDAP WMS",
            "legend": [{"color": "#042333", "label": "0°C"},
                       {"color": "#2278b5", "label": "10°C"},
                       {"color": "#7ac7a4", "label": "20°C"},
                       {"color": "#f4d166", "label": "25°C"},
                       {"color": "#e55c3c", "label": "30°C+"}]},
}
_ERDDAP["PFZ"] = {**_ERDDAP["CHL"], "title": "Chlorophyll (PFZ indicator)"}

_RESOLVED: dict[str, dict] = {}


def _iso(days_ago: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return dt.strftime("%Y-%m-%dT00:00:00.000Z")


def _cop_layer(spec): return f"{spec['product']}/{spec['dataset']}/{spec['variable']}"


def _cop_tile(spec):
    # GoogleMapsCompatible tile matrix set matches Google Maps' EPSG:3857
    # convention exactly, so {z}/{x}/{y} substitute correctly.
    lp = _cop_layer(spec)
    t = _iso(spec["offset_days"])
    return (f"{_WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
            f"&LAYER={lp}&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible"
            f"&FORMAT=image/png"
            f"&TILEMATRIX={{z}}&TILEROW={{y}}&TILECOL={{x}}&time={t}")


def _cop_sample(spec):
    lp = _cop_layer(spec)
    return (f"{_WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
            f"&LAYER={lp}&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible"
            f"&FORMAT=image/png"
            f"&TILEMATRIX=3&TILEROW=3&TILECOL=4&time={_iso(spec['offset_days'])}")


def _try_cop(spec):
    try:
        r = httpx.get(_cop_sample(spec), timeout=8.0, follow_redirects=True)
        ctype = r.headers.get("content-type", "")
        if r.status_code == 200 and ctype.startswith("image/") and len(r.content) > 200:
            return True, _cop_sample(spec)
        return False, f"{r.status_code} {ctype}"
    except Exception as e:
        return False, str(e)


def get_layer_info(layer_type: str) -> dict:
    key = (layer_type or "").upper()
    if key in _RESOLVED:
        return _RESOLVED[key]

    cop = _COPERNICUS.get(key)
    if cop:
        ok, detail = _try_cop(cop)
        if ok:
            info = {"available": True, "provider": "copernicus_wmts",
                    "layer_type": key, "units": cop["units"],
                    "title": cop["title"], "source": cop["source"],
                    "time": _iso(cop["offset_days"]),
                    "legend": cop["legend"],
                    "tile_template": _cop_tile(cop),
                    "debug_url": detail}
            logger.info("Overlay for %s: Copernicus WMTS", key)
            _RESOLVED[key] = info
            return info
        logger.warning("Copernicus failed for %s (%s) → ERDDAP WMS", key, detail)

    er = _ERDDAP.get(key) or _ERDDAP["CHL"]
    info = {"available": True, "provider": "erddap_wms",
            "layer_type": key, "units": er["units"],
            "title": er["title"], "source": er["source"],
            "dataset_id": er["dataset_id"], "variable": er["variable"],
            "legend": er["legend"],
            "debug_url": (f"https://coastwatch.pfeg.noaa.gov/erddap/wms/{er['dataset_id']}/request"
                          f"?service=WMS&version=1.1.1&request=GetMap"
                          f"&layers={er['variable']}&styles=&srs=EPSG:4326"
                          f"&bbox=60,0,100,25&width=512&height=512"
                          f"&format=image/png&transparent=true")}
    _RESOLVED[key] = info
    return info