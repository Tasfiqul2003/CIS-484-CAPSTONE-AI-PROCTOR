"""Synthetic Git/source installer tests; no Docker, model, network or private files."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location('apply_video_update', Path(__file__).resolve().parents[1] / 'scripts/apply_video_update.py')
update = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(update)


class VideoUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.package = self.root / 'package'
        (self.package / 'files').mkdir(parents=True)
        self.command('init', '-b', 'kay')
        self.command('config', 'user.name', 'Synthetic Test')
        self.command('config', 'user.email', 'synthetic@example.invalid')
        (self.repo / 'app.txt').write_text('baseline\n')
        (self.repo / 'unrelated.txt').write_text('preserve\n')
        self.command('add', '.')
        self.command('commit', '-m', 'Synthetic baseline')
        self.head = self.command('rev-parse', 'HEAD')
        (self.repo / 'app.txt').write_text('installed speech work\n')
        files = []
        for name, before, after in [('app.txt', b'installed speech work\n', b'polished source\n'),
                                    ('added.txt', None, b'new synthetic source\n')]:
            (self.package / 'files' / name).write_bytes(after)
            files.append({'path': name, 'allowed_before': [update.sha(before) if before is not None else None],
                          'after': update.sha(after)})
        self.manifest = {'head': self.head, 'files': files}
        self.save_manifest()

    def command(self, *args):
        return update.git(self.repo, *args)

    def save_manifest(self):
        (self.package / 'manifest.json').write_text(json.dumps(self.manifest))

    def validate(self):
        return update.validate(self.repo, self.package)

    def test_dry_run_does_not_write_or_stage(self):
        manifest, changes, committed = self.validate()
        self.assertEqual(len(changes), 2)
        self.assertFalse(committed)
        self.assertEqual((self.repo / 'app.txt').read_text(), 'installed speech work\n')
        self.assertEqual(self.command('diff', '--cached', '--name-only'), '')

    def test_apply_commits_only_reviewed_files_and_keeps_unrelated_work(self):
        (self.repo / 'unrelated.txt').write_text('unrelated pending work\n')
        manifest, changes, _ = self.validate()
        with redirect_stdout(io.StringIO()):
            update.apply(self.repo, self.package, manifest, changes, commit=True)
        self.assertEqual(self.command('show', 'HEAD:app.txt'), 'polished source')
        self.assertEqual(self.command('show', 'HEAD:added.txt'), 'new synthetic source')
        self.assertEqual(self.command('show', 'HEAD:unrelated.txt'), 'preserve')
        self.assertEqual((self.repo / 'unrelated.txt').read_text(), 'unrelated pending work\n')
        self.assertEqual(self.command('branch', '--show-current'), 'kay')
        self.assertEqual(self.command('rev-parse', 'HEAD^'), self.head)
        self.assertEqual(len(list(self.package.glob('backup_*/app.txt'))), 1)
        self.assertEqual(self.validate()[1:], ([], True))

    def test_crlf_source_is_accepted_without_rewriting_baseline_bytes_in_backup(self):
        (self.repo / 'app.txt').write_bytes(b'installed speech work\r\n')
        manifest, changes, _ = self.validate()
        with redirect_stdout(io.StringIO()):
            update.apply(self.repo, self.package, manifest, changes)
        saved = next(self.package.glob('backup_*/app.txt'))
        self.assertEqual(saved.read_bytes(), b'installed speech work\r\n')

    def test_unexpected_source_edits_are_preserved(self):
        (self.repo / 'app.txt').write_text('new user work')
        with self.assertRaisesRegex(ValueError, 'differs from the reviewed'):
            self.validate()
        self.assertEqual((self.repo / 'app.txt').read_text(), 'new user work')

    def test_existing_staged_work_prevents_any_write(self):
        self.command('add', 'unrelated.txt', 'app.txt')
        with self.assertRaisesRegex(ValueError, 'existing staged work'):
            self.validate()
        self.assertFalse((self.repo / 'added.txt').exists())

    def test_changed_head_prevents_apply(self):
        self.command('commit', '--allow-empty', '-m', 'Other synthetic change')
        with self.assertRaisesRegex(ValueError, 'HEAD changed'):
            self.validate()

    def test_package_corruption_prevents_any_write(self):
        (self.package / 'files' / 'added.txt').write_text('corrupt')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.validate()

    def test_traversal_and_git_metadata_paths_are_rejected(self):
        for name in ('../outside', '.git/config', '.GIT/config', 'nested/.git/config', '/absolute', 'C:/outside', 'a\\b'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                update.safe_path(self.repo, name)

    def test_concurrent_source_edit_is_preserved(self):
        manifest, changes, _ = self.validate()
        (self.repo / 'app.txt').write_text('concurrent user work')
        with self.assertRaisesRegex(ValueError, 'changed during validation'):
            update.apply(self.repo, self.package, manifest, changes)
        self.assertEqual((self.repo / 'app.txt').read_text(), 'concurrent user work')
        self.assertFalse((self.repo / 'added.txt').exists())


if __name__ == '__main__':
    unittest.main()
