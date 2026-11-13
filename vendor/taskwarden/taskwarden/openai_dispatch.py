"""Explicit OpenAI Responses route after TaskWarden's unchanged preflight checks.

Added by TaleWisp for an author-selected API option. No fallback or retries.
Credentials are process environment only and never part of the model packet.
"""
import json
import os
from pathlib import Path
import re
import urllib.request
import urllib.error
from .core import WardenError


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise WardenError('OpenAI API redirect refused')


class OpenAIHandle:
    def __init__(self, binding, run_root):
        self.binding = binding
        self.directory = Path(run_root) / binding['request']['id']
        self.directory.mkdir(parents=True, exist_ok=False)
        self.pid = os.getpid()
        self.last = self.directory / 'last-message.txt'
        self.model = binding['spec']['model']
        if self.model != 'gpt-6.1-sol' or binding['spec']['effort'] not in {'medium', 'high'}:
            raise WardenError('API role model/effort is not authorized')
        if not os.environ.get('OPENAI_API_KEY'):
            raise WardenError('OpenAI API key is not configured')
        self.max_output = int(os.environ.get('TALEWISP_API_MAX_OUTPUT', '2048'))
        if not 512 <= self.max_output <= 8192:
            raise WardenError('Invalid API output token bound')
        packet = json.loads(binding['prompt'].split('COMPLETE INPUT:\n', 1)[1])
        if packet['purpose'] == 'decision':
            options = packet['allowedActions']
            schema = {'type': 'object', 'additionalProperties': False,
                'properties': {'actionType': {'type': 'string', 'enum': sorted({o['actionType'] for o in options})},
                    'targetId': {'type': 'string', 'enum': sorted({o['targetId'] for o in options})},
                    'interactionId': {'type': ['string', 'null']}, 'reason': {'type': 'string'}},
                'required': ['actionType', 'targetId', 'interactionId', 'reason']}
        elif packet['purpose'] == 'dialogue':
            schema = {'type': 'object', 'additionalProperties': False, 'properties': {'content': {'type': 'string'}, 'shouldContinue': {'type': 'boolean'}}, 'required': ['content', 'shouldContinue']}
        else:
            raise WardenError('Unsupported API role task')
        self.body = {'model': self.model, 'input': binding['prompt'], 'reasoning': {'effort': binding['spec']['effort']},
                     'max_output_tokens': self.max_output, 'store': False, 'tools': [],
                     'text': {'format': {'type': 'json_schema', 'name': 'world_role_output', 'strict': True, 'schema': schema}}}
        (self.directory / 'launch.json').write_text(json.dumps({'provider': 'openai', 'endpoint': 'https://api.openai.com/v1/responses', 'model': self.model,
            'effort': binding['spec']['effort'], 'input_sha256': binding['input_sha256'], 'requirements_sha256': binding['requirements_sha256'],
            'max_output_tokens': self.max_output, 'credentials_in_packet': False}), encoding='utf-8')

    def result(self):
        key = os.environ['OPENAI_API_KEY']
        headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
        if os.environ.get('OPENAI_PROJECT_ID'): headers['OpenAI-Project'] = os.environ['OPENAI_PROJECT_ID']
        request = urllib.request.Request('https://api.openai.com/v1/responses', data=json.dumps(self.body, ensure_ascii=False).encode('utf-8'), headers=headers, method='POST')
        try:
            with urllib.request.build_opener(_NoRedirect()).open(request, timeout=90) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000: raise WardenError('API output exceeded limit')
            data = json.loads(raw)
        except urllib.error.HTTPError as exc:
            try: message = json.loads(exc.read(10000)).get('error', {}).get('message', 'API request failed')
            except Exception: message = 'API request failed'
            message = re.sub(r'sk-[A-Za-z0-9_-]+', '[redacted]', str(message).replace(key, '[redacted]'))
            raise WardenError(f'OpenAI API {exc.code}: {message}') from None
        except (urllib.error.URLError, TimeoutError):
            raise WardenError('OpenAI API network error; no retry or fallback') from None
        observed = data.get('model', '')
        if observed != self.model and not observed.startswith(self.model + '-'):
            raise WardenError('OpenAI API returned a different model')
        if data.get('status') != 'completed': raise WardenError('OpenAI response incomplete; usage may have been charged')
        text = ''.join(c.get('text', '') for item in data.get('output', []) if item.get('type') == 'message' for c in item.get('content', []) if c.get('type') == 'output_text')
        if not text.strip(): raise WardenError('OpenAI API returned empty role output')
        json.loads(text)
        self.last.write_text(text, encoding='utf-8')
        usage = data.get('usage', {})
        return {'text': text, 'last_message': str(self.last), 'launch_record': str(self.directory / 'launch.json'), 'pid': self.pid,
            'model_metadata': {'configured_model': self.model, 'observed_model': observed, 'provider': 'openai', 'response_id': data.get('id'), 'usage': usage}}
