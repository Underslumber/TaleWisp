"""Read-only adapter to the owning StoryArt catalogue. No copied taxonomy."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
root = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('storyart_reference_pool_manager', root/'tools/reference_pool_manager.py')
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)
request = json.load(sys.stdin)
configs = [root/p for p in [
    'config/reference_categories.json', 'config/reference_pools.json',
    'tools/reference_pool_manager.py', 'tools/pose_reference_manager.py',
    'tools/external_reference_catalog.py', 'BODY_REFERENCE_LIBRARY/POSE_ATLAS/POSE_GROUPS.json',
    'work/pinterest-sketch-20261029/INTEGRATION_CANDIDATES.json',
    'work/pinterest-sketch-20261029/ready/manifest.json',
    'COSTUME_DB_01_SOURCE_COLLECTION/DOWNLOAD_MANIFEST.csv',
    'OLDMANLUX_SOURCE_COLLECTION/CURATED_ITEMS.json',
    'OLDMANLUX_SOURCE_COLLECTION/POSITIVE_EXAMPLES.json']]
before = [p.read_bytes() for p in configs]
pools = manager.cfg()
categories = manager.category_cfg()['categories']
records = []
for pool in pools:
    _, rows = manager.records(pool)
    for row in rows:
        records.append(manager.public_record(pool, row))
if before != [p.read_bytes() for p in configs]:
    raise ValueError('StoryArt catalogue changed during read; retry required')
revision = hashlib.sha256(b''.join(before)+json.dumps(records, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
if request.get('operation') == 'select':
    if request.get('revision') != revision:
        raise ValueError('StoryArt catalogue changed; selection must be reviewed again')
    selected = []
    for item in request['items']:
        result = manager.select(item['pool'], item['id'], item['role'], request.get('subject', ''))
        record = next(r for r in records if r['pool'] == item['pool'] and r['id'] == item['id'])
        if record['sha256'] != item['sha256']:
            raise ValueError('Reference hash changed')
        selected.append({'record': record, 'candidate': result})
    if before != [p.read_bytes() for p in configs]:
        raise ValueError('StoryArt catalogue changed during selection')
    output = {'revision': revision, 'selected': selected}
else:
    output = {'revision': revision, 'categories': categories, 'pools': pools, 'records': records}
json.dump(output, sys.stdout, ensure_ascii=False)
