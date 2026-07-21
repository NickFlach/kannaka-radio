#!/usr/bin/env python3
"""fetch-kax-art.py — build a catalog of Kannaka's image artifacts from KAX.

Paginates the KAX storefront /works endpoint, keeps artifactType=="image"
entries that have a public image URL, and writes a de-duplicated catalog to
workspace/podcasts/art-catalog.json. This is the pool the podcast slideshow
draws from (no-repeat picker in podcast-slideshow.py). Re-run any time to pick
up newly harvested art.

Usage: python scripts/fetch-kax-art.py [agent_slug]
"""
import json, os, subprocess, sys

AGENT = sys.argv[1] if len(sys.argv) > 1 else "kannaka-0f05e1"
BASE = f"https://kax.ninja-portal.com/api/storefront/by-agent/{AGENT}/works"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "workspace", "podcasts", "art-catalog.json")


def get(url):
    # curl, not urllib: KAX sits behind Cloudflare, which hangs urllib but passes curl.
    out = subprocess.run(
        ["curl", "-s", "-m", "25", "-H", "User-Agent: Mozilla/5.0 (Kannaka podcast art fetcher)", url],
        capture_output=True, text=True, encoding="utf-8",
    ).stdout
    return json.loads(out)


def main():
    seen, catalog = set(), []
    offset, limit = 0, 100
    total = get(f"{BASE}?limit=1").get("total", 0)   # KAX pages by offset, NOT page=
    while offset < (total or 10_000):
        data = get(f"{BASE}?limit={limit}&offset={offset}")
        arts = data.get("artifacts", [])
        if not arts:
            break
        for a in arts:
            if a.get("artifactType") != "image":
                continue
            url = a.get("publicUrl") or a.get("thumbnailUrl")
            if not url or not url.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                continue
            fname = url.rsplit("/", 1)[-1]
            if fname in seen:
                continue
            seen.add(fname)
            catalog.append({
                "id": a.get("id"),
                "file": fname,
                "url": url,
                "title": a.get("title"),
                "tags": a.get("tags"),
                "score": a.get("kannakaScore"),
                "reactions": a.get("reactionCount"),
            })
        print(f"offset {offset}: +{len(arts)} works, catalog now {len(catalog)} images")
        if len(arts) < limit:
            break
        offset += limit
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=1)
    print(f"WROTE {len(catalog)} image artifacts -> {OUT}")


if __name__ == "__main__":
    main()
