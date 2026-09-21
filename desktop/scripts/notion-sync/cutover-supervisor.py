#!/usr/bin/env python3
"""Own the old supervisor lock while a structured worker runs; secrets stay in memory."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path('/Users/sign-x/.buzz/RESEARCH')
STATE = ROOT / 'notion-structured-cutover-20260916'
LEGACY = ROOT / 'notion-live-sync-20260915'
DESKTOP = Path(__file__).resolve().parents[2]

def status(**data):
    tmp = STATE / 'supervisor.json.new'
    with open(tmp, 'w') as h:
        json.dump(dict(pid=os.getpid(), at=time.time(), **data), h)
        h.flush()
        os.fsync(h.fileno())
    os.replace(tmp, STATE / 'supervisor.json')

parser = argparse.ArgumentParser()
parser.add_argument('--detach', action='store_true')
args = parser.parse_args()
os.umask(0o077)
STATE.mkdir(parents=True, exist_ok=True)
if args.detach:
    with open(STATE / 'worker.log', 'a') as log:
        env = {k: v for k, v in os.environ.items() if k in {
            'PATH', 'HOME', 'TMPDIR', 'LANG', 'BUZZ_RELAY_URL', 'BUZZ_PRIVATE_KEY', 'BUZZ_AUTH_TAG'}}
        p = subprocess.Popen([sys.executable, str(Path(__file__).resolve())], env=env,
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             start_new_session=True, close_fds=True)
    print(json.dumps({'supervisorPid': p.pid}))
    sys.exit(0)

stopping = False
child = None
def stop(sig, frame):
    global stopping
    stopping = True
    if child and child.poll() is None:
        child.send_signal(signal.SIGTERM)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
with open(LEGACY / 'background/service.lock', 'a+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    while not stopping:
        child = subprocess.Popen([
            'node', '--import', './test-loader.mjs', '--experimental-strip-types',
            'scripts/notion-sync/run-cutover.mjs', '--cli', '../target/debug/buzz',
            '--state', str(STATE), '--legacy', str(LEGACY), '--watch'], cwd=DESKTOP)
        status(phase='running', workerPid=child.pid)
        code = child.wait()
        status(phase='stopped' if stopping else 'retrying', exitCode=code)
        for _ in range(60):
            if stopping: break
            time.sleep(1)
