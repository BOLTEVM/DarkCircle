/**
 * Speech I/O for the voice agent.
 *
 * Recognition: the browser's SpeechRecognition API. Two honesty rules, inherited from DarkCircle:
 *  - On Chrome the audio leaves the machine (Google's speech service); Firefox has no
 *    recognition at all. The UI says so and asks before the mic is ever opened, and the typed
 *    command line is always there as the first-class path.
 *  - Recognition gives us TEXT only. That text goes through the deterministic grammar in
 *    @darkorder/core; nothing about the audio is trusted beyond the transcript.
 *
 * Replies: speechSynthesis, fully local, and only ever reads back text the agent itself produced.
 */

export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  const ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as SpeechRecognitionCtor | undefined;
  return typeof ctor === 'function' ? ctor : null;
}

export function speechRecognitionAvailable(): boolean {
  return speechRecognitionCtor() !== null;
}

export interface ListenHandle {
  stop: () => void;
}

/**
 * Listens for one utterance. `onFinal` gets the final transcript; `onInterim` gets partial text;
 * `onError` gets a human-readable reason. Recognition always ends on its own (onend).
 */
export function listenOnce(handlers: {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
}): ListenHandle | null {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let finalText = '';
  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const alt = result?.[0];
      if (!result || !alt) continue;
      if (result.isFinal) finalText += alt.transcript;
      else interim += alt.transcript;
    }
    if (interim) handlers.onInterim?.(interim);
  };
  rec.onerror = (event) => {
    const code = event.error ?? 'unknown';
    handlers.onError?.(
      code === 'not-allowed' || code === 'service-not-allowed'
        ? 'The browser refused microphone access. Check the permission, or type the command instead.'
        : code === 'no-speech'
          ? 'Nothing was heard. Try again, or type the command.'
          : code === 'network'
            ? 'The browser speech service is unreachable. Type the command instead.'
            : `Speech recognition failed (${code}). Type the command instead.`
    );
  };
  rec.onend = () => {
    if (finalText.trim()) handlers.onFinal(finalText.trim());
    else handlers.onError?.('Nothing was heard. Try again, or type the command.');
    handlers.onEnd?.();
  };
  try {
    rec.start();
  } catch {
    return null;
  }
  return {
    stop: () => {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}

/** Speaks text the agent produced. Resolves when done (or immediately if unavailable). */
export function speak(text: string, opts: { enabled: boolean }): Promise<void> {
  if (!opts.enabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return Promise.resolve();
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.02;
    utter.pitch = 0.9;
    return new Promise((resolve) => {
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      window.speechSynthesis.speak(utter);
    });
  } catch {
    return Promise.resolve();
  }
}

export function stopSpeaking(): void {
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  } catch {
    /* nothing playing */
  }
}
