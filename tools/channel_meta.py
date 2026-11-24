#!/usr/bin/env python3
"""Add YouTube handles and profile images to the channel lists.

    python3 tools/channel_meta.py && python3 tools/build.py

Reads the app's starter-pack data (the source of truth for verified channel
IDs, handles and avatars) from the sibling VideoFocus-iOS repo, then for every
<li> in content/channels/*.html:
  - downloads the channel's avatar once to landing/assets/channels/<id>.jpg
    (self-hosted: visitors' browsers never contact Google, and the image
    can't break when YouTube rotates its image URLs);
  - rewrites the item's head as avatar + name + age + @handle link.

Safe to re-run: items already carrying an avatar are rebuilt the same way,
and existing image files aren't downloaded again (delete one to refresh it).
A channel missing from the packs stops the script, so add it to
starter_packs.json first (with a verified ID).
"""
import json
import re
import subprocess
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKS = ROOT.parent / "VideoFocus-iOS" / "tools" / "starter-packs" / "starter_packs.json"
AVATARS = ROOT / "landing" / "assets" / "channels"

# Website names that differ from the in-app pack titles.
ALIASES = {
    "ms rachel - toddler learning videos": "ms rachel",
    "bluey - official channel": "bluey",
    "national geographic kids": "nat geo kids",
}

ITEM = re.compile(
    r'<li>(?:<img class="ch-avatar"[^>]*>)?<div class="ch-head">.*?</div>|'
    r'<li><span class="ch-name">(?P<name>[^<]+)</span><span class="ch-meta">(?P<meta>[^<]*)</span>'
)
HEAD = re.compile(
    r'<li><img class="ch-avatar"[^>]*><div class="ch-head"><span class="ch-name">(?P<name>[^<]+)</span>'
    r'<span class="ch-meta">(?P<meta>[^<]*)</span>.*?</div>'
)


def load_channels() -> dict:
    data = json.loads(PACKS.read_text())
    packs = data["packs"] if isinstance(data, dict) else data
    return {c["title"].lower(): c for p in packs for c in p["channels"]}


def avatar(channel: dict) -> str:
    AVATARS.mkdir(parents=True, exist_ok=True)
    path = AVATARS / f'{channel["channelId"]}.jpg'
    if not path.exists():
        url = re.sub(r"=s\d+-.*$", "=s176-c-k-c0x00ffffff-no-rj", channel["thumbnailURL"])
        # curl, not urllib: python.org builds on macOS ship without CA certs.
        subprocess.run(["curl", "-sfL", "--max-time", "20", "-H", "Accept: image/jpeg",
                        "-o", str(path), url], check=True)
        print(f"  downloaded {channel['title']}")
    return f"/assets/channels/{path.name}"


def render(name: str, meta: str, channel: dict) -> str:
    handle = channel.get("handle") or ""
    link = (f'<a class="ch-handle" href="https://www.youtube.com/{escape(handle)}" '
            f'target="_blank" rel="noopener">{escape(handle)}</a>') if handle else ""
    return (f'<li><img class="ch-avatar" src="{avatar(channel)}" alt="" width="44" height="44" loading="lazy">'
            f'<div class="ch-head"><span class="ch-name">{name}</span><span class="ch-meta">{meta}</span>{link}</div>')


def main() -> None:
    channels = load_channels()
    missing = []
    for f in sorted((ROOT / "content" / "channels").glob("*.html")):
        text = f.read_text()

        def sub(m: re.Match) -> str:
            m2 = HEAD.match(m.group(0)) if m.group("name") is None else m
            name, meta = m2.group("name"), m2.group("meta")
            key = ALIASES.get(name.lower(), name.lower())
            if key not in channels:
                missing.append(f"{f.name}: {name}")
                return m.group(0)
            return render(name, meta, channels[key])

        new = ITEM.sub(sub, text)
        if new != text:
            f.write_text(new)
            print(f"updated {f.relative_to(ROOT)}")
    if missing:
        sys.exit("not in starter_packs.json:\n  " + "\n  ".join(missing))


if __name__ == "__main__":
    main()
