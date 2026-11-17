#!/usr/bin/env python3
"""Build the content pages for videofocus.app.

    python3 tools/build.py

What it does:
  1. Renders every content/**/*.html into landing/<path>.html, adding the shared
     head (SEO and social tags, JSON-LD), nav, breadcrumbs, CTA, related links
     and footer.
  2. Rewrites every App Store link in landing/ that carries data-ct="..." so it
     uses the campaign URL (set PT below once you have the provider token).
  3. Replaces the footer links and the analytics block on every page.
  4. Writes landing/sitemap.xml.

Content file format: an HTML comment header with `key: value` lines, then the
page body. Keys: path, title, description, h1, eyebrow, kind
(guide|compare|list|hub|page), updated (YYYY-MM-DD), related (comma-separated
paths), lede, noindex (yes). FAQ items written as <details> inside
<div class="faq-list"> also become FAQPage structured data.

No dependencies beyond the Python standard library.
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
LANDING = ROOT / "landing"
SITE = "https://videofocus.app"
APP_ID = "6795647933"
# Bump when styles.css or theme.js change: nginx lets browsers cache them for 7 days.
ASSET_V = "20261117"

# ---- Fill these in (Step 1) -------------------------------------------------
PT = ""            # App Store Connect provider token, e.g. "123456789"
GOATCOUNTER = ""   # GoatCounter code, e.g. "videofocus" for videofocus.goatcounter.com
# ------------------------------------------------------------------------------

# Static pages that aren't built from content/ but belong in the sitemap.
STATIC_PAGES = [
    ("/", "2026-11-16", "1.0"),
    ("/youtube-access", "2026-09-10", "0.5"),
    ("/support", "2026-11-14", "0.4"),
    ("/privacy", "2026-11-14", "0.2"),
    ("/terms", "2026-11-14", "0.2"),
]

APPLE_SVG = '<svg width="18" height="22" viewBox="0 0 20 24" fill="white" aria-hidden="true"><path d="M16.57 12.84c-.03-2.74 2.24-4.07 2.34-4.13-1.28-1.87-3.26-2.13-3.96-2.15-1.67-.17-3.29 1-4.14 1-.86 0-2.17-.98-3.58-.95-1.82.03-3.52 1.07-4.46 2.71-1.92 3.33-.49 8.24 1.36 10.94.92 1.33 2 2.81 3.42 2.76 1.38-.06 1.9-.89 3.56-.89 1.66 0 2.14.89 3.58.86 1.48-.03 2.4-1.34 3.29-2.67 1.05-1.52 1.48-3.01 1.5-3.09-.03-.01-2.88-1.11-2.91-4.39zM13.86 4.6c.74-.92 1.25-2.17 1.11-3.44-1.07.05-2.39.73-3.16 1.63-.69.8-1.3 2.1-1.14 3.33 1.2.09 2.43-.61 3.19-1.52z"/></svg>'

FOOTER_LINKS = """<div class="footer-links">
      <a href="/guides">Guides for parents</a>
      <a href="/press">Press</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
      <a href="/support">Support</a>
    </div>"""

KIND_LABEL = {"guide": "Guide", "compare": "Comparison", "list": "Channel list", "hub": "Guides", "page": ""}
KIND_CRUMB = {"guide": ("Guides", "/guides"), "compare": ("Guides", "/guides"), "list": ("Channel lists", "/guides#channel-lists")}


def app_url(ct: str) -> str:
    if PT:
        return f"https://apps.apple.com/app/apple-store/id{APP_ID}?pt={PT}&ct={ct}&mt=8"
    return f"https://apps.apple.com/app/videofocus-kids-video-library/id{APP_ID}"


def analytics_block() -> str:
    if not GOATCOUNTER:
        return "<!-- analytics:start --><!-- analytics:end -->"
    return ("<!-- analytics:start -->"
            f'<script data-goatcounter="https://{GOATCOUNTER}.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>'
            "<!-- analytics:end -->")


def parse(path: Path):
    text = path.read_text()
    m = re.match(r"\s*<!--(.*?)-->\s*(.*)", text, re.S)
    if not m:
        raise SystemExit(f"{path}: missing header comment")
    meta = {}
    for line in m.group(1).strip().splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    for req in ("path", "title", "description", "h1", "kind"):
        if req not in meta:
            raise SystemExit(f"{path}: missing '{req}'")
    meta["body"] = m.group(2)
    meta.setdefault("updated", "2026-11-16")
    meta["src"] = path
    return meta


def faq_items(body: str):
    items = []
    for q, a in re.findall(r"<details>\s*<summary>(.*?)</summary>\s*<div>(.*?)</div>\s*</details>", body, re.S):
        plain_a = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", a)).strip()
        items.append({"@type": "Question", "name": html.unescape(re.sub(r"<[^>]+>", "", q)).strip(),
                      "acceptedAnswer": {"@type": "Answer", "text": html.unescape(plain_a)}})
    return items


def slug(p: str) -> str:
    return p.strip("/").replace("/", "-") or "home"


def render(page, pages_by_path):
    p = page["path"]
    url = SITE + p
    title = page["title"]
    desc = page["description"]
    kind = page["kind"]
    e = html.escape

    crumbs = [("Home", "/")]
    if kind in KIND_CRUMB:
        crumbs.append(KIND_CRUMB[kind])
    crumbs.append((page.get("crumb", page["h1"]), p))

    ld = []
    if kind in ("guide", "compare", "list"):
        ld.append({
            "@context": "https://schema.org", "@type": "Article",
            "headline": page["h1"], "description": desc,
            "datePublished": page.get("published", page["updated"]), "dateModified": page["updated"],
            "author": {"@type": "Organization", "name": "VideoFocus", "url": SITE},
            "publisher": {"@type": "Organization", "name": "VideoFocus", "logo": {"@type": "ImageObject", "url": SITE + "/icon-512.png"}},
            "image": SITE + "/assets/og-image.png", "mainEntityOfPage": url,
        })
    ld.append({
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": n, "item": SITE + h.split("#")[0]}
                            for i, (n, h) in enumerate(crumbs)],
    })
    faqs = faq_items(page["body"])
    if faqs:
        ld.append({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": faqs})
    ld_html = "\n".join(f'<script type="application/ld+json">{json.dumps(x, ensure_ascii=False)}</script>' for x in ld)

    crumb_html = '<div class="crumbs" role="navigation" aria-label="Breadcrumb">' + '<span>›</span>'.join(
        f'<a href="{h}">{e(n)}</a>' for n, h in crumbs[:-1]) + "</div>" if kind != "page" else ""

    related = [pages_by_path[r.strip()] for r in page.get("related", "").split(",") if r.strip() in pages_by_path]
    related_html = ""
    if related:
        cards = "".join(f'<a href="{r["path"]}"><span class="t">{e(r["h1"])}</span><span class="d">{e(r.get("card", r["description"]))}</span></a>'
                        for r in related)
        related_html = f'<aside class="related"><h2>Keep reading</h2><div class="related-grid">{cards}</div></aside>'

    ct = "site-" + slug(p)[:30]
    cta_html = ""
    if kind != "page" or page.get("cta") == "yes":
        cta_html = (f'<div class="cta-box"><div><h2>Try VideoFocus free</h2><p>Only the YouTube channels you choose, with screen time that holds. '
                    f'iPhone and iPad. Family Plan free for 2 weeks.</p></div>'
                    f'<a class="btn-app-store" data-ct="{ct}" href="{app_url(ct)}">{APPLE_SVG} Download on the App Store</a></div>')

    lede = f'<p class="legal-lede">{page["lede"]}</p>' if page.get("lede") else ""
    eyebrow = page.get("eyebrow", KIND_LABEL.get(kind, ""))
    updated_line = (f'<p class="legal-updated">Updated <strong>{fmt_date(page["updated"])}</strong> · by the parent who builds VideoFocus</p>'
                    if kind in ("guide", "compare", "list") else "")
    robots = '<meta name="robots" content="noindex">' if page.get("noindex") == "yes" else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
{robots}
<link rel="canonical" href="{url}">
<meta name="apple-itunes-app" content="app-id={APP_ID}">
<meta property="og:site_name" content="VideoFocus">
<meta property="og:title" content="{e(page.get('og_title', page['h1']))}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}/assets/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css?v={ASSET_V}">
<script src="/theme.js?v={ASSET_V}"></script>
{ld_html}
</head>
<body data-theme="emerald" class="legal-body-page">

<nav id="mainNav" class="scrolled">
  <div class="nav-inner">
    <a href="/" class="nav-logo">
      <span class="nav-logo-mark"><img class="theme-logo" src="/assets/logo-emerald.png" alt="VideoFocus" width="944" height="706"></span>
      <span class="nav-logo-text">VideoFocus</span>
    </a>
    <div class="nav-links">
      <a href="/#features">How it works</a>
      <a href="/guides">Guides</a>
      <a href="/#pricing">Pricing</a>
    </div>
    <div class="nav-right">
      <a class="nav-cta" data-ct="site-nav" href="{app_url('site-nav')}">Download</a>
    </div>
  </div>
</nav>

<article class="legal-page">
  <div class="legal-inner">
    <header class="legal-header">
      {crumb_html}
      {f'<div class="section-eyebrow">{e(eyebrow)}</div>' if eyebrow else ''}
      <h1>{e(page['h1'])}</h1>
      {updated_line}
    </header>
    <div class="legal-content">
      {lede}
{page['body'].rstrip()}
      {cta_html}
      {related_html}
    </div>
  </div>
</article>

<footer>
  <div class="footer-inner">
    <a href="/" class="footer-brand" aria-label="VideoFocus home">
      <img class="theme-logo" src="/assets/logo-emerald.png" alt="" width="944" height="706">
      <span class="footer-brand-text">VideoFocus</span>
    </a>
    {FOOTER_LINKS}
    <div class="footer-copy">&copy; 2026 Venture Ink LLC. YouTube is a trademark of Google LLC; VideoFocus is not affiliated with or endorsed by Google.</div>
  </div>
</footer>
{analytics_block()}
</body>
</html>
"""


def fmt_date(d: str) -> str:
    import datetime
    return datetime.date.fromisoformat(d).strftime("%-d %B %Y")


def postprocess_all():
    """App Store links, footer links and analytics on every page in landing/."""
    for f in LANDING.rglob("*.html"):
        s = f.read_text()
        orig = s
        s = re.sub(r'(<a\b[^>]*?data-ct="([^"]+)"[^>]*?href=")[^"]*(")',
                   lambda m: m.group(1) + html.escape(app_url(m.group(2))) + m.group(3), s)
        s = re.sub(r'(<a\b[^>]*?href=")[^"]*("[^>]*?data-ct="([^"]+)")',
                   lambda m: m.group(1) + html.escape(app_url(m.group(3))) + m.group(2), s)
        s = re.sub(r'(href="/?styles\.css)(\?v=[^"]*)?"', lambda m: f'{m.group(1)}?v={ASSET_V}"', s)
        s = re.sub(r'(src="/?theme\.js)(\?v=[^"]*)?"', lambda m: f'{m.group(1)}?v={ASSET_V}"', s)
        s = re.sub(r'<div class="footer-links">.*?</div>', FOOTER_LINKS, s, count=1, flags=re.S)
        if "<!-- analytics:start -->" in s:
            s = re.sub(r"<!-- analytics:start -->.*?<!-- analytics:end -->", analytics_block(), s, flags=re.S)
        elif "</body>" in s:
            s = s.replace("</body>", analytics_block() + "\n</body>", 1)
        if s != orig:
            f.write_text(s)


def main():
    pages = [parse(f) for f in sorted(CONTENT.rglob("*.html"))]
    by_path = {p["path"]: p for p in pages}
    for page in pages:
        out = LANDING / (page["path"].strip("/") + ".html")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render(page, by_path))
        print("built", page["path"], "->", out.relative_to(ROOT))
    postprocess_all()

    entries = list(STATIC_PAGES) + [(p["path"], p["updated"], "0.8" if p["kind"] != "page" else "0.5")
                                    for p in pages if p.get("noindex") != "yes"]
    xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for path, mod, prio in entries:
        xml.append(f"  <url><loc>{SITE}{path}</loc><lastmod>{mod}</lastmod><priority>{prio}</priority></url>")
    xml.append("</urlset>")
    (LANDING / "sitemap.xml").write_text("\n".join(xml) + "\n")
    print(f"sitemap: {len(entries)} URLs")


if __name__ == "__main__":
    main()
