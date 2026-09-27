"""Static reference data: harbours, EEZ polygon, restricted zones."""

from __future__ import annotations
import math
from typing import NamedTuple


class Harbour(NamedTuple):
    name: str
    state: str
    lat: float
    lon: float


HARBOURS: list[Harbour] = [
    Harbour("Kochi", "Kerala", 9.9645, 76.2424),
    Harbour("Kollam", "Kerala", 8.8801, 76.5900),
    Harbour("Alappuzha", "Kerala", 9.4981, 76.3388),
    Harbour("Kayamkulam", "Kerala", 9.1500, 76.4833),
    Harbour("Ponnani", "Kerala", 10.7789, 75.9214),
    Harbour("Beypore", "Kerala", 11.1698, 75.8078),
    Harbour("Azhikkal", "Kerala", 11.9430, 75.3220),
    Harbour("Kasaragod", "Kerala", 12.5000, 74.9833),
    Harbour("Mangalore", "Karnataka", 12.8698, 74.8424),
    Harbour("Malpe", "Karnataka", 13.3493, 74.7055),
    Harbour("Karwar", "Karnataka", 14.8136, 74.1297),
    Harbour("Panaji", "Goa", 15.4989, 73.8278),
    Harbour("Chapora", "Goa", 15.6035, 73.7413),
    Harbour("Ratnagiri", "Maharashtra", 16.9902, 73.3120),
    Harbour("Sassoon Dock", "Maharashtra", 18.9188, 72.8287),
    Harbour("Versova", "Maharashtra", 19.1320, 72.8111),
    Harbour("Dumas", "Gujarat", 21.0720, 72.7080),
    Harbour("Veraval", "Gujarat", 20.9000, 70.3667),
    Harbour("Porbandar", "Gujarat", 21.6417, 69.6293),
    Harbour("Dwarka", "Gujarat", 22.2394, 68.9678),
    Harbour("Okha", "Gujarat", 22.4712, 69.0703),
    Harbour("Vizag", "Andhra Pradesh", 17.6868, 83.2185),
    Harbour("Kakinada", "Andhra Pradesh", 16.9891, 82.2475),
    Harbour("Kasimedu", "Tamil Nadu", 13.1170, 80.2980),
    Harbour("Nagapattinam", "Tamil Nadu", 10.7672, 79.8449),
    Harbour("Rameswaram", "Tamil Nadu", 9.2876, 79.3129),
    Harbour("Tuticorin", "Tamil Nadu", 8.7642, 78.1348),
    Harbour("Kanyakumari", "Tamil Nadu", 8.0883, 77.5385),
    Harbour("Paradip", "Odisha", 20.2644, 86.6780),
    Harbour("Diamond Harbour", "West Bengal", 22.1911, 88.1900),
]


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def km_to_nm(km: float) -> float:
    return km / 1.852


def nearest_harbour(lat: float, lon: float, count: int = 3) -> list[dict]:
    ranked = sorted(HARBOURS, key=lambda h: haversine_km(lat, lon, h.lat, h.lon))[:count]
    return [{
        "name": h.name, "state": h.state,
        "lat": h.lat, "lon": h.lon,
        "distance_km": round(haversine_km(lat, lon, h.lat, h.lon), 1),
        "distance_nm": round(km_to_nm(haversine_km(lat, lon, h.lat, h.lon)), 1),
    } for h in ranked]


INDIA_EEZ_POLYGON = [
    (23.5, 68.0), (23.5, 92.0), (20.0, 92.5), (15.0, 94.0),
    (10.0, 93.0), (5.0, 87.0), (5.0, 74.0), (8.0, 71.0),
    (12.0, 69.0), (18.0, 67.0),
]


def point_in_polygon(lat: float, lon: float, poly) -> bool:
    inside, n = False, len(poly)
    j = n - 1
    for i in range(n):
        yi, xi = poly[i]
        yj, xj = poly[j]
        if ((xi > lon) != (xj > lon)) and (lat < (yj-yi)*(lon-xi)/(xj-xi+1e-12)+yi):
            inside = not inside
        j = i
    return inside


RESTRICTED_ZONES = [
    {"name": "Gulf of Mannar Marine National Park", "lat": 9.10, "lon": 79.10, "radius_km": 40,
     "reason": "Marine National Park — fishing restricted"},
    {"name": "Gulf of Kutch Marine National Park", "lat": 22.50, "lon": 69.60, "radius_km": 30,
     "reason": "Marine National Park — fishing restricted"},
    {"name": "Malvan Marine Sanctuary", "lat": 16.05, "lon": 73.47, "radius_km": 15,
     "reason": "Marine Sanctuary — fishing restricted"},
    {"name": "Gahirmatha Marine Sanctuary", "lat": 20.70, "lon": 87.00, "radius_km": 25,
     "reason": "Turtle nesting — seasonal fishing ban"},
    {"name": "Wheeler Island Marine Sanctuary", "lat": 20.72, "lon": 87.05, "radius_km": 15,
     "reason": "Turtle nesting — seasonal fishing ban"},
]


def restricted_zone_at(lat: float, lon: float) -> dict | None:
    for z in RESTRICTED_ZONES:
        d = haversine_km(lat, lon, z["lat"], z["lon"])
        if d <= z["radius_km"]:
            return {**z, "distance_km": round(d, 1)}
    return None