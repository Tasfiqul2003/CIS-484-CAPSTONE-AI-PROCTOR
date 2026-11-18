"""Emit source-only manifest for separately copied avatar installations."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
root=Path(__file__).resolve().parents[1]
files=['avatar/avatar_app.py','avatar/render_worker.py','avatar/start_avatar_box.sh','avatar/pack_for_box.sh']
commit=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
manifest={'source_commit':commit,'scope':'source only; excludes profiles, recordings, model weights and private configuration',
    'files':[{'source':name,'install_name':Path(name).name,'sha256':hashlib.sha256((root/name).read_bytes()).hexdigest(),'bytes':(root/name).stat().st_size} for name in files]}
payload=json.dumps(manifest,indent=2)+'\n'
if len(sys.argv)>1:Path(sys.argv[1]).write_text(payload,encoding='utf-8')
else:print(payload,end='')
