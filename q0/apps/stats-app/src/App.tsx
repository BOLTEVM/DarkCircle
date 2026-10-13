import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { 
  Activity, 
  ArrowUpDown, 
  Coins, 
  Database, 
  ExternalLink, 
  TrendingUp, 
  Wallet, 
  RefreshCw, 
  Users, 
  Award,
  Sparkles,
  Shield,
  Layers,
  Rocket
} from 'lucide-react';
import {
  CONTRACTS,
  DEXES,
  REGISTERED_TOKENS,
  TOKEN_REGISTRY,
  DEPLOYED,
  QRB_BOOST_THRESHOLD_WEI,
  formatBoostPct,
  formatBoostDuration,
  getQrbBoostStatus,
  describeQrbBoost,
  clampSlippagePct,
  prepareContractCall,
  type QrbBoostStatus,
  POOL_REGISTRY,
  QUAINANCE_DEX_IDS,
  type PoolInfo,
  type DexId,
  requireDex,
  tokenAddress,
  quoteRoute,
  listRoutes,
  isConnected,
  requoteCandidate,
  verifyDexCode,
  canSign,
  mergePools,
  type RouteCandidate,
  type DexCodeReport,
  parseUnits,
  formatUnits as formatBaseUnits,
  getTokenMetadata,
  getLPReserves,
  getLatestBlockNumber,
  getTokenBalance,
  getAllowance,
  quaiRpcCall,
  getTokenDetailV2,
  getQuainanceTVL,
  mergeQuainance,
  analyzePairs,
  getTokenByAddress,
  type PairSnapshot,
  type QuainanceAggregate,
  TokenMetadata,
  type TokenInfo,
  LPReserves,
  TokenDetailV2,
  TokenTransferV2,
  QuainanceTVL
} from 'quai-service';
import PoolModal from './PoolModal';
import PairsPage from './PairsPage';
import TokenPicker from './TokenPicker';
import TokenBubble, { type TokenBubbleMetadata } from './TokenBubble';
import { formatUsd } from './TokenPicker';
import { toBubbleMetadata, useTokenProfiles } from './useTokenProfiles';
import ImportTokenModal from './ImportTokenModal';
import FarmsPage from './FarmsPage';
import PrimaryNav from './PrimaryNav';
import { SectionBoundary } from './CrashScreen';
import { resolveQuaiUsd } from './quaiUsd';
import { useQrbMarket } from './useQrbMarket';
import QrbMarketCards from './QrbMarketCards';
import QuainanceMarkets from './QuainanceMarkets';
import { loadQuainanceCatalog, type CatalogLoad } from './quainanceCatalog';
import { useAdministrator } from './useAdministrator';
import { deployTabVisible } from './adminAccess';
import TokenAnalyticsPage from './TokenAnalyticsPage';
import { readImportedTokens, writeImportedTokens } from './customTokens';
import { loadBalances, loadSwapLiquidity } from './swapLiquidity';

// The deploy tooling carries the contracts' creation bytecode and the quais SDK; it loads only when opened.
const DeployPage = lazy(() => import('./DeployPage'));
import { 
  getQuaiProvider, 
  getCyprus1Address, 
  requestWalletAccounts, 
  getAuthorizedAccounts, 
  sendWalletTransaction,
  subscribeProvider
} from './providerUtils';

const showLegacyAnalytics = (): boolean => false;

const isLocalhost = typeof window !== 'undefined' && (
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === '0.0.0.0' ||
  import.meta.env.DEV
);

// The Deploy tab is for the administrator only (see adminAccess.ts). It is never part of a production visitor's page; the
// one exception is a development build on this machine against a network with nothing deployed, where there is no owner yet.
const DEPLOY_BOOTSTRAP_OPEN = deployTabVisible({
  isAdmin: false,
  production: Boolean(import.meta.env.PROD),
  onThisMachine: isLocalhost,
  anythingDeployed: DEPLOYED.MASTERCHEF !== null || DEPLOYED.AMM_FACTORY !== null
});

const getTabFromHash = (deployAllowed: boolean = false): 'SWAP' | 'FARMS' | 'QRB' | 'ANALYTICS' | 'PAIRS' | 'DEPLOY' => {
  const hash = typeof window !== 'undefined' ? window.location.hash.toLowerCase() : '';
  if (hash === '#deploy') return deployAllowed ? 'DEPLOY' : 'SWAP';
  if (hash === '#farms') return 'FARMS';
  if (hash === '#qrb') return 'QRB';
  if (hash === '#analytics') return 'ANALYTICS';
  if (hash === '#pairs') return 'PAIRS';
  if (hash === '#swap') return 'SWAP';
  return 'SWAP';
};

export default function App() {
  // Navigation State
  const [activeTab, setActiveTab] = useState<'SWAP' | 'FARMS' | 'QRB' | 'ANALYTICS' | 'PAIRS' | 'DEPLOY'>(() => getTabFromHash(DEPLOY_BOOTSTRAP_OPEN));
  // Wallet first: the administrator check below needs it. (Declared here so the hash handler can read the result.)
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const { isAdmin } = useAdministrator(walletAddress);
  // QRB price and market cap refresh in the background (explorer + pool reserves), independent of the loading screen:
  // the first read starts now, and the tab keeps it fresh while it is open.
  const qrbMarket = useQrbMarket(activeTab === 'QRB');
  const deployVisible = isAdmin || DEPLOY_BOOTSTRAP_OPEN;
  const deployVisibleRef = useRef(deployVisible);
  deployVisibleRef.current = deployVisible;

  useEffect(() => {
    const onHashChange = () => {
      setActiveTab(getTabFromHash(deployVisibleRef.current));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Land on #deploy once the administrator is recognised, and never stay on it (or keep it in the address bar) after that
  // stops being true: a different wallet, a disconnect, an ownership transfer.
  useEffect(() => {
    if (deployVisible) {
      if (window.location.hash.toLowerCase() === '#deploy') setActiveTab('DEPLOY');
    } else if (activeTab === 'DEPLOY') {
      setActiveTab('SWAP');
      if (window.location.hash.toLowerCase() === '#deploy') window.history.replaceState(null, '', '#swap');
    }
  }, [deployVisible, activeTab]);

  const navigateToTab = (tab: 'SWAP' | 'FARMS' | 'QRB' | 'ANALYTICS' | 'PAIRS' | 'DEPLOY') => {
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      window.location.hash = '#' + tab.toLowerCase();
    }
  };

  // Wallet States
  // Raw base-unit balances (decimal strings); formatted on render so no precision is lost.
  const [rawBalances, setRawBalances] = useState<Record<string, string>>({});
  // LP token balances held by the wallet, keyed by lower-cased pair address.
  const [lpBalances, setLpBalances] = useState<Record<string, string>>({});
  // Live reserves for every registered pool, keyed by lower-cased pair address.
  const [poolReserves, setPoolReserves] = useState<Record<string, LPReserves>>({});
  const [walletLoading, setWalletLoading] = useState<boolean>(false);

  // General Chain & Contract States
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [q0Meta, setQ0Meta] = useState<TokenMetadata | null>(null);
  const [holderCount, setHolderCount] = useState<number>(0);
  const [latestBlock, setLatestBlock] = useState<number>(0);
  const [transfers, setTransfers] = useState<TokenTransferV2[]>([]);
  const [tokenDetail, setTokenDetail] = useState<TokenDetailV2 | null>(null);

  // LP Pool States
  const [lpWquai, setLpWquai] = useState<LPReserves | null>(null);
  const [lpBoss, setLpBoss] = useState<LPReserves | null>(null);

  // Quainance DEX States
  const [quainanceTvl, setQuainanceTvl] = useState<QuainanceTVL | null>(null);
  // Every pair the Quainance factory reports, merged with the explorer's indexed stats (see quai-service/quainance.ts).
  const [quainanceAgg, setQuainanceAgg] = useState<QuainanceAggregate | null>(null);
  // The launchpad catalog behind it (Hartii, QAXE, POOP, curves): live, or a dated snapshot, or null when unreadable.
  const [quainanceCatalog, setQuainanceCatalog] = useState<CatalogLoad | null>(null);
  const [quaiUsdNow, setQuaiUsdNow] = useState<number | null>(null);
  
  // Swap States
  // Every pool on every DEX factory (read from the factories themselves), and the tokens found in them.
  const [discoveredPools, setDiscoveredPools] = useState<PoolInfo[]>([]);
  const [discoveredTokens, setDiscoveredTokens] = useState<TokenInfo[]>([]);
  // Whether each DEX's contracts are still the ones this app pins, the gas price, and pools that could not be used.
  const [dexState, setDexState] = useState<Partial<Record<DexId, DexCodeReport>>>({});
  const [gasPriceWei, setGasPriceWei] = useState<bigint | null>(null);
  const [skippedPools, setSkippedPools] = useState<number>(0);
  // The two tokens being swapped (registry keys; native QUAI is WQUAI plus `nativeQuaiSide`), and a way the user chose.
  const [pair, setPair] = useState<{ from: string; to: string }>({ from: 'Q0', to: 'WQUAI' });
  const [forcedRouteId, setForcedRouteId] = useState<string | null>(null);
  const [poolModalOpen, setPoolModalOpen] = useState<boolean>(false);
  const [customTokens, setCustomTokens] = useState(() => readImportedTokens());
  const [importTokenOpen, setImportTokenOpen] = useState(false);
  const [importPrefill, setImportPrefill] = useState<string | undefined>(undefined);
  const tokenCatalog = useMemo(() => {
    const known = new Set([...REGISTERED_TOKENS, ...customTokens].map(token => token.address.toLowerCase()));
    return [...REGISTERED_TOKENS, ...customTokens, ...discoveredTokens.filter(token => !known.has(token.address.toLowerCase()))];
  }, [customTokens, discoveredTokens]);
  const tokenCatalogRef = useRef(tokenCatalog);
  tokenCatalogRef.current = tokenCatalog;

  // Keep imported metadata available to the shared route/quote helpers. The generated registry remains the
  // source of built-ins; imported entries are browser-local additions only.
  useEffect(() => {
    for (const token of customTokens) TOKEN_REGISTRY[token.symbol] = token;
    writeImportedTokens(customTokens);
  }, [customTokens]);

  // Live token metadata (see quai-service/tokenMetadata.ts): contract fields come from the chain in one
  // batch and win over everything else; the explorer adds logo, price and holders. Cached profiles paint
  // immediately, results stream in per token, and a failed source never erases what is already known.
  // Live profiles (logo, price, holders) are fetched for curated and imported tokens, for tokens the wallet holds or the swap
  // screen shows, and for the deepest discovered ones: not for all of the hundred or so, which would be one explorer request
  // each every few minutes. A discovered token whose symbol imitates another keeps its suffixed key and is never looked up,
  // so a contract cannot dress itself up as a listed token by answering symbol().
  const profileTokens = useMemo(() => {
    const wanted = new Set<string>([pair.from, pair.to]);
    for (const [symbol, raw] of Object.entries(rawBalances)) if (raw !== '0') wanted.add(symbol);
    let deepest = 0;
    return tokenCatalog.filter(token => {
      if (!token.discovered) return true;
      if (token.symbol.includes('#')) return false;
      return wanted.has(token.symbol) || deepest++ < 24;
    });
  }, [tokenCatalog, rawBalances, pair.from, pair.to]);
  const { profiles: tokenProfiles, status: contractMetadataStatus, refreshing: tokenMetadataRefreshing, refresh: refreshTokenMetadata } = useTokenProfiles(profileTokens);
  const contractMetadata = useMemo(() => {
    const map: Record<string, TokenBubbleMetadata> = {};
    for (const token of tokenCatalog) {
      const live = toBubbleMetadata(token, tokenProfiles[token.address.toLowerCase()]);
      if (live) map[token.address.toLowerCase()] = live;
    }
    // Native QUAI has no contract: show the wrapped-Quai logo and price, which is the same asset.
    const wquai = TOKEN_REGISTRY['WQUAI'];
    const native = TOKEN_REGISTRY['QUAI'];
    const wquaiLive = wquai ? map[wquai.address.toLowerCase()] : undefined;
    if (native && wquaiLive) {
      map[native.address.toLowerCase()] = {
        address: native.address, name: native.name, symbol: native.symbol, decimals: native.decimals, totalSupply: '0',
        iconUrl: wquaiLive.iconUrl, priceUsd: wquaiLive.priceUsd, decimalsVerified: true
      };
    }
    return map;
  }, [tokenCatalog, tokenProfiles]);
  const importedAddresses = useMemo(() => new Set(customTokens.map(token => token.address.toLowerCase())), [customTokens]);

  // The curated pools plus every pool the factories report (the same pair address is listed once).
  const allPools = useMemo<PoolInfo[]>(() => mergePools(POOL_REGISTRY, discoveredPools), [discoveredPools]);
  const allPoolsRef = useRef<PoolInfo[]>(allPools);
  allPoolsRef.current = allPools;
  const tokenLabel = (symbol: string) => TOKEN_REGISTRY[symbol]?.symbol ?? symbol;

  // The wallet's boost as the Qrb contract reports it (balance AND holding time), not inferred from a balance.
  const [qrbStatus, setQrbStatus] = useState<QrbBoostStatus | null>(null);
  // A swap that moves the price a lot, or involves a token nobody has vetted, must be acknowledged before it is sent.
  const [impactAck, setImpactAck] = useState<boolean>(false);
  const [nativeQuaiSide, setNativeQuaiSide] = useState<'FROM' | 'TO' | null>(null);
  const [swapAmountIn, setSwapAmountIn] = useState<string>('');
  const [slippage, setSlippage] = useState<number>(1.0);
  const [swapLoading, setSwapLoading] = useState<boolean>(false);
  const [swapTxHash, setSwapTxHash] = useState<string | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  // Atomic router swap progress state ('IDLE' | 'APPROVING' | 'SWAPPING')
  const [pendingSwapStep, setPendingSwapStep] = useState<'IDLE' | 'APPROVING' | 'SWAPPING'>('IDLE');
  // Which step of a route that takes several transactions is being sent.
  const [swapStep, setSwapStep] = useState<{ index: number; total: number }>({ index: 0, total: 1 });

  // Top Holders
  const [topHolders, setTopHolders] = useState<{address: string, balance: string, pct: string}[]>([]);

  // ABI Helpers for Router
  const encodeRouterSwap = (
    amountIn: bigint,
    amountOutMin: bigint,
    path: string[],
    to: string,
    deadline: bigint
  ): string => {
    const pad = (n: bigint | number, bits = 32) =>
      BigInt(n).toString(16).padStart(bits * 2, '0');
    const padAddr = (addr: string) =>
      addr.replace('0x', '').toLowerCase().padStart(64, '0');

    const pathOffset = BigInt(0xa0);
    const pathLen = BigInt(path.length);
    const pathEncoded = path.map(padAddr).join('');

    return (
      '0x38ed1739' +
      pad(amountIn) +
      pad(amountOutMin) +
      pad(pathOffset) +
      padAddr(to) +
      pad(deadline) +
      pad(pathLen) +
      pathEncoded
    );
  };

  // Native QUAI uses the router's WQUAI boundary. Never encode the zero address as an ERC-20 path token.
  const encodeRouterSwapExactETH = (amountOutMin: bigint, path: string[], to: string, deadline: bigint): string => {
    const pad = (n: bigint | number, bits = 32) => BigInt(n).toString(16).padStart(bits * 2, '0');
    const padAddr = (addr: string) => addr.replace('0x', '').toLowerCase().padStart(64, '0');
    return '0x7ff36ab5' + pad(amountOutMin) + pad(0x80) + padAddr(to) + pad(deadline) + pad(path.length) + path.map(padAddr).join('');
  };

  const encodeRouterSwapExactTokensForETH = (amountIn: bigint, amountOutMin: bigint, path: string[], to: string, deadline: bigint): string => {
    const pad = (n: bigint | number, bits = 32) => BigInt(n).toString(16).padStart(bits * 2, '0');
    const padAddr = (addr: string) => addr.replace('0x', '').toLowerCase().padStart(64, '0');
    return '0x18cbafe5' + pad(amountIn) + pad(amountOutMin) + pad(0xa0) + padAddr(to) + pad(deadline) + pad(path.length) + path.map(padAddr).join('');
  };

  const encodeApprove = (spender: string, amount: bigint): string => {
    const cleanSpender = spender.replace('0x', '').toLowerCase().padStart(64, '0');
    const cleanAmount = amount.toString(16).padStart(64, '0');
    return '0x095ea7b3' + cleanSpender + cleanAmount;
  };

  const waitForTransaction = async (txHash: string): Promise<any> => {
    const maxAttempts = 120;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const receipt = await quaiRpcCall('quai_getTransactionReceipt', [txHash]);
        if (receipt) {
          if (receipt.status === '0x1' || receipt.status === 1) {
            return receipt;
          }
          throw new Error("Transaction execution failed on-chain.");
        }
      } catch (e: any) {
        if (e.message && e.message.includes("failed on-chain")) {
          throw e;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error("Transaction was not mined within 90 seconds. It may still confirm on Cyprus-1.");
  };

  const parseSwapError = (err: any): string => {
    const msg = err.message || String(err);
    if (msg.toLowerCase().includes("insufficient funds")) {
      return "⚠️ Insufficient QUAI for Gas: You need more native QUAI in your wallet to cover the network transaction fee.";
    }
    return msg || "Transaction rejected or execution reverted.";
  };

  // Fetch all on-chain data
  const fetchData = useCallback(async (isRefresh: boolean = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    // Liquidity first and on its own: the swap screen needs only the chain, so a slow or blocked explorer must not hold it up
    // or take it down. Every pool of every DEX factory is read in one pass (see swapLiquidity.ts).
    let snapshots: PairSnapshot[] = [];
    let allSnapshots: PairSnapshot[] = [];
    let factoryTotal = 0;
    try {
      const liquidity = await loadSwapLiquidity();
      setDiscoveredPools(liquidity.pools);
      setDiscoveredTokens(liquidity.tokens);
      setPoolReserves(liquidity.reserves);
      setDexState(liquidity.dexState);
      setGasPriceWei(liquidity.gasPriceWei);
      setSkippedPools(liquidity.skippedPools);
      setLpWquai(liquidity.reserves[CONTRACTS.LP_WQUAI.toLowerCase()] ?? null);
      setLpBoss(liquidity.reserves[CONTRACTS.LP_BOSS.toLowerCase()] ?? null);
      snapshots = liquidity.snapshots.filter(p => QUAINANCE_DEX_IDS.includes(p.dex));
      factoryTotal = QUAINANCE_DEX_IDS.reduce((sum, id) => sum + (liquidity.totals[id] ?? 0), 0);
      for (const note of liquidity.errors) console.warn('Liquidity read:', note);
      setLatestBlock(liquidity.block || (await getLatestBlockNumber().catch(() => 0)));
      // Priced from every pair, so a token is valued through whichever DEX holds its deepest pool.
      allSnapshots = liquidity.snapshots;
    } catch (e) {
      console.error('Error loading pools from Quai:', e);
    }

    try {
      const [meta, detail] = await Promise.all([getTokenMetadata(CONTRACTS.Q0), getTokenDetailV2(CONTRACTS.Q0)]);
      setQ0Meta(meta);
      setTokenDetail(detail);
      setTransfers(detail.transfers);
      setHolderCount(detail.token.holder_count || 34);
      setTopHolders(
        detail.holders
          .filter(h => h.address.toLowerCase() !== '0x0000000000000000000000000000000000000000')
          .slice(0, 8)
          .map(h => ({
            address: h.address,
            balance: (Number(h.balance) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 }),
            pct: h.percentage.toFixed(2) + '%'
          }))
      );
    } catch (e) {
      console.warn('Q0 token details unavailable:', e);
    }

    try {
      // The explorer's indexed stats are optional: partial (top 25 pools) and blocked from browsers in production.
      // Only the development proxy can read this endpoint: the explorer sends no CORS header, so in production the call would
      // fail on every load (and fill the console), and the figures are derived from pool reserves either way.
      let indexed: QuainanceTVL | null = null;
      if (import.meta.env.DEV) {
        try {
          indexed = await getQuainanceTVL(1, '/api-quai-v2');
          setQuainanceTvl(indexed);
        } catch (tvlErr) {
          console.warn('Quainance indexed stats unavailable; values come from pool reserves:', tvlErr);
          setQuainanceTvl(null);
        }
      } else {
        setQuainanceTvl(null);
      }
      const [quaiUsd, catalog] = await Promise.all([resolveQuaiUsd(), loadQuainanceCatalog()]);
      setQuaiUsdNow(quaiUsd);
      setQuainanceCatalog(catalog);
      setQuainanceAgg(
        mergeQuainance({
          snapshots,
          analysis: analyzePairs(allSnapshots, { quaiUsd }).filter(a => QUAINANCE_DEX_IDS.includes(a.dex)),
          explorer: indexed,
          factoryTotal,
          launches: catalog ? catalog.launches : undefined,
          isListed: address => {
            const t = getTokenByAddress(address);
            return Boolean(t) && t!.deployed !== false && !t!.isNative;
          }
        })
      );
    } catch (aggErr) {
      console.warn('Could not aggregate Quainance pairs:', aggErr);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Load wallet balances for every known token, plus LP tokens for every pool, as a few batched requests (there are a
  // hundred or more of each; one request per read would hammer the node). A failed read is left unset (rendered as an em
  // dash) rather than shown as 0.
  const loadWalletBalances = useCallback(async (addr: string) => {
    try {
      const { raw, lp } = await loadBalances(
        addr,
        tokenCatalogRef.current.filter(tok => tok.deployed !== false),
        allPoolsRef.current.map(pool => pool.pair)
      );
      setRawBalances(raw);
      setLpBalances(lp);
    } catch (e) {
      console.warn('Balance read failed:', e);
    }
  }, []);

  const getBalanceForToken = (symbol: string) => {
    const raw = rawBalances[symbol];
    const decimals = TOKEN_REGISTRY[symbol]?.decimals ?? 18;
    if (raw === undefined) return '—';
    // thousands separators on the integer part only: 428191052.577887 -> 428,191,052.577887
    const [whole, fraction] = formatBaseUnits(BigInt(raw), decimals, 6).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fraction === undefined ? grouped : `${grouped}.${fraction}`;
  };

  const quaiBalance = rawBalances['QUAI'] === undefined ? '—' : formatBaseUnits(BigInt(rawBalances['QUAI']), 18, 4);
  // The boost: the figure and threshold come from the shared constants (mirrors Qrb.BOOST_BPS / BOOST_THRESHOLD).
  const boostThresholdText = formatBaseUnits(QRB_BOOST_THRESHOLD_WEI, 18, 18);
  const boostDurationText = formatBoostDuration();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const qrbBoostState = qrbStatus ? describeQrbBoost(qrbStatus, QRB_BOOST_THRESHOLD_WEI, nowSeconds) : 'BELOW_THRESHOLD';
  const boostEligibleInText = qrbStatus && qrbStatus.eligibleAt > nowSeconds
    ? (() => { const h = Math.ceil((qrbStatus.eligibleAt - nowSeconds) / 3600); return h >= 48 ? Math.ceil(h / 24) + ' days' : h + ' h'; })()
    : '';
  // One line for the Farms page: the same states the QRB tab shows, so the two never disagree.
  const farmBoostLabel =
    DEPLOYED.QRB === null
      ? 'QRB bonus not available yet'
      : !walletAddress
        ? `Hold ${boostThresholdText} QRB for ${boostDurationText}: +${formatBoostPct()} rewards`
        : qrbBoostState === 'ACTIVE'
          ? `QRB bonus on: +${formatBoostPct()} rewards`
          : qrbBoostState === 'MATURING'
            ? `QRB bonus starts in ${boostEligibleInText}`
            : `Hold ${boostThresholdText} QRB for ${boostDurationText} for +${formatBoostPct()} rewards`;
  const artworkHref = DEPLOYED.ARTWORK_URI ? DEPLOYED.ARTWORK_URI.replace(/^ar:\/\//, 'https://arweave.net/') : null;


  useEffect(() => {
    if (walletAddress) {
      loadWalletBalances(walletAddress);
    }
  }, [walletAddress, loadWalletBalances, discoveredPools, discoveredTokens, customTokens]);

  useEffect(() => {
    let live = true;
    if (!walletAddress || !DEPLOYED.QRB) { setQrbStatus(null); return; }
    getQrbBoostStatus(DEPLOYED.QRB, walletAddress)
      .then(st => { if (live) setQrbStatus(st); })
      .catch(e => console.warn('Qrb boost status read failed:', e));
    return () => { live = false; };
  }, [walletAddress, rawBalances]);

  // Auto connect check
  useEffect(() => {
    let isMounted = true;
    const checkSilentConnect = async () => {
      const provider = getQuaiProvider();
      if (!provider) return;
      try {
        const accounts = await getAuthorizedAccounts(provider);
        if (isMounted && accounts && accounts.length > 0) {
          const cyprus1Addr = getCyprus1Address(accounts);
          if (cyprus1Addr) {
            setWalletAddress(cyprus1Addr);
          }
        }
      } catch (err) {
        console.warn("Silent account check failed:", err);
      }
    };
    checkSilentConnect();
    return () => {
      isMounted = false;
    };
  }, []);

  // Accounts listener
  useEffect(() => {
    const provider = getQuaiProvider();
    if (!provider) return;

    const handleAccountsChanged = (newAccounts: string[]) => {
      if (Array.isArray(newAccounts) && newAccounts.length > 0) {
        const cyprus1Addr = getCyprus1Address(newAccounts);
        setWalletAddress(cyprus1Addr);
      } else {
        setWalletAddress(null);
      }
    };

    // never throws: an injected provider that is half-implemented must not blank the page
    return subscribeProvider(provider, 'accountsChanged', handleAccountsChanged);
  }, []);

  // Wallet connect
  const connectWallet = async () => {
    const provider = getQuaiProvider();
    if (!provider) {
      alert("Pelagus Wallet not found. Please install the Pelagus extension from https://pelaguswallet.io to interact with Quai Network.");
      return;
    }

    setWalletLoading(true);
    try {
      const accounts = await requestWalletAccounts(provider);
      if (accounts && accounts.length > 0) {
        const selected = getCyprus1Address(accounts);
        if (selected) {
          if (!selected.toLowerCase().startsWith('0x00')) {
            alert(`Warning: The connected account (${selected}) does not reside on the Cyprus-1 shard (address must begin with 0x00). Please select a Cyprus-1 account in Pelagus.`);
          }
          setWalletAddress(selected);
        }
      }
    } catch (e: any) {
      console.error("Wallet connection failed:", e);
      alert("Failed to connect wallet: " + (e.message || "Unknown error"));
    } finally {
      setWalletLoading(false);
    }
  };

  // ---- the swap, derived from live reserves on every render (no cached copy to go stale) ----
  const fromSymbol = nativeQuaiSide === 'FROM' ? 'QUAI' : pair.from;
  const toSymbol = nativeQuaiSide === 'TO' ? 'QUAI' : pair.to;
  const fromTokenDecimals = TOKEN_REGISTRY[fromSymbol]?.decimals ?? 18;
  const toTokenDecimals = TOKEN_REGISTRY[toSymbol]?.decimals ?? 18;

  // ---- display helpers (read-only; none of this feeds the quote) ----
  const pickerTokens = useMemo(() => tokenCatalog.filter(token => token.deployed !== false), [tokenCatalog]);
  // The decimals the swap maths uses are the registry's; show amounts with the same value so a balance
  // in the list always matches what the quote will do with it.
  const pickerDecimalsOf = useCallback((token: TokenInfo) => TOKEN_REGISTRY[token.symbol]?.decimals ?? token.decimals, []);
  const pickerBalanceOf = useCallback((token: TokenInfo): bigint | undefined => {
    const raw = rawBalances[token.symbol];
    return raw === undefined || !walletAddress ? undefined : BigInt(raw);
  }, [rawBalances, walletAddress]);
  const openImport = useCallback((address?: string) => {
    setImportPrefill(address);
    setImportTokenOpen(true);
  }, []);
  /** "≈ $1.23" for an amount of a token the explorer has a price for; empty otherwise. */
  const usdText = (amount: string, symbol: string): string => {
    const token = TOKEN_REGISTRY[symbol];
    if (!token) return '';
    const priced = token.isNative ? TOKEN_REGISTRY['WQUAI'] : token;
    const price = priced ? contractMetadata[priced.address.toLowerCase()]?.priceUsd : undefined;
    const n = Number(amount);
    if (price === undefined || !Number.isFinite(n) || n <= 0) return '';
    const text = formatUsd(n * price);
    return text ? `≈ ${text}` : '';
  };

  let amountInWei: bigint | null = null;
  let amountParseError: string | null = null;
  if (swapAmountIn) {
    try {
      amountInWei = parseUnits(swapAmountIn, fromTokenDecimals);
    } catch (e: any) {
      amountParseError = e.message;
    }
  }

  // Every way to swap this pair for the amount typed (or for one whole token when nothing is typed, so there is a price to
  // show), best first. Ranked by what a route returns after its network fees; a route in one transaction is preferred when
  // it is within 1% of the best. Routes cross every DEX the app can read, so there is no list of "supported" pairs.
  const probeAmount = amountInWei && amountInWei > 0n ? amountInWei : 10n ** BigInt(fromTokenDecimals);
  const candidates = useMemo(
    () =>
      listRoutes({
        from: pair.from,
        to: pair.to,
        amountIn: probeAmount,
        pools: allPools,
        reserves: poolReserves,
        slippagePct: slippage,
        nativeIn: nativeQuaiSide === 'FROM',
        gas: gasPriceWei !== null ? { gasPriceWei } : null
      }),
    [pair.from, pair.to, probeAmount, allPools, poolReserves, slippage, nativeQuaiSide, gasPriceWei]
  );
  const active: RouteCandidate | null = candidates.find(c => c.id === forcedRouteId) ?? candidates[0] ?? null;
  const routeLegs = active ? active.legs : [];
  const routeDexLabels = [...new Set(routeLegs.map(leg => (leg.kind === 'AMM' ? DEXES[leg.dex].label : 'Launch curve')))].join(' → ');
  const routeSteps = routeLegs.length;
  // When nothing connects the two tokens, say which of the two situations it is.
  const connected = useMemo(() => isConnected(pair.from, pair.to, allPools, poolReserves), [pair.from, pair.to, allPools, poolReserves]);
  const noRouteText = active
    ? null
    : connected
      ? `The pools between ${tokenLabel(fromSymbol)} and ${tokenLabel(toSymbol)} cannot fill that amount. Try a smaller amount.`
      : `No pool connects ${tokenLabel(fromSymbol)} and ${tokenLabel(toSymbol)} yet. Add liquidity to start one.`;
  /** A route's tokens as the person would say them: native QUAI at the ends where it is the one paid or received. */
  const pathLabel = (path: string[]) =>
    path.map((key, i) => (i === 0 && nativeQuaiSide === 'FROM') || (i === path.length - 1 && nativeQuaiSide === 'TO') ? 'QUAI' : tokenLabel(key)).join(' → ');

  const quote = active && amountInWei && amountInWei > 0n ? active.quote : null;
  const fromBalanceRaw = rawBalances[fromSymbol];
  const insufficientBalance = amountInWei !== null && fromBalanceRaw !== undefined && BigInt(fromBalanceRaw) < amountInWei;

  // A swap this far from the market price hands most of its value to whoever trades against it, and a token found in a pool
  // (not listed by this app) can be called anything: either needs an explicit tick before the swap can be sent.
  const HIGH_IMPACT_PCT = 10;
  const needsImpactAck = !!quote && quote.priceImpactPct >= HIGH_IMPACT_PCT;
  const unverifiedInRoute = active ? active.unverified : [];
  const needsUnverifiedAck = !!quote && unverifiedInRoute.length > 0;
  const needsAck = needsImpactAck || needsUnverifiedAck;

  const swapAmountOut = quote ? formatBaseUnits(quote.amountOut, toTokenDecimals, 6) : '';
  const minReceived = quote ? formatBaseUnits(quote.minimumReceived, toTokenDecimals, 6) : '0';
  const priceImpact = quote ? quote.priceImpactPct.toFixed(2) + '%' : '0.00%';
  // Output per input in WHOLE tokens (the quote's own ratio is in base units, which differ when decimals differ).
  const execPrice = (() => {
    // With nothing typed the rate is for one whole token, so the screen still shows a price.
    if (!active) return '0';
    const wholeIn = Number(probeAmount) / 10 ** fromTokenDecimals;
    const wholeOut = Number(active.quote.amountOut) / 10 ** toTokenDecimals;
    const n = wholeIn > 0 ? wholeOut / wholeIn : 0;
    return n === 0 ? '0' : n >= 1 ? n.toFixed(4) : n.toPrecision(4);
  })();
  const feeQuaiText = active && active.feeWei !== null ? formatBaseUnits(active.feeWei, 18, 2) : null;
  // The fees can be most of a small swap: say so before it is sent.
  const feesDominate = !!quote && !!active && active.feeOut !== null && active.feeOut * 2n > quote.amountOut;

  const handleAmountInChange = (val: string) => {
    setImpactAck(false);
    setSwapAmountIn(val);
    setSwapTxHash(null);
    setSwapError(null);
  };

  const toggleSwapDirection = () => {
    setImpactAck(false);
    setPair(p => ({ from: p.to, to: p.from }));
    setForcedRouteId(null);
    setNativeQuaiSide(side => side === 'FROM' ? 'TO' : side === 'TO' ? 'FROM' : null);
    setSwapAmountIn('');
    setSwapError(null);
    setSwapTxHash(null);
  };

  // Execute the swap: one transaction per step, each through the router of the DEX that owns that step's pools.
  const executeSwap = async () => {
    if (!walletAddress) {
      connectWallet();
      return;
    }
    if (amountParseError) {
      setSwapError(amountParseError);
      return;
    }
    if (!amountInWei || amountInWei <= 0n) {
      setSwapError("Enter an amount to swap.");
      return;
    }
    if (!active || !quote) {
      setSwapError(noRouteText ?? 'There is no way to swap this pair for that amount.');
      return;
    }
    if (insufficientBalance) {
      setSwapError(`Insufficient ${tokenLabel(fromSymbol)}: you hold ${getBalanceForToken(fromSymbol)}.`);
      return;
    }
    if (needsAck && !impactAck) {
      setSwapError('Tick the box to confirm you understand the risk before swapping.');
      return;
    }

    setSwapLoading(true);
    setSwapError(null);
    setSwapTxHash(null);

    const provider = getQuaiProvider();
    if (!provider) {
      setSwapError("Pelagus / Quai provider not found. Please connect your wallet.");
      setSwapLoading(false);
      return;
    }

    const legs = active.legs;
    let completedSteps = 0;
    try {
      // The DEX contracts must still be the ones this app was written for: a swap is never signed against code that changed.
      const dexIds = [...new Set(legs.flatMap(leg => (leg.kind === 'AMM' ? [leg.dex] : [])))];
      const integrity = await verifyDexCode(dexIds);
      for (const id of dexIds) {
        if (!canSign(integrity[id].state)) throw new Error(integrity[id].detail);
      }

      // Re-read every pool of the route right before signing so the minimum is not built from a stale page load.
      const hopPairs = new Set<string>();
      for (const leg of legs) {
        if (leg.kind !== 'AMM') continue;
        for (let i = 0; i < leg.path.length - 1; i++) {
          const pool = allPools.find(p => p.dex === leg.dex && ((p.tokens[0] === leg.path[i] && p.tokens[1] === leg.path[i + 1]) || (p.tokens[1] === leg.path[i] && p.tokens[0] === leg.path[i + 1])));
          if (!pool) throw new Error(`No ${DEXES[leg.dex].label} pool for ${leg.path[i]}/${leg.path[i + 1]}.`);
          hopPairs.add(pool.pair);
        }
      }
      const fresh: Record<string, LPReserves> = { ...poolReserves };
      await Promise.all([...hopPairs].map(async pairAddress => {
        fresh[pairAddress.toLowerCase()] = await getLPReserves(pairAddress);
      }));
      setPoolReserves(fresh);
      const freshQuote = requoteCandidate(active, amountInWei, fresh, slippage, allPools);
      if (!freshQuote) throw new Error("Could not quote this swap from live reserves.");
      // Never send a swap that would now pay out less than the minimum the person was shown.
      if (freshQuote.amountOut < quote.minimumReceived) {
        throw new Error(`The price moved while you were confirming: this swap would now give ${formatBaseUnits(freshQuote.amountOut, toTokenDecimals, 6)} ${tokenLabel(toSymbol)}, below the minimum of ${minReceived} shown. Nothing was sent. Check the new quote and try again.`);
      }

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      let carried = amountInWei;
      for (const [index, leg] of legs.entries()) {
        if (leg.kind !== 'AMM') throw new Error('This kind of step is not available in this version of the app.');
        const legDex = requireDex(leg.dex);
        const last = index === legs.length - 1;
        const nativeInput = fromSymbol === 'QUAI' && index === 0;
        const nativeOutput = toSymbol === 'QUAI' && last;
        setSwapStep({ index, total: legs.length });

        const legRoute = { id: `step_${index}`, label: leg.path.join(' / '), dex: leg.dex, path: leg.path };
        const legQuote = quoteRoute(legRoute, false, carried, fresh, slippage, allPools);
        if (!legQuote) throw new Error(`Could not quote the ${legDex.label} step ${leg.path.map(tokenLabel).join(' → ')}.`);
        // The last step may never pay out less than the minimum that was shown.
        let minimumOut = legQuote.minimumReceived;
        if (last && quote.minimumReceived > minimumOut) minimumOut = quote.minimumReceived;
        if (last && legQuote.amountOut < minimumOut) {
          throw new Error(`The earlier steps paid out less than quoted, so the last step can no longer reach the minimum shown. Nothing more was sent. You hold the ${tokenLabel(leg.path[0])} from the earlier steps.`);
        }

        const outputSymbol = leg.path[leg.path.length - 1];
        const outputToken = nativeOutput ? null : tokenAddress(outputSymbol);
        // The amount the next step receives is the balance change, not the quote: the pool may have moved in between.
        const outputBefore = !last && outputToken ? BigInt(await getTokenBalance(outputToken, walletAddress)) : 0n;

        const inputToken = nativeInput ? null : tokenAddress(leg.path[0]);
        if (inputToken) {
          const allowance = await getAllowance(inputToken, walletAddress, legDex.router);
          if (allowance < carried) {
            setPendingSwapStep('APPROVING');
            const approveTx = await sendWalletTransaction(provider, {
              from: walletAddress,
              to: inputToken,
              data: encodeApprove(legDex.router, carried),
              gas: '0x186a0'
            });
            await waitForTransaction(approveTx);
          }
        }

        setPendingSwapStep('SWAPPING');
        const path = leg.path.map(tokenAddress);
        const data = nativeInput
          ? encodeRouterSwapExactETH(minimumOut, path, walletAddress, deadline)
          : nativeOutput
            ? encodeRouterSwapExactTokensForETH(carried, minimumOut, path, walletAddress, deadline)
            : encodeRouterSwap(carried, minimumOut, path, walletAddress, deadline);
        // On Cyprus-1 a reverted transaction burns its whole gas limit, so each step is simulated against the now-approved
        // allowance first; if it would revert (slippage, dust pool, stale price) nothing is sent.
        const prepared = await prepareContractCall(walletAddress, legDex.router, data, 1.5, undefined, nativeInput ? carried : 0n);
        const swapTx = await sendWalletTransaction(provider, prepared.tx);
        setSwapTxHash(swapTx);
        await waitForTransaction(swapTx);
        completedSteps++;

        if (!last) {
          const received = BigInt(await getTokenBalance(outputToken!, walletAddress)) - outputBefore;
          if (received <= 0n) throw new Error(`The ${legDex.label} step confirmed but no ${tokenLabel(outputSymbol)} was received.`);
          carried = received;
        }
      }

      setPendingSwapStep('IDLE');
      setSwapAmountIn('');
      loadWalletBalances(walletAddress);
      setTimeout(() => loadWalletBalances(walletAddress), 2000);
      setTimeout(() => {
        loadWalletBalances(walletAddress);
        fetchData(true);
      }, 5000);

    } catch (e: any) {
      console.error("[Swap] Failed:", e);
      const detail = parseSwapError(e);
      setSwapError(legs.length > 1 && completedSteps > 0
        ? `${completedSteps} of ${legs.length} steps confirmed. The rest was not completed; the token from the finished steps is in your wallet. ${detail}`
        : detail);
      setPendingSwapStep('IDLE');
    } finally {
      setSwapLoading(false);
    }
  };

  // Open the swap screen on a pair ("FROM|TO", registry keys; QUAI is native QUAI), as the Quainance list's Trade button does.
  const selectPair = (key: string) => {
    const [a, b] = key.split('|');
    if (!a || !b || !TOKEN_REGISTRY[a] || !TOKEN_REGISTRY[b]) return;
    const from = a === 'QUAI' ? 'WQUAI' : a;
    const to = b === 'QUAI' ? 'WQUAI' : b;
    if (from === to) return;
    setImpactAck(false);
    setPair({ from, to });
    setForcedRouteId(null);
    setNativeQuaiSide(a === 'QUAI' ? 'FROM' : b === 'QUAI' ? 'TO' : null);
    setSwapAmountIn('');
    setSwapError(null);
    setSwapTxHash(null);
  };

  const handleImportedToken = (token: TokenInfo) => {
    // The same contract may already be known (found in a pool): then there is nothing to add.
    const sameContract = tokenCatalog.find(candidate => candidate.address.toLowerCase() === token.address.toLowerCase());
    const existing = tokenCatalog.find(candidate => candidate.symbol.toLowerCase() === token.symbol.toLowerCase());
    if (!sameContract && existing && existing.address.toLowerCase() !== token.address.toLowerCase()) {
      setSwapError(`${token.symbol} is already used by another token in this app. Import it using its existing contract or choose a token with a different symbol.`);
      setImportTokenOpen(false);
      return;
    }
    if (!sameContract) setCustomTokens(tokens => [...tokens, token]);
    setImportTokenOpen(false);
    setSwapError(null);
  };

  // Choosing a token never fails: any token can be paid or received, and if no pool connects the pair the screen says so.
  const selectToken = (side: 'FROM' | 'TO', symbol: string) => {
    const native = symbol === 'QUAI';
    const key = native ? 'WQUAI' : symbol;
    if (!TOKEN_REGISTRY[key]) return;
    const other = side === 'FROM' ? pair.to : pair.from;
    setImpactAck(false);
    setForcedRouteId(null);
    setSwapAmountIn('');
    setSwapError(null);
    setSwapTxHash(null);
    if (key === other) {
      const otherSide = side === 'FROM' ? 'TO' : 'FROM';
      // QUAI and WQUAI are one asset, and wrapping is not a swap: say so instead of quoting a swap of a token for itself.
      if (key === 'WQUAI' && native !== (nativeQuaiSide === otherSide)) {
        setSwapError('QUAI and WQUAI are the same asset. Choose a different token to swap with.');
        return;
      }
      // Picking the token already on the other side turns the pair around.
      setPair(p => ({ from: p.to, to: p.from }));
      setNativeQuaiSide(current => current === 'FROM' ? 'TO' : current === 'TO' ? 'FROM' : null);
      return;
    }
    setPair(side === 'FROM' ? { from: key, to: pair.to } : { from: pair.from, to: key });
    setNativeQuaiSide(current => native ? side : current === side ? null : current);
  };

  const formatAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const formatUnits = (valStr: string) => {
    return (Number(valStr) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  if (loading) {
    return (
      <div className="loader-container">
        <div className="loader" style={{ borderColor: 'rgba(255, 51, 68, 0.2)', borderTopColor: 'var(--accent-plasma)' }}></div>
        <p style={{ fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--accent-plasma)' }}>
          Loading Circleswap Protocol on Cyprus-1...
        </p>
      </div>
    );
  }

  const wquaiPrice = lpWquai ? (Number(lpWquai.reserve1) / Number(lpWquai.reserve0)) : 0;
  const bossPrice = lpBoss ? (Number(lpBoss.reserve1) / Number(lpBoss.reserve0)) : 0;

  return (
    <div className="app-container">
      {/* Top Header */}
      <header>
        <div className="brand-section">
          <img 
            src={`${import.meta.env.BASE_URL}QgoGIF.gif`} 
            className="brand-logo" 
            alt="Circleswap Logo" 
            style={{ borderRadius: '50%', width: '48px', height: '48px', objectFit: 'cover', border: '1px solid rgba(255, 51, 68, 0.5)' }} 
          />
          <div className="brand-title">
            <h1 style={{ background: 'linear-gradient(90deg, #ffffff 0%, var(--accent-plasma) 50%, var(--accent-violet) 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              CIRCLESWAP
            </h1>
            <p style={{ color: 'var(--accent-plasma)' }}>Swap, earn and stake on Quai</p>
          </div>
        </div>

        <div className="wallet-section">
          <div className="network-status">
            <div className="status-dot"></div>
            <span className="status-text">Quai network</span>
          </div>

          {walletAddress ? (
            <div className="wallet-connected-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span className="gas-chip" style={{ fontSize: '0.8rem', background: 'rgba(255,255,255,0.05)', padding: '0.4rem 0.75rem', borderRadius: '8px', border: '1px solid var(--panel-border)', color: 'var(--accent-gold)', fontWeight: 600 }}>
                Gas: {quaiBalance} QUAI
              </span>
              <button className="btn-primary btn-wallet-connected">
                <Wallet size={16} />
                <span>{formatAddr(walletAddress)}</span>
              </button>
            </div>
          ) : (
            <button className="btn-primary" onClick={connectWallet} disabled={walletLoading}>
              <Wallet size={16} />
              <span>{walletLoading ? 'Connecting...' : 'Connect Wallet'}</span>
            </button>
          )}

          <button 
            className="btn-primary" 
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--panel-border)', color: 'var(--text-main)', boxShadow: 'none', padding: '0.6rem 0.8rem' }}
            onClick={() => fetchData(true)}
            disabled={refreshing}
          >
            <RefreshCw size={16} className={refreshing ? 'loader' : ''} style={{ animationDuration: '2s' }} />
          </button>
        </div>
      </header>

      {/* Primary Navigation Tabs */}
      <PrimaryNav
        active={activeTab}
        onNavigate={navigateToTab}
        items={[
          { id: 'SWAP', label: 'Swap', icon: <ArrowUpDown size={16} /> },
          { id: 'FARMS', label: 'Farms & Pools', icon: <TrendingUp size={16} /> },
          { id: 'QRB', label: 'Qrb Genesis', icon: <Sparkles size={16} /> },
          { id: 'ANALYTICS', label: 'Analytics & Ledger', icon: <Activity size={16} /> },
          { id: 'PAIRS', label: 'Pairs & Liquidity', icon: <Layers size={16} /> },
          ...(deployVisible ? [{ id: 'DEPLOY' as const, label: 'Deploy', icon: <Rocket size={16} /> }] : [])
        ]}
      />

      {/* Multi-Token Portfolio Ticker: scrolls by itself (no scrollbar); pauses while hovered or focused */}
      {walletAddress && (() => {
        // Curated and imported tokens always; a token only found in a pool only when this wallet holds some of it.
        const owned = tokenCatalog.filter(t => t.deployed !== false && (!t.discovered || (rawBalances[t.symbol] !== undefined && rawBalances[t.symbol] !== '0')));
        const chips = owned.map(t => {
          const bal = getBalanceForToken(t.symbol);
          const liveMetadata = contractMetadata[t.address.toLowerCase()];
          return (
            <div
              className="portfolio-chip"
              key={t.symbol}
              title={`${liveMetadata?.name ?? t.name} · ${t.isNative ? 'Native Cyprus-1 asset' : t.address} · ${liveMetadata?.decimals ?? t.decimals} decimals`}
            >
              <TokenBubble token={t} metadata={liveMetadata} size="xs" />
              <span className="portfolio-chip-symbol">{liveMetadata?.symbol ?? t.symbol}</span>
              <span className="portfolio-chip-balance">{bal}</span>
            </div>
          );
        });
        // A short list fits on screen and stays still; a long one loops seamlessly (the second copy is hidden from
        // assistive tech so every balance is read once).
        const loops = chips.length >= 6;
        return (
          <div className={`portfolio-ticker${loops ? ' is-looping' : ''}`} role="group" aria-label="Wallet balances" tabIndex={loops ? 0 : undefined}>
            <div className="portfolio-track" style={loops ? ({ '--portfolio-duration': `${Math.max(30, chips.length * 4)}s` } as React.CSSProperties) : undefined}>
              <div className="portfolio-group">{chips}</div>
              {loops && <div className="portfolio-group" aria-hidden="true">{chips}</div>}
            </div>
          </div>
        );
      })()}

      {/* Each tab fails on its own: the navigation above stays usable if one section throws. `key` resets it on every tab change. */}
      <SectionBoundary key={activeTab} label={`The ${activeTab.toLowerCase()} section`}>
      {/* TAB 5: ALL PAIRS & LIQUIDITY */}
      {activeTab === 'PAIRS' && (
        <>
          <PairsPage onOpenLiquidity={() => setPoolModalOpen(true)} />
          {/* Quainance DEX: every factory pair and every launchpad market (Hartii incl. QAXE), by default */}
          <QuainanceMarkets
            agg={quainanceAgg}
            stale={Boolean(quainanceTvl?.stale)}
            loading={loading}
            catalog={quainanceCatalog}
            quaiUsd={quaiUsdNow}
            tradeRouteFor={pool => {
              // The swap screen picks the best way itself, so a Trade button only needs the pair: "FROM|TO" (QUAI is native
              // QUAI, which is what a pool against WQUAI is normally traded with).
              const a = getTokenByAddress(pool.token0.address);
              const b = getTokenByAddress(pool.token1.address);
              if (!a || !b || a.deployed === false || b.deployed === false || a.isNative || b.isNative) return null;
              if (b.symbol === 'WQUAI') return `QUAI|${a.symbol}`;
              if (a.symbol === 'WQUAI') return `QUAI|${b.symbol}`;
              return `${a.symbol}|${b.symbol}`;
            }}
            onTrade={pairKey => {
              selectPair(pairKey);
              navigateToTab('SWAP');
            }}
          />
        </>
      )}

      {/* TAB 6: DEPLOYMENT (lazy: carries the contracts' bytecode; administrator only) */}
      {deployVisible && activeTab === 'DEPLOY' && (
        <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center' }}>Loading deployment tools…</div>}>
          <DeployPage
            walletAddress={walletAddress}
            onConnect={connectWallet}
            pools={allPools}
            onOpenLiquidity={() => setPoolModalOpen(true)}
          />
        </Suspense>
      )}

      {/* TAB 1: SWAP MODULE */}
      {activeTab === 'SWAP' && (
        <div className="swap-page-shell">
          <div className="glass-card swap-card uniswap-swap-card" style={{ borderColor: 'rgba(255, 51, 68, 0.25)' }}>
            <div className="swap-card-heading">
              <div>
                <div className="swap-eyebrow hide-sm">Quai network</div>
                <div className="swap-title"><ArrowUpDown size={20} style={{ color: 'var(--accent-plasma)' }} /> Swap</div>
              </div>
              <button type="button" className="swap-settings-button" title="Swap settings" onClick={() => document.getElementById('swap-settings')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>•••</button>
            </div>

            <div className="swap-route-summary">
              <div>
                <span className="swap-summary-label">{active ? 'Best price via' : 'No way to swap yet'}</span>
                <strong>{active ? pathLabel(active.path) : `${tokenLabel(fromSymbol)} → ${tokenLabel(toSymbol)}`}</strong>
              </div>
              <button type="button" className="swap-route-button" onClick={() => document.getElementById('route-options')?.toggleAttribute('open')}>
                <span>{active ? (routeSteps > 1 ? `${routeSteps} steps` : routeDexLabels) : 'Options'}</span><span>⌄</span>
              </button>
            </div>

            <details id="route-options" className="swap-route-options">
              <summary>Choose another way to swap</summary>
              <div className="pool-selector-tabs swap-route-grid">
                {candidates.slice(0, 6).map(c => (
                  <button
                    key={c.id}
                    className={`pool-tab-btn ${active?.id === c.id ? 'active' : ''}`}
                    onClick={() => { setForcedRouteId(c.id); setImpactAck(false); }}
                    title={`${pathLabel(c.path)} through ${[...new Set(c.legs.map(leg => (leg.kind === 'AMM' ? DEXES[leg.dex].label : 'a launch curve')))].join(', then ')}. ${c.segmentCount === 1 ? 'One transaction' : `${c.segmentCount} transactions`}.`}
                  >
                    {pathLabel(c.path)}
                    <small style={{ display: 'block' }}>
                      {[...new Set(c.legs.map(leg => (leg.kind === 'AMM' ? DEXES[leg.dex].label : 'Launch curve')))].join(' → ')}
                      {' · '}{c.segmentCount === 1 ? '1 transaction' : `${c.segmentCount} transactions`}
                    </small>
                    <small style={{ display: 'block' }}>{formatBaseUnits(c.quote.amountOut, toTokenDecimals, 4)} {tokenLabel(toSymbol)}{amountInWei && amountInWei > 0n ? '' : ` for 1 ${tokenLabel(fromSymbol)}`}</small>
                  </button>
                ))}
                {candidates.length === 0 && <span className="dimmed-text">No way to swap this pair yet.</span>}
                <button className="pool-tab-btn route-create-button" onClick={() => setPoolModalOpen(true)} title="Create a new pool or add liquidity to an existing one">
                  + Create Pool
                </button>
              </div>
            </details>

            {noRouteText && (
              <div role="status" style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.35)', color: 'var(--accent-amber, #f59e0b)', padding: '0.7rem 0.85rem', borderRadius: '10px', fontSize: '0.78rem', lineHeight: 1.4, marginBottom: '1rem' }}>
                {noRouteText}{' '}
                {!connected && (
                  <button type="button" onClick={() => setPoolModalOpen(true)} style={{ background: 'transparent', border: 0, padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>
                    Add liquidity
                  </button>
                )}
              </div>
            )}

            {active && routeSteps > 1 && (
              <div style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.35)', color: 'var(--accent-amber, #f59e0b)', padding: '0.7rem 0.85rem', borderRadius: '10px', fontSize: '0.76rem', lineHeight: 1.4, marginBottom: '1rem' }}>
                This swap takes {routeSteps} steps, one transaction each ({routeDexLabels}). After each step the token you receive arrives in your wallet before the next one is sent. If you stop part way, what you already received stays in your wallet.
              </div>
            )}

            {Object.values(dexState).some(report => report && report.state === 'MISMATCH') && (
              <div className="dimmed-text" style={{ marginBottom: '0.75rem', color: 'var(--accent-amber, #f59e0b)' }}>
                {Object.values(dexState).filter(report => report && report.state === 'MISMATCH').map(report => report!.detail).join(' ')}
              </div>
            )}

            {skippedPools > 0 && (
              <div className="dimmed-text" style={{ marginBottom: '0.75rem' }}>
                {skippedPools} pool{skippedPools === 1 ? ' was' : 's were'} left out because the details of a token in {skippedPools === 1 ? 'it' : 'them'} could not be read.
              </div>
            )}

            {/* Input In */}
            <div className="swap-input-group uniswap-token-input">
              <div className="swap-input-header">
                <span>You pay</span>
                {walletAddress && (
                  <span>
                    Balance: {getBalanceForToken(fromSymbol)}
                    {fromBalanceRaw !== undefined && BigInt(fromBalanceRaw) > 0n && (
                      <button
                        type="button"
                        onClick={() => handleAmountInChange(formatBaseUnits(BigInt(fromBalanceRaw), fromTokenDecimals, fromTokenDecimals))}
                        style={{ marginLeft: '0.5rem', background: 'transparent', border: '1px solid var(--panel-border)', color: 'var(--accent-plasma)', borderRadius: '4px', fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer', padding: '0 0.35rem' }}
                      >
                        MAX
                      </button>
                    )}
                  </span>
                )}
              </div>
              <div className="swap-input-row">
                <input 
                  type="text"
                  inputMode="decimal"
                  className="swap-field" 
                  placeholder="0.0" 
                  value={swapAmountIn}
                  onChange={(e) => handleAmountInChange(e.target.value)}
                />
                <TokenPicker value={fromSymbol} tokens={pickerTokens} metadata={contractMetadata} metadataStatus={contractMetadataStatus} balanceOf={pickerBalanceOf} decimalsOf={pickerDecimalsOf} importedAddresses={importedAddresses} onRefresh={refreshTokenMetadata} refreshing={tokenMetadataRefreshing} onImport={openImport} onChange={symbol => selectToken('FROM', symbol)} />
              </div>
              <div className="swap-usd" aria-live="polite">{usdText(swapAmountIn, fromSymbol)}</div>
            </div>

            {/* Middle Switch Arrow */}
            <div className="swap-arrow-container">
              <button className="swap-arrow-btn" onClick={toggleSwapDirection}>
                <ArrowUpDown size={16} />
              </button>
            </div>

            {/* Input Out */}
            <div className="swap-input-group uniswap-token-input">
              <div className="swap-input-header">
                <span>You receive</span>
                {walletAddress && (
                  <span>
                    Balance: {getBalanceForToken(toSymbol)}
                  </span>
                )}
              </div>
              <div className="swap-input-row">
                <input 
                  type="text"
                  className="swap-field" 
                  placeholder="0.0" 
                  value={swapAmountOut}
                  readOnly 
                />
                <TokenPicker value={toSymbol} tokens={pickerTokens} metadata={contractMetadata} metadataStatus={contractMetadataStatus} balanceOf={pickerBalanceOf} decimalsOf={pickerDecimalsOf} importedAddresses={importedAddresses} onRefresh={refreshTokenMetadata} refreshing={tokenMetadataRefreshing} onImport={openImport} onChange={symbol => selectToken('TO', symbol)} />
              </div>
              <div className="swap-usd" aria-live="polite">{usdText(swapAmountOut, toSymbol)}</div>
            </div>

            {/* Detail Sheet */}
            <div id="swap-settings" className="swap-details">
              <div className="swap-detail-row">
                <span className="swap-detail-label">Price</span>
                <span className="swap-detail-value">{execPrice} {tokenLabel(toSymbol)} per {tokenLabel(fromSymbol)}</span>
              </div>
              <div className="swap-detail-row">
                <span className="swap-detail-label">Effect on price</span>
                <span className={`swap-detail-value ${
                  parseFloat(priceImpact) < 1 ? 'impact-green' : (parseFloat(priceImpact) < 5 ? 'impact-orange' : 'impact-red')
                }`}>{priceImpact}</span>
              </div>
              <div className="swap-detail-row">
                <span className="swap-detail-label">You get at least</span>
                <span className="swap-detail-value">{minReceived} {tokenLabel(toSymbol)}</span>
              </div>
              <div className="swap-detail-row" style={{ alignItems: 'center' }}>
                <span className="swap-detail-label" title="How far the price may move against you before the swap is cancelled">Allowed price change</span>
                <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                  {[0.1, 0.5, 1.0, 2.0].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      style={{
                        background: slippage === preset ? 'rgba(255, 51, 68, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                        border: slippage === preset ? '1px solid var(--accent-plasma)' : '1px solid var(--panel-border)',
                        color: slippage === preset ? 'var(--accent-plasma)' : 'var(--text-muted)',
                        borderRadius: '4px',
                        padding: '0.15rem 0.4rem',
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.2s ease'
                      }}
                      onClick={() => {
                        setSlippage(preset);
                        setTimeout(() => handleAmountInChange(swapAmountIn), 10);
                      }}
                    >
                      {preset}%
                    </button>
                  ))}
                  <input 
                    type="number" 
                    min={0}
                    max={50}
                    step={0.1}
                    value={slippage} 
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      setSlippage(clampSlippagePct(val));
                      setTimeout(() => handleAmountInChange(swapAmountIn), 10);
                    }}
                    style={{ background: 'transparent', border: '1px solid var(--panel-border)', borderRadius: '4px', width: '45px', color: 'inherit', fontSize: '0.75rem', textAlign: 'center', outline: 'none', marginLeft: '0.25rem' }}
                  />
                  <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>%</span>
                </div>
              </div>
            </div>

            {/* Progress: the approval, then the swap, for each step of the route */}
            {pendingSwapStep === 'APPROVING' && (
              <div style={{ background: 'rgba(0, 242, 254, 0.05)', border: '1px solid rgba(0, 242, 254, 0.15)', padding: '1rem', borderRadius: '14px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div className="loader" style={{ width: '24px', height: '24px', borderWidth: '2px', margin: 0 }}></div>
                <div style={{ fontSize: '0.8rem' }}>
                  <strong>{swapStep.total > 1 ? `Step ${swapStep.index + 1} of ${swapStep.total}: allowing the swap…` : 'Allowing the swap…'}</strong>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>Confirm in your wallet to let the exchange take exactly the amount you are swapping. Nothing else can be taken.</div>
                </div>
              </div>
            )}

            {pendingSwapStep === 'SWAPPING' && (
              <div style={{ background: 'rgba(255, 51, 68, 0.08)', border: '1px solid rgba(255, 51, 68, 0.25)', padding: '1rem', borderRadius: '14px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div className="loader" style={{ width: '24px', height: '24px', borderWidth: '2px', margin: 0, borderColor: 'rgba(255, 51, 68, 0.2)', borderTopColor: 'var(--accent-plasma)' }}></div>
                <div style={{ fontSize: '0.8rem' }}>
                  <strong>{swapStep.total > 1 ? `Step ${swapStep.index + 1} of ${swapStep.total}: swapping…` : 'Swapping…'}</strong>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{routeDexLabels}</div>
                </div>
              </div>
            )}

            {/* Messages */}
            {swapTxHash && (
              <div style={{ background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.2)', padding: '0.75rem 1rem', borderRadius: '10px', fontSize: '0.8rem', color: 'var(--success)', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>Swap Successful!</strong>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>Tx: {formatAddr(swapTxHash)}</div>
                </div>
                <a href={`https://quaiscan.io/tx/${swapTxHash}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-neon)' }}>
                  <ExternalLink size={14} />
                </a>
              </div>
            )}

            {active && feeQuaiText && quote && (
              <div className="dimmed-text" style={{ marginBottom: '0.75rem', color: feesDominate ? 'var(--accent-amber, #f59e0b)' : undefined }}>
                Network fees: about {feeQuaiText} QUAI for {routeSteps === 1 ? 'this swap' : `these ${routeSteps} steps`}, paid separately in QUAI.
                {feesDominate && ' That is more than half of what you receive: a larger swap is usually better value.'}
              </div>
            )}
            {needsAck && (
              <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.8rem', color: 'var(--error)', marginBottom: '1rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={impactAck} onChange={e => setImpactAck(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                <span>
                  {needsImpactAck && <>This swap moves the price by {priceImpact}. The pool is small, so you will receive far less than the market rate. </>}
                  {needsUnverifiedAck && <>{unverifiedInRoute.map(tokenLabel).join(', ')} {unverifiedInRoute.length === 1 ? 'was' : 'were'} found in a pool and is not on this app&apos;s list: anyone can create a token with any name, so check the contract address in the token list before you trade. </>}
                  I understand and want to continue.
                </span>
              </label>
            )}
            {!swapError && amountParseError && (
              <div style={{ fontSize: '0.8rem', color: 'var(--error)', marginBottom: '1rem' }}>{amountParseError}</div>
            )}

            {swapError && (
              <div style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)', padding: '0.75rem 1rem', borderRadius: '10px', fontSize: '0.8rem', color: 'var(--error)', marginBottom: '1rem' }}>
                {swapError}
              </div>
            )}

            {/* Swap Button */}
            <button 
              className="btn-primary btn-swap-submit" 
              onClick={executeSwap}
              disabled={swapLoading || pendingSwapStep !== 'IDLE' || (!!walletAddress && (!active || insufficientBalance || !!amountParseError || (needsAck && !impactAck)))}
              style={{ justifyContent: 'center', background: 'linear-gradient(135deg, var(--accent-plasma) 0%, #8a2be2 100%)', color: '#fff' }}
            >
              {pendingSwapStep === 'APPROVING'
                ? 'Approving…'
                : pendingSwapStep === 'SWAPPING'
                ? 'Swapping…'
                : !walletAddress
                ? 'Connect Wallet to Swap'
                : !active
                ? 'No way to swap this pair yet'
                : insufficientBalance
                ? `Insufficient ${tokenLabel(fromSymbol)} balance`
                : 'Confirm Swap'}
            </button>
                <div className="swap-route-footer">
                  <span>{active ? (routeSteps > 1 ? `${routeSteps}-step route` : `${routeDexLabels} route`) : 'No route'}</span>
                  <span>{active ? pathLabel(active.path) : `${tokenLabel(fromSymbol)} → ${tokenLabel(toSymbol)}`}</span>
                </div>
          </div>
        </div>
      )}

      {/* TAB 2: FARMS & LIQUIDITY MINING */}
      {activeTab === 'FARMS' && (
        <FarmsPage
          walletAddress={walletAddress}
          onConnect={connectWallet}
          onOpenLiquidity={() => setPoolModalOpen(true)}
          boostLabel={farmBoostLabel}
        />
      )}

      {/* TAB 3: QRB 1-OF-1 GENESIS SOVEREIGN ARTIFACT */}
      {activeTab === 'QRB' && (
        <div>
          <div className="qrb-hero-container">
            {/* Holographic Containment Pod with QgoGIF */}
            <div className="qrb-artwork-pod">
              <div className="qrb-gif-viewport">
                <img src={`${import.meta.env.BASE_URL}QgoGIF.gif`} alt="Circleswap Qrb 1-of-1 Genesis Singularity" />
                <div style={{ position: 'absolute', bottom: 12, left: 12, background: 'rgba(0,0,0,0.7)', border: '1px solid rgba(255,51,68,0.4)', padding: '0.35rem 0.75rem', borderRadius: '8px', fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-plasma)', backdropFilter: 'blur(8px)' }}>
                  Singularity Core: Active
                </div>
              </div>
            </div>

            {/* Spec Sheet & Metadata */}
            <div className="qrb-spec-sheet">
              <div className="qrb-supply-badge">
                <Sparkles size={14} /> One of one &middot; Genesis
              </div>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.85rem', fontWeight: 800, color: '#fff', lineHeight: 1.2 }}>
                Circleswap Qrb Genesis
              </h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                Circleswap&apos;s one-of-one token. There will only ever be <strong>1.0 QRB</strong>. Hold at least <strong>{boostThresholdText} QRB</strong> for <strong>{boostDurationText}</strong> and you earn <strong>+{formatBoostPct()}</strong> on farm rewards. A matching 1-of-1 NFT is a collectible and does not change your rewards. The artwork is stored permanently on Arweave.
              </p>

              <div className="qrb-traits-grid">
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">Max Supply</div>
                  <div className="qrb-trait-val" style={{ color: 'var(--accent-plasma)' }}>1.0 QRB, ever</div>
                </div>
                <QrbMarketCards market={qrbMarket} />
                <div className="qrb-trait-card hide-sm">
                  <div className="qrb-trait-name">Core Catalyst</div>
                  <div className="qrb-trait-val">Radiant Dark Plasma</div>
                </div>
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">Comes as</div>
                  <div className="qrb-trait-val">Token + 1-of-1 NFT</div>
                </div>
                <div className="qrb-trait-card hide-sm">
                  <div className="qrb-trait-name">Stasis Pod</div>
                  <div className="qrb-trait-val">Class-IV Cryo Pod</div>
                </div>
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">Farm bonus</div>
                  <div className="qrb-trait-val" style={{ color: 'var(--accent-gold)' }}>+{formatBoostPct()} rewards</div>
                </div>
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">To earn the bonus</div>
                  <div className="qrb-trait-val">Hold {boostThresholdText} QRB for {boostDurationText}</div>
                </div>
                <div className="qrb-trait-card hide-sm">
                  <div className="qrb-trait-name">Network</div>
                  <div className="qrb-trait-val">Quai (Cyprus-1)</div>
                </div>
              </div>

              <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                {artworkHref ? (
                  <a
                    href={artworkHref}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-primary"
                    style={{ textDecoration: 'none', fontSize: '0.85rem', padding: '0.6rem 1.25rem', background: 'linear-gradient(135deg, var(--accent-plasma) 0%, #8a2be2 100%)', color: '#fff' }}
                  >
                    <ExternalLink size={15} /> View the artwork
                  </a>
                ) : (
                  <span className="btn-primary" style={{ fontSize: '0.85rem', opacity: 0.6, cursor: 'default', background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', boxShadow: 'none' }}>
                    Artwork: not yet uploaded to Arweave
                  </span>
                )}
              </div>

              {/* On-chain provenance: real addresses once deployed, an honest "not deployed" before */}
              <div style={{ marginTop: '1rem', display: 'grid', gap: '0.4rem', fontSize: '0.8rem' }}>
                {([['QRB token', DEPLOYED.QRB], ['Artifact NFT', DEPLOYED.QRB_NFT]] as const).map(([label, addr]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0.3rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}><Shield size={12} /> {label}</span>
                    {addr ? (
                      <a href={`https://quaiscan.io/address/${addr}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-neon)', fontFamily: 'monospace' }}>{formatAddr(addr)}</a>
                    ) : (
                      <span style={{ color: 'var(--accent-amber, #f59e0b)' }}>Not deployed</span>
                    )}
                  </div>
                ))}
                {walletAddress && DEPLOYED.QRB && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Your QRB</span>
                    <span>{getBalanceForToken('QRB')} {qrbBoostState === 'ACTIVE' ? `(boost +${formatBoostPct()} active)` : qrbBoostState === 'MATURING' ? `(boost starts in ${boostEligibleInText})` : '(below boost threshold)'}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: ANALYTICS & TRANSACTION LEDGER */}
      {activeTab === 'ANALYTICS' && <TokenAnalyticsPage latestBlock={latestBlock} pools={allPools} poolReserves={poolReserves} />}
      {showLegacyAnalytics() && activeTab === 'ANALYTICS' && (
        <div>
          {/* Stats Cards Row */}
          <div className="stats-grid">
            <div className="glass-card stat-card">
              <div className="stat-header">
                <span>TOKEN NAME</span>
                <Coins size={18} className="stat-icon" />
              </div>
              <div>
                <div className="stat-value">{q0Meta?.name}</div>
                <div className="stat-sub">
                  Symbol: {q0Meta?.symbol} | Decimals: {q0Meta?.decimals}
                </div>
              </div>
            </div>

            <div className="glass-card stat-card">
              <div className="stat-header">
                <span>TOTAL SUPPLY</span>
                <Activity size={18} className="stat-icon" />
              </div>
              <div>
                <div className="stat-value">
                  {q0Meta ? (Number(q0Meta.totalSupply) / 1e18).toLocaleString() : '1,000,000,000'}
                </div>
                <div className="stat-sub">Max cap locked in contract</div>
              </div>
            </div>

            <div className="glass-card stat-card">
              <div className="stat-header">
                <span>ACTIVE HOLDERS</span>
                <Users size={18} className="stat-icon" />
              </div>
              <div>
                <div className="stat-value">{holderCount}</div>
                <div className="stat-sub">Addresses holding Q0 tokens</div>
              </div>
            </div>

            <div className="glass-card stat-card">
              <div className="stat-header">
                <span>LATEST BLOCK</span>
                <Database size={18} className="stat-icon" />
              </div>
              <div>
                <div className="stat-value">#{latestBlock}</div>
                <div className="stat-sub">Cyprus-1 block height</div>
              </div>
            </div>

            <div className="glass-card stat-card">
              <div className="stat-header">
                <span>USD PRICE / MARKET CAP</span>
                <TrendingUp size={18} className="stat-icon" />
              </div>
              <div>
                <div className="stat-value">
                  {tokenDetail?.marketStats?.priceUsd ? `$${Number(tokenDetail.marketStats.priceUsd).toFixed(9)}` : '—'}
                </div>
                <div className="stat-sub">
                  MCap: {tokenDetail?.marketStats?.marketCapUsd ? `$${Number(tokenDetail.marketStats.marketCapUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
                </div>
              </div>
            </div>
          </div>

          {/* Main Panels Layout */}
          <div className="dashboard-sections">
            {/* Left Side: Liquidity Pools */}
            <div className="side-panel">
              <div className="glass-card">
                <h2 className="section-title">
                  <TrendingUp size={20} style={{ color: 'var(--accent-neon)' }} />
                  Quaiswap Liquidity Pools
                </h2>

                {/* Pool 1: Q0 / WQUAI */}
                <div style={{ marginBottom: '1.5rem', paddingBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="lp-header">
                    <div className="lp-title">
                      <span>Q0 / WQUAI LP</span>
                    </div>
                    <div className="lp-badges" style={{ alignItems: 'center', gap: '0.5rem' }}>
                      <span className="lp-badge lp-badge-address">{formatAddr(CONTRACTS.LP_WQUAI)}</span>
                      <button 
                        className="btn-primary" 
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: '8px', cursor: 'pointer' }}
                        onClick={() => {
                          selectPair('Q0|WQUAI');
                          setActiveTab('SWAP');
                        }}
                      >
                        <ArrowUpDown size={12} /> Swap WQUAI
                      </button>
                    </div>
                  </div>
                  <div className="lp-reserves-row">
                    <div className="lp-reserve-box">
                      <div className="lp-reserve-label">Q0 Reserve</div>
                      <div className="lp-reserve-value">{lpWquai ? formatUnits(lpWquai.reserve0) : '0'}</div>
                    </div>
                    <div className="lp-reserve-box">
                      <div className="lp-reserve-label">WQUAI Reserve</div>
                      <div className="lp-reserve-value">{lpWquai ? formatUnits(lpWquai.reserve1) : '0'}</div>
                    </div>
                  </div>
                  <div className="lp-price-metric">
                    <span className="lp-price-label">Token Exchange Rate</span>
                    <span className="lp-price-value">
                      1 Q0 = {wquaiPrice.toFixed(8)} WQUAI &nbsp;|&nbsp; 1 WQUAI = {wquaiPrice > 0 ? (1/wquaiPrice).toLocaleString(undefined, { maximumFractionDigits: 2 }) : 0} Q0
                    </span>
                  </div>
                </div>

                {/* Pool 2: Q0 / BOSS */}
                <div style={{ marginBottom: '1.5rem', paddingBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="lp-header">
                    <div className="lp-title">
                      <span>Q0 / BOSS LP</span>
                    </div>
                    <div className="lp-badges" style={{ alignItems: 'center', gap: '0.5rem' }}>
                      <span className="lp-badge lp-badge-address">{formatAddr(CONTRACTS.LP_BOSS)}</span>
                      <button 
                        className="btn-primary" 
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: '8px', cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent-violet) 0%, #a855f7 100%)', color: '#fff' }}
                        onClick={() => {
                          selectPair('Q0|BOSS');
                          setActiveTab('SWAP');
                        }}
                      >
                        <ArrowUpDown size={12} /> Swap Q0 / BOSS
                      </button>
                    </div>
                  </div>
                  <div className="lp-reserves-row">
                    <div className="lp-reserve-box">
                      <div className="lp-reserve-label">Q0 Reserve</div>
                      <div className="lp-reserve-value">{lpBoss ? formatUnits(lpBoss.reserve0) : '0'}</div>
                    </div>
                    <div className="lp-reserve-box">
                      <div className="lp-reserve-label">BOSS Reserve</div>
                      <div className="lp-reserve-value">{lpBoss ? formatUnits(lpBoss.reserve1) : '0'}</div>
                    </div>
                  </div>
                  <div className="lp-price-metric">
                    <span className="lp-price-label">Token Exchange Rate</span>
                    <span className="lp-price-value">
                      1 Q0 = {bossPrice.toFixed(5)} BOSS &nbsp;|&nbsp; 1 BOSS = {bossPrice > 0 ? (1/bossPrice).toLocaleString(undefined, { maximumFractionDigits: 2 }) : 0} Q0
                    </span>
                  </div>
                </div>

                {/* Pool 3: BOSS / QUAI (Multi-Hop) */}
                <div>
                  <div className="lp-header">
                    <div className="lp-title">
                      <span>BOSS / QUAI (Routed)</span>
                    </div>
                    <div className="lp-badges" style={{ alignItems: 'center', gap: '0.5rem' }}>
                      <span className="lp-badge lp-badge-address">Multi-Hop LP</span>
                      <button 
                        className="btn-primary" 
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: '8px', cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent-gold) 0%, #f59e0b 100%)', color: '#000' }}
                        onClick={() => {
                          selectPair('BOSS|WQUAI');
                          setActiveTab('SWAP');
                        }}
                      >
                        <ArrowUpDown size={12} /> Swap BOSS / QUAI
                      </button>
                    </div>
                  </div>
                  <div className="lp-reserves-row">
                    <div className="lp-reserve-box">
                      <div className="lp-reserve-label">BOSS Reserve (LP 2)</div>
                      <div className="lp-reserve-value">{lpBoss ? formatUnits(lpBoss.reserve1) : '0'}</div>
                    </div>
                    <div className="lp-reserve-box">
                      <div className="lp-reserve-label">WQUAI Reserve (LP 1)</div>
                      <div className="lp-reserve-value">{lpWquai ? formatUnits(lpWquai.reserve1) : '0'}</div>
                    </div>
                  </div>
                  <div className="lp-price-metric">
                    <span className="lp-price-label">Cross-Pair Rate</span>
                    <span className="lp-price-value">
                      1 BOSS = {(wquaiPrice > 0 ? (bossPrice / wquaiPrice) : 0).toFixed(6)} WQUAI &nbsp;|&nbsp; 1 WQUAI = {(bossPrice > 0 ? (wquaiPrice / bossPrice) : 0).toFixed(2)} BOSS
                    </span>
                  </div>
                </div>
              </div>


            </div>

            {/* Right Side: Top Holders & Transaction Ledger */}
            <div className="side-panel">
              {/* Top Holders */}
              <div className="glass-card">
                <h2 className="section-title">
                  <Award size={20} style={{ color: 'var(--accent-gold)' }} />
                  Top Token Holders
                </h2>

                <div className="holders-list">
                  {topHolders.map((holder, index) => (
                    <div className="holder-row" key={holder.address}>
                      <div className="holder-info">
                        <span className="holder-rank">#{index + 1}</span>
                        <span className="holder-address">{formatAddr(holder.address)}</span>
                        {holder.address.toLowerCase() === CONTRACTS.LP_WQUAI.toLowerCase() && (
                          <span className="lp-badge" style={{ background: 'rgba(0, 242, 254, 0.08)', color: 'var(--accent-neon)', border: '1px solid rgba(0, 242, 254, 0.15)', fontSize: '0.6rem' }}>LP 1</span>
                        )}
                        {holder.address.toLowerCase() === CONTRACTS.LP_BOSS.toLowerCase() && (
                          <span className="lp-badge" style={{ background: 'rgba(138, 43, 226, 0.08)', color: '#a855f7', border: '1px solid rgba(138, 43, 226, 0.15)', fontSize: '0.6rem' }}>LP 2</span>
                        )}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="holder-balance">{holder.balance} Q0</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>{holder.pct} of supply</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Ledger of Recent Transfers */}
              <div className="glass-card">
                <h2 className="section-title">
                  <Activity size={20} style={{ color: 'var(--accent-neon)' }} />
                  On-Chain Transaction Ledger
                </h2>

                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Tx Hash</th>
                        <th>From</th>
                        <th>To</th>
                        <th style={{ textAlign: 'right' }}>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transfers.slice(0, 10).map((tx, idx) => {
                        const isLpFrom = tx.from_addr.toLowerCase() === CONTRACTS.LP_WQUAI.toLowerCase() || tx.from_addr.toLowerCase() === CONTRACTS.LP_BOSS.toLowerCase();
                        const isLpTo = tx.to_addr.toLowerCase() === CONTRACTS.LP_WQUAI.toLowerCase() || tx.to_addr.toLowerCase() === CONTRACTS.LP_BOSS.toLowerCase();

                        return (
                          <tr key={`${tx.tx_hash}-${idx}`}>
                            <td>
                              <a
                                href={`https://explorer.qu.ai/tx/${tx.tx_hash}`}
                                target="_blank"
                                rel="noreferrer"
                                className="link-hash"
                              >
                                {formatAddr(tx.tx_hash)}
                              </a>
                            </td>
                            <td>
                              <span className={`address-badge ${isLpFrom ? 'lp' : ''}`}>
                                {isLpFrom ? 'LP Pair' : formatAddr(tx.from_addr)}
                              </span>
                            </td>
                            <td>
                              <span className={`address-badge ${isLpTo ? 'lp' : ''}`}>
                                {isLpTo ? 'LP Pair' : formatAddr(tx.to_addr)}
                              </span>
                            </td>
                            <td className="tx-value" style={{ textAlign: 'right', color: isLpFrom ? 'var(--success)' : (isLpTo ? 'var(--accent-neon)' : 'inherit') }}>
                              {(Number(tx.value) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })} Q0
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="dimmed-text">
                  Showing the latest 10 transfer events from block explorer.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer Info */}
      </SectionBoundary>

      <footer className="app-footer" style={{ marginTop: '3rem', paddingTop: '1.5rem', borderTop: '1px solid var(--panel-border)', display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-dim)', flexWrap: 'wrap', gap: '1rem' }}>
        <details className="footer-addresses">
          <summary>Token contracts</summary>
          <div>
            Q0: <a href={`https://quaiscan.io/token/${CONTRACTS.Q0}`} target="_blank" rel="noreferrer" className="link-hash">{CONTRACTS.Q0}</a>
          </div>
          <div>
            BDELTA: <a href={`https://quaiscan.io/token/${CONTRACTS.BDELTA}`} target="_blank" rel="noreferrer" className="link-hash">{CONTRACTS.BDELTA}</a>
          </div>
        </details>
        <div className="hide-sm">
          Circleswap on the Quai network
        </div>
        <a
          href="https://boltevm.com"
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'inherit', textDecoration: 'none' }}
        >
          <span>Powered by</span>
          <img
            src={`${import.meta.env.BASE_URL}Boltfont.png`}
            alt="BOLT"
            width={63}
            height={18}
            style={{ height: '18px', width: 'auto', filter: 'invert(1)', opacity: 0.8 }}
          />
        </a>
      </footer>

      {poolModalOpen && (
        <PoolModal
          walletAddress={walletAddress}
          rawBalances={rawBalances}
          pools={allPools}
          lpBalances={lpBalances}
          onConnect={connectWallet}
          onClose={() => setPoolModalOpen(false)}
          onDone={() => {
            fetchData(true);
            if (walletAddress) loadWalletBalances(walletAddress);
          }}
        />
      )}
      {importTokenOpen && (
        <ImportTokenModal
          initialAddress={importPrefill}
          onClose={() => { setImportTokenOpen(false); setImportPrefill(undefined); }}
          onImported={handleImportedToken}
        />
      )}
    </div>
  );
}
