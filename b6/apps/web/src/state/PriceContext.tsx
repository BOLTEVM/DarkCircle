import React, { createContext, useContext, useEffect, useState } from 'react';
import { fetchQuaiUsd, type UsdQuote } from '@darkquestate/core';

const Ctx = createContext<UsdQuote | null>(null);
const REFRESH_MS = 5 * 60_000;

/** QUAI/USD for display only. Null until fetched, and stays null if the source is unreachable. */
export const PriceProvider: React.FC<{ children: React.ReactNode; disabled?: boolean }> = ({ children, disabled = false }) => {
  const [quote, setQuote] = useState<UsdQuote | null>(null);
  useEffect(() => {
    if (disabled) return;
    let alive = true;
    const load = () =>
      fetchQuaiUsd().then((q) => {
        if (alive && q) setQuote(q);
      });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [disabled]);
  return <Ctx.Provider value={quote}>{children}</Ctx.Provider>;
};

export function useUsdQuote(): UsdQuote | null {
  return useContext(Ctx);
}
