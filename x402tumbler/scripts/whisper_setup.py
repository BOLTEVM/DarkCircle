"""
DarkCircle voice: install the local speech-to-text model, once.

    pnpm voice:setup                 # shows what would be downloaded, and from where
    pnpm voice:setup -- --yes        # downloads it

The model comes from Hugging Face (Systran/faster-whisper-<model>, the CTranslate2 conversion of OpenAI's
Whisper) into .darkcircle-voice/models. After that, speech-to-text runs entirely on this machine.
"""

import argparse
import os
import sys

SIZES_MB = {"tiny.en": 75, "base.en": 145, "small.en": 485, "medium.en": 1530}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("DARKCIRCLE_VOICE_MODEL", "base.en"), choices=sorted(SIZES_MB))
    ap.add_argument("--model-dir", default=os.environ.get("DARKCIRCLE_VOICE_MODEL_DIR", os.path.join(here, "..", ".darkcircle-voice", "models")))
    ap.add_argument("--yes", action="store_true", help="actually download")
    # pnpm forwards a literal "--" (`pnpm voice:setup -- --yes`); npm does not. Accept both.
    args = ap.parse_args([a for a in sys.argv[1:] if a != "--"])
    target = os.path.abspath(args.model_dir)
    source = f"https://huggingface.co/Systran/faster-whisper-{args.model}"
    print(f"model   {args.model} (about {SIZES_MB[args.model]} MB)")
    print(f"source  {source}")
    print(f"into    {target}")
    if not args.yes:
        print("\nNothing downloaded. Run again with --yes to download it (pnpm voice:setup -- --yes).")
        return
    try:
        from faster_whisper.utils import download_model
    except Exception as exc:  # noqa: BLE001
        print(f"faster-whisper is not installed for this Python ({sys.executable}): {exc}\nInstall it with: python -m pip install faster-whisper")
        sys.exit(1)
    os.makedirs(target, exist_ok=True)
    path = download_model(args.model, cache_dir=target)
    print(f"\ninstalled: {path}")


if __name__ == "__main__":
    main()
