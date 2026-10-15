import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff, Send, Volume2, VolumeX } from 'lucide-react';
import {
  EXAMPLES,
  GuildPlanner,
  Refusal,
  matchGuild,
  parseCommand,
  readGuildRoles,
  type Intent,
  type Plan,
} from '@darkorder/core';
import { getCurrentGuild } from '../lib/currentGuild.js';
import { readStored, writeStored } from '../lib/env.js';
import { listenOnce, speak, speechRecognitionAvailable, stopSpeaking } from '../lib/speech.js';
import { navigate } from '../lib/router.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { useTx } from '../state/TxContext.js';
import { useGuildDirectory } from '../state/directory.js';
import { Badge, Button, Card, Notice, cx } from '../components/primitives.js';

interface LogEntry {
  who: 'you' | 'agent';
  text: string;
}

const MIC_KEY = 'darkorder.voice.mic-opt-in';
const SPEAK_KEY = 'darkorder.voice.speak';

export const VoicePage: React.FC = () => {
  const { rpc, network, deployment } = useNetwork();
  const { address } = useWallet();
  const tx = useTx();
  const directory = useGuildDirectory();

  const [log, setLog] = useState<LogEntry[]>([
    { who: 'agent', text: 'The halls answer to voice. Say "help" for what I understand, or type below. Nothing moves without your wallet.' },
  ]);
  const [input, setInput] = useState('');
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [micOptIn, setMicOptIn] = useState(readStored(MIC_KEY) === '1');
  const [speakReplies, setSpeakReplies] = useState(readStored(SPEAK_KEY) !== '0');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [, setTick] = useState(0);
  const listenRef = useRef<{ stop: () => void } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const planner = useMemo(
    () => (deployment ? new GuildPlanner({ rpc, network, registry: deployment.registry }) : null),
    [rpc, network, deployment]
  );

  const micAvailable = speechRecognitionAvailable();

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, interim]);

  // Tick the plan's countdown.
  useEffect(() => {
    if (!plan) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [plan]);

  const say = useCallback(
    (text: string) => {
      setLog((l) => [...l, { who: 'agent', text }]);
      void speak(text, { enabled: speakReplies });
    },
    [speakReplies]
  );

  const offerPlan = useCallback(
    (p: Plan) => {
      setPlan(p);
      say(`${p.summary} If that is right, say "confirm ${p.code.split('').join(' ')}" within three minutes, or press sign.`);
    },
    [say]
  );

  const signPlan = useCallback(
    async (p: Plan) => {
      const ok = await tx.run(p.summary, [{ label: p.summary, build: () => ({ to: p.tx.to, data: p.tx.data, value: p.tx.value }) }]);
      if (ok) {
        setPlan(null);
        say('Done, and confirmed on chain.');
      }
      return ok;
    },
    [tx, say]
  );

  const handleIntent = useCallback(
    (intent: Intent, said: string) => {
      switch (intent.kind) {
        case 'halls':
          say('Walking you to the halls.');
          navigate({ name: 'home' });
          return;
        case 'found':
          say('The Founding Rite awaits. One transaction, no admin keys.');
          navigate({ name: 'found' });
          return;
        case 'open-guild': {
          const { guild, nearby } = matchGuild(intent.guild, directory.guilds);
          if (guild) {
            say(`Opening the ${guild.name} hall.`);
            navigate({ name: 'guild', guild: guild.name });
          } else {
            say(nearby.length ? `No hall called "${intent.guild}". Did you mean ${nearby.join(' or ')}?` : `No hall called "${intent.guild}". Say "show the halls".`);
          }
          return;
        }
        case 'proposals': {
          const name = intent.guild ?? getCurrentGuild()?.name;
          if (name) {
            say(`The floor of ${name}.`);
            navigate({ name: 'guild', guild: name });
          } else {
            say('Which hall? Say for example "open emberhold" first.');
          }
          return;
        }
        case 'voting-power': {
          const cur = getCurrentGuild();
          if (cur && cur.mode === 'token') {
            say('Your voting power, and how to wake it.');
            navigate({ name: 'mint', guild: cur.name });
          } else if (cur) {
            say(`The ${cur.name} hall is a council; power there is a seat, not a balance.`);
          } else {
            say('Open a hall first, so I know whose power you mean.');
          }
          return;
        }
        case 'new-proposal': {
          const cur = getCurrentGuild();
          if (cur?.mode === 'token') {
            say('Draft it on the voting power page; the hall votes on what you write.');
            navigate({ name: 'mint', guild: cur.name });
          } else if (cur) {
            say('Council motions are raised inside the hall. Opening it.');
            navigate({ name: 'guild', guild: cur.name });
          } else {
            say('Open a hall first, then we draft.');
          }
          return;
        }
        case 'steward': {
          const cur = getCurrentGuild();
          if (!cur) {
            say('Open a hall first; every hall keeps its own steward’s desk.');
            return;
          }
          say(
            `The steward’s desk of ${cur.name}. Crest, charter and roles are set there — typed or uploaded, never spoken, so no address ever travels by voice. Nothing moves without your wallet.`
          );
          navigate({ name: 'guild', guild: cur.name });
          window.setTimeout(() => document.getElementById('steward-desk')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 450);
          return;
        }
        case 'my-roles': {
          if (!deployment) {
            say('Showcase mode: the protocol is not deployed on this network, so there are no on-chain roles to read.');
            return;
          }
          if (!address) {
            say('Connect your wallet first; I read your key’s powers from the chain.');
            return;
          }
          const name = intent.guild ?? getCurrentGuild()?.name;
          if (!name) {
            say('Open a hall first, or name it: "my roles in emberhold".');
            return;
          }
          const { guild, nearby } = matchGuild(name, directory.guilds);
          if (!guild) {
            say(nearby.length ? `No hall called "${name}". Did you mean ${nearby.join(' or ')}?` : `No hall called "${name}". Say "show the halls".`);
            return;
          }
          say(`Reading your key’s powers in ${guild.name}…`);
          readGuildRoles(rpc, guild.guild, address)
            .then((held) => {
              const list = [held.root && 'root power', held.execute && 'execute power', held.setMetadata && 'metadata power'].filter(Boolean) as string[];
              say(
                list.length
                  ? `Your key holds ${list.join(', ')} in ${guild.name}.`
                  : `Your key holds no powers in ${guild.name} — but any change can still go to a proposal from the steward’s desk.`
              );
            })
            .catch(() => say('The chain would not answer; try again in a moment.'));
          return;
        }
        case 'help':
          say(`I understand: ${EXAMPLES.join('; ')}.`);
          return;
        case 'cancel':
          setPlan(null);
          say('Cancelled. Nothing was sent.');
          return;
        case 'confirm': {
          if (!plan) {
            say('There is no plan to confirm.');
            return;
          }
          if (Date.now() > plan.expiresAt) {
            setPlan(null);
            say('That plan expired. Ask again and I will read the chain fresh.');
            return;
          }
          if (intent.code !== plan.code) {
            say(`That is not the code. The plan still stands: say "confirm ${plan.code.split('').join(' ')}", or say "cancel".`);
            return;
          }
          void signPlan(plan);
          return;
        }
        case 'vote':
        case 'approve':
        case 'execute':
        case 'tribute': {
          if (!planner) {
            say('Showcase mode: the protocol is not deployed on this network, so there is nothing to sign.');
            return;
          }
          if (!address) {
            say('Connect your wallet first; I plan, but you sign.');
            return;
          }
          const current = intent.kind === 'tribute' ? null : getCurrentGuild();
          planner
            .build(intent, said, address, current)
            .then(offerPlan)
            .catch((e) => say(e instanceof Refusal ? e.message : `I could not plan that: ${(e as Error).message}`));
          return;
        }
      }
    },
    [directory.guilds, planner, address, plan, say, offerPlan, signPlan, rpc, deployment]
  );

  const handleCommand = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setLog((l) => [...l, { who: 'you', text }]);
      const parsed = parseCommand(text);
      if (!parsed.ok) {
        say(parsed.message);
        return;
      }
      handleIntent(parsed.intent, text);
    },
    [handleIntent, say]
  );

  const toggleMic = () => {
    if (listening) {
      listenRef.current?.stop();
      return;
    }
    stopSpeaking();
    setListening(true);
    setInterim('');
    listenRef.current = listenOnce({
      onInterim: setInterim,
      onFinal: (text) => handleCommand(text),
      onError: (message) => {
        setInterim('');
        if (message) say(message);
      },
      onEnd: () => {
        setListening(false);
        listenRef.current = null;
      },
    });
    if (!listenRef.current) {
      setListening(false);
      say('The microphone would not open. Type the command instead.');
    }
  };

  const secondsLeft = plan ? Math.max(0, Math.floor((plan.expiresAt - Date.now()) / 1000)) : 0;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 lg:px-8">
      <h1 className="font-display text-3xl text-bone">The Voice of the Order</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-bone-dim">
        Speak an intent; the agent plans the exact transaction — simulated against {network.label} first — and you confirm by a spoken three-digit code or by
        pressing sign. It is a grammar, not a language model: it cannot be talked into anything off its list, voice never carries an address, and tribute always
        names its asset.
      </p>

      {!micAvailable && (
        <Notice tone="info" className="mt-4" title="No speech recognition in this browser">
          Chrome and Edge can listen; Firefox cannot. The typed command line below understands everything the microphone would.
        </Notice>
      )}
      {micAvailable && !micOptIn && (
        <Notice tone="warn" className="mt-4" title="Before the microphone opens">
          Chrome sends speech audio to its cloud speech service to transcribe it — the transcript is all the agent ever sees, but the audio leaves this machine.
          Replies are spoken locally by your browser. If that trade is not for you, everything here works typed.
          <div className="mt-3">
            <Button
              size="sm"
              onClick={() => {
                writeStored(MIC_KEY, '1');
                setMicOptIn(true);
              }}
            >
              I understand — enable the microphone
            </Button>
          </div>
        </Notice>
      )}

      {/* Transcript */}
      <Card className="mt-6" padded={false}>
        <div ref={logRef} className="max-h-[46vh] space-y-3 overflow-y-auto p-5" aria-live="polite">
          {log.map((e, i) => (
            <div key={i} className={cx('flex', e.who === 'you' ? 'justify-end' : 'justify-start')}>
              <div
                className={cx(
                  'max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed',
                  e.who === 'you' ? 'bg-gold/15 text-gold-pale' : 'border border-line bg-ink-deep text-bone-dim'
                )}
              >
                {e.text}
              </div>
            </div>
          ))}
          {interim && (
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-xl bg-gold/10 px-4 py-2.5 text-sm italic text-gold-pale/70">{interim}…</div>
            </div>
          )}
        </div>

        {/* Input row */}
        <form
          className="flex items-center gap-2 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            handleCommand(input);
            setInput('');
          }}
        >
          {micAvailable && micOptIn && (
            <button
              type="button"
              onClick={toggleMic}
              aria-label={listening ? 'Stop listening' : 'Start listening'}
              className={cx(
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border transition-colors',
                listening ? 'animate-ember-pulse border-gold/60 bg-gold/20 text-gold' : 'border-line bg-panel-raised text-bone-dim hover:text-bone'
              )}
            >
              {listening ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
            </button>
          )}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Type it like you would say it: "vote yes on proposal 3"'
            className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-ink-deep px-3 text-sm text-bone placeholder:text-bone-mute/70 focus:border-gold/70 focus:outline-none"
          />
          <Button type="submit" variant="secondary" className="h-11 shrink-0" aria-label="Send">
            <Send className="h-4 w-4" aria-hidden />
          </Button>
          <button
            type="button"
            onClick={() => {
              const next = !speakReplies;
              setSpeakReplies(next);
              writeStored(SPEAK_KEY, next ? '1' : '0');
              if (!next) stopSpeaking();
            }}
            aria-label={speakReplies ? 'Mute spoken replies' : 'Unmute spoken replies'}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-raised text-bone-dim transition-colors hover:text-bone"
          >
            {speakReplies ? <Volume2 className="h-4 w-4" aria-hidden /> : <VolumeX className="h-4 w-4" aria-hidden />}
          </button>
        </form>
      </Card>

      {/* The standing plan */}
      {plan && (
        <Card className="mt-4 border-gold/40 bg-gold/[0.05]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.16em] text-gold">The plan · {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')} left</div>
              <div className="mt-1.5 text-sm font-medium text-bone">{plan.summary}</div>
              <dl className="mt-2 space-y-1">
                {plan.details.map((d) => (
                  <div key={d.label} className="flex gap-2 text-xs">
                    <dt className="w-28 shrink-0 text-bone-mute">{d.label}</dt>
                    <dd className="min-w-0 break-all text-bone-dim">{d.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="text-center">
              <div className="text-[10px] uppercase tracking-[0.2em] text-bone-mute">say</div>
              <div className="mt-1 font-mono text-3xl tracking-[0.3em] text-gold-light">{plan.code.split('').join(' ')}</div>
              <Badge tone="gold" className="mt-1">
                confirm {plan.code.split('').join(' ')}
              </Badge>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-3 border-t border-gold/20 pt-4">
            <Button variant="secondary" onClick={() => setPlan(null)}>
              Cancel
            </Button>
            <Button onClick={() => void signPlan(plan)}>Sign now</Button>
          </div>
        </Card>
      )}

      {/* What it understands */}
      <Card className="mt-6">
        <h2 className="font-display text-lg text-bone">Say it like this</h2>
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {EXAMPLES.map((x) => (
            <li key={x}>
              <button type="button" onClick={() => handleCommand(x)} className="w-full rounded-lg border border-line bg-ink-deep px-3 py-2 text-left font-mono text-xs text-bone-dim transition-colors hover:border-gold/40 hover:text-bone">
                “{x}”
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-bone-mute">
          Hard rules: the agent never sends payments to spoken names (that is DarkCircle's job), never wraps or swaps, and never accepts an address by voice.
          Tribute is always in QUAI to a named hall.
        </p>
      </Card>
    </div>
  );
};
