"""Single native role decision through the included version-bound TaskWarden.

Called only by the authenticated main server, never by imported WorldX code.
Explicit API or native route; no model fallback, nested models, or arbitrary executable input.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'vendor/taskwarden'))
from taskwarden.core import Controller
from taskwarden.dispatch import digest, dispatch
from taskwarden.native_dispatch import launcher


def run(branch, filename):
    branch = Path(branch).resolve()
    source = branch / 'inputs' / filename
    if not source.is_file() or source.parent != branch / 'inputs' or source.suffix != '.json':
        raise ValueError('Invalid actor input')
    packet = json.loads(source.read_text(encoding='utf-8'))
    if packet.get('session_id') != branch.name or packet.get('role') not in {'hero', 'npc'}:
        raise ValueError('Actor packet belongs to another branch')
    role = packet['role']
    sp = importlib.util.spec_from_file_location('living_model_selection', ROOT / 'plugin/scripts/model_selection.py')
    selection = importlib.util.module_from_spec(sp); sp.loader.exec_module(selection)
    choice = selection.resolve_selection(ROOT)
    if not choice.get('ready'): raise ValueError('Project model selection is unresolved')
    pair = choice['selection']
    if pair['model'] == 'gpt-6-astra': raise ValueError('Astra is authorized for mechanism design, not automatic character decisions')
    provider = os.environ.get('TALEWISP_WORLD_PROVIDER', 'codex')
    if provider not in {'codex', 'openai'}: raise ValueError('Unsupported world provider')
    purpose = 'Role-separated noncanonical WorldX decision or utterance, under author-granted autonomy'
    spec = dict(provider=provider, model=pair['model'], effort=pair['effort'], purpose=purpose,
                input_kind=role, instruction='NO TOOLS. NO FILE ACCESS. NO NESTED AGENTS OR MODEL CALLS. Use only COMPLETE INPUT. Return a JSON object matching its responseSchema, without a prose wrapper. Do not narrate other actors decisions or invent world facts. Russian output. Never convert hearsay or belief into objective truth.')
    goal = 'Реализовать и использовать модуль «Живой мир» в TaleWisp: отдельная неканоническая ветка, авторское управление, разделение знаний. Автор явно включил ограниченную автономию выбранных участников в интерфейсе. Текущий вызов обслуживает только роль из INPUT; править канон запрещено.'
    requirements = dict(goal=goal, scope=['inputs', 'runs'], criteria=[dict(id='R', text='Only one own-knowledge-bound character response; no canon writes', mandatory=True)], dispatch=dict(context_id=branch.name, roles={role: spec}))
    private = branch.parents[1] / 'model-control' / branch.name
    private.mkdir(parents=True, exist_ok=True)
    controller = Controller(private / 'state.db', branch)
    try:
        if not (private / 'executor.token').exists():
            caps = controller.create(branch.name, requirements, requirements['scope'], 1000)
            for name, value in caps.items(): (private / (name + '.token')).write_text(value, encoding='utf-8')
        owner = (private / 'owner.token').read_text(encoding='utf-8')
        current = controller.status(branch.name, owner, 'owner')
        if digest(current['requirements']) != digest(requirements):
            controller.amend(branch.name, owner, current['version'], requirements)
        version = controller.status(branch.name, owner, 'owner')['version']
        request = dict(id=source.stem, role=role, provider=provider, model=pair['model'], effort=pair['effort'],
                       purpose=purpose, input_file='inputs/' + source.name,
                       input_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), requirements_sha256=digest(requirements))
        receipt = dispatch(controller, branch.name, (private / 'executor.token').read_text(encoding='utf-8'), version, request, launcher(branch / 'runs'))
        (branch / 'runs' / (source.stem + '-receipt.json')).write_text(json.dumps(receipt, ensure_ascii=False), encoding='utf-8')
        raw = receipt['result']['text'].strip()
        if raw.startswith('```'): raw = '\n'.join(raw.splitlines()[1:-1])
        result = json.loads(raw)
        if not isinstance(result, dict): raise ValueError('Character response is not an object')
        return dict(result=result, receipt=str(Path('runs') / (source.stem + '-receipt.json')), model=pair['model'], effort=pair['effort'], metadata=receipt['result']['model_metadata'])
    finally:
        controller.close()


if __name__ == '__main__':
    try:
        result = run(*sys.argv[1:3]); code = 0
    except Exception as error:
        result = {'error': str(error)}; code = 1
    sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False) + '\n').encode('utf-8'))
    raise SystemExit(code)
