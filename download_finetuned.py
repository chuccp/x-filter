"""
Download fine-tuned x-spam-classifier model from Hugging Face Hub.

Usage:
    python download_finetuned.py --repo chuccp/x-spam-classifier --output <dir>

Progress lines (for Electron UI parsing):
    [STATUS] <message>
    [PROGRESS] {"file": "model.onnx", "downloaded": 1024, "total": 2048, "percent": 50}
"""

import argparse
import io
import json
import os
import sys
import time


def status(msg):
    print(f"[STATUS] {msg}", flush=True)


def progress(file, downloaded, total, percent):
    print(f"[PROGRESS] {json.dumps({'file': file, 'downloaded': downloaded, 'total': total, 'percent': percent})}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Download fine-tuned x-spam-classifier model")
    parser.add_argument("--repo", default="chuccp/x-spam-classifier", help="HF Hub repo ID")
    parser.add_argument("--output", required=True, help="Directory to save the model")
    parser.add_argument("--force", action="store_true", help="Delete existing directory and re-download")
    args = parser.parse_args()

    from huggingface_hub import snapshot_download
    from tqdm import tqdm as _tqdm

    class _StatusTqdm(_tqdm):
        """Custom tqdm that reports download progress via [STATUS]/[PROGRESS]."""
        def __init__(self, *a, **kw):
            kw['file'] = io.StringIO()
            super().__init__(*a, **kw)
            self._last_pct = -1
            self._last_time = time.time()
            self._last_n = 0

        def update(self, n=1):
            super().update(n)
            if self.total and self.n > 0:
                pct = int(self.n / self.total * 100)
                if pct >= self._last_pct + 1 or pct == 100:
                    self._last_pct = pct
                    name = (self.desc or "file").strip()
                    if self.total <= 1000:
                        status(f"{name} {self.n}/{self.total}: {pct}%")
                    else:
                        mb = self.n / 1024 / 1024
                        total_mb = self.total / 1024 / 1024
                        now = time.time()
                        elapsed = now - self._last_time if self._last_time else 1
                        speed_mb = (self.n - self._last_n) / 1024 / 1024 / elapsed if elapsed > 0 else 0
                        self._last_time = now
                        self._last_n = self.n
                        status(f"{name}: {pct}% ({mb:.1f}/{total_mb:.1f} MB) {speed_mb:.1f} MB/s")
                        progress(name, self.n, self.total, pct)

    output_dir = args.output

    if args.force and os.path.exists(output_dir):
        import shutil
        status(f"Removing existing model directory: {output_dir}")
        shutil.rmtree(output_dir)

    os.makedirs(output_dir, exist_ok=True)

    # Check if model already downloaded (has ONNX model + config)
    has_model = os.path.exists(os.path.join(output_dir, "onnx", "model.onnx")) \
        or os.path.exists(os.path.join(output_dir, "model.onnx"))
    has_config = os.path.exists(os.path.join(output_dir, "config.json"))
    if has_model and has_config and not args.force:
        status(f"Model already exists at {output_dir}, skipping download")
        return

    status(f"Downloading model: {args.repo}")
    snapshot_download(
        args.repo,
        local_dir=output_dir,
        tqdm_class=_StatusTqdm,
        resume_download=True,
    )
    status(f"Model downloaded to {output_dir}")


if __name__ == "__main__":
    main()
