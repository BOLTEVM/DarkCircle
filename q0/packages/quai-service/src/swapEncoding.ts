// Calldata for the Uniswap-V2-style router swap functions, as the Swap page sends them. `to` is the address that receives the
// output; it is validated here so a malformed value can never be packed into the wrong 32-byte slot.
//
//   swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)  0x38ed1739
//   swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)  payable             0x7ff36ab5
//   swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)    0x18cbafe5

const word = (n: bigint | number): string => {
    const v = BigInt(n);
    if (v < 0n || v >= 1n << 256n) throw new Error('A swap amount or deadline is out of range.');
    return v.toString(16).padStart(64, '0');
};

const addressWord = (what: string, a: string): string => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`${what} is not a 20-byte address.`);
    return a.slice(2).toLowerCase().padStart(64, '0');
};

const pathWords = (path: string[]): string => {
    if (path.length < 2) throw new Error('A swap path needs at least two tokens.');
    return word(path.length) + path.map((p, i) => addressWord(`Path token ${i + 1}`, p)).join('');
};

export function encodeSwapExactTokensForTokens(amountIn: bigint, amountOutMin: bigint, path: string[], to: string, deadline: bigint): string {
    return '0x38ed1739' + word(amountIn) + word(amountOutMin) + word(0xa0) + addressWord('The recipient', to) + word(deadline) + pathWords(path);
}

export function encodeSwapExactETHForTokens(amountOutMin: bigint, path: string[], to: string, deadline: bigint): string {
    return '0x7ff36ab5' + word(amountOutMin) + word(0x80) + addressWord('The recipient', to) + word(deadline) + pathWords(path);
}

export function encodeSwapExactTokensForETH(amountIn: bigint, amountOutMin: bigint, path: string[], to: string, deadline: bigint): string {
    return '0x18cbafe5' + word(amountIn) + word(amountOutMin) + word(0xa0) + addressWord('The recipient', to) + word(deadline) + pathWords(path);
}
