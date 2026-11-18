"""Package the committed recording changes for the protected Windows checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


BASE = 'ec980e85a8c527d7d4904dc34a11e9dca12ce548'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(data):
    return data.replace(b'\r\n', b'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--prior-package', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--base-commit', default=BASE, help='Exact reviewed target HEAD; defaults to the original speech-update baseline.')
    parser.add_argument('--commit-message', help='Commit message for the guarded installer.')
    args = parser.parse_args()
    repo = args.repo.resolve()
    git = lambda *options: subprocess.check_output(['git', '-C', str(repo), *options])
    target_head = subprocess.check_output(['git', '--git-dir', str(args.target / '.git'), 'rev-parse', 'HEAD']).decode().strip()
    baseline = args.base_commit
    if target_head != baseline:
        raise ValueError('The target HEAD changed; inspect it before preparing an update.')
    if git('status', '--porcelain').strip():
        raise ValueError('Commit the reviewed source before packaging it.')
    names = git('diff', '--name-only', '-z', baseline, 'HEAD').decode().strip('\0').split('\0')
    if any(name.startswith(('frontend/dist/', 'models/', '.git/')) or name == '.env' for name in names):
        raise ValueError('Generated, private or model files were included in the source delta.')
    manifest = {'head': baseline, 'source_commit': git('rev-parse', 'HEAD').decode().strip(), 'files': []}
    if args.commit_message:
        manifest['commit_message'] = args.commit_message
    for name in names:
        source = repo / name
        if not source.is_file():
            raise ValueError('This package supports reviewed file writes only: ' + name)
        old = subprocess.run(['git', '-C', str(repo), 'show', baseline + ':' + name], capture_output=True)
        allowed = [sha(canonical(old.stdout))] if old.returncode == 0 else [None]
        prior = args.prior_package / 'files' / name
        if prior.is_file():
            allowed.append(sha(canonical(prior.read_bytes())))
        if name == 'backend/requirements-transcription.txt':
            legacy = b'-r requirements.txt\nfaster-whisper==1.2.1\n# PyAV 19 removes metadata_errors used by faster-whisper 1.2.1.\nav==18.1.0\n'
            allowed.append(sha(legacy))
        after = source.read_bytes()
        target = args.target / name
        current = sha(canonical(target.read_bytes())) if target.is_file() else None
        if current not in allowed and current != sha(canonical(after)):
            raise ValueError('The target source differs from reviewed versions: ' + name)
        destination = args.output / 'files' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        manifest['files'].append({'path': name, 'allowed_before': list(dict.fromkeys(allowed)), 'after': sha(after)})
    installer = repo / 'scripts/apply_video_update.py'
    shutil.copyfile(installer, args.output / 'apply_update.py')
    manifest['installer_sha256'] = sha(installer.read_bytes())
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Packaged {len(names)} reviewed source files from Git commit {manifest["source_commit"]}.')


if __name__ == '__main__':
    main()
