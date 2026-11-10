import { expect } from "chai";
import { ethers } from "hardhat";
import { E18, deadline, deployAmm, poolWith, rng } from "./ammHelpers";
import {
  encodeSwapExactTokensForTokens,
  encodeSwapExactETHForTokens,
  encodeSwapExactTokensForETH
} from "../../quai-service/src/swapEncoding";
import { recipientForSegment } from "../../quai-service/src/swapRecipient";

/**
 * "Receive to another wallet": the calldata the Swap page builds, sent to the real compiled router. The router has always taken
 * an explicit recipient; what these prove is that the page's encoders put the recipient in exactly that slot, for all three swap
 * functions, along a direct route and along a route split across two routers.
 */
describe("Receive to another wallet: the Swap page's calldata against the real router", function () {
  this.timeout(120_000);

  const randomAddress = (rand: () => number) => ethers.getAddress("0x" + Array.from({ length: 40 }, () => Math.floor(rand() * 16).toString(16)).join(""));

  describe("the encoders produce exactly what the router's ABI produces", function () {
    it("for random amounts, paths of two to five tokens, recipients and deadlines", async function () {
      const { router } = await deployAmm();
      const rand = rng(20241109);
      for (let i = 0; i < 60; i++) {
        const path = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => randomAddress(rand));
        const to = randomAddress(rand);
        const amountIn = BigInt(Math.floor(rand() * 1e15)) * 1_000_003n;
        const amountOutMin = BigInt(Math.floor(rand() * 1e12));
        const dl = BigInt(1_700_000_000 + Math.floor(rand() * 1e6));
        expect(encodeSwapExactTokensForTokens(amountIn, amountOutMin, path, to, dl)).to.equal(
          router.interface.encodeFunctionData("swapExactTokensForTokens", [amountIn, amountOutMin, path, to, dl])
        );
        expect(encodeSwapExactETHForTokens(amountOutMin, path, to, dl)).to.equal(
          router.interface.encodeFunctionData("swapExactETHForTokens", [amountOutMin, path, to, dl])
        );
        expect(encodeSwapExactTokensForETH(amountIn, amountOutMin, path, to, dl)).to.equal(
          router.interface.encodeFunctionData("swapExactTokensForETH", [amountIn, amountOutMin, path, to, dl])
        );
      }
    });
  });

  describe("tokens for tokens", function () {
    it("pays the output to the recipient, and leaves the sender with the input debited and nothing received", async function () {
      const amm = await deployAmm();
      const { A, B, bob, carol, router } = amm;
      await poolWith(amm, A, B, 1000n * E18, 4000n * E18);
      const quoted = (await router.getAmountsOut(10n * E18, [await A.getAddress(), await B.getAddress()]))[1];

      const bobA = await A.balanceOf(bob.address);
      const bobB = await B.balanceOf(bob.address);
      const carolB = await B.balanceOf(carol.address);
      const data = encodeSwapExactTokensForTokens(10n * E18, quoted, [await A.getAddress(), await B.getAddress()], carol.address, BigInt(await deadline()));
      await bob.sendTransaction({ to: await router.getAddress(), data });

      expect(await A.balanceOf(bob.address)).to.equal(bobA - 10n * E18);
      expect(await B.balanceOf(bob.address)).to.equal(bobB); // the sender receives nothing
      expect(await B.balanceOf(carol.address)).to.equal(carolB + quoted); // exactly the quote, to the recipient
      expect(await A.balanceOf(await router.getAddress())).to.equal(0n);
      expect(await B.balanceOf(await router.getAddress())).to.equal(0n);
    });

    it("along a two-hop path, only the final token reaches the recipient and nothing is left in the router", async function () {
      const amm = await deployAmm();
      const { A, B, C, bob, carol, router } = amm;
      await poolWith(amm, A, B, 1000n * E18, 1000n * E18);
      await poolWith(amm, B, C, 1000n * E18, 2000n * E18);
      const path = [await A.getAddress(), await B.getAddress(), await C.getAddress()];
      const quoted = (await router.getAmountsOut(20n * E18, path))[2];

      const carolBefore = { B: await B.balanceOf(carol.address), C: await C.balanceOf(carol.address) };
      const bobBefore = { B: await B.balanceOf(bob.address), C: await C.balanceOf(bob.address) };
      await bob.sendTransaction({ to: await router.getAddress(), data: encodeSwapExactTokensForTokens(20n * E18, quoted, path, carol.address, BigInt(await deadline())) });

      expect(await C.balanceOf(carol.address)).to.equal(carolBefore.C + quoted);
      expect(await B.balanceOf(carol.address)).to.equal(carolBefore.B); // the intermediate token goes to the next pool, not the recipient
      expect(await B.balanceOf(bob.address)).to.equal(bobBefore.B);
      expect(await C.balanceOf(bob.address)).to.equal(bobBefore.C);
      for (const t of [A, B, C]) expect(await t.balanceOf(await router.getAddress())).to.equal(0n);
    });

    it("a recipient that is the sender is an ordinary swap", async function () {
      const amm = await deployAmm();
      const { A, B, bob, router } = amm;
      await poolWith(amm, A, B, 1000n * E18, 1000n * E18);
      const path = [await A.getAddress(), await B.getAddress()];
      const quoted = (await router.getAmountsOut(5n * E18, path))[1];
      const before = await B.balanceOf(bob.address);
      await bob.sendTransaction({ to: await router.getAddress(), data: encodeSwapExactTokensForTokens(5n * E18, quoted, path, bob.address, BigInt(await deadline())) });
      expect(await B.balanceOf(bob.address)).to.equal(before + quoted);
    });

    it("the minimum is still enforced when the output goes to someone else", async function () {
      const amm = await deployAmm();
      const { A, B, bob, carol, router } = amm;
      await poolWith(amm, A, B, 1000n * E18, 1000n * E18);
      const path = [await A.getAddress(), await B.getAddress()];
      const quoted = (await router.getAmountsOut(5n * E18, path))[1];
      const carolBefore = await B.balanceOf(carol.address);
      await expect(
        bob.sendTransaction({ to: await router.getAddress(), data: encodeSwapExactTokensForTokens(5n * E18, quoted + 1n, path, carol.address, BigInt(await deadline())) })
      ).to.be.revertedWithCustomError(router, "InsufficientOutputAmount");
      expect(await B.balanceOf(carol.address)).to.equal(carolBefore);
    });
  });

  describe("native QUAI", function () {
    it("QUAI in, tokens to the recipient: the sender pays the native value and receives nothing", async function () {
      const amm = await deployAmm();
      const { A, wquai, bob, carol, router } = amm;
      await router.connect(amm.alice).addLiquidityETH(await A.getAddress(), 1000n * E18, 0, 0, amm.alice.address, await deadline(), { value: 1000n * E18 });
      const path = [await wquai.getAddress(), await A.getAddress()];
      const quoted = (await router.getAmountsOut(5n * E18, path))[1];
      const carolBefore = await A.balanceOf(carol.address);
      const bobBefore = await A.balanceOf(bob.address);
      await bob.sendTransaction({ to: await router.getAddress(), data: encodeSwapExactETHForTokens(quoted, path, carol.address, BigInt(await deadline())), value: 5n * E18 });
      expect(await A.balanceOf(carol.address)).to.equal(carolBefore + quoted);
      expect(await A.balanceOf(bob.address)).to.equal(bobBefore);
    });

    it("tokens in, native QUAI to the recipient: the recipient's balance rises by exactly the quote", async function () {
      const amm = await deployAmm();
      const { A, wquai, bob, router } = amm;
      await router.connect(amm.alice).addLiquidityETH(await A.getAddress(), 1000n * E18, 0, 0, amm.alice.address, await deadline(), { value: 1000n * E18 });
      const path = [await A.getAddress(), await wquai.getAddress()];
      const quoted = (await router.getAmountsOut(10n * E18, path))[1];
      const fresh = ethers.Wallet.createRandom().address; // an address that has never held anything
      expect(await ethers.provider.getBalance(fresh)).to.equal(0n);
      await bob.sendTransaction({ to: await router.getAddress(), data: encodeSwapExactTokensForETH(10n * E18, quoted, path, fresh, BigInt(await deadline())) });
      expect(await ethers.provider.getBalance(fresh)).to.equal(quoted);
    });

    it("a recipient that cannot receive QUAI makes the whole swap revert, so nothing is lost", async function () {
      const amm = await deployAmm();
      const { A, wquai, bob, router } = amm;
      await router.connect(amm.alice).addLiquidityETH(await A.getAddress(), 1000n * E18, 0, 0, amm.alice.address, await deadline(), { value: 1000n * E18 });
      const rejects = await (await ethers.getContractFactory("RejectsNative")).deploy();
      const path = [await A.getAddress(), await wquai.getAddress()];
      const bobBefore = await A.balanceOf(bob.address);
      await expect(
        bob.sendTransaction({ to: await router.getAddress(), data: encodeSwapExactTokensForETH(10n * E18, 0n, path, await rejects.getAddress(), BigInt(await deadline())) })
      ).to.be.revertedWithCustomError(router, "NativeTransferFailed");
      expect(await A.balanceOf(bob.address)).to.equal(bobBefore);
    });
  });

  describe("recipients the router refuses, even though the page also refuses them first", function () {
    it("the zero address and the router itself", async function () {
      const amm = await deployAmm();
      const { A, B, bob, router } = amm;
      await poolWith(amm, A, B, 1000n * E18, 1000n * E18);
      const path = [await A.getAddress(), await B.getAddress()];
      for (const to of [ethers.ZeroAddress, await router.getAddress()]) {
        await expect(
          bob.sendTransaction({ to: await router.getAddress(), data: encodeSwapExactTokensForTokens(5n * E18, 0n, path, to, BigInt(await deadline())) })
        ).to.be.revertedWithCustomError(router, "InvalidRecipient");
      }
    });

    it("a pool's own token as the recipient fails at the pool (it would swallow the output), so the page refuses token contracts", async function () {
      const amm = await deployAmm();
      const { A, B, bob, router } = amm;
      await poolWith(amm, A, B, 1000n * E18, 1000n * E18);
      const path = [await A.getAddress(), await B.getAddress()];
      await expect(
        bob.sendTransaction({ to: await router.getAddress(), data: encodeSwapExactTokensForTokens(5n * E18, 0n, path, await B.getAddress(), BigInt(await deadline())) })
      ).to.be.reverted; // INVALID_TO at the pool
    });
  });

  describe("a route split across two routers (the Swap page's cross-DEX route)", function () {
    /** A second, independent router and factory over the same tokens, built the way deployAmm builds the first. */
    async function secondStack(wquai: string, owner: string) {
      const Factory = await ethers.getContractFactory("CircleswapFactory");
      const Router = await ethers.getContractFactory("CircleswapRouter");
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const fImpl = await Factory.deploy();
      const factory = Factory.attach(await (await Proxy.deploy(await fImpl.getAddress(), Factory.interface.encodeFunctionData("initialize", [owner]))).getAddress()) as any;
      const rImpl = await Router.deploy();
      const router = Router.attach(
        await (await Proxy.deploy(await rImpl.getAddress(), Router.interface.encodeFunctionData("initialize", [await factory.getAddress(), wquai, owner]))).getAddress()
      ) as any;
      return { factory, router };
    }

    it("each segment pays the wallet except the last, which pays the recipient; the recipient ends with the final token only", async function () {
      const first = await deployAmm();
      const { A, B, C, bob, carol, alice, router: router1 } = first;
      const { router: router2 } = await secondStack(await first.wquai.getAddress(), first.owner.address);
      await poolWith(first, A, B, 1000n * E18, 1000n * E18); // router 1: A/B
      for (const t of [B, C]) {
        await t.connect(alice).approve(await router2.getAddress(), ethers.MaxUint256);
      }
      await router2.connect(alice).addLiquidity(await B.getAddress(), await C.getAddress(), 1000n * E18, 3000n * E18, 0, 0, alice.address, await deadline());

      const segments = [
        { router: router1, path: [await A.getAddress(), await B.getAddress()] },
        { router: router2, path: [await B.getAddress(), await C.getAddress()] }
      ];
      let amountIn = 25n * E18;
      await A.connect(bob).approve(await router1.getAddress(), ethers.MaxUint256);
      await B.connect(bob).approve(await router2.getAddress(), ethers.MaxUint256);
      const carolBefore = { A: await A.balanceOf(carol.address), B: await B.balanceOf(carol.address), C: await C.balanceOf(carol.address) };
      const bobBefore = { B: await B.balanceOf(bob.address), C: await C.balanceOf(bob.address) };

      for (const [i, seg] of segments.entries()) {
        const to = recipientForSegment(i, segments.length, bob.address, carol.address);
        const outToken = i === 0 ? B : C;
        const before = await outToken.balanceOf(to);
        const quoted = (await seg.router.getAmountsOut(amountIn, seg.path))[1];
        await bob.sendTransaction({
          to: await seg.router.getAddress(),
          data: encodeSwapExactTokensForTokens(amountIn, quoted, seg.path, to, BigInt(await deadline()))
        });
        const received = (await outToken.balanceOf(to)) - before;
        expect(received).to.equal(quoted);
        // the page chains the wallet's confirmed balance delta into the next segment; only the first segment pays the wallet
        if (i === 0) amountIn = received;
      }

      expect(await C.balanceOf(carol.address)).to.be.gt(carolBefore.C); // the recipient got the final token
      expect(await B.balanceOf(carol.address)).to.equal(carolBefore.B); // not the intermediate one
      expect(await A.balanceOf(carol.address)).to.equal(carolBefore.A);
      expect(await B.balanceOf(bob.address)).to.equal(bobBefore.B); // the wallet spent the intermediate token on the second leg
      expect(await C.balanceOf(bob.address)).to.equal(bobBefore.C); // and received none of the final one
    });
  });
});
