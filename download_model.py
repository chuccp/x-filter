"""
Download pretrained model for x-filter training.

Usage:
    python download_model.py --output <dir> --model bert-base-multilingual-cased

Progress lines (for Electron UI parsing):
    [STATUS] <message>
    [PROGRESS] {"file": "config.json", "downloaded": 1024, "total": 2048, "percent": 50}
"""

import argparse
import json
import os
import sys
import time


def status(msg):
    print(f"[STATUS] {msg}", flush=True)


def progress(file, downloaded, total, percent):
    print(f"[PROGRESS] {json.dumps({'file': file, 'downloaded': downloaded, 'total': total, 'percent': percent})}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Download pretrained model for x-filter")
    parser.add_argument("--output", required=True, help="Directory to save the model")
    parser.add_argument("--model", default="bert-base-multilingual-cased", help="Model name from HuggingFace Hub")
    parser.add_argument("--force", action="store_true", help="Delete existing directory and re-download from scratch")
    args = parser.parse_args()

    from huggingface_hub import snapshot_download
    from tqdm import tqdm as _tqdm

    class _StatusTqdm(_tqdm):
        def __init__(self, *a, **kw):
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
                    name = (self.desc or "model").strip()
                    mb = self.n / 1024 / 1024
                    total_mb = self.total / 1024 / 1024
                    now = time.time()
                    elapsed = now - self._last_time if self._last_time else 1
                    speed_mb = (self.n - self._last_n) / 1024 / 1024 / elapsed if elapsed > 0 else 0
                    self._last_time = now
                    self._last_n = self.n
                    status(f"Downloading {name}: {pct}% ({mb:.1f}/{total_mb:.1f} MB) {speed_mb:.1f} MB/s")
                    progress(name, self.n, self.total, pct)

    output_dir = args.output

    # Force re-download: remove existing directory
    if args.force and os.path.exists(output_dir):
        import shutil
        status(f"Removing existing model directory: {output_dir}")
        shutil.rmtree(output_dir)

    os.makedirs(output_dir, exist_ok=True)

    # Check if model already fully downloaded
    config_path = os.path.join(output_dir, "config.json")
    if os.path.exists(config_path):
        status(f"Model already exists at {output_dir}, skipping download")
        return

    status(f"Downloading model: {args.model}")
    # snapshot_download automatically resumes incomplete downloads
    snapshot_download(args.model, local_dir=output_dir, tqdm_class=_StatusTqdm)
    status(f"Model downloaded to {output_dir}")


if __name__ == "__main__":
    main()
