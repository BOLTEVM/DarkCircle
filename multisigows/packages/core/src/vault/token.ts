import { erc20Interface } from './abi.js';
import { TokenInfo } from './risk.js';
import { sanitizeText } from './sanitize.js';
import { RpcLike, callAt } from './rpc.js';

/**
 * Symbol and decimals of an ERC-20, read from the token itself and sanitised (symbols are
 * attacker-chosen text). Null when the contract does not answer like a token.
 */
export async function readTokenInfo(rpc: RpcLike, token: string): Promise<TokenInfo | null> {
  try {
    const [symRaw, decRaw] = await Promise.all([
      callAt(rpc, token, erc20Interface.encodeFunctionData('symbol')),
      callAt(rpc, token, erc20Interface.encodeFunctionData('decimals')),
    ]);
    const symbol = sanitizeText(erc20Interface.decodeFunctionResult('symbol', symRaw)[0], 12);
    const decimals = Number(erc20Interface.decodeFunctionResult('decimals', decRaw)[0]);
    if (!symbol || !Number.isInteger(decimals) || decimals > 36) return null;
    return { symbol, decimals };
  } catch {
    return null;
  }
}
