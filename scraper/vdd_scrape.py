import os
import re
import requests
import json
import sys
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo  # requires 'tzdata' package on Windows

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_HEADERS = {"User-Agent": "VDD-Distanzwettbewerbe-Scraper/1.0 (giese.timo@gmail.com)"}

API_URL = "https://vdd-aktuell.de/mediawiki/api.php"
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH     = os.path.join(ROOT_DIR, "data.json")
DATA_MIN_PATH = os.path.join(ROOT_DIR, "data.min.json")

PROPS = (
    "|?Startdatum#ISO"
    "|?Enddatum#ISO"
    "|?Ritt-Name"
    "|?Untertitel"
    "|?Region"
    "|?Veranstaltungsland"
    "|?Veranstaltungsort"
    "|?Koordinaten"
    "|?Veranstalter"
    "|?Organisator"
    "|?Schirmherr"
    "|?Ritt-Arten"
    "|?EFR"
    "|?KDR"
    "|?MDR"
    "|?LDR"
    "|?MTR"
    "|?CEI"
    "|?Ausschreibung"
    "|?Ausschreibung_aktualisiert"
    "|?Ergebnisliste"
    "|?Nennform"
    "|?Termin"
    "|?Erstveranstaltung"
    "|?Mehrtägig"
    "|?Website"
    "|?Bemerkung"
    "|?Ritt-Bild"
    "|sort=Startdatum"
    "|order=ascending"
)

QUERY_ACTIVE = "[[Veranstaltungsland::Deutschland]][[Kategorie:Ritt in 2026]][[Freigeschaltet::Ja]]" + PROPS
QUERY_VORRAT = "[[Kategorie:Ritt in 2026]][[Freigeschaltet::Nein]]" + PROPS


def wiki_title_to_vdd_url(wiki_title):
    if not wiki_title:
        return None
    slug = wiki_title
    for old, new in [("Ä", "Ae"), ("Ö", "Oe"), ("Ü", "Ue"),
                     ("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")]:
        slug = slug.replace(old, new)
    slug = re.sub(r"[^A-Za-z0-9]+", "-", slug).strip("-")
    return f"https://vdd-aktuell.de/ritt/{slug}/"


def address_parts(raw):
    if not raw:
        return []
    parts = [p.strip() for p in raw.splitlines() if p.strip()]
    return [p for p in parts if "@" not in p and len(p) > 2]


def extract_postcode_city(raw):
    if not raw:
        return None
    m = re.search(r"\b(\d{5})\s+(\S.*)", raw)
    return f"{m.group(1)} {m.group(2).split(',')[0].strip()}" if m else None


def _nominatim(q):
    try:
        resp = requests.get(
            NOMINATIM_URL,
            params={"q": q, "format": "json", "limit": 1, "countrycodes": "de"},
            headers=NOMINATIM_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        if data:
            return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception as e:
        print(f"    Nominatim error: {e}")
    return None, None


def nominatim_geocode(venue, organizer, region=None):
    queries = []
    parts = address_parts(venue)
    if parts:
        queries.append(", ".join(parts) + ", Deutschland")
    pc = extract_postcode_city(venue)
    if pc:
        queries.append(pc + ", Deutschland")
    org_parts = address_parts(organizer)
    if len(org_parts) > 1:
        queries.append(", ".join(org_parts[1:]) + ", Deutschland")
    pc_org = extract_postcode_city(organizer)
    if pc_org and pc_org != pc:
        queries.append(pc_org + ", Deutschland")
    for raw in (venue, organizer):
        m = re.search(r"\b(\d{5})\b", raw or "")
        if m:
            queries.append(m.group(1) + ", Deutschland")

    first_query = True
    for q in dict.fromkeys(queries):
        if not first_query:
            time.sleep(1.1)
        first_query = False
        print(f"    querying: {q!r}")
        lat, lon = _nominatim(q)
        if lat:
            return lat, lon
    return None, None


def fetch_page_touched(titles):
    """Return {wiki_title: "YYYY-MM-DD"} for the given page titles (batched 50 at a time)."""
    touched = {}
    for i in range(0, len(titles), 50):
        batch = titles[i:i + 50]
        resp = requests.get(
            API_URL,
            params={"action": "query", "prop": "info", "titles": "|".join(batch),
                    "format": "json", "formatversion": "2"},
            timeout=30,
        )
        resp.raise_for_status()
        for page in resp.json().get("query", {}).get("pages", []):
            t = page.get("touched")
            if page.get("title") and t:
                touched[page["title"]] = t
    return touched


def fetch_all_events(query):
    events, offset, limit = [], 0, 500
    while True:
        params = {
            "action": "ask",
            "query": f"{query}|limit={limit}|offset={offset}",
            "format": "json",
            "formatversion": "2",
        }
        resp = requests.get(API_URL, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        results = data.get("query", {}).get("results", {})
        if not results:
            break
        events.extend(results.values())
        count = int(data.get("query", {}).get("meta", {}).get("count", 0))
        print(f"  offset={offset}: got {count} (total so far: {len(events)})")
        if count < limit:
            break
        offset += limit
    return events


def first(lst, default=None):
    return lst[0] if lst else default


def join_list(lst):
    return ", ".join(str(x) for x in lst) if lst else None


def ts_to_date(entry):
    if not entry:
        return None
    ts = entry.get("timestamp")
    if ts:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
    parts = entry.get("raw", "").split("/")
    if len(parts) >= 4:
        return f"{parts[1]}-{int(parts[2]):02d}-{int(parts[3]):02d}"
    return None


def bool_val(lst):
    v = first(lst)
    if v is None:
        return None
    return 1 if str(v).lower() in ("t", "true", "1", "yes") else 0


def first_year(lst):
    v = first(lst)
    if not isinstance(v, dict):
        return None
    parts = v.get("raw", "").split("/")
    return int(parts[1]) if len(parts) >= 2 else None


def parse_event(raw, rittvorrat):
    p = raw.get("printouts", {})
    wiki_title = raw.get("fulltext")

    coords = first(p.get("Koordinaten", []))
    lat = coords.get("lat") if coords else None
    lon = coords.get("lon") if coords else None

    ev = {
        "id":                   wiki_title,                                                                     
        "wiki_title":           wiki_title,
        "wiki_url":             raw.get("fullurl"),
        "vdd_url":              wiki_title_to_vdd_url(wiki_title),
        "name":                 first(p.get("Ritt-Name", [])),
        "subtitle":             first(p.get("Untertitel", [])),
        "start_date":           ts_to_date(first(p.get("Startdatum", []))),
        "end_date":             ts_to_date(first(p.get("Enddatum", []))),
        "multi_day":            bool_val(p.get("Mehrtägig", [])),
        "region":               first(p.get("Region", [])),
        "country":              first(p.get("Veranstaltungsland", [])),
        "venue":                first(p.get("Veranstaltungsort", [])),
        "lat":                  lat,
        "lon":                  lon,
        "organizer":            first(p.get("Veranstalter", [])),
        "contact":              first(p.get("Organisator", [])),
        "patron":               first(p.get("Schirmherr", [])),
        "event_types":          join_list(p.get("Ritt-Arten", [])),
        "efr":                  join_list(p.get("EFR", [])),
        "kdr":                  join_list(p.get("KDR", [])),
        "mdr":                  join_list(p.get("MDR", [])),
        "ldr":                  join_list(p.get("LDR", [])),
        "mtr":                  join_list(p.get("MTR", [])),
        "cei":                  join_list(p.get("CEI", [])),
        "announcement_pdf":     join_list(p.get("Ausschreibung", [])),
        "announcement_updated": bool_val(p.get("Ausschreibung_aktualisiert", [])),
        "results_pdf":          join_list(p.get("Ergebnisliste", [])),
        "registration_pdf":     join_list(p.get("Nennform", [])),
        "status":               first(p.get("Termin", [])),
        "first_edition_year":   first_year(p.get("Erstveranstaltung", [])),
        "website":              first(p.get("Website", [])),
        "bemerkung":            first(p.get("Bemerkung", [])),
        "ritt_bild":            first(p.get("Ritt-Bild", [])),
        "rittvorrat":           rittvorrat,
        "wiki_touched":         None,
    }
    return ev, lat is None


def main():
    print("Fetching active events (Freigeschaltet=Ja)...")
    active_raws = fetch_all_events(QUERY_ACTIVE)
    print(f"  {len(active_raws)} active events")

    print("Fetching Rittvorrat events (Freigeschaltet=Nein)...")
    vorrat_raws = fetch_all_events(QUERY_VORRAT)
    print(f"  {len(vorrat_raws)} Rittvorrat events")

    events = []
    to_geocode = []

    for raws, flag in ((active_raws, 0), (vorrat_raws, 1)):
        for raw in raws:
            ev, needs = parse_event(raw, rittvorrat=flag)
            events.append(ev)
            if needs:
                to_geocode.append(ev)

    # Stable order independent of SMW's tie-breaking for equal Startdatum values,
    # so re-runs with no real changes don't produce reorder-only diffs.
    events.sort(key=lambda ev: (ev.get("start_date") or "", ev["id"]))

    old = _read_existing_data()
    old_coords = {
        ev["id"]: (ev["lat"], ev["lon"])
        for ev in (old["events"] if old else [])
        if ev.get("lat") is not None
    }

    all_titles = [ev["wiki_title"] for ev in events if ev.get("wiki_title")]
    print(f"\nFetching last-modified timestamps for {len(all_titles)} pages...")
    touched_map = fetch_page_touched(all_titles)
    for ev in events:
        ev["wiki_touched"] = touched_map.get(ev.get("wiki_title"))
    print(f"  got timestamps for {len(touched_map)} pages")

    if to_geocode:
        print(f"\nGeocoding {len(to_geocode)} events missing wiki Koordinaten via Nominatim...")
        for ev in to_geocode:
            name = ev.get("name") or ev.get("wiki_title")
            if not ev.get("venue") and not ev.get("organizer"):
                print(f"  [{name}] no address -- skipping")
                continue
            print(f"  [{name}]")
            lat, lon = nominatim_geocode(ev.get("venue"), ev.get("organizer"), ev.get("region"))
            if lat:
                ev["lat"], ev["lon"] = lat, lon
                print(f"    -> {lat:.5f}, {lon:.5f}")
            elif ev["id"] in old_coords:
                ev["lat"], ev["lon"] = old_coords[ev["id"]]
                print(f"    -> no result, keeping previous coordinates")
            else:
                print(f"    -> no result")

    if old and json.dumps(old["events"], ensure_ascii=False, sort_keys=True) == \
               json.dumps(events,        ensure_ascii=False, sort_keys=True):
        scraped_at = old["scraped_at"]
        print("Events unchanged — keeping existing scraped_at.")
    else:
        scraped_at = datetime.now(tz=ZoneInfo("Europe/Berlin")).strftime("%Y-%m-%d %H:%M:%S")

    data = {"scraped_at": scraped_at, "events": events}
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    with open(DATA_MIN_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

    active = sum(1 for e in events if not e["rittvorrat"])
    vorrat = sum(1 for e in events if e["rittvorrat"])
    pins   = sum(1 for e in events if e.get("lat"))
    print(f"\nGenerated {DATA_PATH} + {DATA_MIN_PATH}: {active} active + {vorrat} Rittvorrat = {len(events)} total "
          f"({pins} with pins, {len(to_geocode)} Nominatim lookups)")


def _read_existing_data():
    try:
        with open(DATA_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def read_last_scraped_at():
    d = _read_existing_data()
    return d.get("scraped_at") if d else None


def has_wiki_changes(since_local):
    """Return True if any namespace-0 page changed since since_local (Europe/Berlin, YYYY-MM-DD HH:MM:SS)."""
    dt = datetime.strptime(since_local, "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZoneInfo("Europe/Berlin"))
    since_utc = dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        resp = requests.get(
            API_URL,
            params={
                "action": "query",
                "list": "recentchanges",
                "rcend": since_utc,
                "rcnamespace": "0",
                "rclimit": "1",
                "rcprop": "title",
                "format": "json",
            },
            timeout=15,
        )
        resp.raise_for_status()
        return bool(resp.json().get("query", {}).get("recentchanges"))
    except Exception as e:
        print(f"Change detection failed: {e}", file=sys.stderr)
        return True  # fail open: assume changes so the scraper still runs


if __name__ == "__main__":
    if "--check-only" in sys.argv:
        last = read_last_scraped_at()
        if not last:
            print("true")  # no data.json yet
        else:
            print("true" if has_wiki_changes(last) else "false")
    else:
        main()
