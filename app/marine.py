"""Keyless HTTP adapters for marine data sources."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)

OPEN_METEO_MARINE = "https://marine-api.open-meteo.com/v1/marine"
OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast"
ERDDAP_MUR_SST = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json"
ERDDAP_CHL = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/erdMH1chlamday.json"

_HTTP_TIMEOUT = httpx.Timeout(15.0, connect=6.0)
_BOX_DEG = 0.15


async def _get_json(client: httpx.AsyncClient, url: str, params: dict | None = None) -> Any:
    try:
        r = await client.get(url, params=params, timeout=_HTTP_TIMEOUT)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        logger.warning("HTTP fetch failed %s: %s", url, exc)
        return None


async def fetch_marine_state(lat: float, lon: float) -> dict:
    params = {
        "latitude": lat, "longitude": lon,
        "hourly": ",".join([
            "wave_height", "wave_direction", "wave_period",
            "swell_wave_height", "swell_wave_direction", "swell_wave_period",
            "wind_wave_height", "ocean_current_velocity", "ocean_current_direction",
        ]),
        "timezone": "Asia/Kolkata", "forecast_days": 3,
    }
    async with httpx.AsyncClient() as client:
        data = await _get_json(client, OPEN_METEO_MARINE, params)
    if not data or "hourly" not in data:
        return {"available": False, "reason": "Open-Meteo Marine unavailable"}
    hourly = data["hourly"]
    times = hourly.get("time", [])
    if not times:
        return {"available": False, "reason": "Empty marine forecast"}
    now_idx = _nearest_hour_index(times)
    def val(key: str):
        arr = hourly.get(key, [])
        return arr[now_idx] if now_idx < len(arr) else None
    return {
        "available": True, "source": "Open-Meteo Marine",
        "time": times[now_idx],
        "wave_height_m": val("wave_height"),
        "wave_period_s": val("wave_period"),
        "wave_direction_deg": val("wave_direction"),
        "swell_wave_height_m": val("swell_wave_height"),
        "swell_wave_period_s": val("swell_wave_period"),
        "wind_wave_height_m": val("wind_wave_height"),
        "ocean_current_velocity_ms": val("ocean_current_velocity"),
        "ocean_current_direction_deg": val("ocean_current_direction"),
    }


async def fetch_weather(lat: float, lon: float) -> dict:
    params = {
        "latitude": lat, "longitude": lon,
        "hourly": ",".join([
            "temperature_2m", "relative_humidity_2m",
            "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
            "precipitation", "weathercode", "visibility",
        ]),
        "timezone": "Asia/Kolkata", "forecast_days": 3,
    }
    async with httpx.AsyncClient() as client:
        data = await _get_json(client, OPEN_METEO_FORECAST, params)
    if not data or "hourly" not in data:
        return {"available": False, "reason": "Open-Meteo Forecast unavailable"}
    hourly = data["hourly"]
    times = hourly.get("time", [])
    if not times:
        return {"available": False, "reason": "Empty weather forecast"}
    now_idx = _nearest_hour_index(times)
    def val(key: str):
        arr = hourly.get(key, [])
        return arr[now_idx] if now_idx < len(arr) else None
    wind_kmh = val("wind_speed_10m")
    gust_kmh = val("wind_gusts_10m")
    return {
        "available": True, "source": "Open-Meteo Forecast",
        "time": times[now_idx],
        "temperature_c": val("temperature_2m"),
        "humidity_pct": val("relative_humidity_2m"),
        "wind_speed_kmh": wind_kmh,
        "wind_speed_kt": round(wind_kmh / 1.852, 1) if wind_kmh else None,
        "wind_gusts_kt": round(gust_kmh / 1.852, 1) if gust_kmh else None,
        "wind_direction_deg": val("wind_direction_10m"),
        "precipitation_mm": val("precipitation"),
        "visibility_m": val("visibility"),
        "weathercode": val("weathercode"),
    }


async def _erddap_box_mean(url_base: str, variable: str, lat: float, lon: float) -> dict:
    """Query ERDDAP over a small bounding box and average valid samples."""
    lat_min, lat_max = lat - _BOX_DEG, lat + _BOX_DEG
    lon_min, lon_max = lon - _BOX_DEG, lon + _BOX_DEG
    url = (
        f"{url_base}?{variable}"
        f"[(last)]"
        f"[({lat_min:.4f}):1:({lat_max:.4f})]"
        f"[({lon_min:.4f}):1:({lon_max:.4f})]"
    )
    async with httpx.AsyncClient() as client:
        data = await _get_json(client, url)
    if not data:
        return {"available": False, "reason": "ERDDAP request failed"}

    try:
        table = data["table"]
        rows = table["rows"]
        cols = table["columnNames"]
        if not rows:
            return {"available": False, "reason": "ERDDAP returned no rows"}

        idx = {name: i for i, name in enumerate(cols)}
        value_col = None
        for candidate in (variable, "chlorophyll", "analysed_sst", "value"):
            if candidate in idx:
                value_col = idx[candidate]
                break
        if value_col is None:
            return {"available": False, "reason": f"No value column in {cols}"}

        valid: list[float] = []
        time_values: list[str] = []
        for row in rows:
            v = row[value_col]
            if v is None:
                continue
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if abs(fv) > 1e30:
                continue
            valid.append(fv)
            if "time" in idx:
                time_values.append(str(row[idx["time"]]))

        if not valid:
            return {"available": False, "reason": "All samples in the box were masked"}

        mean = sum(valid) / len(valid)
        latest_time = max(time_values) if time_values else None
        return {
            "available": True,
            "mean": mean,
            "samples": len(valid),
            "observation_time": latest_time,
        }
    except Exception as exc:
        logger.warning("ERDDAP parse failed: %s", exc)
        return {"available": False, "reason": "ERDDAP parse error"}


async def fetch_sst(lat: float, lon: float) -> dict:
    res = await _erddap_box_mean(ERDDAP_MUR_SST, "analysed_sst", lat, lon)
    if not res.get("available"):
        return {"available": False,
                "reason": res.get("reason", "SST unavailable"),
                "source": "NOAA MUR SST v4.1"}

    raw = res["mean"]

    # Defensive unit normalisation. MUR metadata declares Kelvin, but ERDDAP
    # has been observed returning already-converted Celsius. Also rejects
    # the -1e34 sentinel which we already filter above.
    if raw is None or abs(raw) > 1e30:
        return {"available": False, "reason": "SST masked at this location",
                "source": "NOAA MUR SST v4.1"}

    if raw > 200:                # Kelvin
        sst_c = raw - 273.15
    elif -5 <= raw <= 50:        # Already Celsius
        sst_c = raw
    else:
        return {"available": False,
                "reason": f"SST value out of range ({raw})",
                "source": "NOAA MUR SST v4.1"}

    sst_c = round(sst_c, 2)
    if not (-3 <= sst_c <= 40):
        return {"available": False,
                "reason": f"SST {sst_c}°C outside plausible ocean range",
                "source": "NOAA MUR SST v4.1"}

    return {
        "available": True,
        "source": "NOAA MUR SST v4.1",
        "latitude": lat, "longitude": lon,
        "sst_celsius": sst_c,
        "sst_fahrenheit": round(sst_c * 9 / 5 + 32, 1),
        "observation_time": res["observation_time"],
        "samples": res["samples"],
    }


async def fetch_chlorophyll(lat: float, lon: float) -> dict:
    res = await _erddap_box_mean(ERDDAP_CHL, "chlorophyll", lat, lon)
    if not res.get("available"):
        return {"available": False,
                "reason": res.get("reason", "Chlorophyll unavailable"),
                "source": "NOAA MODIS-Aqua Chlorophyll"}

    chl = round(float(res["mean"]), 4)
    if chl >= 1.0:
        category = "high (good for fish aggregation)"
    elif chl >= 0.3:
        category = "moderate"
    elif chl >= 0.1:
        category = "low-moderate"
    else:
        category = "low (oligotrophic)"

    return {
        "available": True,
        "source": "NOAA MODIS-Aqua Chlorophyll",
        "latitude": lat, "longitude": lon,
        "chlorophyll_mg_m3": chl,
        "category": category,
        "observation_time": res["observation_time"],
        "samples": res["samples"],
    }


async def fetch_ocean_snapshot(lat: float, lon: float) -> dict:
    sst, chl, marine = await asyncio.gather(
        fetch_sst(lat, lon), fetch_chlorophyll(lat, lon), fetch_marine_state(lat, lon),
    )
    return {"sst": sst, "chlorophyll": chl, "marine": marine}


def _nearest_hour_index(times: list[str]) -> int:
    if not times:
        return 0
    now = datetime.now(timezone.utc).astimezone()
    best_idx, best_diff = 0, None
    for i, t in enumerate(times):
        try:
            dt = datetime.fromisoformat(t)
            diff = abs((dt.replace(tzinfo=now.tzinfo) - now).total_seconds())
            if best_diff is None or diff < best_diff:
                best_diff, best_idx = diff, i
        except Exception:
            continue
    return best_idx