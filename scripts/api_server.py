#!/usr/bin/env python3
"""轻量 API 服务器：处理节点删除"""
import http.server, json, subprocess, sys, os
from pathlib import Path

PORT = 7824
SCRIPT_DIR = Path(__file__).parent
DELETE_SCRIPT = SCRIPT_DIR / "delete_node.py"

class Handler(http.server.BaseHTTPRequestHandler):
    def do_DELETE(self):
        # 解析路径：/api/nodes/<node_id>
        if not self.path.startswith("/api/nodes/"):
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": "Not Found"}).encode())
            return

        node_id = self.path[len("/api/nodes/"):]
        if not node_id:
            self.send_response(400)
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": "Missing node_id"}).encode())
            return

        # 调用删除脚本
        result = subprocess.run(
            [sys.executable, str(DELETE_SCRIPT), node_id],
            capture_output=True, text=True
        )

        if result.returncode == 0:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "message": result.stdout.strip()}).encode())
        else:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": result.stderr.strip()}).encode())

    def log_message(self, fmt, *args):
        pass  # 安静日志

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

if __name__ == "__main__":
    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"API server running on http://0.0.0.0:{PORT}", flush=True)
    server.serve_forever()
