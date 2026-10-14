import React from 'react';
import { NetworkProvider } from './state/NetworkContext.js';
import { WalletProvider } from './state/WalletContext.js';
import { TxProvider } from './state/TxContext.js';
import { Footer, Header, StatusBanner } from './components/Layout.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { href, useRoute, type Route } from './lib/router.js';
import { HallsPage } from './pages/HallsPage.js';
import { FoundPage } from './pages/FoundPage.js';
import { GuildPage } from './pages/GuildPage.js';
import { ProposalPage } from './pages/ProposalPage.js';
import { MintPage } from './pages/MintPage.js';
import { VoicePage } from './pages/VoicePage.js';
import { TributePage } from './pages/TributePage.js';

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HallsPage />;
    case 'found':
      return <FoundPage />;
    case 'guild':
      return <GuildPage key={route.guild} name={route.guild} />;
    case 'proposal':
      return <ProposalPage key={`${route.guild}/${route.id}`} guildName={route.guild} id={route.id} />;
    case 'mint':
      return <MintPage key={route.guild} guildName={route.guild} />;
    case 'voice':
      return <VoicePage />;
    case 'tribute':
      return <TributePage />;
    case 'notfound':
      return (
        <div className="mx-auto max-w-3xl px-4 py-24 text-center">
          <h1 className="font-display text-3xl text-bone">No hall at this address</h1>
          <a href={href({ name: 'home' })} className="mt-4 inline-block text-sm text-gold">
            Back to the halls
          </a>
        </div>
      );
  }
}

export const App: React.FC = () => {
  const route = useRoute();
  return (
    <NetworkProvider>
      <WalletProvider>
        <TxProvider>
          <div className="darkorder-ground flex min-h-screen flex-col">
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
      </WalletProvider>
    </NetworkProvider>
  );
};
