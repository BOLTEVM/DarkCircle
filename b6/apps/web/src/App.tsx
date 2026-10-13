import React from 'react';
import { NetworkProvider } from './state/NetworkContext.js';
import { WalletProvider } from './state/WalletContext.js';
import { MarketProvider } from './state/MarketContext.js';
import { PriceProvider } from './state/PriceContext.js';
import { TxProvider } from './state/TxContext.js';
import { Footer, Header, StatusBanner } from './components/Layout.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { href, useRoute, type Route } from './lib/router.js';
import { HomePage } from './pages/HomePage.js';
import { ListingsPage } from './pages/ListingsPage.js';
import { ListingPage } from './pages/ListingPage.js';
import { SellPage } from './pages/SellPage.js';
import { PortfolioPage } from './pages/PortfolioPage.js';
import { BrokersPage } from './pages/BrokersPage.js';
import { RegistrarPage } from './pages/RegistrarPage.js';

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HomePage />;
    case 'listings':
      // keyed by query so a new search from the header or home page starts fresh
      return <ListingsPage key={route.q} initialQuery={route.q} />;
    case 'listing':
      return <ListingPage key={route.id.toString()} id={route.id} />;
    case 'sell':
      return <SellPage />;
    case 'portfolio':
      return <PortfolioPage />;
    case 'brokers':
      return <BrokersPage />;
    case 'registrar':
      return <RegistrarPage />;
    case 'notfound':
      return (
        <div className="mx-auto max-w-3xl px-4 py-24 text-center">
          <h1 className="font-display text-3xl text-bone">Nothing at this address</h1>
          <a href={href({ name: 'home' })} className="mt-4 inline-block text-sm text-gold">
            Back to the desk
          </a>
        </div>
      );
  }
}

export const App: React.FC = () => {
  const route = useRoute();
  return (
    <NetworkProvider>
      <PriceProvider>
        <WalletProvider>
          <MarketProvider>
            <TxProvider>
              <div className="questate-ground flex min-h-screen flex-col">
                <Header route={route} />
                <StatusBanner />
                <main className="flex-1">
                  <ErrorBoundary key={route.name}>
                    <Page route={route} />
                  </ErrorBoundary>
                </main>
                <Footer />
              </div>
            </TxProvider>
          </MarketProvider>
        </WalletProvider>
      </PriceProvider>
    </NetworkProvider>
  );
};
