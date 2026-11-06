#!/usr/bin/env python3
"""Refresh url.txt entries that have a 5th field (a filename pattern).

  number | slug | Name | URL | pattern

The URL's folder (everything up to the last "/") is the place to look.
- GitHub release URLs  (github.com/<owner>/<repo>/releases/...): newest release's files (no API/token)
- anything else: treated as a directory index page (Apache/nginx listing)
The highest version whose filename matches the glob pattern wins.
Entries without a pattern are never touched.
"""
import fnmatch, os, re, urllib.request
from html.parser import HTMLParser
from urllib.parse import urljoin, unquote, urlparse, quote

FILE = os.environ.get("URL_FILE", "url.txt")
UA = {"User-Agent": "get-harry-run-updater/1.0"}


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def vkey(name):
    return tuple(int(n) for n in re.findall(r"\d+", name))


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for k, v in attrs:
                if k == "href" and v:
                    self.hrefs.append(v)


def from_index(url, pattern):
    d = url.split("?")[0]
    d = d[: d.rfind("/") + 1]
    p = Links()
    p.feed(fetch(d))
    best = {}
    for href in p.hrefs:
        if "?" in href or href.endswith("/"):
            continue
        name = unquote(os.path.basename(urlparse(urljoin(d, href)).path))
        if fnmatch.fnmatch(name, pattern):
            best[name] = vkey(name)
    if not best:
        raise RuntimeError(f"no file matching {pattern} in {d}")
    name = max(best, key=best.get)
    return urljoin(d, quote(name))


def from_github(url, pattern):
    # No API (so no token): /releases/latest redirects to the newest tag page,
    # and /releases/expanded_assets/<tag> lists that release's files as plain HTML.
    m = re.search(r"github\.com/([^/]+)/([^/]+)/releases", url)
    base = f"https://github.com/{m.group(1)}/{m.group(2)}"
    with urllib.request.urlopen(urllib.request.Request(base + "/releases/latest", headers=UA), timeout=30) as r:
        final = r.geturl()
    if "/tag/" not in final:
        raise RuntimeError("could not find latest release tag")
    tag = final.rsplit("/tag/", 1)[1]
    p = Links()
    p.feed(fetch(f"{base}/releases/expanded_assets/{tag}"))
    hits = {}
    for href in p.hrefs:
        if "/releases/download/" in href:
            name = unquote(os.path.basename(urlparse(href).path))
            if fnmatch.fnmatch(name, pattern):
                hits[urljoin("https://github.com", href)] = vkey(name)
    if not hits:
        raise RuntimeError(f"no release asset matching {pattern}")
    return max(hits, key=hits.get)


def main():
    lines = open(FILE, encoding="utf-8").read().split("\n")
    changed = failed = 0
    for n, line in enumerate(lines):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 5 or not parts[4]:
            continue
        slug, url, pattern = parts[1], parts[3], parts[4]
        try:
            new = (from_github if re.search(r"github\.com/[^/]+/[^/]+/releases", url) else from_index)(url, pattern)
        except Exception as e:
            failed += 1
            print(f"::warning::{slug}: {e}")
            continue
        if new != url:
            parts[3] = new
            lines[n] = " | ".join(parts)
            changed += 1
            print(f"{slug}: {url} -> {new}")
        else:
            print(f"{slug}: up to date")
    if changed:
        open(FILE, "w", encoding="utf-8").write("\n".join(lines))
    print(f"{changed} updated, {failed} failed")


if __name__ == "__main__":
    main()
