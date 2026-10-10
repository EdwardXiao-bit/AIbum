import os
from pathlib import Path
import threading
import numpy as np

MODEL_NAME = 'OFA-Sys/chinese-clip-vit-base-patch16'
ROOT = Path(__file__).resolve().parents[1]
TAGS = {
    '人物': ['人物', '合影', '孩子'],
    '物体': ['猫', '狗', '鸟', '花', '树木', '汽车', '自行车', '食物', '蛋糕', '书籍'],
    '场景': ['风景', '海边', '山景', '森林', '草地', '城市', '建筑', '室内', '夜景', '日落', '雪景'],
}


def normalize(vector):
    vector = np.asarray(vector, dtype=np.float32)
    norm = np.linalg.norm(vector, axis=-1, keepdims=True)
    if not np.all(np.isfinite(vector)) or np.any(norm < 1e-8):
        raise ValueError('无法生成有效语义向量')
    return vector / norm


class ModelUnavailable(RuntimeError):
    pass


class ChineseClipEncoder:
    def __init__(self):
        self.path = Path(os.environ.get('AIBUM_MODEL_PATH', ROOT / 'models' / 'chinese-clip'))
        # A prepared model records its Hub revision, so incompatible vectors never mix.
        marker = self.path / 'revision.txt'
        self.model_id = MODEL_NAME + '@' + (marker.read_text().strip() if marker.exists() else 'local')
        self.lock = threading.Lock()
        self.model = None
        self.error = None
        self.label_vectors = None
        self.labels = [(name, kind) for kind, names in TAGS.items() for name in names]

    def _load(self):
        if self.model is not None:
            return
        if not (self.path / 'model.safetensors').exists():
            raise ModelUnavailable('模型未安装，请先运行 python scripts/prepare_model.py，再重启服务并重试分析')
        try:
            import torch
            from transformers import ChineseCLIPModel, ChineseCLIPProcessor
            self.torch = torch
            torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
            self.device = os.environ.get('AIBUM_DEVICE', 'cpu')
            self.processor = ChineseCLIPProcessor.from_pretrained(self.path, local_files_only=True, use_fast=False)
            model = ChineseCLIPModel.from_pretrained(self.path, local_files_only=True, use_safetensors=True)
            self.model = model.to(self.device).eval()
            self.error = None
        except Exception as exc:
            self.error = str(exc)
            raise ModelUnavailable('模型加载失败，请检查模型文件和依赖；详细原因见服务日志') from exc

    def _text(self, texts):
        inputs = self.processor(text=texts, return_tensors='pt', padding=True, truncation=True,
                                max_length=52).to(self.device)
        with self.torch.inference_mode():
            # Transformers 4.57.6 get_text_features uses a disabled pooler.
            # Use the CLS projection used by ChineseCLIPModel.forward itself.
            hidden = self.model.text_model(**inputs).last_hidden_state[:, 0, :]
            return normalize(self.model.text_projection(hidden).cpu().numpy())

    def text(self, text):
        with self.lock:
            self._load()
            return self._text([text])[0]

    def image(self, image):
        with self.lock:
            self._load()
            inputs = self.processor(images=image, return_tensors='pt').to(self.device)
            with self.torch.inference_mode():
                return normalize(self.model.get_image_features(**inputs).cpu().numpy())[0]

    def tags(self, vector):
        with self.lock:
            self._load()
            if self.label_vectors is None:
                self.label_vectors = self._text(['一张' + n + '的照片' for n, _ in self.labels])
            scores = self.label_vectors @ vector
            # Heuristic, not calibrated confidence: avoid forcing three unrelated labels.
            cutoff = max(.25, float(scores.max()) - .025)
            return [dict(name=self.labels[i][0], kind=self.labels[i][1], score=float(scores[i]))
                    for i in np.argsort(-scores, kind='stable')[:3] if scores[i] >= cutoff]

    def status(self):
        return {'ready': self.model is not None, 'installed': (self.path / 'model.safetensors').exists(),
                'model': self.model_id, 'device': getattr(self, 'device', 'cpu')}
