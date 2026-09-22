"""Header wording → meaning, with a small local model: all-MiniLM-L6-v2, int8 ONNX (~23 MB) in models/minilm/.

table.py asks here only when its synonym lists draw a blank ("Quay", "Craft", "Alongside from"). The header is
embedded and compared with every synonym of every field; the nearest synonym's cosine says how sure we are.
No model files, or onnxruntime missing → semantic() answers {} and the reader behaves as if this file didn't exist.
One session per process, synonyms embedded once. Values in the column still outrank the header (table.py).
"""
import functools
from pathlib import Path

MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "minilm"
MAX_TOKENS = 32
MIN_COSINE = 0.60        # below this the model is guessing; the column stays unmapped
# Things a dock sheet often has a column for that are NOT one of our fields. A header nearer to one of these than
# to any field synonym is rejected outright ("Skipper" is a person, not a vessel or a date).
DECOYS = ("skipper", "captain", "master", "crew", "person", "contact name", "phone", "email", "fuel", "cargo",
          "weather", "colour", "color", "flag", "nationality", "fee", "price", "paid", "invoice", "insurance",
          "engine", "tonnage", "passengers", "purpose", "reason", "signature")
DECOY = "~"


@functools.lru_cache(maxsize=1)
def _session():
    """(onnxruntime session, tokenizer) or None. Cached, including the failure."""
    try:
        import numpy  # noqa: F401  (comes with onnxruntime)
        import onnxruntime as ort
        from tokenizers import Tokenizer
        model, tok = MODEL_DIR / "model_quantized.onnx", MODEL_DIR / "tokenizer.json"
        if not model.exists() or not tok.exists():
            return None
        so = ort.SessionOptions()
        so.intra_op_num_threads = 1
        so.log_severity_level = 3
        sess = ort.InferenceSession(str(model), so, providers=["CPUExecutionProvider"])
        t = Tokenizer.from_file(str(tok))
        t.enable_truncation(MAX_TOKENS)
        t.enable_padding()
        return sess, t
    except Exception:
        return None


def available() -> bool:
    return _session() is not None


def embed(texts):
    """[str] → float32 array (n, 384), L2-normalised (mean pooling over tokens, as sentence-transformers does)."""
    import numpy as np
    sess, tok = _session()
    enc = tok.encode_batch([t if t else " " for t in texts])
    ids = np.array([e.ids for e in enc], dtype=np.int64)
    mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
    feeds = {"input_ids": ids, "attention_mask": mask}
    if any(i.name == "token_type_ids" for i in sess.get_inputs()):
        feeds["token_type_ids"] = np.zeros_like(ids)
    hidden = sess.run(None, feeds)[0]                       # (n, tokens, 384)
    m = mask[:, :, None].astype(np.float32)
    pooled = (hidden * m).sum(1) / np.maximum(m.sum(1), 1e-9)
    return pooled / np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-9)


@functools.lru_cache(maxsize=1)
def _prototypes(fields_key):
    """Embed every synonym of every field once. fields_key: tuple of (field, tuple(synonyms))."""
    import numpy as np
    labels, texts = [], []
    for field, syns in fields_key + ((DECOY, DECOYS),):
        for s in syns:
            labels.append(field)
            texts.append(s)
    return labels, np.asarray(embed(texts))


@functools.lru_cache(maxsize=4096)
def _semantic(text, fields_key):
    import numpy as np
    labels, protos = _prototypes(fields_key)
    v = embed([text])[0]
    sims = protos @ v
    best = {}
    for label, s in zip(labels, sims):
        if s > best.get(label, 0):
            best[label] = float(s)
    decoy = best.pop(DECOY, 0)
    return {f: round(s, 3) for f, s in best.items() if s >= MIN_COSINE and s > decoy}


def semantic(header: str, fields: dict) -> dict:
    """'Quay' → {"berth": 0.71}: each field's best cosine against its synonyms, only those at or above MIN_COSINE.
    {} when the model isn't available."""
    if not header or not available():
        return {}
    key = tuple((f, tuple(sorted(s))) for f, s in sorted(fields.items()))
    try:
        return _semantic(header.strip().lower(), key)
    except Exception:
        return {}
