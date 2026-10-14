import { expect } from "chai";
import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { COMMISSION_BPS, DAY, deadline, deployDesk, listedDeed, mintParams } from "./fixtures.ts";

const { ethers } = hre;

const PRICE = ethers.parseEther("1000");
const commissionOf = (price: bigint) => (price * BigInt(COMMISSION_BPS)) / 10_000n;

/** The desk must always hold exactly the open offer deposits plus the credited proceeds. */
async function expectSolvent(desk: any) {
  const held = await ethers.provider.getBalance(await desk.getAddress());
  expect(held).to.equal((await desk.totalOfferEscrow()) + (await desk.totalProceedsOwed()));
}

describe("QuestateBrokerage", function () {
  describe("setup", function () {
    it("refuses a deed registry that is not ERC-721 + EIP-6065", async function () {
      const [operator] = await ethers.getSigners();
      const Desk = await ethers.getContractFactory("QuestateBrokerage");
      const notADeed = await (await ethers.getContractFactory("HostileParty")).deploy(operator.address);
      await expect(Desk.deploy(await notADeed.getAddress(), operator.address)).to.be.reverted;
    });

    it("registers brokers with a capped commission, operator only", async function () {
      const { desk, stranger, broker } = await deployDesk();
      await expect(desk.connect(stranger).registerBroker(stranger.address, "X", "L", 100)).to.be.revertedWithCustomError(
        desk,
        "OwnableUnauthorizedAccount"
      );
      await expect(desk.registerBroker(stranger.address, "Too Greedy", "LIC-9", 1_001))
        .to.be.revertedWithCustomError(desk, "CommissionTooHigh")
        .withArgs(1_001);
      await expect(desk.registerBroker(stranger.address, "", "LIC-9", 100)).to.be.revertedWithCustomError(desk, "EmptyField");
      await expect(desk.registerBroker(ethers.ZeroAddress, "Nobody", "LIC-0", 100)).to.be.revertedWithCustomError(
        desk,
        "InvalidBroker"
      );

      const b = await desk.getBroker(broker.address);
      expect([b.name, b.licenseId, b.commissionBps, b.active]).to.deep.equal(["Obsidian Realty", "LIC-0042", 300n, true]);
      expect(await desk.brokerCount()).to.equal(1n);
      expect(await desk.brokersPage(0, 10)).to.deep.equal([broker.address]);

      // re-registering updates in place, without a duplicate directory entry
      await desk.registerBroker(broker.address, "Obsidian Realty Group", "LIC-0042", 250);
      expect(await desk.brokerCount()).to.equal(1n);
      expect((await desk.getBroker(broker.address)).commissionBps).to.equal(250n);
    });
  });

  describe("listing", function () {
    it("takes custody of the deed and records the broker's commission at listing time", async function () {
      const ctx = await deployDesk();
      const { deed, desk, seller, broker } = ctx;
      const { deedId, listingId } = await listedDeed(ctx, "APN-LIST-1", PRICE);

      expect(await deed.ownerOf(deedId)).to.equal(await desk.getAddress());
      expect(await desk.activeListingOfDeed(deedId)).to.equal(listingId);
      const l = await desk.getListing(listingId);
      expect(l.seller).to.equal(seller.address);
      expect(l.broker).to.equal(broker.address);
      expect(l.commissionBps).to.equal(BigInt(COMMISSION_BPS));
      expect(l.askPrice).to.equal(PRICE);
      expect(l.status).to.equal(1n); // Active
      expect(await desk.listingsBySeller(seller.address, 0, 10)).to.deep.equal([listingId]);

      // a later commission change does not touch this listing
      await desk.registerBroker(broker.address, "Obsidian Realty", "LIC-0042", 900);
      expect((await desk.getListing(listingId)).commissionBps).to.equal(BigInt(COMMISSION_BPS));
    });

    it("refuses a deed the caller does not hold, an unknown or inactive broker, a zero price, long details", async function () {
      const { deed, desk, seller, broker, stranger } = await deployDesk();
      await deed.mintDeed(mintParams(seller.address, "APN-RULES"));
      await deed.connect(seller).approve(await desk.getAddress(), 1);

      await expect(desk.connect(stranger).createListing(1, PRICE, broker.address, ""))
        .to.be.revertedWithCustomError(desk, "NotDeedHolder")
        .withArgs(1n);
      await expect(desk.connect(seller).createListing(1, PRICE, stranger.address, ""))
        .to.be.revertedWithCustomError(desk, "InvalidBroker")
        .withArgs(stranger.address);
      await expect(desk.connect(seller).createListing(1, 0, broker.address, "")).to.be.revertedWithCustomError(desk, "ZeroPrice");
      await expect(desk.connect(seller).createListing(1, PRICE, broker.address, "x".repeat(1_025)))
        .to.be.revertedWithCustomError(desk, "DetailsTooLong")
        .withArgs(1_025n);

      await desk.setBrokerActive(broker.address, false);
      await expect(desk.connect(seller).createListing(1, PRICE, broker.address, "")).to.be.revertedWithCustomError(
        desk,
        "InvalidBroker"
      );
    });

    it("refuses to list a foreclosed deed", async function () {
      const { deed, desk, seller, broker } = await deployDesk();
      await deed.mintDeed(mintParams(seller.address, "APN-FC-LIST"));
      await deed.foreclose(1);
      await deed.connect(seller).approve(await desk.getAddress(), 1);
      await expect(desk.connect(seller).createListing(1, PRICE, broker.address, ""))
        .to.be.revertedWithCustomError(desk, "DeedForeclosed")
        .withArgs(1n);
    });

    it("lets the seller reprice, and the seller or operator cancel, returning the deed", async function () {
      const ctx = await deployDesk();
      const { deed, desk, seller, operator, stranger } = ctx;
      const { deedId, listingId } = await listedDeed(ctx, "APN-CANCEL", PRICE);

      await expect(desk.connect(stranger).updateListing(listingId, 1, "")).to.be.revertedWithCustomError(desk, "NotSeller");
      await expect(desk.connect(seller).updateListing(listingId, PRICE / 2n, "{}"))
        .to.emit(desk, "ListingUpdated")
        .withArgs(listingId, PRICE / 2n);

      await expect(desk.connect(stranger).cancelListing(listingId)).to.be.revertedWithCustomError(desk, "NotSeller");
      await expect(desk.connect(operator).cancelListing(listingId))
        .to.emit(desk, "ListingCancelled")
        .withArgs(listingId, operator.address);
      expect(await deed.ownerOf(deedId)).to.equal(seller.address);
      expect(await desk.activeListingOfDeed(deedId)).to.equal(0n);
      await expect(desk.connect(seller).cancelListing(listingId)).to.be.revertedWithCustomError(desk, "ListingNotActive");

      // relisting the same deed works once it is back with the seller
      await deed.connect(seller).approve(await desk.getAddress(), deedId);
      await desk.connect(seller).createListing(deedId, PRICE, ctx.broker.address, "");
      expect(await desk.activeListingOfDeed(deedId)).to.equal(2n);
    });
  });

  describe("buy now", function () {
    it("closes atomically: deed to buyer, price split into seller and broker proceeds", async function () {
      const ctx = await deployDesk();
      const { deed, desk, seller, buyer, broker } = ctx;
      const { deedId, listingId } = await listedDeed(ctx, "APN-BUY", PRICE);

      await expect(desk.connect(buyer).buy(listingId, ethers.ZeroAddress, 0, { value: PRICE }))
        .to.emit(desk, "Sale")
        .withArgs(listingId, deedId, buyer.address, seller.address, broker.address, PRICE, commissionOf(PRICE), 0n);

      expect(await deed.ownerOf(deedId)).to.equal(buyer.address);
      expect(await desk.proceeds(seller.address)).to.equal(PRICE - commissionOf(PRICE));
      expect(await desk.proceeds(broker.address)).to.equal(commissionOf(PRICE));
      const l = await desk.getListing(listingId);
      expect([l.status, l.buyer, l.salePrice]).to.deep.equal([2n, buyer.address, PRICE]);
      await expectSolvent(desk);

      const [sellerNet, commission] = await desk.quoteSettlement(listingId, PRICE);
      expect(sellerNet + commission).to.equal(PRICE);
      expect(commission).to.equal(commissionOf(PRICE));
    });

    it("pays out exactly what was credited", async function () {
      const ctx = await deployDesk();
      const { desk, seller, buyer, broker } = ctx;
      const { listingId } = await listedDeed(ctx, "APN-PAYOUT", PRICE);
      await desk.connect(buyer).buy(listingId, ethers.ZeroAddress, 0, { value: PRICE });

      await expect(desk.connect(seller).withdrawProceeds()).to.changeEtherBalances(
        [desk, seller],
        [-(PRICE - commissionOf(PRICE)), PRICE - commissionOf(PRICE)]
      );
      await expect(desk.connect(broker).withdrawProceeds()).to.changeEtherBalances(
        [desk, broker],
        [-commissionOf(PRICE), commissionOf(PRICE)]
      );
      await expect(desk.connect(seller).withdrawProceeds()).to.be.revertedWithCustomError(desk, "NothingToWithdraw");
      expect(await ethers.provider.getBalance(await desk.getAddress())).to.equal(0n);
      await expectSolvent(desk);
    });

    it("refuses a wrong payment, the seller buying their own listing, and a closed listing", async function () {
      const ctx = await deployDesk();
      const { desk, seller, buyer, rival } = ctx;
      const { listingId } = await listedDeed(ctx, "APN-BUY-RULES", PRICE);
      await expect(desk.connect(buyer).buy(listingId, ethers.ZeroAddress, 0, { value: PRICE - 1n }))
        .to.be.revertedWithCustomError(desk, "WrongPayment")
        .withArgs(PRICE, PRICE - 1n);
      await expect(desk.connect(seller).buy(listingId, ethers.ZeroAddress, 0, { value: PRICE })).to.be.revertedWithCustomError(
        desk,
        "SellerCannotBuy"
      );
      await desk.connect(buyer).buy(listingId, ethers.ZeroAddress, 0, { value: PRICE });
      await expect(desk.connect(rival).buy(listingId, ethers.ZeroAddress, 0, { value: PRICE }))
        .to.be.revertedWithCustomError(desk, "ListingNotActive")
        .withArgs(listingId);
    });

    it("rejects coin sent outside a purchase", async function () {
      const { desk, buyer } = await deployDesk();
      await expect(buyer.sendTransaction({ to: await desk.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  describe("liens and foreclosure at closing", function () {
    it("closes over a disclosed lien the buyer accepted, and refuses a bigger one", async function () {
      const ctx = await deployDesk();
      const { deed, desk, buyer } = ctx;
      const { deedId, listingId } = await listedDeed(ctx, "APN-LIEN-CLOSE", PRICE);
      await deed.setDebt(deedId, ethers.ZeroAddress, ethers.parseEther("10"));

      await expect(desk.connect(buyer).buy(listingId, ethers.ZeroAddress, 0, { value: PRICE }))
        .to.be.revertedWithCustomError(desk, "LienAboveBuyerLimit")
        .withArgs(ethers.ZeroAddress, ethers.parseEther("10"), 0n);
      await expect(
        desk.connect(buyer).buy(listingId, ethers.ZeroAddress, ethers.parseEther("10"), { value: PRICE })
      ).to.emit(desk, "Sale");
    });

    it("refuses a lien denominated in a different token than the buyer accepted", async function () {
      const ctx = await deployDesk();
      const { deed, desk, buyer, stranger } = ctx;
      const { deedId, listingId } = await listedDeed(ctx, "APN-LIEN-TOKEN", PRICE);
      await deed.setDebt(deedId, stranger.address, 5n);
      await expect(desk.connect(buyer).buy(listingId, ethers.ZeroAddress, 1_000n, { value: PRICE })).to.be.revertedWithCustomError(
        desk,
        "LienAboveBuyerLimit"
      );
    });

    it("protects an offer from a lien recorded after it was made", async function () {
      const ctx = await deployDesk();
      const { deed, desk, seller, buyer } = ctx;
      const { deedId, listingId } = await listedDeed(ctx, "APN-LATE-LIEN", PRICE);
      await desk.connect(buyer).makeOffer(listingId, await deadline(7 * DAY), ethers.ZeroAddress, 0, { value: PRICE });
      await deed.setDebt(deedId, ethers.ZeroAddress, 1n);
      await expect(desk.connect(seller).acceptOffer(1)).to.be.revertedWithCustomError(desk, "LienAboveBuyerLimit");
      // a credit (negative debt) is never a reason to refuse
      await deed.setDebt(deedId, ethers.ZeroAddress, -ethers.parseEther("2"));
      await expect(desk.connect(seller).acceptOffer(1)).to.emit(desk, "Sale");
    });

    it("blocks closing on a deed foreclosed while listed; the seller recovers it and buyers their deposits", async function () {
      const ctx = await deployDesk();
      const { deed, desk, seller, buyer } = ctx;
      const { deedId, listingId } = await listedDeed(ctx, "APN-FC-CLOSE", PRICE);
      await desk.connect(buyer).makeOffer(listingId, await deadline(DAY), ethers.ZeroAddress, 0, { value: PRICE });
      await deed.foreclose(deedId);

      await expect(desk.connect(seller).acceptOffer(1)).to.be.revertedWithCustomError(desk, "DeedForeclosed");
      await expect(desk.connect(buyer).buy(listingId, ethers.ZeroAddress, 0, { value: PRICE })).to.be.revertedWithCustomError(
        desk,
        "DeedForeclosed"
      );
      await desk.connect(seller).cancelListing(listingId);
      expect(await deed.ownerOf(deedId)).to.equal(seller.address);
      await expect(desk.connect(buyer).withdrawOffer(1)).to.changeEtherBalance(buyer, PRICE);
      await expectSolvent(desk);
    });
  });

  describe("offers", function () {
    it("escrows the deposit, and the seller can accept it before it expires", async function () {
      const ctx = await deployDesk();
      const { deed, desk, seller, buyer, broker } = ctx;
      const { deedId, listingId } = await listedDeed(ctx, "APN-OFFER", PRICE);
      const offer = ethers.parseEther("900");
      const expiresAt = await deadline(3 * DAY);

      await expect(desk.connect(buyer).makeOffer(listingId, expiresAt, ethers.ZeroAddress, 0, { value: offer }))
        .to.emit(desk, "OfferMade")
        .withArgs(1n, listingId, buyer.address, offer, expiresAt);
      expect(await desk.totalOfferEscrow()).to.equal(offer);
      expect(await desk.offersForListing(listingId, 0, 10)).to.deep.equal([1n]);
      expect(await desk.offersByBuyer(buyer.address, 0, 10)).to.deep.equal([1n]);
      await expectSolvent(desk);

      await expect(desk.connect(buyer).acceptOffer(1)).to.be.revertedWithCustomError(desk, "NotSeller");
      await expect(desk.connect(seller).acceptOffer(1))
        .to.emit(desk, "Sale")
        .withArgs(listingId, deedId, buyer.address, seller.address, broker.address, offer, commissionOf(offer), 1n);
      expect(await deed.ownerOf(deedId)).to.equal(buyer.address);
      expect((await desk.getOffer(1)).status).to.equal(3n); // Accepted
      expect(await desk.totalOfferEscrow()).to.equal(0n);
      await expectSolvent(desk);
      await expect(desk.connect(buyer).withdrawOffer(1)).to.be.revertedWithCustomError(desk, "OfferNotOpen");
    });

    it("lets a buyer withdraw an unaccepted offer at any time, even while paused", async function () {
      const ctx = await deployDesk();
      const { desk, buyer, rival } = ctx;
      const { listingId } = await listedDeed(ctx, "APN-WITHDRAW", PRICE);
      await desk.connect(buyer).makeOffer(listingId, await deadline(DAY), ethers.ZeroAddress, 0, { value: 123n });
      await desk.setPaused(true);
      await expect(desk.connect(rival).withdrawOffer(1)).to.be.revertedWithCustomError(desk, "NotOfferBuyer");
      await expect(desk.connect(buyer).withdrawOffer(1)).to.changeEtherBalances([desk, buyer], [-123n, 123n]);
      await expect(desk.connect(buyer).withdrawOffer(1)).to.be.revertedWithCustomError(desk, "OfferNotOpen");
    });

    it("refuses to accept an expired offer, and the buyer still recovers it", async function () {
      const ctx = await deployDesk();
      const { desk, seller, buyer } = ctx;
      const { listingId } = await listedDeed(ctx, "APN-EXPIRED", PRICE);
      await desk.connect(buyer).makeOffer(listingId, await deadline(DAY), ethers.ZeroAddress, 0, { value: PRICE });
      await time.increase(DAY + 1);
      await expect(desk.connect(seller).acceptOffer(1)).to.be.revertedWithCustomError(desk, "OfferExpired").withArgs(1n);
      await expect(desk.connect(buyer).withdrawOffer(1)).to.changeEtherBalance(buyer, PRICE);
    });

    it("bounds the expiry and refuses empty offers and offers from the seller", async function () {
      const ctx = await deployDesk();
      const { desk, seller, buyer } = ctx;
      const { listingId } = await listedDeed(ctx, "APN-OFFER-RULES", PRICE);
      await expect(desk.connect(buyer).makeOffer(listingId, await deadline(0), ethers.ZeroAddress, 0, { value: 1n })).to.be
        .reverted;
      await expect(
        desk.connect(buyer).makeOffer(listingId, await deadline(91 * DAY), ethers.ZeroAddress, 0, { value: 1n })
      ).to.be.revertedWithCustomError(desk, "BadExpiry");
      await expect(
        desk.connect(buyer).makeOffer(listingId, await deadline(DAY), ethers.ZeroAddress, 0, { value: 0n })
      ).to.be.revertedWithCustomError(desk, "ZeroPrice");
      await expect(
        desk.connect(seller).makeOffer(listingId, await deadline(DAY), ethers.ZeroAddress, 0, { value: 1n })
      ).to.be.revertedWithCustomError(desk, "SellerCannotBuy");
    });

    it("leaves competing offers withdrawable after another one wins", async function () {
      const ctx = await deployDesk();
      const { desk, seller, buyer, rival } = ctx;
      const { listingId } = await listedDeed(ctx, "APN-RIVALS", PRICE);
      await desk.connect(buyer).makeOffer(listingId, await deadline(DAY), ethers.ZeroAddress, 0, { value: PRICE });
      await desk.connect(rival).makeOffer(listingId, await deadline(DAY), ethers.ZeroAddress, 0, { value: PRICE - 1n });
      await desk.connect(seller).acceptOffer(1);
      await expect(desk.connect(seller).acceptOffer(2)).to.be.revertedWithCustomError(desk, "ListingNotActive");
      await expect(desk.connect(rival).withdrawOffer(2)).to.changeEtherBalance(rival, PRICE - 1n);
      await expectSolvent(desk);
    });

    it("pages offer and listing indexes, and caps a page at 100", async function () {
      const ctx = await deployDesk();
      const { desk, buyer } = ctx;
      const { listingId } = await listedDeed(ctx, "APN-PAGES", PRICE);
      for (let i = 0; i < 3; i++) {
        await desk.connect(buyer).makeOffer(listingId, await deadline(DAY), ethers.ZeroAddress, 0, { value: 1n });
      }
      expect(await desk.offerCountForListing(listingId)).to.equal(3n);
      expect(await desk.offersForListing(listingId, 1, 10)).to.deep.equal([2n, 3n]);
      expect(await desk.offersForListing(listingId, 5, 10)).to.deep.equal([]);
      await expect(desk.offersForListing(listingId, 0, 101)).to.be.revertedWithCustomError(desk, "PageTooLarge");
    });
  });

  describe("pause", function () {
    it("stops new business but never cancellation, withdrawals or payouts", async function () {
      const ctx = await deployDesk();
      const { desk, seller, buyer, stranger } = ctx;
      const { listingId } = await listedDeed(ctx, "APN-PAUSE", PRICE);
      await desk.connect(buyer).makeOffer(listingId, await deadline(DAY), ethers.ZeroAddress, 0, { value: 5n });

      await expect(desk.connect(stranger).setPaused(true)).to.be.revertedWithCustomError(desk, "OwnableUnauthorizedAccount");
      await desk.setPaused(true);
      await expect(desk.connect(buyer).buy(listingId, ethers.ZeroAddress, 0, { value: PRICE })).to.be.revertedWithCustomError(
        desk,
        "Paused"
      );
      await expect(desk.connect(seller).acceptOffer(1)).to.be.revertedWithCustomError(desk, "Paused");
      await expect(
        desk.connect(buyer).makeOffer(listingId, await deadline(DAY), ethers.ZeroAddress, 0, { value: 1n })
      ).to.be.revertedWithCustomError(desk, "Paused");

      await desk.connect(buyer).withdrawOffer(1);
      await desk.connect(seller).cancelListing(listingId);
      await desk.setPaused(false);
      expect(await desk.paused()).to.equal(false);
    });

    it("cannot be made permanent by renouncing the desk", async function () {
      const { desk, operator, stranger } = await deployDesk();
      await desk.setPaused(true);
      await expect(desk.renounceOwnership()).to.be.revertedWithCustomError(desk, "RenounceDisabled");
      await expect(desk.connect(stranger).renounceOwnership()).to.be.revertedWithCustomError(desk, "RenounceDisabled");
      expect(await desk.owner()).to.equal(operator.address);
      await desk.setPaused(false);
      expect(await desk.paused()).to.equal(false);
    });
  });

  describe("hostile counterparties", function () {
    async function hostile(desk: any) {
      return (await ethers.getContractFactory("HostileParty")).deploy(await desk.getAddress()) as Promise<any>;
    }

    it("a seller that rejects the coin cannot block its own closing (proceeds are pulled)", async function () {
      const { deed, desk, buyer, broker } = await deployDesk();
      const party = await hostile(desk);
      const partyAddr = await party.getAddress();
      await deed.mintDeed(mintParams(partyAddr, "APN-HOSTILE-SELLER"));
      await party.exec(await deed.getAddress(), deed.interface.encodeFunctionData("approve", [await desk.getAddress(), 1]));
      await party.exec(
        await desk.getAddress(),
        desk.interface.encodeFunctionData("createListing", [1, PRICE, broker.address, ""])
      );
      await party.setMode(1, 0);

      await desk.connect(buyer).buy(1, ethers.ZeroAddress, 0, { value: PRICE });
      expect(await deed.ownerOf(1)).to.equal(buyer.address);
      await expect(desk.connect(broker).withdrawProceeds()).to.changeEtherBalance(broker, commissionOf(PRICE));
      await expect(party.exec(await desk.getAddress(), desk.interface.encodeFunctionData("withdrawProceeds"))).to.be.reverted;
      expect(await desk.proceeds(partyAddr)).to.equal(PRICE - commissionOf(PRICE));
      await expectSolvent(desk);
    });

    it("re-entering withdrawOffer from the refund is blocked", async function () {
      const ctx = await deployDesk();
      const { desk } = ctx;
      const { listingId } = await listedDeed(ctx, "APN-REENTER-REFUND", PRICE);
      const party = await hostile(desk);
      await party.exec(
        await desk.getAddress(),
        desk.interface.encodeFunctionData("makeOffer", [listingId, await deadline(DAY), ethers.ZeroAddress, 0]),
        { value: 100n }
      );
      await party.setMode(2, 1);
      await expect(party.exec(await desk.getAddress(), desk.interface.encodeFunctionData("withdrawOffer", [1]))).to.be.reverted;
      expect((await desk.getOffer(1)).status).to.equal(1n); // still Open, still escrowed
      await expectSolvent(desk);
    });

    it("a buyer that re-enters on deed receipt cannot close", async function () {
      const ctx = await deployDesk();
      const { desk, deed } = ctx;
      const { listingId, deedId } = await listedDeed(ctx, "APN-REENTER-DEED", PRICE);
      const party = await hostile(desk);
      await party.exec(
        await desk.getAddress(),
        desk.interface.encodeFunctionData("makeOffer", [listingId, await deadline(DAY), ethers.ZeroAddress, 0]),
        { value: 1n }
      );
      await party.setMode(3, 1);
      await expect(
        party.exec(await desk.getAddress(), desk.interface.encodeFunctionData("buy", [listingId, ethers.ZeroAddress, 0]), {
          value: PRICE,
        })
      ).to.be.reverted;
      expect(await deed.ownerOf(deedId)).to.equal(await desk.getAddress());
      expect((await desk.getListing(listingId)).status).to.equal(1n);
      await expectSolvent(desk);
    });
  });
});
