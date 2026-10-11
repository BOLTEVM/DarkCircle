import { formatDuration } from './format.js';

export type ConfigGrade = 'A' | 'B' | 'C' | 'D';

export interface ConfigAssessment {
  grade: ConfigGrade;
  notes: string[];
}

const DAY = 24 * 60 * 60;

/**
 * Rates a vault configuration before it is created, so weak setups are visible up front.
 *  A: needs at least two owners, has at least one spare key, and a delay of a day or more.
 *  B: the same with a shorter (non-zero) delay.
 *  C: no timelock, or every owner must sign (one lost key locks the vault).
 *  D: a single key can move everything.
 */
export function assessVaultConfig(ownerCount: number, threshold: number, delaySeconds: number): ConfigAssessment {
  const notes: string[] = [];
  let grade: ConfigGrade = 'A';
  const lower = (g: ConfigGrade) => {
    if (g > grade) grade = g;
  };

  if (ownerCount === 1 || threshold === 1) {
    lower('D');
    notes.push(ownerCount === 1 ? 'One owner holds every key: this is not a multisig.' : 'Any single owner can move every asset alone.');
  }
  if (threshold === ownerCount && ownerCount > 1) {
    lower('C');
    notes.push('Every owner must approve; losing any one key locks the vault for good.');
  }
  if (delaySeconds === 0) {
    lower('C');
    notes.push('No timelock: an approved transaction can run immediately, leaving no time to react to a compromised key.');
  } else if (delaySeconds < DAY) {
    lower('B');
    notes.push(`A ${formatDuration(delaySeconds)} timelock gives little time to notice and cancel a bad transaction; a day or more is recommended.`);
  }
  if (grade === 'A') notes.push('Needs more than one key, tolerates a lost key, and leaves at least a day to react.');
  return { grade, notes };
}

export interface VaultPreset {
  id: string;
  label: string;
  description: string;
  /** Owners the preset expects; the user still enters the addresses. */
  owners: number;
  threshold: number;
  delaySeconds: number;
}

export const VAULT_PRESETS: readonly VaultPreset[] = [
  { id: 'personal', label: 'Personal 2-of-3', description: 'Three of your own keys; any two can act after a day.', owners: 3, threshold: 2, delaySeconds: DAY },
  { id: 'team', label: 'Team 3-of-5', description: 'Five people; any three can act after two days.', owners: 5, threshold: 3, delaySeconds: 2 * DAY },
];
