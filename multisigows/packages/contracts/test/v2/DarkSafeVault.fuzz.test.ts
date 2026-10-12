/**
 * Stateful differential fuzz test for DarkSafeVault.
 *
 * A small, independent model of the vault's rules (written from the spec, not from the
 * Solidity) predicts whether each random action must succeed or revert. The run fails on
 * the first disagreement, and after every step all observable state is compared:
 * owners, threshold, delay floor, nonce, and every transaction's status and valid approval
 * count. Seeds are deterministic; widen with FUZZ_SEEDS=1,2,3,... and FUZZ_STEPS=n.
 */
import { expect } from "chai";
import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Wallet } from "ethers";
import { DAY, MAX_DELAY, cyprusWallets, createVault, TxStatus, EXEC_GAS } from "./helpers.ts";

const { ethers, network } = hre;

const SEEDS = (process.env.FUZZ_SEEDS ?? "11,22,33").split(",").map(Number);
const STEPS = Number(process.env.FUZZ_STEPS ?? 150);
const MAX_OWNERS = 20;
const WINDOW = 30 * DAY;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Admin =
  | { kind: "addOwner"; owner: string; threshold: number }
  | { kind: "removeOwner"; owner: string; threshold: number }
  | { kind: "changeThreshold"; threshold: number }
  | { kind: "setMinExecutionDelay"; delay: number };

interface MTx {
  hash: string;
  proposer: string;
  admin: Admin | null;
  delay: number;
  expiration: number;
  approvedAt: number;
  executed: boolean;
  cancelled: boolean;
  expiredFlag: boolean;
  approvals: Map<string, number>;
}

const ADMIN = new ethers.Interface([
  "function addOwner(address,uint256)",
  "function removeOwner(address,uint256)",
  "function changeThreshold(uint256)",
  "function setMinExecutionDelay(uint32)",
]);

function encodeAdmin(a: Admin): string {
  switch (a.kind) {
    case "addOwner":
      return ADMIN.encodeFunctionData("addOwner", [a.owner, a.threshold]);
    case "removeOwner":
      return ADMIN.encodeFunctionData("removeOwner", [a.owner, a.threshold]);
    case "changeThreshold":
      return ADMIN.encodeFunctionData("changeThreshold", [a.threshold]);
    case "setMinExecutionDelay":
      return ADMIN.encodeFunctionData("setMinExecutionDelay", [a.delay]);
  }
}

describe("DarkSafeVault v2: stateful differential fuzz", function () {
  this.timeout(600_000);
  let pool: Wallet[];
  let recorder: any;

  before(async function () {
    pool = await cyprusWallets(8);
    recorder = await (await ethers.getContractFactory("CallRecorder")).deploy();
  });

  for (const seed of SEEDS) {
    it(`seed ${seed}: ${STEPS} random actions match the model`, async function () {
      const rand = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
      const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

      const initialOwners = pool.slice(0, 3).map((w) => w.address);
      const initialDelay = pick([0, 3600]);
      const { vault, address } = await createVault({ owners: initialOwners, threshold: 2, minDelay: initialDelay });
      const recorderAddr = await recorder.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // ---- model
      let owners = [...initialOwners];
      const epoch = new Map<string, number>();
      let threshold = 2;
      let minDelay = initialDelay;
      let nonce = 0;
      const txs: MTx[] = [];
      const ep = (a: string) => epoch.get(a) ?? 0;
      const isOwner = (a: string) => owners.includes(a);
      const valid = (t: MTx) => owners.filter((o) => t.approvals.get(o) === ep(o) + 1).length;
      const expired = (t: MTx, T: number) => t.expiredFlag || T > t.expiration;
      const log: string[] = [];

      function adminValid(a: Admin): boolean {
        const len = owners.length;
        switch (a.kind) {
          case "addOwner":
            return len < MAX_OWNERS && !isOwner(a.owner) && a.threshold >= 1 && a.threshold <= len + 1;
          case "removeOwner":
            return isOwner(a.owner) && len > 1 && a.threshold >= 1 && a.threshold <= len - 1;
          case "changeThreshold":
            return a.threshold >= 1 && a.threshold <= len;
          case "setMinExecutionDelay":
            return a.delay <= MAX_DELAY;
        }
      }
      function applyAdmin(a: Admin) {
        switch (a.kind) {
          case "addOwner":
            owners.push(a.owner);
            threshold = a.threshold;
            break;
          case "removeOwner":
            owners = owners.filter((o) => o !== a.owner);
            epoch.set(a.owner, ep(a.owner) + 1);
            threshold = a.threshold;
            break;
          case "changeThreshold":
            threshold = a.threshold;
            break;
          case "setMinExecutionDelay":
            minDelay = a.delay;
            break;
        }
      }
      function modelStatus(t: MTx, T: number): bigint {
        if (t.executed) return TxStatus.Executed;
        if (t.cancelled) return TxStatus.Cancelled;
        if (expired(t, T)) return TxStatus.Expired;
        if (valid(t) < threshold) return TxStatus.Pending;
        if (t.approvedAt === 0) return t.delay === 0 ? TxStatus.Executable : TxStatus.Timelocked;
        return T < t.approvedAt + t.delay ? TxStatus.Timelocked : TxStatus.Executable;
      }

      async function attempt(fn: () => Promise<any>): Promise<{ ok: boolean; receipt?: any; err?: string }> {
        try {
          const tx = await fn();
          return { ok: true, receipt: await tx.wait() };
        } catch (e: any) {
          return { ok: false, err: e?.shortMessage ?? e?.message };
        }
      }

      function mismatch(step: number, what: string, expected: unknown, actual: unknown): never {
        throw new Error(
          `seed ${seed} step ${step}: ${what}: model=${String(expected)} chain=${String(actual)}\n` + log.slice(-12).join("\n")
        );
      }

      for (let step = 0; step < STEPS; step++) {
        const T = (await time.latest()) + pick([1, 1, 30, 600, 3600, DAY / 2, 2 * DAY]);
        await time.setNextBlockTimestamp(T);
        // Biased toward current owners and live transactions so the run reaches deep states;
        // non-owners and dead transactions still come up often enough to test the rejections.
        const byAddress = new Map(pool.map((w) => [w.address, w]));
        const caller = rand() < 0.75 ? byAddress.get(pick(owners))! : pick(pool);
        const roll = rand();
        const live = txs.filter((t) => !t.executed && !t.cancelled && !expired(t, T));
        const open = live.length > 0 && rand() < 0.8 ? pick(live) : txs.length > 0 ? pick(txs) : null;

        let expectedOk: boolean;
        let result: Awaited<ReturnType<typeof attempt>>;
        let describe: string;

        if (roll < 0.22 || !open) {
          // propose an external call or an admin self-call
          // Admin ops are mostly valid for the current state (so they can execute), sometimes not.
          const isAdmin = rand() < 0.4;
          const len = owners.length;
          const nonOwners = pool.map((w) => w.address).filter((a) => !isOwner(a));
          const admin: Admin | null = isAdmin
            ? pick<() => Admin>([
                () => ({ kind: "changeThreshold", threshold: randInt(1, len + 1) }),
                () => ({
                  kind: "addOwner",
                  owner: nonOwners.length && rand() < 0.85 ? pick(nonOwners) : pick(pool).address,
                  threshold: randInt(1, len + 2),
                }),
                () => ({
                  kind: "removeOwner",
                  owner: rand() < 0.85 ? pick(owners) : pick(pool).address,
                  threshold: randInt(1, Math.max(1, len - 1)),
                }),
                () => ({ kind: "setMinExecutionDelay", delay: pick([0, 60, 3600, 3600, MAX_DELAY + 1]) }),
              ])()
            : null;
          const requested = pick([0, 0, 60, 3600, 2 * DAY]);
          const delay = admin ? 0 : Math.max(minDelay, requested);
          const offset = pick([-5, 0, 1, 3600, 7 * DAY, 7 * DAY, WINDOW, WINDOW + 1]);
          const expiration = Math.max(0, T + delay + offset);
          const to = admin ? address : recorderAddr;
          const data = admin ? encodeAdmin(admin) : recorder.interface.encodeFunctionData("record", [ethers.toBeHex(step, 4)]);
          const gasLimit = admin ? 0n : 200_000n;
          expectedOk = isOwner(caller.address) && offset > 0 && offset <= WINDOW;
          describe = `propose ${admin ? admin.kind : "external"} by ${caller.address.slice(0, 8)} delay=${delay} offset=${offset}`;
          result = await attempt(() =>
            vault.connect(caller).proposeTransaction(to, 0, data, gasLimit, expiration, admin ? 0 : requested)
          );
          if (result.ok !== expectedOk) mismatch(step, describe, expectedOk, result.ok);
          if (result.ok) {
            const ev = result.receipt.logs.map((l: any) => vault.interface.parseLog(l)).find((l: any) => l?.name === "TransactionProposed");
            const expectedHash = ethers.keccak256(
              ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "uint256", "address", "uint256", "bytes32", "uint64", "uint64", "uint32", "uint256"],
                [address, chainId, to, 0, ethers.keccak256(data), gasLimit, expiration, delay, nonce]
              )
            );
            if (ev.args.txHash !== expectedHash) mismatch(step, "tx hash formula", expectedHash, ev.args.txHash);
            nonce++;
            const t: MTx = {
              hash: ev.args.txHash,
              proposer: caller.address,
              admin,
              delay,
              expiration,
              approvedAt: 0,
              executed: false,
              cancelled: false,
              expiredFlag: false,
              approvals: new Map([[caller.address, ep(caller.address) + 1]]),
            };
            if (valid(t) >= threshold) t.approvedAt = T;
            txs.push(t);
          }
        } else if (roll < 0.45) {
          const t = open;
          expectedOk =
            isOwner(caller.address) &&
            !t.executed &&
            !t.cancelled &&
            !expired(t, T) &&
            t.approvals.get(caller.address) !== ep(caller.address) + 1;
          describe = `approve ${t.hash.slice(0, 10)} by ${caller.address.slice(0, 8)}`;
          result = await attempt(() => vault.connect(caller).approveTransaction(t.hash));
          if (result.ok !== expectedOk) mismatch(step, describe, expectedOk, result.ok);
          if (result.ok) {
            t.approvals.set(caller.address, ep(caller.address) + 1);
            if (t.approvedAt === 0 && valid(t) >= threshold) t.approvedAt = T;
          }
        } else if (roll < 0.53) {
          const t = open;
          expectedOk =
            isOwner(caller.address) && !t.executed && !t.cancelled && t.approvals.get(caller.address) === ep(caller.address) + 1;
          describe = `revoke ${t.hash.slice(0, 10)} by ${caller.address.slice(0, 8)}`;
          result = await attempt(() => vault.connect(caller).revokeApproval(t.hash));
          if (result.ok !== expectedOk) mismatch(step, describe, expectedOk, result.ok);
          if (result.ok) t.approvals.delete(caller.address);
        } else if (roll < 0.8) {
          const t = open;
          let clockOnly = false;
          let startsClock = false;
          expectedOk = isOwner(caller.address) && !t.executed && !t.cancelled && !expired(t, T) && valid(t) >= threshold;
          if (expectedOk && t.approvedAt === 0) {
            startsClock = true;
            clockOnly = t.delay > 0;
          }
          const approvedAt = startsClock ? T : t.approvedAt;
          if (expectedOk && !clockOnly && T < approvedAt + t.delay) expectedOk = false;
          if (expectedOk && !clockOnly && t.admin && !adminValid(t.admin)) expectedOk = false;
          describe = `execute ${t.admin ? t.admin.kind : "external"} ${t.hash.slice(0, 10)} by ${caller.address.slice(0, 8)}`;
          result = await attempt(() => vault.connect(caller).executeTransaction(t.hash, EXEC_GAS));
          if (result.ok !== expectedOk) mismatch(step, describe, expectedOk, result.ok);
          if (result.ok) {
            if (startsClock) t.approvedAt = T;
            const names = result.receipt.logs.map((l: any) => vault.interface.parseLog(l)?.name);
            const ran = names.includes("TransactionExecuted");
            if (ran === clockOnly) mismatch(step, `${describe} ran`, !clockOnly, ran);
            if (!clockOnly) {
              t.executed = true;
              if (t.admin) applyAdmin(t.admin);
            }
          }
        } else if (roll < 0.88) {
          const t = open;
          expectedOk = isOwner(caller.address) && caller.address === t.proposer && t.approvedAt === 0 && !t.executed && !t.cancelled;
          describe = `cancel ${t.hash.slice(0, 10)} by ${caller.address.slice(0, 8)}`;
          result = await attempt(() => vault.connect(caller).cancelTransaction(t.hash));
          if (result.ok !== expectedOk) mismatch(step, describe, expectedOk, result.ok);
          if (result.ok) t.cancelled = true;
        } else if (roll < 0.95) {
          const t = open;
          expectedOk = !t.executed && !t.cancelled && !t.expiredFlag && T > t.expiration;
          describe = `expire ${t.hash.slice(0, 10)}`;
          result = await attempt(() => vault.connect(caller).expireTransaction(t.hash));
          if (result.ok !== expectedOk) mismatch(step, describe, expectedOk, result.ok);
          if (result.ok) t.expiredFlag = true;
        } else {
          describe = "advance time";
          await network.provider.send("evm_mine", []);
        }
        log.push(`#${step} T=${T} ${describe}`);

        // ---- compare every observable against the model
        const now = await time.latest();
        const chainOwners: string[] = [...(await vault.getOwners())];
        if ([...chainOwners].sort().join() !== [...owners].sort().join()) mismatch(step, "owners", owners, chainOwners);
        if (Number(await vault.threshold()) !== threshold) mismatch(step, "threshold", threshold, await vault.threshold());
        if (Number(await vault.minExecutionDelay()) !== minDelay) mismatch(step, "minDelay", minDelay, await vault.minExecutionDelay());
        if (Number(await vault.txNonce()) !== nonce) mismatch(step, "nonce", nonce, await vault.txNonce());
        expect(threshold).to.be.within(1, owners.length);
        expect(owners.length).to.be.within(1, MAX_OWNERS);
        for (const t of txs) {
          const st = await vault.status(t.hash);
          if (st !== modelStatus(t, now)) mismatch(step, `status ${t.hash.slice(0, 10)}`, modelStatus(t, now), st);
          const cnt = Number(await vault.getApprovalCount(t.hash));
          if (cnt !== valid(t)) mismatch(step, `approvals ${t.hash.slice(0, 10)}`, valid(t), cnt);
        }
      }

      // The fixed CI seeds must exercise the interesting paths, or they prove little. Ad-hoc
      // soak seeds (FUZZ_SEEDS) only report gaps, since any single random run can miss one.
      const reached = {
        "an external call executed": txs.some((t) => t.executed && !t.admin),
        "an admin self-call executed": txs.some((t) => t.executed && t.admin),
        "a cancel or expiry happened": txs.some((t) => t.cancelled || t.expiredFlag),
      };
      for (const [what, ok] of Object.entries(reached)) {
        if (process.env.FUZZ_SEEDS) {
          if (!ok) console.warn(`      seed ${seed}: coverage gap: ${what} never happened`);
        } else {
          expect(ok, what).to.equal(true);
        }
      }
    });
  }
});
