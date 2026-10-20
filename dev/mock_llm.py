"""Mock OpenAI-compatible chat server that stands in for the company Qwen endpoint.

Behaviour (deterministic, for tests):
- If the last user message contains "PLEASE_SEND_TO:<name>" and no tool result
  follows yet, the model calls the `team_send` tool with to=<name>.
- Otherwise it answers with plain text: "QWEN-REPLY: <first 80 chars of last user text>".
Supports streaming (SSE) and non-streaming responses.
"""
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open(sys.argv[2] if len(sys.argv) > 2 else "/dev/null", "a")


def last_user_text(messages):
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, list):
                return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
            return c or ""
    return ""


def decide(body):
    msgs = body.get("messages", [])
    tools = [t.get("function", {}).get("name") for t in body.get("tools", []) or []]
    last = msgs[-1] if msgs else {}
    text = last_user_text(msgs)
    bash = next((t for t in tools if t and t.lower() == "bash"), None)  # OpenCode: bash, ZCode: Bash
    if "PLEASE_RUN_TESTS" in text and last.get("role") == "user" and bash:
        return {"tool": bash, "args": {"command": "npm test", "description": "Run the test suite"}}
    m = re.search(r"PLEASE_SEND_TO:([\w-]+)", text)
    if m and last.get("role") == "user":
        name = next((t for t in tools if t and t.endswith("team_send")), None)
        if name:
            return {"tool": name, "args": {"to": m.group(1), "message": "hello from qwen: API contract is /users/{id}"}}
    if last.get("role") == "tool":
        return {"text": "QWEN-REPLY: tool said: " + str(last.get("content"))[:120]}
    return {"text": "QWEN-REPLY: " + text.strip().replace("\n", " ")[:80]}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": "qwen-test", "object": "model"}]})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        LOG.write(json.dumps({"t": time.time(), "path": self.path, "tools": [t.get("function", {}).get("name") for t in body.get("tools", []) or []], "last": body.get("messages", [])[-1:]}) + "\n")
        LOG.flush()
        d = decide(body)
        cid = "chatcmpl-%d" % int(time.time() * 1000)
        if not body.get("stream"):
            msg = {"role": "assistant", "content": d.get("text")}
            if "tool" in d:
                msg["tool_calls"] = [{"id": "call_1", "type": "function", "function": {"name": d["tool"], "arguments": json.dumps(d["args"])}}]
            return self._json(200, {"id": cid, "object": "chat.completion", "model": "qwen-test", "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if "tool" in d else "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def ev(obj):
            self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")
            self.wfile.flush()

        base = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": "qwen-test"}
        if "tool" in d:
            ev({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": d["tool"], "arguments": ""}}]}, "finish_reason": None}]})
            ev({**base, "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": json.dumps(d["args"])}}]}, "finish_reason": None}]})
            ev({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
        else:
            ev({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]})
            for i in range(0, len(d["text"]), 20):
                ev({**base, "choices": [{"index": 0, "delta": {"content": d["text"][i:i + 20]}, "finish_reason": None}]})
            ev({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        ev({**base, "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
