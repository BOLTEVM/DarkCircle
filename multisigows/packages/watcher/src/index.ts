export { pollOnce, emptyState } from './poll.js';
export type { Alert, AlertLevel, WatcherState, VaultRecord, TrackedTx, PollDeps } from './poll.js';
export { validateConfig, loadState, saveState, consoleSink, webhookSink, runWatcher } from './runner.js';
export type { WatcherConfig, AlertSink, RunOptions } from './runner.js';
