#!/usr/bin/env python3
"""Fake Claude / OpenAI-compatible API for integration tests.

Streams SSE responses in the real formats and appends every request to a JSONL log.
The last user message selects the behavior:
  FAIL401   -> 401 error
  SLOW      -> slow stream (for testing Stop)
  MATH      -> an answer with LaTeX maths
  otherwise -> a Markdown answer that says whether the paper's marker text was in the context

Usage: mock_server.py PORT LOGFILE
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

MARKER = "QUANTUM-BANANA-42"
MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]

ANSWER = """## Summary
The paper's marker is **{marker_status}** and the method is *self-attention*.

| Aspect | Detail |
|---|---|
| Model | Transformer |
| Marker | `{marker_status}` |

- First point
- Second point
  - Nested point

```python
print("hello <world>")
```

```
{long_line}
```

More at https://example.org/paper. Long link: https://example.org/{long_path}"""

# LaTeX as models write it (the first part is from a real answer), with a wide equation,
# a price that must stay text, and one broken formula
MATH_ANSWER = r"""The loss has two parts, \(L_{\text{img}}\) and \(L_{\text{unc}}\):

- \(\tilde C\): render **after** the appearance adjustment.
- The paper sets \(\lambda_{\text{dssim}}=0.2\); a run costs $5 and $10 with $x_i^2$ terms.

\[
L_{\text{DINO}}
=\min\!\left(1,\;2-2\cos(\tilde D,D)\right),
\qquad
L_{\text{uncertainty}}
=\frac{L_{\text{DINO}}}{2\sigma^2}
+\lambda_{\text{prior}}\log\sigma .
\]

A wide one:
$$\sum_{i=1}^{N} w_i \left\| \hat{C}_i - C_i \right\|_2^2 + \lambda_1 \sum_{j} \sqrt{\alpha_j} + \lambda_2 \int_0^1 \overrightarrow{v}(t)\,dt + \lambda_3 \operatorname{SSIM}(\hat C, C) + \lambda_4 \log \det \Sigma$$

Broken: \(\frac{a\)"""

# Long unbreakable content, to check the chat never widens Zotero's item pane
LONG_LINE = "very_long_identifier_" * 15
LONG_PATH = "segment" * 30


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except Exception:
            body = None
        with open(self.server.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": body,
            }) + "\n")

        if self.path.endswith("/v1/messages"):
            self.handle_anthropic(body)
        elif self.path.endswith("/chat/completions"):
            self.handle_openai(body)
        else:
            self.send_json(404, {"error": {"message": f"unknown path {self.path}"}})

    def do_GET(self):
        # Model list, for both the Claude (/v1/models) and OpenAI-style (/v1/models) shapes
        if urlparse(self.path).path == "/v1/models":
            return self.send_json(200, {"data": [{"id": m, "type": "model"} for m in MODELS]})
        self.send_json(404, {"error": {"message": f"unknown path {self.path}"}})

    def send_json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def start_stream(self):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()

    def write(self, text):
        self.wfile.write(text.encode())
        self.wfile.flush()

    @staticmethod
    def has_image(body):
        # Claude: {"type": "image", ...}; OpenAI: {"type": "image_url", ...}
        return '"type": "image' in json.dumps(body.get("messages"))

    @staticmethod
    def last_user_text(messages):
        for m in reversed(messages or []):
            if m.get("role") == "user":
                c = m.get("content")
                return c if isinstance(c, str) else json.dumps(c)
        return ""

    def answer_chunks(self, context_text, question, has_image=False):
        if "Reply with the single word OK" in question:
            return ["OK"]
        if "MATH" in question:
            return [MATH_ANSWER[i:i + 9] for i in range(0, len(MATH_ANSWER), 9)]
        status = "CONTEXT-SEEN" if MARKER in context_text else "CONTEXT-MISSING"
        if has_image:
            status += " IMAGE-SEEN"
        text = ANSWER.format(marker_status=status, long_line=LONG_LINE, long_path=LONG_PATH)
        return [text[i:i + 9] for i in range(0, len(text), 9)]

    def handle_anthropic(self, body):
        if self.headers.get("x-api-key") != "test-key":
            return self.send_json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        question = self.last_user_text(body.get("messages"))
        if "FAIL401" in question:
            return self.send_json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        system = " ".join(block.get("text", "") for block in body.get("system", []))

        def ev(kind, data):
            self.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n")

        self.start_stream()
        ev("message_start", {"type": "message_start", "message": {"id": "msg_test", "type": "message", "role": "assistant", "model": body.get("model"), "content": []}})
        ev("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}})
        ev("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "SECRET-THOUGHTS"}})
        ev("content_block_stop", {"type": "content_block_stop", "index": 0})
        ev("content_block_start", {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}})
        if "SLOW" in question:
            chunks = [f"slow chunk {i}. " for i in range(40)]
            delay = 0.5
        else:
            chunks = self.answer_chunks(system, question, self.has_image(body))
            delay = 0.01
        try:
            for chunk in chunks:
                ev("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": chunk}})
                time.sleep(delay)
            ev("content_block_stop", {"type": "content_block_stop", "index": 1})
            ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 10}})
            ev("message_stop", {"type": "message_stop"})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def handle_openai(self, body):
        messages = body.get("messages") or []
        question = self.last_user_text(messages)
        if "FAIL401" in question:
            return self.send_json(401, {"error": {"message": "Incorrect API key provided"}})
        system = messages[0].get("content", "") if messages and messages[0].get("role") == "system" else ""
        model = body.get("model")
        self.start_stream()
        try:
            for chunk in self.answer_chunks(system, question, self.has_image(body)):
                self.write("data: " + json.dumps({"model": model, "choices": [{"index": 0, "delta": {"content": chunk}}]}) + "\n\n")
                time.sleep(0.01)
            self.write("data: " + json.dumps({"model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}) + "\n\n")
            self.write("data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    port, log_path = int(sys.argv[1]), sys.argv[2]
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.log_path = log_path
    print(f"mock server on 127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
