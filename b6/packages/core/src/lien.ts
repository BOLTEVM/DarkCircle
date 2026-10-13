import { ZERO_ADDRESS, sameAddress } from './address.js';
import type { DebtView } from './brokerage.js';
import { formatQuai } from './money.js';

export type LienState = 'clear' | 'credit' | 'lien' | 'foreclosed';

export interface LienDisclosure {
  state: LienState;
  headline: string;
  detail: string;
}

/** Plain-language reading of an EIP-6065 debt record, as shown to buyers before they commit coin. */
export function describeLien(debt: DebtView): LienDisclosure {
  const unit = sameAddress(debt.token, ZERO_ADDRESS) ? 'QUAI' : `units of token ${debt.token}`;
  if (debt.foreclosed) {
    return {
      state: 'foreclosed',
      headline: 'Foreclosed',
      detail: 'The registrar has foreclosed this property. The deed no longer represents it and cannot be sold through the desk.',
    };
  }
  if (debt.amount > 0n) {
    return {
      state: 'lien',
      headline: `Lien of ${formatQuai(debt.amount)} ${unit}`,
      detail:
        'A lien recorded by the registrar stays with the property. Buying or offering accepts this amount and no more: if a larger lien is recorded before closing, the closing fails and your deposit stays withdrawable.',
    };
  }
  if (debt.amount < 0n) {
    return {
      state: 'credit',
      headline: `Credit of ${formatQuai(-debt.amount)} ${unit}`,
      detail: 'A credit recorded by the registrar (for example prepaid taxes or rent held) passes to the next holder.',
    };
  }
  return { state: 'clear', headline: 'Clear title', detail: 'No lien or credit is recorded against this deed.' };
}
