#!/usr/bin/env python3
"""Serve a built Cindl web client on loopback, behind a front that proxies a
path to it but cannot set response headers (for example Tailscale Serve).

Only Python's standard library, so it runs wherever Hermes does. It serves
only the regular files under --root, read once at start: no symlinks, no
directory listings, nothing outside the root, and nothing written later. The
mount path (default /cindl) may reach it as is (/cindl/assets/x.js) or with
the front's mount stripped (/assets/x.js). The bare mount path, and the
sentinel /.cindl-bare a stripping front can map it to, redirect to the mount
path with a slash, which the build's relative asset paths need.

Every response carries Content-Security-Policy: frame-ancestors 'none' and
X-Content-Type-Options: nosniff. Files without a content hash in their name
(index.html among them) are sent with Cache-Control: no-cache; hashed assets
may be cached for good. Usage:

    python3 cindl-serve.py --root DIR --port 8099 [--host 127.0.0.1] [--mount /cindl]
"""

import argparse
import ipaddress
import os
import re
import socket
import stat
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",
}
# Vite names assets with a content hash: index-0lhCoXes.js, InstrumentSans-Variable-tWV223Ma.woff2.
HASHED = re.compile(r"-[A-Za-z0-9_-]{8}\.(js|css|woff2|map)$|-[A-Za-z0-9_-]{8}\.js\.map$")
# Request paths are plain: letters, digits, dot, dash, underscore and slash.
PLAIN = re.compile(r"^/[A-Za-z0-9._/-]*$")
BARE = "/.cindl-bare"
COMMON = (
    ("Content-Security-Policy", "frame-ancestors 'none'"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
)


def load(root):
    """Every regular file under root, read now; symlinks and the rest are left out."""
    base = os.path.realpath(root)
    if not os.path.isdir(base):
        raise SystemExit(f"cindl-serve: {root} is not a directory")
    files = {}
    for directory, dirnames, filenames in os.walk(base, followlinks=False):
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(directory, d))]
        for name in filenames:
            full = os.path.join(directory, name)
            if not stat.S_ISREG(os.lstat(full).st_mode):
                continue
            relative = os.path.relpath(full, base).replace(os.sep, "/")
            if os.path.splitext(relative)[1] not in TYPES:
                continue
            with open(full, "rb") as handle:
                files[relative] = handle.read()
    if "index.html" not in files:
        raise SystemExit(f"cindl-serve: no index.html in {root}")
    return files


def handler(files, mount):
    class Handler(BaseHTTPRequestHandler):
        server_version = "cindl-serve"
        sys_version = ""

        def do_GET(self):
            self.answer(head=False)

        def do_HEAD(self):
            self.answer(head=True)

        def refuse(self):
            self.reply(405, b"Method Not Allowed\n", "text/plain; charset=utf-8", [("Allow", "GET, HEAD")])

        do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = refuse

        def answer(self, head):
            path = self.path.split("?", 1)[0]
            parts = path.split("/")
            if not PLAIN.match(path) or "//" in path or "." in parts or ".." in parts:
                return self.reply(404, b"Not Found\n", "text/plain; charset=utf-8", head=head)
            if path in (mount, BARE):
                return self.reply(301, b"", "text/plain; charset=utf-8", [("Location", mount + "/")], head)
            relative = path[len(mount) + 1 :] if path.startswith(mount + "/") else path[1:]
            body = files.get(relative or "index.html")
            if body is None:
                return self.reply(404, b"Not Found\n", "text/plain; charset=utf-8", head=head)
            name = relative or "index.html"
            cache = "public, max-age=31536000, immutable" if HASHED.search(name) else "no-cache"
            kind = TYPES[os.path.splitext(name)[1]]
            self.reply(200, body, kind, [("Cache-Control", cache)], head)

        def reply(self, status, body, kind, extra=(), head=False):
            self.send_response(status)
            for name, value in COMMON:
                self.send_header(name, value)
            headers = dict(extra)
            if "Cache-Control" not in headers:
                self.send_header("Cache-Control", "no-cache")
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def log_message(self, format, *args):
            sys.stderr.write("cindl-serve: %s\n" % (format % args))

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve a built Cindl web client on loopback.")
    parser.add_argument("--root", required=True, help="the build (apps/web/dist)")
    parser.add_argument("--port", type=int, required=True, help="loopback port; 0 picks one")
    parser.add_argument("--host", default="127.0.0.1", help="a loopback address (default 127.0.0.1)")
    parser.add_argument("--mount", default="/cindl", help="the public mount path (default /cindl)")
    args = parser.parse_args(argv)
    try:
        loopback = ipaddress.ip_address(args.host).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise SystemExit(f"cindl-serve: {args.host} is not a loopback address; it serves loopback only")
    mount = args.mount.rstrip("/")
    if not mount.startswith("/") or not PLAIN.match(mount) or mount == "":
        raise SystemExit(f"cindl-serve: the mount must be a path such as /cindl, not {args.mount}")
    files = load(args.root)

    class Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in args.host else socket.AF_INET
        daemon_threads = True

    server = Server((args.host, args.port), handler(files, mount))
    host, port = str(server.server_address[0]), server.server_address[1]
    shown = f"[{host}]" if ":" in host else host
    print(f"cindl-serve: {len(files)} files on http://{shown}:{port} for {mount}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
