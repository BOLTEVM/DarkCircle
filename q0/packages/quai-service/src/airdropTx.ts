// CircleswapAirdrop on the client: the calldata the admin dashboard and the claim page send, and one read of the contract's
// state. No wallet and no network in the encoders; the reader takes a batch function so tests can fake the chain.
//
// The encoders are held to the contract's own ABI in q0/packages/contracts/test/Airdrop.test.ts (calldata equality), so the
// page can never send something the contract would decode differently.

import { keccak256Bytes } from './keccak';
import type { BatchCall, BatchFn } from './pairs';

const selector = (signature: string): string => keccak256Bytes(new TextEncoder().encode(signature)).slice(0, 10);

const word = (n: bigint | number): string => {
    const v = BigInt(n);
    if (v < 0n || v >= 1n << 256n) throw new Error('A value does not fit in a uint256.');
    return v.toString(16).padStart(64, '0');
};
const addressWord = (a: string): string => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`Not an address: ${String(a).slice(0, 46)}`);
    return a.slice(2).toLowerCase().padStart(64, '0');
};
const bytes32Word = (h: string): string => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error('A hash must be 32 bytes of hex.');
    return h.slice(2).toLowerCase();
};

export const AIRDROP_SELECTORS = {
    setMerkleRoot: selector('setMerkleRoot(bytes32,uint256,uint256,uint64)'),
    claim: selector('claim(uint256,address,uint256,uint256,bytes32[])'),
    sweep: selector('sweep(address,address)'),
    isClaimed: selector('isClaimed(uint256)'),
    owner: selector('owner()'),
    pendingOwner: selector('pendingOwner()'),
    tokenA: selector('tokenA()'),
    tokenB: selector('tokenB()'),
    merkleRoot: selector('merkleRoot()'),
    totalA: selector('totalA()'),
    totalB: selector('totalB()'),
    claimDeadline: selector('claimDeadline()'),
    claimedA: selector('claimedA()'),
    claimedB: selector('claimedB()')
} as const;

/** The seconds the contract requires a claim window to last at the least (MIN_CLAIM_WINDOW). */
export const AIRDROP_MIN_CLAIM_WINDOW_SECONDS = 14 * 24 * 60 * 60;

export const airdropTx = {
    setMerkleRoot: (root: string, totalA: bigint, totalB: bigint, deadline: number | bigint): string =>
        AIRDROP_SELECTORS.setMerkleRoot + bytes32Word(root) + word(totalA) + word(totalB) + word(deadline),
    claim: (index: number | bigint, account: string, amountA: bigint, amountB: bigint, proof: readonly string[]): string =>
        AIRDROP_SELECTORS.claim +
        word(index) +
        addressWord(account) +
        word(amountA) +
        word(amountB) +
        word(0xa0) +
        word(proof.length) +
        proof.map(bytes32Word).join(''),
    sweep: (token: string, to: string): string => AIRDROP_SELECTORS.sweep + addressWord(token) + addressWord(to),
    isClaimedCall: (index: number | bigint): string => AIRDROP_SELECTORS.isClaimed + word(index)
};

export interface AirdropContractState {
    owner: string;
    pendingOwner: string | null;
    tokenA: string;
    tokenB: string;
    /** The all-zero hash until the owner sets the tree. */
    merkleRoot: string;
    rootSet: boolean;
    totalA: bigint;
    totalB: bigint;
    /** Unix seconds; 0 until the root is set. */
    claimDeadline: number;
    claimedA: bigint;
    claimedB: bigint;
    /** What the contract holds of each token now. */
    balanceA: bigint;
    balanceB: bigint;
}

const isWord = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const asAddress = (w: string): string => '0x' + w.slice(-40).toLowerCase();
const call = (to: string, data: string): BatchCall => ({ method: 'quai_call', params: [{ to, data }, 'latest'] });

/** Read the contract in one batch plus one for the two balances. Throws, naming the field, when something is unreadable. */
export async function readAirdropState(batch: BatchFn, contract: string): Promise<AirdropContractState> {
    const fields = ['owner', 'pendingOwner', 'tokenA', 'tokenB', 'merkleRoot', 'totalA', 'totalB', 'claimDeadline', 'claimedA', 'claimedB'] as const;
    const res = await batch(fields.map(f => call(contract, AIRDROP_SELECTORS[f])));
    const out: Record<string, string> = {};
    fields.forEach((f, i) => {
        const r = res[i];
        if (!r.ok || !isWord(r.value)) {
            // pendingOwner is allowed to be absent on a contract that predates it; everything else is required
            if (f === 'pendingOwner') {
                out[f] = '0x' + '0'.repeat(64);
                return;
            }
            throw new Error(`The airdrop contract did not answer ${f}(): is ${contract} the right address?`);
        }
        out[f] = r.value;
    });
    const tokenA = asAddress(out.tokenA);
    const tokenB = asAddress(out.tokenB);
    const holder = '0x70a08231' + contract.slice(2).toLowerCase().padStart(64, '0');
    const bal = await batch([call(tokenA, holder), call(tokenB, holder)]);
    if (!bal[0].ok || !isWord(bal[0].value) || !bal[1].ok || !isWord(bal[1].value)) throw new Error('Could not read the contract\'s token balances.');
    const zeroAddress = '0x' + '0'.repeat(40);
    const pending = asAddress(out.pendingOwner);
    const rootHex = out.merkleRoot.toLowerCase();
    return {
        owner: asAddress(out.owner),
        pendingOwner: pending === zeroAddress ? null : pending,
        tokenA,
        tokenB,
        merkleRoot: rootHex,
        rootSet: !/^0x0{64}$/.test(rootHex),
        totalA: BigInt(out.totalA),
        totalB: BigInt(out.totalB),
        claimDeadline: Number(BigInt(out.claimDeadline)),
        claimedA: BigInt(out.claimedA),
        claimedB: BigInt(out.claimedB),
        balanceA: BigInt(bal[0].value),
        balanceB: BigInt(bal[1].value)
    };
}

/** Whether an index has been paid. Throws when the node cannot answer, so "not claimed" is never a guess. */
export async function readIsClaimed(batch: BatchFn, contract: string, index: number): Promise<boolean> {
    const r = (await batch([call(contract, airdropTx.isClaimedCall(index))]))[0];
    if (!r.ok || !isWord(r.value)) throw new Error('Could not read whether this allocation was claimed.');
    return BigInt(r.value) !== 0n;
}
