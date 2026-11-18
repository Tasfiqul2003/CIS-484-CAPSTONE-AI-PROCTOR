"""Bash script process/readiness checks with synthetic executables, no GPU or downloads."""
import os
from pathlib import Path
import socket
import subprocess
import pytest
ROOT=Path(__file__).resolve().parents[1]
BASH=Path('C:/Program Files/Git/bin/bash.exe')
pytestmark=pytest.mark.skipif(not BASH.exists(),reason='Installed Git Bash required for Windows script fixtures')


def listener():
    value=socket.socket();value.bind(('127.0.0.1',0));value.listen(16);return value


def script(path,content):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text('#!/usr/bin/env bash\n'+content+'\n',encoding='utf-8',newline='\n')
    path.chmod(0o700)


def test_packaging_occupied_port_leaves_unrelated_listener_alive(tmp_path):
    with listener() as unrelated:
        env={**os.environ,'WORK':tmp_path.as_posix(),'PACK_OLLAMA_PORT':str(unrelated.getsockname()[1])}
        result=subprocess.run([str(BASH),str(ROOT/'avatar/pack_for_box.sh')],env=env,capture_output=True,text=True,timeout=10)
        assert result.returncode!=0 and 'nothing was installed or stopped' in result.stderr
        with socket.create_connection(unrelated.getsockname(),timeout=1):pass
        assert not (tmp_path/'ollama').exists()


def test_render_timeout_fails_without_starting_app_or_stopping_external_ollama(tmp_path):
    script(tmp_path/'mock-bin/nvidia-smi','echo "0, 8000"')
    script(tmp_path/'miniconda/envs/flashhead/bin/python','if [ "$1" = "-c" ]; then exit 1; fi; exec sleep 60')
    script(tmp_path/'miniconda/envs/chatterbox/bin/python','touch "$WORK/APP_WAS_STARTED"; exit 77')
    script(tmp_path/'ollama/bin/ollama','echo "qwen3:4b-instruct synthetic"')
    with listener() as unrelated, listener() as app_reservation, listener() as worker_reservation:
        app_port=app_reservation.getsockname()[1];worker_port=worker_reservation.getsockname()[1]
        app_reservation.close();worker_reservation.close()
        env={**os.environ,'WORK':tmp_path.as_posix(),'APP_PORT':str(app_port),'FH_PORT':str(worker_port),
            'OLLAMA_PORT':str(unrelated.getsockname()[1]),'WORKER_WAIT_ATTEMPTS':'1',
            'PATH':str(tmp_path/'mock-bin')+os.pathsep+os.environ['PATH']}
        result=subprocess.run([str(BASH),str(ROOT/'avatar/start_avatar_box.sh')],env=env,capture_output=True,text=True,timeout=20)
        assert result.returncode!=0 and 'timed out' in result.stderr
        assert not (tmp_path/'APP_WAS_STARTED').exists()
        with socket.create_connection(unrelated.getsockname(),timeout=1):pass
