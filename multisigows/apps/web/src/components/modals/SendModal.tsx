import React, { useState } from 'react';
import { parseUnits } from 'ethers';
import { X, Send, AlertCircle, CheckCircle2 } from 'lucide-react';
import { validateCyprus1Address, erc20TransferCall } from '@darksafe/core';
import { useSafe } from '../../context/SafeContext.js';
import { useMarketData } from '../../context/MarketDataContext.js';
import { buildDraft } from '../../lib/drafts.js';
import type { ReviewTarget } from './TransactionReviewModal.js';

const DAY = 24 * 60 * 60;

interface SendModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialAsset?: string;
  onReview: (target: ReviewTarget) => void;
}

export const SendModal: React.FC<SendModalProps> = ({ isOpen, onClose, initialAsset = 'QUAI', onReview }) => {
  const { safeState, rpcClient, clock } = useSafe();
  const { marketState } = useMarketData();

  const [selectedAsset, setSelectedAsset] = useState<string>(initialAsset);
  const [recipient, setRecipient] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const currentAsset = marketState.holdings.find(
    (h) => h.symbol.toLowerCase() === selectedAsset.toLowerCase() || h.symbol.includes(selectedAsset)
  ) || marketState.holdings[0];

  const recipientVal = recipient ? validateCyprus1Address(recipient) : null;
  const isRecipientValid = recipientVal?.isValid ?? false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!isRecipientValid) {
      setError(recipientVal?.error || 'Recipient address must start with 0x00.');
      return;
    }

    const isNative = selectedAsset === 'QUAI';
    const asset = isNative
      ? undefined
      : marketState.holdings.find((h) => h.symbol === selectedAsset && typeof h.address === 'string');
    if (!isNative && !asset) {
      setError(`No token contract is configured for ${selectedAsset}. Nothing was proposed.`);
      return;
    }
    const decimals = isNative ? 18 : asset!.decimals;

    let rawAmount: bigint;
    try {
      rawAmount = parseUnits(amount.trim(), decimals);
    } catch {
      setError(`Amount must be a plain decimal number with at most ${decimals} decimal places.`);
      return;
    }
    if (rawAmount <= 0n) {
      setError('Please enter an amount greater than 0.');
      return;
    }

    const checksumRecipient = recipientVal!.checksumAddress!;
    setIsSubmitting(true);
    try {
      const result = await buildDraft(rpcClient, clock, {
        vault: safeState.address,
        minExecutionDelay: safeState.minExecutionDelay,
        to: isNative ? checksumRecipient : asset!.address!,
        value: isNative ? rawAmount : 0n,
        data: isNative ? '0x' : erc20TransferCall(checksumRecipient, rawAmount),
        windowSeconds: 7 * DAY,
        requestedDelay: 0,
      });
      if (!result.ok) {
        setError(result.errors.join(' '));
        return;
      }
      onReview({ mode: 'propose', draft: result.draft });
      setRecipient('');
      setAmount('');
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Could not prepare the proposal.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
            <Send className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Send Assets</h3>
            <p className="text-xs text-slate-400">Initiate a multi-sig withdrawal proposal</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-red-950/40 border border-red-800/50 rounded-xl p-3 text-xs text-red-300 flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Asset Selection */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">Select Asset</label>
            <div className="grid grid-cols-3 gap-2">
              {['QUAI', 'Qi (WQI)', 'USDT'].map((assetSymbol) => (
                <button
                  type="button"
                  key={assetSymbol}
                  onClick={() => setSelectedAsset(assetSymbol)}
                  className={`p-2.5 rounded-xl border font-semibold text-center transition-all ${
                    selectedAsset === assetSymbol
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-bold">{assetSymbol}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Recipient */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              Recipient Address (Cyprus-1 Shard)
            </label>
            <div className="relative">
              <input
                type="text"
                placeholder="0x00..."
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-xs"
                required
              />
              {recipient && (
                <div className="absolute right-3 top-2.5">
                  {isRecipientValid ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-400" />
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Amount */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-slate-300 font-semibold">Amount</label>
              <span className="text-[10px] text-slate-400 font-mono">
                Balance: {currentAsset?.formattedBalance || '0.00'} {currentAsset?.symbol}
              </span>
            </div>
            <div className="relative">
              <input
                type="number"
                step="any"
                min="0"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-xs"
                required
              />
              <button
                type="button"
                onClick={() => setAmount(currentAsset?.formattedBalance || '0')}
                className="absolute right-2.5 top-2 px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] font-bold"
              >
                MAX
              </button>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-end space-x-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !isRecipientValid}
              className={`px-5 py-2 rounded-xl text-xs font-bold text-slate-950 transition-all ${
                isSubmitting || !isRecipientValid
                  ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                  : 'bg-emerald-500 hover:bg-emerald-400 shadow-lg shadow-emerald-500/20'
              }`}
            >
              {isSubmitting ? 'Preparing...' : 'Review'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
