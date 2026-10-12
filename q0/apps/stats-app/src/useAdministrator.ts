import { useEffect, useMemo, useState } from 'react';
import { DEPLOYED, FARM_SELECTORS, batchQuaiCall } from 'quai-service';
import { isAdministrator, parseAdminList } from './adminAccess';

// Optional extra administrators, fixed at build time (a multisig signer, or a second operator). The farm owner needs no entry:
// it is read from the contract.
const LISTED = parseAdminList((import.meta as any).env?.VITE_ADMIN_ADDRESSES);

/**
 * Whether the connected wallet is an administrator. The owner is read from the farm contract once per load (it only
 * changes through a two-step transfer), so the answer follows an ownership change without a redeploy.
 *
 * `checked` is false until the owner read has finished; callers should treat "not checked" as "not an administrator".
 */
export function useAdministrator(wallet: string | null): { isAdmin: boolean; checked: boolean } {
  const [owners, setOwners] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let live = true;
    const farm = DEPLOYED.MASTERCHEF;
    if (!farm) {
      setChecked(true);
      return;
    }
    void batchQuaiCall([{ to: farm, data: FARM_SELECTORS.owner }])
      .then(([word]) => {
        if (!live) return;
        const hex = typeof word === 'string' ? word.replace(/^0x/, '') : '';
        setOwners(/^[0-9a-fA-F]{64}$/.test(hex) ? ['0x' + hex.slice(24)] : []);
      })
      .catch(() => live && setOwners([]))
      .finally(() => live && setChecked(true));
    return () => {
      live = false;
    };
  }, []);

  const isAdmin = useMemo(() => isAdministrator(wallet, owners, LISTED), [wallet, owners]);
  return { isAdmin, checked };
}
