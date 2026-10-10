"""Download one official model snapshot. Safe to rerun after interruption."""
import os
from pathlib import Path

# Avoid a second large binary transfer through Xet on constrained networks.
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
from huggingface_hub import snapshot_download

root = Path(__file__).resolve().parents[1]
target = Path(os.environ.get('AIBUM_MODEL_PATH', root / 'models' / 'chinese-clip'))
repo = 'OFA-Sys/chinese-clip-vit-base-patch16'
revision = '36e679e65c2a2fead755ae21162091293ad37834'
if (target / 'model.safetensors').exists() and (target / 'revision.txt').exists():
    if (target / 'revision.txt').read_text().strip() == revision:
        print(f'Model already prepared: {target}')
        raise SystemExit(0)
snapshot_download(repo_id=repo, revision=revision, local_dir=target,
                  allow_patterns=['*.json', 'vocab.txt', 'pytorch_model.bin', 'README.md'], max_workers=2)
from transformers import ChineseCLIPModel
model = ChineseCLIPModel.from_pretrained(target, local_files_only=True, use_safetensors=False, weights_only=True)
model.save_pretrained(target, safe_serialization=True)
(target / 'revision.txt').write_text(revision, encoding='utf-8')
print(f'Model ready: {target} (revision {revision})')
