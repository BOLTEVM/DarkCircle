"""
DarkCircle voice: local speech-to-text worker (faster-whisper).

Started by src/voice/transcriber.ts and kept alive, so the model loads once. Audio never leaves this machine.
The model is loaded with local_files_only=True: this process never downloads anything. Install the model once
with `pnpm voice:setup`.

Protocol, one JSON object per line:
  stdout  {"type":"ready","model":...}                          model loaded
          {"type":"fatal","code":"MODEL_MISSING"|"IMPORT_FAILED","message":...}   then exit
  stdin   {"id":...,"path":...,"prompt":...,"hotwords":...}     one clip to transcribe
  stdout  {"type":"result","id":...,"text":...,"duration":...,"ms":...}
          {"type":"error","id":...,"message":...}
"""

import argparse
import json
import sys
import time

MAX_SECONDS = 30.0


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="base.en")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001 - reported to the parent verbatim
        emit({"type": "fatal", "code": "IMPORT_FAILED", "message": f"faster-whisper is not importable: {exc}"})
        sys.exit(1)

    try:
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type=args.compute_type,
            download_root=args.model_dir,
            local_files_only=True,
            cpu_threads=args.threads,
        )
    except Exception as exc:  # noqa: BLE001
        emit({"type": "fatal", "code": "MODEL_MISSING", "message": f"model '{args.model}' is not installed in {args.model_dir}: {exc}"})
        sys.exit(2)

    emit({"type": "ready", "model": args.model})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            started = time.time()
            options = dict(
                language="en",
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=False,
                without_timestamps=True,
                initial_prompt=req.get("prompt") or None,
            )
            if req.get("hotwords"):
                options["hotwords"] = req["hotwords"]
            try:
                segments, info = model.transcribe(req["path"], **options)
            except TypeError:
                options.pop("hotwords", None)  # an older faster-whisper without hotwords
                segments, info = model.transcribe(req["path"], **options)
            if info.duration > MAX_SECONDS:
                emit({"type": "error", "id": req.get("id"), "message": f"the clip is {info.duration:.0f} s long; commands are limited to {MAX_SECONDS:.0f} s"})
                continue
            text = " ".join(s.text.strip() for s in segments).strip()
            emit({"type": "result", "id": req.get("id"), "text": text, "duration": info.duration, "ms": int((time.time() - started) * 1000)})
        except Exception as exc:  # noqa: BLE001 - one bad clip must not end the worker
            emit({"type": "error", "id": req.get("id"), "message": str(exc)[:300]})


if __name__ == "__main__":
    main()
