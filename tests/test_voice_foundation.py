"""Offline checks of the preserved voice response path; never import the live script."""
import ast
import contextlib
import io
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unicodedata
import unittest
from unittest.mock import Mock

SOURCE = Path(__file__).resolve().parents[1] / 'backend/ai_oral_examiner_foundation_v1.py'
TREE = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
HELPERS = [node for node in TREE.body if isinstance(node, ast.FunctionDef)
           and node.name in {'clean_for_speech', 'looks_like_internal_reasoning'}]
RESPONSE_PATH = next(node for node in TREE.body if isinstance(node, ast.If)
                     and isinstance(node.test, ast.Name) and node.test.id == 'transcription')


class VoiceFoundationTests(unittest.TestCase):
    def run_response(self, content, transcription='Synthetic question'):
        voice = Mock()
        audio = Mock()
        client = Mock()
        client.chat.return_value = {'message': {'content': content}}
        file_context = contextlib.nullcontext(object())
        namespace = dict(re=re, json=json, unicodedata=unicodedata,
                         transcription=transcription, ollama=client,
                         ollama_model='oral-examiner-v2:latest', response_schema={},
                         voice=voice, sd=audio, output_audio_file='unused.wav',
                         wave=SimpleNamespace(open=Mock(return_value=file_context)),
                         read=Mock(return_value=(22050, b'synthetic')))
        exec(compile(ast.Module(body=HELPERS, type_ignores=[]), str(SOURCE), 'exec'), namespace)
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(ast.Module(body=[RESPONSE_PATH], type_ignores=[]), str(SOURCE), 'exec'), namespace)
        return namespace

    def assert_blocked(self, content):
        namespace = self.run_response(content)
        namespace['voice'].synthesize_wav.assert_not_called()
        namespace['sd'].play.assert_not_called()
        namespace['wave'].open.assert_not_called()

    def test_only_spoken_field_reaches_voice(self):
        namespace = self.run_response(json.dumps({'spoken_response': 'Hello.', 'analysis': 'PRIVATE'}))
        self.assertEqual(namespace['voice'].synthesize_wav.call_args.args[0], 'Hello.')
        namespace['sd'].play.assert_called_once()
        kwargs = namespace['ollama'].chat.call_args.kwargs
        self.assertFalse(kwargs['think'])
        self.assertEqual(kwargs['options'], {'temperature': 0, 'num_predict': 120})
        self.assertEqual(kwargs['keep_alive'], '30m')

    def test_cleanup_before_synthesis(self):
        namespace = self.run_response(json.dumps({'spoken_response': '<think>hidden</think> **Hello** `student`! 😀\n'}))
        self.assertEqual(namespace['voice'].synthesize_wav.call_args.args[0], 'Hello student!')

    def test_suspicious_phrases_block_speech(self):
        for phrase in ['The user is asking for help.', 'I need to respond carefully.', "Let\'s think."]:
            with self.subTest(phrase=phrase):
                self.assert_blocked(json.dumps({'spoken_response': phrase}))

    def test_malformed_json_blocks_speech(self):
        self.assert_blocked('not JSON')

    def test_missing_spoken_field_blocks_speech(self):
        self.assert_blocked(json.dumps({'analysis': 'not for speech'}))

    def test_wrong_types_block_speech(self):
        for value in [None, 12, [], {}]:
            with self.subTest(value=value):
                self.assert_blocked(json.dumps({'spoken_response': value}))
        self.assert_blocked('[]')

    def test_empty_or_removed_output_blocks_speech(self):
        for value in ['', '   ', '<think>hidden</think>', '```code```']:
            with self.subTest(value=value):
                self.assert_blocked(json.dumps({'spoken_response': value}))

    def test_empty_transcription_does_not_call_model_or_speaker(self):
        namespace = self.run_response('{}', transcription='')
        namespace['ollama'].chat.assert_not_called()
        namespace['voice'].synthesize_wav.assert_not_called()
        namespace['sd'].play.assert_not_called()


if __name__ == '__main__':
    unittest.main()
