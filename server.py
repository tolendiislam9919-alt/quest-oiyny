# -*- coding: utf-8 -*-
"""
«Құпия есік» — жергілікті сервер (тек Python, қосымша кітапхана керек емес).

Не істейді:
  1) ойынның файлдарын береді (index.html, pad.html, *.js);
  2) панель мен телефондардың арасында хабар тасиды:
       POST /relay/send            — хабар жіберу  {"box": "...", "msg": {...}}
       GET  /relay/events?box=...  — хабарларды тыңдау (Server-Sent Events)
       GET  /relay/ping            — сервер бар ма, компьютердің IP-адресі

Интернет керек емес: компьютер мен телефондар бір Wi-Fi желісінде болса жеткілікті.
Іске қосу: start.bat (немесе:  python server.py)
"""
import json
import os
import queue
import socket
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get('PORT', '8000'))
ROOT = os.path.dirname(os.path.abspath(__file__))

boxes = {}                 # box атауы → тыңдаушылардың кезектері
lock = threading.Lock()


def lan_ip():
    """Компьютердің жергілікті желідегі адресі (телефон осыған кіреді)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))       # ешнәрсе жібермейді, тек бағытты анықтайды
        ip = s.getsockname()[0]
        s.close()
        if not ip.startswith('127.'):
            return ip
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith('127.'):
                return ip
    except OSError:
        pass
    return '127.0.0.1'


HOST_IP = lan_ip()


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'          # байланыс қайта қолданылады — жылдамырақ

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):     # әр сұрауды экранға шығармаймыз
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/relay/ping':
            return self._json({'relay': True, 'host': HOST_IP, 'port': PORT})
        if u.path == '/relay/events':
            box = (parse_qs(u.query).get('box') or [''])[0]
            return self._events(box)
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != '/relay/send':
            return self._json({'error': 'not found'}, 404)
        try:
            n = int(self.headers.get('Content-Length') or 0)
            data = json.loads(self.rfile.read(n).decode('utf-8'))
            box, msg = str(data['box']), data['msg']
        except Exception:
            return self._json({'error': 'bad request'}, 400)
        line = json.dumps(msg, ensure_ascii=False)
        with lock:
            subs = list(boxes.get(box, ()))
        for q in subs:
            q.put(line)
        return self._json({'ok': True, 'to': len(subs)})

    def _events(self, box):
        q = queue.Queue()
        with lock:
            boxes.setdefault(box, set()).add(q)
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(b': ok\n\n')
            self.wfile.flush()
            while True:
                try:
                    line = q.get(timeout=15)
                    out = ('data: ' + line + '\n\n').encode('utf-8')
                except queue.Empty:
                    out = b': ping\n\n'            # байланыстың тірі екенін тексереміз
                self.wfile.write(out)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with lock:
                s = boxes.get(box)
                if s:
                    s.discard(q)
                    if not s:
                        boxes.pop(box, None)
            self.close_connection = True


def main():
    # Windows консолі қазақ әріптерін (Қ, Ұ, ...) шығара алмай құламасын
    for st in (sys.stdout, sys.stderr):
        try:
            st.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    try:
        srv = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    except OSError:
        print(f'\n  {PORT}-порт бос емес. Сервер бұрыннан ашық тұрған шығар — сол терезені жабыңыз.')
        input('  Enter басыңыз...')
        sys.exit(1)
    srv.daemon_threads = True
    url = f'http://{HOST_IP}:{PORT}/'
    print()
    print('  ===============================================')
    print('   ҚҰПИЯ ЕСІК — сервер іске қосылды')
    print('  ===============================================')
    print(f'   Панельде ашыңыз:  {url}')
    print('   Телефондар компьютермен БІР Wi-Fi желісінде болсын.')
    print('   Тоқтату үшін осы терезені жабыңыз (немесе Ctrl+C).')
    print()
    if HOST_IP == '127.0.0.1':
        print('   ЕСКЕРТУ: компьютер ешбір желіге қосылмаған — телефон кіре алмайды.')
    if '--no-browser' not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
