import React, { useState } from 'react';
import { parseUnits } from 'ethers';
import { X, Send, AlertCircle, Settings, Loader2 } from 'lucide-react';
import { adminCalls, validateCyprus1Address, VAULT_LIMITS, shortAddress, summarizeCall, decodeVaultCall } from '@darksafe/core';
import { useSafe } from '../../context/SafeContext.js';
import { buildDraft } from '../../lib/drafts.js';
import type { ReviewTarget } from './TransactionReviewModal.js';

interface NewTransactionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReview: (target: ReviewTarget) => void;
}

type Tab = 'call' | 'admin';
type AdminAction = 'addOwner' | 'removeOwner' | 'changeThreshold' | 'setMinExecutionDelay' | 'cancelByConsensus';

const HOUR = 3600;
const DAY = 24 * HOUR;
const inputClass =
  'w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-xs';

export const NewTransactionModal: React.FC<NewTransactionModalProps> = ({ isOpen, onClose, onReview }) => {
  const { safeState, rpcClient, clock, transactions, writeBlockReason } = useSafe();

  const [tab, setTab] = useState<Tab>('call');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [data, setData] = useState('0x');
  const [expiryDays, setExpiryDays] = useState('7');
  const [extraDelayHours, setExtraDelayHours] = useState('0');
  const [manualGas, setManualGas] = useState('');
  const [adminAction, setAdminAction] = useState<AdminAction>('addOwner');
  const [adminAddress, setAdminAddress] = useState('');
  const [adminNumber, setAdminNumber] = useState('');
  const [cancelHash, setCancelHash] = useState('');
  const [isBuilding, setIsBuilding] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  if (!isOpen) return null;

  const openTxs = transactions.filter((t) => !t.executed && !t.cancelled);
  const ownerCount = safeState.owners.length;

  const reset = () => {
    setRecipient('');
    setAmount('');
    setData('0x');
    setManualGas('');
    setAdminAddress('');
    setAdminNumber('');
    setCancelHash('');
    setErrors([]);
  };

  const fail = (...msgs: string[]) => {
    setErrors(msgs);
    return null;
  };

  const adminCalldata = (): string | null => {
    const n = Number(adminNumber);
    switch (adminAction) {
      case 'addOwner': {
        const v = validateCyprus1Address(adminAddress.trim());
        if (!v.isValid || !v.checksumAddress) return fail(`New owner: ${v.error}`);
        if (!Number.isInteger(n)) return fail('Enter the threshold to use after adding the owner.');
        return adminCalls.addOwner(v.checksumAddress, n);
      }
      case 'removeOwner':
        if (!adminAddress) return fail('Choose the owner to remove.');
        if (!Number.isInteger(n)) return fail('Enter the threshold to use after removing the owner.');
        return adminCalls.removeOwner(adminAddress, n);
      case 'changeThreshold':
        if (!Number.isInteger(n)) return fail('Enter the new threshold.');
        return adminCalls.changeThreshold(n);
      case 'setMinExecutionDelay': {
        const seconds = Math.round(Number(adminNumber) * HOUR);
        if (adminNumber.trim() === '' || !Number.isFinite(seconds) || seconds < 0) return fail('Enter the new delay in hours.');
        return adminCalls.setMinExecutionDelay(seconds);
      }
      case 'cancelByConsensus':
        if (!/^0x[0-9a-fA-F]{64}$/.test(cancelHash.trim())) return fail('Choose or paste the transaction hash to cancel.');
        return adminCalls.cancelByConsensus(cancelHash.trim());
    }
  };

  const handleReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors([]);
    const windowSeconds = Math.round(Number(expiryDays) * DAY);
    const requestedDelay = Math.round(Number(extraDelayHours || '0') * HOUR);
    if (!Number.isFinite(windowSeconds) || !Number.isFinite(requestedDelay)) return fail('Expiry and delay must be numbers.');

    let to: string;
    let value = 0n;
    let calldata: string;
    if (tab === 'call') {
      const v = validateCyprus1Address(recipient.trim());
      if (!v.isValid || !v.checksumAddress) return fail(`Destination: ${v.error}`);
      to = v.checksumAddress;
      calldata = data.trim() || '0x';
      if (!/^0x([0-9a-fA-F]{2})*$/.test(calldata)) return fail('Calldata must be 0x followed by whole bytes of hex.');
      try {
        value = parseUnits(amount.trim() || '0', 18);
      } catch {
        return fail('Amount must be a plain decimal number of QUAI (up to 18 decimal places).');
      }
      if (value < 0n) return fail('Amount cannot be negative.');
    } else {
      const built = adminCalldata();
      if (!built) return;
      to = safeState.address;
      calldata = built;
    }

    let gasLimit: bigint | undefined;
    if (tab === 'call' && manualGas.trim()) {
      try {
        gasLimit = BigInt(manualGas.trim());
      } catch {
        return fail('Gas limit must be a whole number.');
      }
    }

    setIsBuilding(true);
    try {
      const result = await buildDraft(rpcClient, clock, {
        vault: safeState.address,
        minExecutionDelay: safeState.minExecutionDelay,
        to,
        value,
        data: calldata,
        windowSeconds,
        requestedDelay,
        gasLimit,
      });
      if (!result.ok) return fail(...result.errors);
      onReview({ mode: 'propose', draft: result.draft });
      reset();
      onClose();
    } catch (err: any) {
      fail(err?.message ?? String(err));
    } finally {
      setIsBuilding(false);
    }
    return null;
  };

  const tabButton = (id: Tab, label: string, Icon: typeof Send) => (
    <button
      type="button"
      onClick={() => {
        setTab(id);
        setErrors([]);
      }}
      className={`flex-1 py-2 rounded-lg text-xs font-bold flex items-center justify-center space-x-1.5 ${
        tab === id ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-600/60' : 'bg-slate-950 text-slate-400 border border-slate-800'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors">
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
            <Send className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">New Multi-Sig Transaction</h3>
            <p className="text-xs text-slate-400">Proposed on chain; other owners approve it there</p>
          </div>
        </div>

        <div className="flex space-x-2 mb-4">
          {tabButton('call', 'Transfer or call', Send)}
          {tabButton('admin', 'Vault settings', Settings)}
        </div>

        {errors.length > 0 && (
          <div className="mb-4 bg-red-950/40 border border-red-800/50 rounded-xl p-3 text-xs text-red-300 space-y-1" data-testid="draft-errors">
            {errors.map((e) => (
              <div key={e} className="flex items-start space-x-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{e}</span>
              </div>
            ))}
          </div>
        )}
        {writeBlockReason && <div className="mb-3 text-[11px] text-slate-400">{writeBlockReason}</div>}

        <form onSubmit={handleReview} className="space-y-4 text-xs">
          {tab === 'call' ? (
            <>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Destination (Cyprus-1)</label>
                <input type="text" placeholder="0x00..." value={recipient} onChange={(e) => setRecipient(e.target.value)} className={`${inputClass} font-mono`} />
                {recipient && !validateCyprus1Address(recipient.trim()).isValid && (
                  <p className="text-red-400 text-[10px] mt-1">{validateCyprus1Address(recipient.trim()).error}</p>
                )}
              </div>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Amount (QUAI)</label>
                <input type="text" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inputClass} font-mono`} />
              </div>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Calldata (hex, optional)</label>
                <input type="text" placeholder="0x" value={data} onChange={(e) => setData(e.target.value)} className={`${inputClass} font-mono`} />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Change</label>
                <select value={adminAction} onChange={(e) => setAdminAction(e.target.value as AdminAction)} className={inputClass} data-testid="admin-action">
                  <option value="addOwner">Add an owner</option>
                  <option value="removeOwner">Remove an owner</option>
                  <option value="changeThreshold">Change the threshold</option>
                  <option value="setMinExecutionDelay">Change the minimum timelock</option>
                  <option value="cancelByConsensus">Cancel a transaction by consensus</option>
                </select>
                <p className="text-amber-300 text-[10px] mt-1">
                  Admin changes run as soon as quorum approves; they skip the timelock so owners can react quickly.
                </p>
              </div>
              {adminAction === 'addOwner' && (
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">New owner</label>
                  <input type="text" placeholder="0x00..." value={adminAddress} onChange={(e) => setAdminAddress(e.target.value)} className={`${inputClass} font-mono`} />
                </div>
              )}
              {adminAction === 'removeOwner' && (
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">Owner to remove</label>
                  <select value={adminAddress} onChange={(e) => setAdminAddress(e.target.value)} className={`${inputClass} font-mono`}>
                    <option value="">Choose...</option>
                    {safeState.owners.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {(adminAction === 'addOwner' || adminAction === 'removeOwner' || adminAction === 'changeThreshold') && (
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Threshold afterwards (now {safeState.threshold} of {ownerCount};{' '}
                    {adminAction === 'addOwner' ? ownerCount + 1 : adminAction === 'removeOwner' ? ownerCount - 1 : ownerCount} owners after)
                  </label>
                  <input type="number" min={1} max={VAULT_LIMITS.MAX_OWNERS} value={adminNumber} onChange={(e) => setAdminNumber(e.target.value)} className={`${inputClass} w-32`} />
                </div>
              )}
              {adminAction === 'setMinExecutionDelay' && (
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">New minimum timelock in hours (now {safeState.minExecutionDelay / HOUR}h)</label>
                  <input type="number" min={0} max={720} step="any" value={adminNumber} onChange={(e) => setAdminNumber(e.target.value)} className={`${inputClass} w-32`} />
                </div>
              )}
              {adminAction === 'cancelByConsensus' && (
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">Transaction to cancel</label>
                  <select value={cancelHash} onChange={(e) => setCancelHash(e.target.value)} className={`${inputClass} font-mono`}>
                    <option value="">Choose an open transaction...</option>
                    {openTxs.map((t) => (
                      <option key={t.hash} value={t.hash}>
                        #{t.nonce} {summarizeCall(decodeVaultCall({ vault: safeState.address, to: t.to, value: t.value, data: t.data }))} ({shortAddress(t.hash)})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          <details className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
            <summary className="cursor-pointer text-slate-300 font-semibold">Advanced: expiry, extra delay, gas</summary>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="block text-slate-400 mb-1">Expires (days after the timelock ends)</label>
                <input type="number" min={0.05} max={30} step="any" value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} className={inputClass} />
              </div>
              {tab === 'call' && (
                <div>
                  <label className="block text-slate-400 mb-1">Extra delay (hours, on top of the vault's {safeState.minExecutionDelay / HOUR}h)</label>
                  <input type="number" min={0} max={720} step="any" value={extraDelayHours} onChange={(e) => setExtraDelayHours(e.target.value)} className={inputClass} />
                </div>
              )}
              {tab === 'call' && (
                <div className="col-span-2">
                  <label className="block text-slate-400 mb-1">Gas for the call (blank = estimate from the vault's own call, plus headroom)</label>
                  <input type="text" inputMode="numeric" placeholder="auto" value={manualGas} onChange={(e) => setManualGas(e.target.value)} className={`${inputClass} font-mono`} />
                </div>
              )}
            </div>
          </details>

          <div className="flex items-center justify-end space-x-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isBuilding || !safeState.address}
              className="px-5 py-2 rounded-xl text-xs font-bold text-slate-950 bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-500 flex items-center space-x-1.5"
            >
              {isBuilding && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>Review</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
