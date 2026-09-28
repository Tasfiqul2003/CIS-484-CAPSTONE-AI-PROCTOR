"""Headless integration checks; no Tk window, microphone, model, or child process."""
import ast
from pathlib import Path
import queue
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'backend/ai_oral_examiner_gui_integrated_v1.py'
TREE = ast.parse(SCRIPT.read_text(encoding='utf-8-sig'))
NODES = [node for node in TREE.body if isinstance(node, ast.ClassDef) or
         (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and
          target.id in {'PROJECT_FOLDER', 'FOUNDATION_FOLDER', 'FOUNDATION_SCRIPT'}
          for target in node.targets))]


def load_gui(path=SCRIPT):
    namespace = dict(__file__=str(path), Path=Path, queue=queue, sys=sys,
                     tk=SimpleNamespace(END='end'), threading=Mock(),
                     subprocess=SimpleNamespace(Popen=Mock(), PIPE=subprocess.PIPE,
                                                STDOUT=subprocess.STDOUT))
    exec(compile(ast.Module(body=NODES, type_ignores=[]), str(SCRIPT), 'exec'), namespace)
    gui = namespace['AIOralExaminerGUI'].__new__(namespace['AIOralExaminerGUI'])
    gui.event_queue = queue.Queue()
    return gui, namespace


class GUIIntegrationTests(unittest.TestCase):
    def test_paths_follow_checkout_location(self):
        relocated = ROOT / 'checkout with spaces' / 'backend' / SCRIPT.name
        _, namespace = load_gui(relocated)
        self.assertEqual(namespace['PROJECT_FOLDER'], relocated.resolve().parents[1])
        self.assertEqual(namespace['FOUNDATION_SCRIPT'],
                         relocated.resolve().parent / 'ai_oral_examiner_foundation_v1.py')

    def test_child_interpreter_cwd_and_actual_foundation_markers(self):
        gui, namespace = load_gui()
        messages = ['Loading speech recognition model...', 'Get ready...', 'Listening...',
                    'Converting speech to text...', 'Sending transcription to AI Oral Examiner...',
                    'Generating AI voice response...', 'Playing AI response...', 'AI finished speaking.']
        source = (ROOT / 'backend/ai_oral_examiner_foundation_v1.py').read_text()
        for message in messages:
            self.assertIn(message, source)
        process = Mock(stdout=iter(messages))
        namespace['subprocess'].Popen.return_value = process
        gui.run_foundation()
        args, kwargs = namespace['subprocess'].Popen.call_args
        self.assertEqual(args[0], [sys.executable, '-u', str(namespace['FOUNDATION_SCRIPT'])])
        self.assertEqual(kwargs['cwd'], str(ROOT))
        self.assertEqual(kwargs['stderr'], subprocess.STDOUT)
        events = list(gui.event_queue.queue)
        self.assertEqual([data for kind, data in events if kind == 'state'],
                         ['Loading', 'Get Ready', 'Listening', 'Thinking', 'Thinking', 'Thinking', 'Speaking', 'Idle'])
        self.assertEqual([data for kind, data in events if kind == 'log'], messages)
        self.assertEqual(events[-1], ('finished', None))
        process.wait.assert_called_once()

    def test_launch_error_is_queued(self):
        gui, namespace = load_gui()
        namespace['subprocess'].Popen.side_effect = OSError('Synthetic launch failure')
        gui.run_foundation()
        self.assertEqual(gui.event_queue.get_nowait(), ('error', 'Synthetic launch failure'))

    def test_completion_and_error_restore_start_button(self):
        for kind, data in [('finished', None), ('error', 'Synthetic failure')]:
            with self.subTest(kind=kind):
                gui, _ = load_gui()
                gui.root = Mock()
                gui.start_button = Mock()
                gui.set_state = Mock()
                gui.add_log = Mock()
                gui.ai_running = True
                gui.event_queue.put((kind, data))
                gui.check_events()
                self.assertFalse(gui.ai_running)
                gui.set_state.assert_called_once_with('Idle')
                gui.start_button.config.assert_called_once_with(state='normal')
                gui.root.after.assert_called_once_with(100, gui.check_events)

    def test_mouth_animation_stops_on_idle(self):
        gui, _ = load_gui()
        gui.root = Mock()
        gui.root.after.return_value = 'animation-1'
        gui.canvas = Mock()
        gui.status_label = Mock()
        gui.mouth = 'mouth'
        gui.mouth_open = False
        gui.animation_job = None
        gui.set_state('Speaking')
        self.assertTrue(gui.mouth_open)
        gui.root.after.assert_called_once_with(180, gui.animate_mouth)
        gui.set_state('Idle')
        gui.root.after_cancel.assert_called_once_with('animation-1')
        self.assertIsNone(gui.animation_job)
        self.assertFalse(gui.mouth_open)
        gui.canvas.coords.assert_called_with('mouth', 165, 230, 235, 238)

    def test_repeated_start_does_not_spawn_second_worker(self):
        gui, namespace = load_gui()
        gui.ai_running = False
        gui.start_button = Mock()
        gui.add_log = Mock()
        gui.start_ai()
        gui.start_ai()
        namespace['threading'].Thread.assert_called_once_with(target=gui.run_foundation, daemon=True)
        namespace['threading'].Thread.return_value.start.assert_called_once()


if __name__ == '__main__':
    unittest.main()
