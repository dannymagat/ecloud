# Stub api / portal upstream for the edge behaviour check (validate-local.sh only).
# Answers every request with its request line and headers as JSON; mimics an Express app by
# sending X-Powered-By, and any path containing /xfo sends its own X-Frame-Options (edge must not add a second one).
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Echo(BaseHTTPRequestHandler):
    def _answer(self):
        body = json.dumps(
            {"upstream": sys.argv[2], "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-Powered-By", "Express")
        if "/xfo" in self.path:
            self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _answer
    do_POST = _answer

    def log_message(self, *args):
        pass


HTTPServer(("0.0.0.0", int(sys.argv[1])), Echo).serve_forever()
