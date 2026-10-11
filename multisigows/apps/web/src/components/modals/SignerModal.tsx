import React from 'react';
import { X, Wallet, Key, AlertCircle } from 'lucide-react';
import { useWallet } from '../../context/WalletContext.js';
import { useSafe } from '../../context/SafeContext.js';

interface SignerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SignerModal: React.FC<SignerModalProps> = ({ isOpen, onClose }) => {
  const { signer, connectEip1193, hasExtension, extensionName, isConnecting, error, disconnect } = useWallet();
  const { safeState } = useSafe();
  const isOwner = Boolean(signer && safeState.owners.some((o) => o.toLowerCase() === signer.address.toLowerCase()));

  if (!isOpen) return null;

  const handleConnectExtension = async () => {
    await connectEip1193();
    onClose();
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
            <Key className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Wallet Signer</h3>
            <p className="text-xs text-slate-400">Connect a Quai wallet extension to sign and execute</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-red-950/40 border border-red-800/50 rounded-xl p-3 text-xs text-red-300 flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {signer ? (
          <div className="space-y-3">
            <div className="bg-emerald-950/40 border border-emerald-500/40 rounded-xl p-3 text-xs">
              <div className="font-semibold text-slate-200 mb-1">{signer.providerName} Connected</div>
              <div className="font-mono text-[10px] text-slate-400">{signer.address}</div>
              {safeState.address && !isOwner && (
                <div className="mt-2 text-[10px] text-amber-300">
                  This address is not on the active vault's owner list.
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={disconnect}
              className="w-full py-2 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-colors"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-400 leading-relaxed">
              Connect Pelagus (native Quai wallet) or a generic EIP-1193 wallet (MetaMask, BoltWallet)
              holding a Cyprus-1 key. Note: typed-data signature approvals are not supported on all
              Pelagus builds.
            </p>

            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 text-center">
              <div className="w-10 h-10 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center mx-auto mb-2">
                <Wallet className="w-5 h-5" />
              </div>
              <div className="text-xs font-semibold text-slate-200 mb-1">
                {hasExtension ? `${extensionName} Detected` : 'No Browser Wallet Detected'}
              </div>
              <p className="text-[11px] text-slate-400 mb-3">
                {hasExtension
                  ? `Ready to request Cyprus-1 account authorization via ${extensionName}.`
                  : 'Please install Pelagus or MetaMask to use browser signing.'}
              </p>

              <button
                type="button"
                onClick={handleConnectExtension}
                disabled={isConnecting}
                className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center space-x-2"
              >
                <Wallet className="w-3.5 h-3.5" />
                <span>{isConnecting ? 'Requesting Accounts...' : 'Connect Extension'}</span>
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 pt-3 border-t border-slate-800/80 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
