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
X-Content-Type-Options: nosniff, its errors for malformed requests included.
A request without a usable HTTP version can take no headers back, so it gets
no answer. Files without a content hash in their name (index.html among
them) are sent with Cache-Control: no-cache; hashed assets may be cached for
good. A connection that sends nothing for --idle-timeout seconds is closed,
and the log escapes control bytes. Usage:

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
TEXT = "text/plain; charset=utf-8"
# Vite names assets with a content hash: index-0lhCoXes.js, InstrumentSans-Variable-tWV223Ma.woff2.
HASHED = re.compile(r"-[A-Za-z0-9_-]{8}\.(js|css|woff2|map)$|-[A-Za-z0-9_-]{8}\.js\.map$")
# Request paths are plain: letters, digits, dot, dash, underscore and slash.
PLAIN = re.compile(r"/[A-Za-z0-9._/-]*")
# A mount is plain segments, none of them empty or starting with a dot.
MOUNT = re.compile(r"(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)+")
BARE = "/.cindl-bare"
COMMON = (
    ("Content-Security-Policy", "frame-ancestors 'none'"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
)
IDLE_TIMEOUT = 10.0
MAX_IDLE_TIMEOUT = 300.0
# The log quotes request lines as received: control bytes (an escape sequence
# meant for a terminal) are written as \xNN, and a backslash as \\.
ESCAPES = {c: "\\x%02x" % c for c in [*range(0x20), *range(0x7F, 0xA0)]}
ESCAPES[ord("\\")] = "\\\\"
LOGGED = str.maketrans(ESCAPES)


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


def handler(files, mount, idle):
    class Handler(BaseHTTPRequestHandler):
        server_version = "cindl-serve"
        sys_version = ""
        # Without one, a connection that never finishes its request holds its thread for good.
        timeout = idle

        def do_GET(self):
            self.answer(head=False)

        def do_HEAD(self):
            self.answer(head=True)

        def refuse(self):
            self.reply(405, b"Method Not Allowed\n", TEXT, [("Allow", "GET, HEAD")])

        do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = refuse

        def send_error(self, code, message=None, explain=None):
            # The standard library's own error page, for a malformed request
            # line, an unknown method or a line too long, is HTML that quotes
            # the request and lacks the headers above. This one quotes nothing.
            self.close_connection = True
            phrase = self.responses.get(code, ("Error",))[0]
            body = ("%s\n" % phrase).encode()
            self.reply(code, body, TEXT, [("Connection", "close")], self.command == "HEAD")

        def answer(self, head):
            path = self.path.split("?", 1)[0]
            parts = path.split("/")
            if not PLAIN.fullmatch(path) or "//" in path or "." in parts or ".." in parts:
                return self.reply(404, b"Not Found\n", TEXT, head=head)
            if path in (mount, BARE):
                return self.reply(301, b"", TEXT, [("Location", mount + "/")], head)
            relative = path[len(mount) + 1 :] if path.startswith(mount + "/") else path[1:]
            body = files.get(relative or "index.html")
            if body is None:
                return self.reply(404, b"Not Found\n", TEXT, head=head)
            name = relative or "index.html"
            cache = "public, max-age=31536000, immutable" if HASHED.search(name) else "no-cache"
            kind = TYPES[os.path.splitext(name)[1]]
            self.reply(200, body, kind, [("Cache-Control", cache)], head)

        def reply(self, status, body, kind, extra=(), head=False):
            if self.request_version == "HTTP/0.9":
                # No version, or one never parsed: an answer here could carry no headers.
                self.log_message('"%s" not answered: no HTTP version', self.requestline)
                self.close_connection = True
                return
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
            sys.stderr.write("cindl-serve: %s\n" % (format % args).translate(LOGGED))

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve a built Cindl web client on loopback.")
    parser.add_argument("--root", required=True, help="the build (apps/web/dist)")
    parser.add_argument("--port", type=int, required=True, help="loopback port; 0 picks one")
    parser.add_argument("--host", default="127.0.0.1", help="a loopback address (default 127.0.0.1)")
    parser.add_argument("--mount", default="/cindl", help="the public mount path (default /cindl)")
    parser.add_argument(
        "--idle-timeout",
        type=float,
        default=IDLE_TIMEOUT,
        help="seconds a connection may send nothing before it is closed (default 10, at most 300)",
    )
    args = parser.parse_args(argv)
    try:
        loopback = ipaddress.ip_address(args.host).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise SystemExit(f"cindl-serve: {args.host!r} is not a loopback address; it serves loopback only")
    mount = args.mount.rstrip("/")
    if not MOUNT.fullmatch(mount):
        raise SystemExit(f"cindl-serve: the mount must be a path such as /cindl, not {args.mount!r}")
    if not 0 < args.idle_timeout <= MAX_IDLE_TIMEOUT:
        raise SystemExit(f"cindl-serve: --idle-timeout must be above 0 and at most {MAX_IDLE_TIMEOUT:g} seconds")
    files = load(args.root)

    class Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in args.host else socket.AF_INET
        daemon_threads = True

    server = Server((args.host, args.port), handler(files, mount, args.idle_timeout))
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
