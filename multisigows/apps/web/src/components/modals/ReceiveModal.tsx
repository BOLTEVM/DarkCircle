import React, { useState } from 'react';
import { X, Copy, Check, QrCode as QrIcon, Shield } from 'lucide-react';
import { useSafe } from '../../context/SafeContext.js';
import { QrCode, groupAddress } from '../QrCode.js';

interface ReceiveModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ReceiveModal: React.FC<ReceiveModalProps> = ({ isOpen, onClose }) => {
  const { safeState } = useSafe();
  const [copied, setCopied] = useState(false);

  if (!isOpen || !safeState.address) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(safeState.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-sm w-full p-6 shadow-2xl relative text-center">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold mx-auto mb-3">
          <QrIcon className="w-6 h-6" />
        </div>

        <h3 className="text-base font-bold text-white mb-1">Receive Assets</h3>
        <p className="text-xs text-slate-400 mb-5">
          Scan QR code or copy address to deposit into this Cyprus-1 Safe
        </p>

        <div className="bg-white p-3 rounded-xl shadow-inner inline-block mb-4">
          <QrCode value={safeState.address} size={180} title="Vault deposit address" />
          <div className="text-[10px] text-slate-800 font-mono font-bold mt-1">Cyprus-1 (Shard 0-0)</div>
        </div>

        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 mb-4 text-left">
          <div className="text-[10px] text-slate-500 mb-1">Check every group matches before sending</div>
          <div className="font-mono text-sm text-slate-100 break-words leading-relaxed" data-testid="grouped-address">
            {groupAddress(safeState.address)}
          </div>
          <button
            onClick={handleCopy}
            className="mt-2 p-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-lg transition-colors inline-flex items-center space-x-1"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span className="text-[10px] font-bold">{copied ? 'Copied' : 'Copy address'}</span>
          </button>
        </div>

        <div className="bg-amber-950/30 border border-amber-800/40 rounded-xl p-2.5 text-[11px] text-amber-300 text-left flex items-start space-x-2">
          <Shield className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-400" />
          <span>
            Only send assets from Quai Cyprus-1 shard (address prefix 0x00). Transfers from other zones
            require cross-zone ETX bridging.
          </span>
        </div>
      </div>
    </div>
  );
};
