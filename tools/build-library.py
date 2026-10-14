#!/usr/bin/env python3
"""Build the banner library in the vault from the art-triage results.

Layout:  Assets/Attachments/Banners/<Set>/<codename>.banner        (metadata, committed)
         Assets/Attachments/Banners/<Set>/<codename>.banner.<ext>  (image; gitignored unless local-only)

Sets written here: Art (kept bookmarks), Ghibli. Existing .banner files are left alone,
so hand edits (tags, crop, descriptions) survive re-runs.
"""
import io
import json
import re
import shutil
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None
HERE = Path(__file__).resolve().parent
VAULT = Path.home() / "Obsidian" / "Personal"
LIB = VAULT / "Assets" / "Attachments" / "Banners"
DESKTOP = Path.home() / "Desktop"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
WIKI_UA = {"User-Agent": "vishnus-banners/0.1 (personal Obsidian plugin; github humboldt123)"}
TWITTER_ID = re.compile(r"^[A-Za-z0-9_-]{15}$")


def slug(s, n=60):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:n].rstrip("-")


def yaml_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        return "[" + ", ".join(yaml_value(x) for x in v) + "]"
    return json.dumps(str(v), ensure_ascii=False)


def write_banner(path, meta):
    lines = [f"{k}: {yaml_value(v)}" for k, v in meta.items() if v not in (None, "", [])]
    path.write_text("\n".join(lines) + "\n")


def fetch(url, headers):
    for attempt in range(3):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120).read()
        except Exception as e:
            print("  retry", url[:80], e)
            time.sleep(20)
    return None


def commons_thumb(url, width=2560):
    """Commons originals rate-limit hard; standard-size thumbnails don't."""
    base = url.split("?")[0]
    a, b = base.split("/wikipedia/commons/")
    return f"{a}/wikipedia/commons/thumb/{b}/{width}px-{b.split('/')[-1]}"


def save_image(data_or_path, dest_stem):
    im = Image.open(io.BytesIO(data_or_path) if isinstance(data_or_path, bytes) else data_or_path)
    ext = "png" if im.format == "PNG" else "jpg"
    dest = dest_stem.with_name(dest_stem.name + "." + ext)
    if isinstance(data_or_path, bytes):
        dest.write_bytes(data_or_path)
    else:
        shutil.copyfile(data_or_path, dest)
    return dest, im.size


def build_art():
    triage = json.loads((HERE / "art-triage" / "triage.json").read_text())
    catalog = json.loads((HERE / "art-triage" / "catalog.json").read_text())
    orig = json.loads(Path(sys.argv[1]).read_text()) if len(sys.argv) > 1 else {"bigger": [], "gone": []}
    bins, comments = triage["bins"], triage["comments"]
    found = catalog.get("found", {})
    gone = {"Bookmarks/Art/" + f for f in orig.get("gone", [])}
    png = {"Bookmarks/Art/" + f for f in orig.get("png", [])}
    kept = [f for f in catalog["all"] if bins.get(f) != "trash"]

    # One banner per matched group (copies collapse), one per loose image otherwise
    entries, seen = [], set()
    for g in catalog["matched"]:
        files = [f for f in g["files"] if f in kept]
        if not files:
            continue
        seen.update(g["files"])
        artist, _, title = g["title"].partition(" — ") if " — " in g["title"] else ("", "", g["title"])
        entries.append({"files": files, "title": title or g["title"], "artist": artist, "note": g.get("note"),
                        "source": g.get("original") if g.get("originalRes") == "search" else None,
                        "url": g.get("original") if g.get("originalRes") not in (None, "search") else None,
                        "key": "group:" + g["title"]})
    for f in kept:
        if f not in seen:
            entries.append({"files": [f], "title": None, "artist": "", "note": None, "source": None, "url": None, "key": f})

    out = LIB / "Art"
    out.mkdir(parents=True, exist_ok=True)
    for e in entries:
        best = max(e["files"], key=lambda f: Image.open(DESKTOP / f).size[0])
        stem = Path(best).stem
        code = slug(f"{e['artist']} {e['title']}") if e["title"] else slug(stem.lstrip("@"))
        banner = out / f"{code}.banner"
        if banner.exists():
            continue
        desc = comments.get(e["key"]) or next((comments[f] for f in e["files"] if comments.get(f)), None)
        fd = next((found[f] for f in e["files"] if f in found), None)
        url = e["url"] or (fd["url"] if fd and fd.get("url") and re.search(r"\.(jpe?g|png)|/download|default\.jpg|i\.redd\.it", fd["url"]) else None)
        source = e["source"] or (fd["url"] if fd and fd.get("url") and not url else None)
        tw = next((f for f in e["files"] if f.startswith("Bookmarks/") and TWITTER_ID.match(Path(f).stem) and f not in gone), None)
        if not url and tw:
            url = f"https://pbs.twimg.com/media/{Path(tw).stem}?format={'png' if tw in png else 'jpg'}&name=orig"

        # Image: download the best URL, else copy the best local copy
        data = None
        if url:
            data = fetch(commons_thumb(url) if "upload.wikimedia.org" in url else url,
                         WIKI_UA if "wikimedia" in url else UA)
            time.sleep(1)
        img, size = save_image(data if data else DESKTOP / best, out / f"{code}.banner")
        local_size = Image.open(DESKTOP / best).size
        if data and size[0] < local_size[0]:  # never downgrade
            img.unlink()
            img, size = save_image(DESKTOP / best, out / f"{code}.banner")

        write_banner(banner, {
            "title": e["title"] or stem,
            "artist": e["artist"] or None,
            "url": url,
            "source": source,
            "description": desc or (fd["note"] if fd else None) or e["note"],
            "localonly": not url,
            "size": f"{size[0]}x{size[1]}",
            "tags": [],
            "from": ", ".join(e["files"]),
        })
        print(f"{code:60} {size[0]}x{size[1]} {'local' if not url else 'url'}")


def build_ghibli():
    d = LIB / "Ghibli"
    for img in sorted(d.glob("ghibli-*.jpg")):
        if img.name.endswith(".banner.jpg"):
            continue
        code = img.stem
        img.rename(d / f"{code}.banner.jpg")
        w, h = Image.open(d / f"{code}.banner.jpg").size
        write_banner(d / f"{code}.banner", {
            "title": f"Studio Ghibli still {code[-2:]}",
            "artist": "Studio Ghibli",
            "description": "Ultra-wide still; source unknown",
            "localonly": True,
            "size": f"{w}x{h}",
            "tags": ["ghibli"],
        })


def build_notion():
    """Notion's built-in covers: downloaded locally, URL kept as the fallback."""
    covers = json.loads((HERE.parent / "covers.json").read_text())
    for col in covers["collections"]:
        out = LIB / ("Notion " + col["name"].replace("The MET Museum – ", "MET ").replace("The MET Museum", "MET"))
        out.mkdir(parents=True, exist_ok=True)
        for url in col["covers"]:
            code = slug(url.rsplit("/", 1)[1].rsplit(".", 1)[0])
            if (out / f"{code}.banner").exists():
                continue
            data = fetch(url, UA)
            if not data:
                continue
            img, size = save_image(data, out / f"{code}.banner")
            write_banner(out / f"{code}.banner", {
                "title": code.replace("-", " ").title(),
                "url": url,
                "source": "Notion built-in page cover",
                "localonly": False,
                "size": f"{size[0]}x{size[1]}",
                "tags": ["notion", slug(col["name"])],
            })
            print(out.name, code, size)


def build_pomological(src):
    """Notion-style crops made from the USDA Pomological Watercolor Collection (public domain)."""
    src = Path(src)
    out = LIB / "Pomological"
    out.mkdir(parents=True, exist_ok=True)
    for e in json.loads((src / "selected.json").read_text()):
        code = e["name"]
        if (out / f"{code}.banner").exists():
            continue
        img, size = save_image(src / "out" / f"{code}.jpg", out / f"{code}.banner")
        write_banner(out / f"{code}.banner", {
            "title": f"{e['fruit'].rstrip('s').title()} — USDA Pomological Watercolor",
            "artist": "USDA Pomological Watercolor Collection",
            "source": e["source"],
            "description": "Whole fruit on its own paper, extended sideways to banner width",
            "license": "public domain",
            "localonly": True,  # derived crop: no URL serves this exact image
            "size": f"{size[0]}x{size[1]}",
            "tags": [e["season"], "fruit", "pomological"],
        })


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("sets", nargs="*", default=["ghibli", "art"])
    ap.add_argument("--orig", help="orig.json from the Twitter original-size check")
    ap.add_argument("--pomological-src")
    args = ap.parse_args()
    if args.orig:
        sys.argv = [sys.argv[0], args.orig]
    else:
        sys.argv = [sys.argv[0]]
    for name in args.sets:
        if name == "ghibli": build_ghibli()
        elif name == "art": build_art()
        elif name == "notion": build_notion()
        elif name == "pomological": build_pomological(args.pomological_src)
