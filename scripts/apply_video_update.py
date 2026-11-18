"""Apply a reviewed source package and optionally commit its exact paths.

Dry-run by default. Never changes an upstream, pushes, runs SQL, or starts services.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(data):
    return data.replace(b'\r\n', b'\n')


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.decode(errors='replace').strip() or 'Git command failed.')
    return result.stdout.decode().strip()


def safe_path(root, name):
    relative = PurePosixPath(name)
    if (relative.is_absolute() or '..' in relative.parts or not relative.parts
            or any(':' in part or '\\' in part for part in relative.parts)
            or any(part.lower() == '.git' for part in relative.parts)):
        raise ValueError('Unsafe package path: ' + name)
    target = root.joinpath(*relative.parts)
    for part in (target, *target.parents):
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise ValueError('Link or junction in source path: ' + name)
    target.resolve().relative_to(root.resolve())
    return target


def validate(repo, package):
    manifest_bytes = (package / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    if Path(git(repo, 'rev-parse', '--show-toplevel')).resolve() != repo.resolve():
        raise ValueError('Use the checkout root as --repo.')
    head = git(repo, 'rev-parse', 'HEAD')
    receipt_path = package / 'applied.json'
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    already_committed = (receipt.get('head') == head
                         and receipt.get('manifest_sha256') == sha(manifest_bytes))
    if head != manifest['head'] and not already_committed:
        raise ValueError('HEAD changed since this package was prepared. Inspect before applying it.')
    if git(repo, 'ls-files', '--unmerged'):
        raise ValueError('Finish the current merge before applying an update.')
    if git(repo, 'diff', '--cached', '--name-only'):
        raise ValueError('The index contains existing staged work. Preserve it before applying this update.')
    changes, paths = [], set()
    for entry in manifest['files']:
        name = entry['path']
        if name in paths:
            raise ValueError('Duplicate package path: ' + name)
        paths.add(name)
        target = safe_path(repo, name)
        source = safe_path(package / 'files', name)
        after = source.read_bytes()
        if sha(after) != entry['after']:
            raise ValueError('Package checksum mismatch: ' + name)
        before = target.read_bytes() if target.exists() else None
        if before is not None and canonical(before) == canonical(after):
            continue
        if already_committed:
            raise ValueError('A committed source file was edited after applying the update: ' + name)
        actual = sha(canonical(before)) if before is not None else None
        if actual not in entry['allowed_before']:
            raise ValueError('Existing source differs from the reviewed versions: ' + name)
        changes.append((entry, target, after, before))
    return manifest, changes, already_committed


def apply(repo, package, manifest, changes, commit=False):
    backup = package / ('backup_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S_%f'))
    # Back up and recheck every target before the first write.
    if changes:
        backup.mkdir()
        for entry, target, _, before in changes:
            actual = target.read_bytes() if target.exists() else None
            if actual != before:
                raise ValueError('Source changed during validation: ' + entry['path'])
            if before is not None:
                saved = safe_path(backup, entry['path'])
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(target, saved)
        for entry, target, after, before in changes:
            actual = target.read_bytes() if target.exists() else None
            if actual != before:
                raise ValueError('Source changed before writing: ' + entry['path'])
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix='.kay-video-', dir=target.parent)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(after)
                os.replace(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        print('Exact original source files backed up to: ' + str(backup))
    _, remaining, _ = validate(repo, package)
    if remaining:
        raise ValueError('Source verification failed. Inspect the exact original backup.')
    if commit:
        names = [entry['path'] for entry in manifest['files']]
        git(repo, 'add', '--', *names)
        staged = set(git(repo, 'diff', '--cached', '--name-only', '-z').split('\0')) - {''}
        if not staged.issubset(names):
            raise ValueError('Unrelated files were staged concurrently. Review the index before committing.')
        if staged:
            git(repo, 'commit', '-m', manifest.get('commit_message',
                'Complete saved examination transcripts and reduce recording resource use'))
        receipt = {'head': git(repo, 'rev-parse', 'HEAD'),
                   'manifest_sha256': sha((package / 'manifest.json').read_bytes())}
        (package / 'applied.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print('Source saved in Git commit: ' + receipt['head'])
    print('Verified source update. No push, upstream change, database migration, or service operation was performed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--commit', action='store_true')
    args = parser.parse_args()
    if args.commit and not args.apply:
        parser.error('--commit requires --apply')
    repo, package = args.repo.resolve(), args.package.resolve()
    manifest, changes, already_committed = validate(repo, package)
    print(f'Validated {len(manifest["files"])} source files; {len(changes)} pending writes.')
    if already_committed:
        print('This reviewed update is already committed in the target checkout.')
        return
    if args.apply:
        apply(repo, package, manifest, changes, args.commit)
    else:
        print('Read-only check. Add --apply --commit to apply and save the reviewed paths in Git.')


if __name__ == '__main__':
    main()
