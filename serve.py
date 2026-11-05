#!/usr/bin/env python3
"""Serve GlobeMap from this folder with the MIME types the PWA needs.

Usage, from this directory:
    python3 serve.py
    python3 serve.py 47321

Do not open index.html as a file:// URL. MapLibre's globe worker only starts
on http or https.
"""

from __future__ import annotations

import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 47321
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json",
        ".geojson": "application/geo+json",
        ".webmanifest": "application/manifest+json",
        ".pbf": "application/octet-stream",
        ".png": "image/png",
        ".txt": "text/plain; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)


def main() -> None:
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"GlobeMap at http://127.0.0.1:{PORT}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
