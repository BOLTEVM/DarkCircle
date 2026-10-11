// Stands in for scripts/whisper_worker.py in tests: same line protocol, no model. A clip's "transcript" is the
// clip's own bytes read as UTF-8, so a test can send the words it wants recognised. FAKE_WHISPER controls it:
//   missing   report MODEL_MISSING and exit (the real worker without `pnpm voice:setup`)
//   slow      take 1.5 s per clip
//   crash     exit on the first clip
import fs from "node:fs";
import readline from "node:readline";

const mode = process.env.FAKE_WHISPER ?? "ok";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (mode === "missing") {
  emit({ type: "fatal", code: "MODEL_MISSING", message: "model 'base.en' is not installed" });
  process.exit(2);
}
emit({ type: "ready", model: "base.en" });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const req = JSON.parse(line);
  if (mode === "crash") process.exit(3);
  if (mode === "slow") await new Promise((r) => setTimeout(r, 1500));
  const text = fs.readFileSync(req.path, "utf8");
  emit({ type: "result", id: req.id, text, duration: 2.0, ms: 5, path: req.path, prompt: req.prompt, hotwords: req.hotwords });
});
