import React from 'react';
import { WalletProvider } from './context/WalletContext.js';
import { SafeProvider, useSafe } from './context/SafeContext.js';
import { MarketDataProvider } from './context/MarketDataContext.js';
import { AppShell } from './components/layout/AppShell.js';

const DynamicMarketDataBridge: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { safeState } = useSafe();
  return (
    <MarketDataProvider safeAddress={safeState.address}>
      {children}
    </MarketDataProvider>
  );
};

export const App: React.FC = () => {
  return (
    <WalletProvider>
      <SafeProvider>
        <DynamicMarketDataBridge>
          <AppShell />
        </DynamicMarketDataBridge>
      </SafeProvider>
    </WalletProvider>
  );
};

export default App;
