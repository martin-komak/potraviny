from __future__ import annotations

import json
import math
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import osmium


ROUTE_RELATION_ID = 7700604
MAX_DISTANCE_METERS = 2000
SHOP_TYPES = {"supermarket", "convenience", "greengrocer", "organic", "farm"}
ROUTE_URL = f"https://www.openstreetmap.org/api/0.6/relation/{ROUTE_RELATION_ID}/full"
EXTRACT_URL = "https://download.geofabrik.de/europe/slovakia-latest.osm.pbf"
DATA_DIR = Path(__file__).parent / "data"
ROUTE_PATH = DATA_DIR / "route.json"
SHOPS_PATH = DATA_DIR / "shops.json"
EXTRACT_PATH = DATA_DIR / "slovakia-latest.osm.pbf"


def http_get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "snp-map-generator/2.0"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def download_file(url: str, target_path: Path) -> None:
    target_path.parent.mkdir(exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "snp-map-generator/2.0"})

    with urllib.request.urlopen(request, timeout=120) as response, target_path.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def parse_route() -> list[list[list[float]]]:
    xml_bytes = http_get(ROUTE_URL)
    root = ET.fromstring(xml_bytes)

    nodes: dict[int, list[float]] = {}
    ways: dict[int, list[int]] = {}
    route_way_ids: list[int] = []

    for node in root.findall("node"):
        nodes[int(node.attrib["id"])] = [float(node.attrib["lat"]), float(node.attrib["lon"])]

    for way in root.findall("way"):
        ways[int(way.attrib["id"])] = [int(nd.attrib["ref"]) for nd in way.findall("nd")]

    relation = None
    for element in root.findall("relation"):
        if int(element.attrib["id"]) == ROUTE_RELATION_ID:
            relation = element
            break

    if relation is None:
        raise RuntimeError("Route relation not found in OSM XML.")

    for member in relation.findall("member"):
        if member.attrib.get("type") == "way":
            route_way_ids.append(int(member.attrib["ref"]))

    segments: list[list[list[float]]] = []
    for way_id in route_way_ids:
        coordinates = [nodes[node_id] for node_id in ways.get(way_id, []) if node_id in nodes]
        if len(coordinates) > 1:
            segments.append(coordinates)

    if not segments:
        raise RuntimeError("No route geometry extracted from OSM relation.")

    return segments


def expanded_route_bbox(segments: list[list[list[float]]]) -> tuple[float, float, float, float]:
    all_points = [point for segment in segments for point in segment]
    south = min(point[0] for point in all_points)
    north = max(point[0] for point in all_points)
    west = min(point[1] for point in all_points)
    east = max(point[1] for point in all_points)

    mid_lat = (south + north) / 2
    lat_padding = MAX_DISTANCE_METERS / 110540
    lon_padding = MAX_DISTANCE_METERS / (111320 * max(0.2, math.cos(math.radians(mid_lat))))
    return (south - lat_padding, west - lon_padding, north + lat_padding, east + lon_padding)


def in_bbox(lat: float, lon: float, bbox: tuple[float, float, float, float]) -> bool:
    south, west, north, east = bbox
    return south <= lat <= north and west <= lon <= east


def project_meters(lat: float, lon: float, reference_lat: float) -> tuple[float, float]:
    radians = math.radians(reference_lat)
    return (lon * 111320 * math.cos(radians), lat * 110540)


def point_to_segment_distance_meters(
    point: tuple[float, float],
    segment_start: tuple[float, float],
    segment_end: tuple[float, float],
) -> float:
    reference_lat = (point[0] + segment_start[0] + segment_end[0]) / 3
    point_x, point_y = project_meters(point[0], point[1], reference_lat)
    start_x, start_y = project_meters(segment_start[0], segment_start[1], reference_lat)
    end_x, end_y = project_meters(segment_end[0], segment_end[1], reference_lat)

    delta_x = end_x - start_x
    delta_y = end_y - start_y
    segment_length_squared = delta_x * delta_x + delta_y * delta_y
    if segment_length_squared == 0:
        return math.hypot(point_x - start_x, point_y - start_y)

    projection = ((point_x - start_x) * delta_x + (point_y - start_y) * delta_y) / segment_length_squared
    projection = max(0.0, min(1.0, projection))
    closest_x = start_x + projection * delta_x
    closest_y = start_y + projection * delta_y
    return math.hypot(point_x - closest_x, point_y - closest_y)


def route_distance_meters(lat: float, lon: float, segments: list[list[list[float]]]) -> float:
    best = float("inf")
    point = (lat, lon)
    for segment in segments:
        for index in range(len(segment) - 1):
            start = (segment[index][0], segment[index][1])
            end = (segment[index + 1][0], segment[index + 1][1])
            best = min(best, point_to_segment_distance_meters(point, start, end))
    return best


def shop_record(element_id: int, name: str, shop_type: str, village: str, lat: float, lon: float) -> dict:
    return {
        "id": element_id,
        "name": name or "Bez nazvu",
        "type": shop_type,
        "village": village,
        "lat": lat,
        "lon": lon,
    }


class ShopCollector(osmium.SimpleHandler):
    def __init__(self, route_segments: list[list[list[float]]], route_bbox: tuple[float, float, float, float]) -> None:
        super().__init__()
        self.route_segments = route_segments
        self.route_bbox = route_bbox
        self.shops: list[dict] = []
        self.seen: set[tuple[str, float, float]] = set()

    def node(self, node: osmium.osm.Node) -> None:
        shop_type = node.tags.get("shop")
        if shop_type not in SHOP_TYPES or not node.location.valid():
            return

        self._collect(node.id, node.location.lat, node.location.lon, node.tags)

    def way(self, way: osmium.osm.Way) -> None:
        shop_type = way.tags.get("shop")
        if shop_type not in SHOP_TYPES:
            return

        coordinates = []
        for node_ref in way.nodes:
            if node_ref.location.valid():
                coordinates.append((node_ref.location.lat, node_ref.location.lon))

        if not coordinates:
            return

        lat = sum(point[0] for point in coordinates) / len(coordinates)
        lon = sum(point[1] for point in coordinates) / len(coordinates)
        self._collect(way.id, lat, lon, way.tags)

    def _collect(self, element_id: int, lat: float, lon: float, tags: osmium.osm.TagList) -> None:
        if not in_bbox(lat, lon, self.route_bbox):
            return

        if route_distance_meters(lat, lon, self.route_segments) > MAX_DISTANCE_METERS:
            return

        name = (tags.get("name") or "Bez nazvu").strip()
        village = (
            tags.get("addr:city")
            or tags.get("addr:town")
            or tags.get("addr:village")
            or tags.get("addr:hamlet")
            or tags.get("addr:suburb")
            or ""
        )
        key = (name, round(lat, 5), round(lon, 5))
        if key in self.seen:
            return

        self.seen.add(key)
        self.shops.append(shop_record(element_id, name, tags.get("shop", "shop"), village, lat, lon))


def ensure_extract() -> None:
    if EXTRACT_PATH.exists() and EXTRACT_PATH.stat().st_size > 0:
        return

    print("Downloading Slovakia OSM extract...")
    download_file(EXTRACT_URL, EXTRACT_PATH)


def collect_shops_from_extract(segments: list[list[list[float]]]) -> list[dict]:
    collector = ShopCollector(segments, expanded_route_bbox(segments))
    collector.apply_file(str(EXTRACT_PATH), locations=True)
    collector.shops.sort(key=lambda shop: (shop["name"].lower(), shop["lat"], shop["lon"]))
    return collector.shops


def main() -> int:
    DATA_DIR.mkdir(exist_ok=True)

    print("Downloading SNP route geometry...")
    segments = parse_route()
    write_json(ROUTE_PATH, {"segments": segments})

    ensure_extract()

    print("Collecting grocery shops from local Slovakia extract...")
    shops = collect_shops_from_extract(segments)
    write_json(SHOPS_PATH, shops)

    print(f"Saved {len(segments)} route segments and {len(shops)} shops to {DATA_DIR}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())