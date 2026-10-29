#!/usr/bin/env python3
"""极简静态服务器（支持 Range 请求，便于拖动进度/缓存）。
用法: python3 serve.py [端口=8080] [绑定地址=0.0.0.0]
"""
import http.server, os, re, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
                      '.webmanifest': 'application/manifest+json', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
                      '.mp3': 'audio/mpeg', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.wav': 'audio/wav'}

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_head(self):
        rng = self.headers.get('Range')
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r'bytes=(\d*)-(\d*)', rng)
        size = os.path.getsize(path)
        start = int(m.group(1)) if m and m.group(1) else 0
        end = int(m.group(2)) if m and m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_error(416); return None
        f = open(path, 'rb'); f.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, src, dst):
        n = getattr(self, '_remaining', None)
        if n is None: return super().copyfile(src, dst)
        while n > 0:
            b = src.read(min(65536, n))
            if not b: break
            dst.write(b); n -= len(b)

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    host = sys.argv[2] if len(sys.argv) > 2 else '0.0.0.0'
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'正在服务 http://{host}:{port}/  (Ctrl+C 退出)')
    http.server.ThreadingHTTPServer((host, port), Handler).serve_forever()
