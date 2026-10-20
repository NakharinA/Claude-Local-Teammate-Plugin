"""Drive a headless Claude Code session (stream-json) with the opencode-team mod loaded.

Sends one user prompt, then keeps the session open and records every event so
replies the mod delivers later (prompt.submit) show up as new turns.
Usage: python3 drive.py <project_dir> <settings.json> <seconds_to_wait> <prompt>
Set CLAUDE_BIN to use a Claude Code other than the one on PATH.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time

proj, settings, wait_s, prompt = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
out_path = proj + "/../drive-events.jsonl"
# shutil.which finds claude.cmd on Windows, where Popen(["claude"]) does not.
claude = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or "claude"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

p = subprocess.Popen(
    [
        claude, "-p",
        "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--plugin-dir", os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "--settings", settings,
        "--permission-mode", "bypassPermissions",
        "--model", "sonnet",
    ],
    cwd=proj, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", bufsize=1,
)

events = []
lock = threading.Lock()


def reader():
    with open(out_path, "w", encoding="utf-8") as f:
        for line in p.stdout:
            f.write(line)
            f.flush()
            try:
                ev = json.loads(line)
            except Exception:
                ev = {"type": "raw", "text": line.strip()}
            with lock:
                events.append(ev)


threading.Thread(target=reader, daemon=True).start()
p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": prompt}}) + "\n")
p.stdin.flush()

deadline = time.time() + wait_s
while time.time() < deadline and p.poll() is None:
    time.sleep(1)
try:
    p.stdin.close()
except Exception:
    pass
try:
    p.wait(timeout=60)
except subprocess.TimeoutExpired:
    p.kill()


def short(s, n=300):
    s = s if isinstance(s, str) else json.dumps(s)
    return s.replace("\n", " ⏎ ")[:n]


# Summarize: user turns (incl. injected), assistant tool calls and texts, tool results.
for ev in events:
    t = ev.get("type")
    if t == "assistant":
        for c in ev["message"].get("content", []):
            if c.get("type") == "text" and c["text"].strip():
                print("CLAUDE  :", short(c["text"]))
            elif c.get("type") == "tool_use":
                print("TOOLCALL:", c["name"], short(c["input"], 400))
    elif t == "user":
        content = ev["message"].get("content")
        if isinstance(content, str):
            print("USER    :", short(content, 500))
        else:
            for c in content or []:
                if c.get("type") == "tool_result":
                    body = c.get("content")
                    if isinstance(body, list):
                        body = " ".join(x.get("text", "") for x in body if isinstance(x, dict))
                    print("RESULT  :", short(body, 400))
                elif c.get("type") == "text":
                    print("USER    :", short(c["text"], 600))
    elif t == "result":
        print("RESULT-EVENT:", ev.get("subtype"), "turns=", ev.get("num_turns"))
    elif t == "system" and ev.get("subtype") not in ("init",):
        print("SYSTEM  :", ev.get("subtype"), short(ev, 300))
    elif t == "raw" and ev["text"]:
        print("RAW     :", short(ev["text"]))
