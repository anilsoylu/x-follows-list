# XFL bench save server: serves the repo dir; POST /bench/save?name=<name>
# writes the request body to bench/<name>.json (the repeatable artifact).
import http.server
import pathlib
import socketserver
import urllib.parse


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/bench/save':
            name = urllib.parse.parse_qs(u.query).get('name', ['results'])[0]
            assert '/' not in name and '..' not in name, 'bad name'
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            pathlib.Path(f'bench/{name}.json').write_bytes(body)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', int(__import__('sys').argv[1])), Handler) as httpd:
    httpd.serve_forever()
