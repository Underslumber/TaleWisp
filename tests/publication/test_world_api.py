"""Guard the credential boundary and exact provider metadata without paid calls."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vendor/taskwarden'))
from taskwarden.openai_dispatch import OpenAIHandle
from taskwarden.core import WardenError


class ApiTests(unittest.TestCase):
    def binding(self):
        packet = {'purpose': 'decision', 'allowedActions': [{'actionType': 'idle', 'targetId': ''}]}
        return {'spec': {'model': 'gpt-6.1-sol', 'effort': 'medium'}, 'request': {'id': 'call1'}, 'input_sha256': 'input',
                'requirements_sha256': 'requirements', 'prompt': 'AUTHOR TASK\nCOMPLETE INPUT:\n' + json.dumps(packet)}

    def test_no_key_fails_before_network(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.agent') as directory, patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(WardenError, 'not configured'): OpenAIHandle(self.binding(), Path(directory))

    def test_responses_request_has_key_only_in_header_and_checks_actual_model(self):
        key = 'sk-TEST_PRIVATE_CANARY_1234567890'
        payload = {'model': 'gpt-6.1-sol', 'status': 'completed', 'id': 'resp_test', 'usage': {'input_tokens': 20, 'output_tokens': 10},
            'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '{"actionType":"idle","targetId":"","interactionId":null,"reason":"Продолжает ожидание."}'}]}]}
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return json.dumps(payload).encode()
        class Opener:
            def open(self, request, timeout):
                body = request.data.decode(); assert key not in body
                assert request.headers['Authorization'] == 'Bearer ' + key
                data = json.loads(body); assert data['store'] is False and data['tools'] == []
                assert data['text']['format']['strict'] is True
                return Response()
        with tempfile.TemporaryDirectory(dir=ROOT / '.agent') as directory, patch.dict(os.environ, {'OPENAI_API_KEY': key}), patch('urllib.request.build_opener', return_value=Opener()):
            handle = OpenAIHandle(self.binding(), Path(directory)); result = handle.result()
            self.assertEqual(result['model_metadata']['observed_model'], 'gpt-6.1-sol')
            self.assertNotIn(key, (handle.directory / 'launch.json').read_text())
            payload['model'] = 'another-model'
            with self.assertRaisesRegex(WardenError, 'different model'): handle.result()


if __name__ == '__main__': unittest.main()
