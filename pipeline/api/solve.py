"""Vercel Python function (same project as api/parse.py): POST /api/solve, body = SolverInput JSON.

Header x-parser-secret must equal $PARSER_SECRET. → 200 SolveResult JSON.
"""
import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from docksolve import solve  # noqa: E402

MAX_BYTES = 4 * 1024 * 1024


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        secret = os.environ.get("PARSER_SECRET", "")
        given = self.headers.get("x-parser-secret", "")
        if not secret or not hmac.compare_digest(secret, given):
            return self._send(401, {"error": "unauthorized"})
        size = int(self.headers.get("content-length") or 0)
        if size <= 0 or size > MAX_BYTES:
            return self._send(413, {"error": f"body must be 1 byte to {MAX_BYTES} bytes"})
        try:
            inp = json.loads(self.rfile.read(size))
        except ValueError:
            return self._send(400, {"error": "body is not JSON"})
        try:
            result = solve(inp)
        except Exception as e:  # a solver bug must not look like bad input
            return self._send(500, {"error": f"solver failed: {type(e).__name__}"})
        return self._send(200, result)

    def _send(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
