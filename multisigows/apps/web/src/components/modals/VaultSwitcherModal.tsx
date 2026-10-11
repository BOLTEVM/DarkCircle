import React, { useState } from 'react';
import { X, Shield, Plus, Check, Trash2, AlertCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { UnknownVaultCodeError, shortAddress } from '@safebuddy/core';
import { useSafe } from '../../context/SafeContext.js';

interface VaultSwitcherModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenCreateVault: () => void;
}

export const VaultSwitcherModal: React.FC<VaultSwitcherModalProps> = ({ isOpen, onClose, onOpenCreateVault }) => {
  const { knownVaults, safeState, selectVault, addExistingVault, forgetVault, deployment, deploymentError } = useSafe();
  const [newAddress, setNewAddress] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknownCode, setUnknownCode] = useState<{ address: string; detail: string } | null>(null);

  if (!isOpen) return null;

  const resetAdd = () => {
    setError(null);
    setUnknownCode(null);
  };

  const handleSelect = (address: string) => {
    selectVault(address);
    onClose();
  };

  const handleAdd = async () => {
    if (!newAddress.trim()) return;
    setIsAdding(true);
    setError(null);
    try {
      await addExistingVault(newAddress.trim());
      setNewAddress('');
      resetAdd();
      onClose();
    } catch (err: any) {
      if (err instanceof UnknownVaultCodeError) {
        setUnknownCode({ address: err.address, detail: err.message });
      }
      setError(err?.message || 'Could not add vault.');
    } finally {
      setIsAdding(false);
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
            <Shield className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Vaults</h3>
            <p className="text-xs text-slate-400">Switch, add, or create a Cyprus-1 vault</p>
          </div>
        </div>

        <div className="space-y-1.5 max-h-56 overflow-y-auto mb-4">
          {knownVaults.length === 0 && (
            <p className="text-xs text-slate-500 py-2">No vaults yet. Create one or add an existing address.</p>
          )}
          {knownVaults.map((v) => {
            const isActive = v.address.toLowerCase() === safeState.address.toLowerCase();
            return (
              <div
                key={v.address}
                className={`flex items-center justify-between p-2.5 rounded-xl border text-xs cursor-pointer transition-colors ${
                  isActive
                    ? 'bg-emerald-950/40 border-emerald-500/50 text-white'
                    : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
                onClick={() => handleSelect(v.address)}
              >
                <div className="min-w-0">
                  <div className="font-semibold text-slate-200 flex items-center space-x-1.5">
                    <span>{v.name || 'Unnamed Vault'}</span>
                  </div>
                  <div className="font-mono text-[10px] text-slate-400 break-all">{v.address}</div>
                </div>
                <div className="flex items-center space-x-2 flex-shrink-0">
                  {isActive && <Check className="w-4 h-4 text-emerald-400" />}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      forgetVault(v.address);
                    }}
                    className="p-1 text-slate-500 hover:text-red-400"
                    title="Remove from list"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {error && !unknownCode && (
          <div className="mb-3 bg-red-950/40 border border-red-800/50 rounded-xl p-2.5 text-xs text-red-300 flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {unknownCode && (
          <div
            className="mb-3 bg-red-950/50 border border-red-700/70 rounded-xl p-3 text-xs text-red-200 space-y-2"
            data-testid="unknown-code-warning"
          >
            <div className="flex items-start space-x-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-400" />
              <span>
                <strong>Not a recognised SafeBuddy vault.</strong> {unknownCode.detail} Any contract can report owners and a
                threshold, so SafeBuddy only opens vaults its verified factory created. Do not send funds to{' '}
                <span className="font-mono">{shortAddress(unknownCode.address)}</span> on the strength of this app.
              </span>
            </div>
          </div>
        )}

        {deploymentError && (
          <div className="mb-3 bg-amber-950/40 border border-amber-700/50 rounded-xl p-2.5 text-xs text-amber-200" data-testid="deployment-missing">
            {deploymentError}
          </div>
        )}

        <label className="block text-slate-300 font-semibold text-xs mb-1">Add existing vault address</label>
        <div className="flex items-center space-x-2 mb-4">
          <input
            type="text"
            placeholder="0x00..."
            value={newAddress}
            onChange={(e) => {
              setNewAddress(e.target.value);
              resetAdd();
            }}
            className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-xs"
          />
          <button
            onClick={() => handleAdd()}
            disabled={isAdding || !newAddress.trim() || !deployment}
            className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold disabled:opacity-50 flex items-center space-x-1"
          >
            {isAdding && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>Add</span>
          </button>
        </div>

        <button
          onClick={() => {
            onClose();
            onOpenCreateVault();
          }}
          className="w-full py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-bold flex items-center justify-center space-x-2"
        >
          <Plus className="w-4 h-4" />
          <span>Create new vault</span>
        </button>
      </div>
    </div>
  );
};
