"""Real-model integration check using two publicly documented sample photos.

Run --download once with network access. Generated accounts/data are temporary.
This is a smoke test, not a retrieval-quality benchmark.
"""
import argparse
from pathlib import Path
import sys
import tempfile
import time
import json

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fastapi.testclient import TestClient
from app.encoder import ChineseClipEncoder
from app.main import create_app

parser = argparse.ArgumentParser()
parser.add_argument('--download', action='store_true')
args = parser.parse_args()
samples = ROOT / 'tmp' / 'samples'
samples.mkdir(parents=True, exist_ok=True)
sources = {
    'cat': 'https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/coco_sample.png',
    'dog': 'https://raw.githubusercontent.com/pytorch/hub/master/images/dog.jpg',
}
if args.download:
    import requests
    for name, url in sources.items():
        response = requests.get(url, timeout=90)
        response.raise_for_status()
        (samples / (name + '.image')).write_bytes(response.content)
for name in sources:
    if not (samples / (name + '.image')).exists():
        parser.error('Missing samples. Run --download first.')

encoder = ChineseClipEncoder()
report = {'model': encoder.model_id, 'sources': sources, 'queries': [], 'scope': 'two-photo smoke test only'}
with tempfile.TemporaryDirectory(prefix='aibum-smoke-') as directory:
    app = create_app(directory, encoder, start_worker=False)
    with TestClient(app, headers={'X-AIbum-Request': '1'}) as client:
        assert client.post('/api/auth/register', json={'username': 'smoke', 'password': 'smoke-password'}).status_code == 201
        ids = {}
        started = time.perf_counter()
        for i, name in enumerate(sources):
            response = client.post('/api/photos', files={'file': (f'{i}.jpg', (samples / (name + '.image')).read_bytes())})
            assert response.status_code == 201, response.text
            ids[name] = response.json()['photo']['id']
        while app.state.worker.step():
            pass
        report['cold_analysis_seconds'] = round(time.perf_counter() - started, 3)
        report['tags'] = {}
        for name, photo_id in ids.items():
            detail = client.get('/api/photos/' + photo_id).json()
            assert detail['status'] == 'ready', detail
            report['tags'][name] = detail['tags']
        for name, text in [('cat', '两只猫'), ('dog', '一只狗')]:
            response = client.post('/api/search', data={'text': text})
            assert response.status_code == 200, response.text
            data = response.json()
            assert data['items'][0]['id'] == ids[name], data
            report['queries'].append({'text': text, 'top1': name, 'scores': [p['score'] for p in data['items']], 'elapsed_ms': data['elapsed_ms']})
            result = client.post('/api/search', files={'image': ('query.jpg', (samples / (name + '.image')).read_bytes())})
            assert result.status_code == 200, result.text
            assert result.json()['items'][0]['id'] == ids[name]
            assert result.json()['items'][0]['score'] > .99
        # Count only exact ranking over 500 vectors, excluding model inference.
        from app.photos import rank
        with app.state.database.connect() as db:
            owner = db.execute('SELECT id FROM users').fetchone()[0]
            row = db.execute('SELECT * FROM photos LIMIT 1').fetchone()
            for i in range(498):
                db.execute('''INSERT INTO photos
                    (id,owner_id,name,sha256,mime,size,width,height,created_at,status,embedding,model_id)
                    VALUES (?,?,?,?,?,?,?,?,?,'ready',?,?)''',
                    (f'synthetic-{i}', owner, 'synthetic', str(i), 'image/jpeg', 1, 1, 1, row['created_at'], row['embedding'], encoder.model_id))
        vector = encoder.text('一只狗')
        durations = []
        for _ in range(20):
            start = time.perf_counter()
            rank(app.state.database, encoder, owner, vector)
            durations.append((time.perf_counter() - start) * 1000)
        import numpy as np
        report['synthetic_500_rank_ms'] = {'p50': round(float(np.median(durations)), 2), 'p95': round(float(np.percentile(durations,95)), 2)}
        report['device'] = encoder.status()['device']
(ROOT / 'docs' / '模型冒烟测试.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=True, indent=2))
