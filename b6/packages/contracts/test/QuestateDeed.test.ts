import { expect } from "chai";
import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { AGREEMENT_HASH, deployDesk, mintParams } from "./fixtures.ts";

const { ethers } = hre;

describe("QuestateDeed (EIP-6065 registry)", function () {
  it("mints a verified title and exposes every EIP-6065 getter", async function () {
    const { deed, seller } = await deployDesk();
    const p = mintParams(seller.address, "APN-PV-0007");
    await expect(deed.mintDeed(p)).to.emit(deed, "DeedMinted").withArgs(1n, "APN-PV-0007", seller.address, p.metadataUri);

    expect(await deed.ownerOf(1)).to.equal(seller.address);
    expect(await deed.legalDescriptionOf(1)).to.equal(p.legalDescription);
    expect(await deed.addressOf(1)).to.equal(p.physicalAddress);
    expect(await deed.geoJsonOf(1)).to.equal(p.geoJson);
    expect(await deed.parcelIdOf(1)).to.equal("APN-PV-0007");
    expect(await deed.legalOwnerOf(1)).to.equal(p.legalOwner);
    expect(await deed.operatingAgreementHashOf(1)).to.equal(AGREEMENT_HASH);
    expect(await deed.tokenURI(1)).to.equal(p.metadataUri);
    expect(await deed.managerOf(1)).to.equal(seller.address);
    const [debtToken, debtAmt, foreclosed] = await deed.debtOf(1);
    expect([debtToken, debtAmt, foreclosed]).to.deep.equal([ethers.ZeroAddress, 0n, false]);

    const record = await deed.deedRecord(1);
    expect(record.parcelId).to.equal("APN-PV-0007");
    expect(await deed.totalSupply()).to.equal(1n);
    expect(await deed.tokenOfOwnerByIndex(seller.address, 0)).to.equal(1n);
  });

  it("advertises ERC-165, ERC-721, ERC-721 Enumerable and EIP-6065", async function () {
    const { deed } = await deployDesk();
    const iface = new ethers.Interface([
      "function legalDescriptionOf(uint256) view returns (string)",
      "function addressOf(uint256) view returns (string)",
      "function geoJsonOf(uint256) view returns (string)",
      "function parcelIdOf(uint256) view returns (string)",
      "function legalOwnerOf(uint256) view returns (string)",
      "function operatingAgreementHashOf(uint256) view returns (bytes32)",
      "function debtOf(uint256) view returns (address,int256,bool)",
      "function managerOf(uint256) view returns (address)",
    ]);
    let id = 0n;
    iface.forEachFunction((f) => {
      id ^= BigInt(f.selector);
    });
    const eip6065 = "0x" + id.toString(16).padStart(8, "0");
    for (const interfaceId of ["0x01ffc9a7", "0x80ac58cd", "0x780e9d63", eip6065]) {
      expect(await deed.supportsInterface(interfaceId), interfaceId).to.equal(true);
    }
    expect(await deed.supportsInterface("0xffffffff")).to.equal(false);
  });

  it("only the registrar mints, and a parcel can be registered once", async function () {
    const { deed, seller, stranger } = await deployDesk();
    await expect(deed.connect(stranger).mintDeed(mintParams(stranger.address, "APN-X")))
      .to.be.revertedWithCustomError(deed, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);

    await deed.mintDeed(mintParams(seller.address, "APN-ONCE"));
    await expect(deed.mintDeed(mintParams(stranger.address, "APN-ONCE")))
      .to.be.revertedWithCustomError(deed, "ParcelAlreadyRegistered")
      .withArgs("APN-ONCE", 1n);
  });

  it("refuses records missing a parcel id, address, owner, boundary or agreement hash", async function () {
    const { deed, seller } = await deployDesk();
    const cases: [string, Record<string, unknown>][] = [
      ["parcelId", { parcelId: "" }],
      ["physicalAddress", { physicalAddress: "" }],
      ["legalOwner", { legalOwner: "" }],
      ["geoJson", { geoJson: "" }],
      ["operatingAgreementHash", { operatingAgreementHash: ethers.ZeroHash }],
    ];
    for (const [field, override] of cases) {
      await expect(deed.mintDeed(mintParams(seller.address, "APN-EMPTY", override)))
        .to.be.revertedWithCustomError(deed, "EmptyField")
        .withArgs(field);
    }
  });

  it("refuses to mint to a contract that cannot hold deeds", async function () {
    const { deed } = await deployDesk();
    const notAReceiver = await deed.getAddress(); // the registry itself has no onERC721Received
    await expect(deed.mintDeed(mintParams(notAReceiver, "APN-LOST")))
      .to.be.revertedWithCustomError(deed, "ERC721InvalidReceiver")
      .withArgs(notAReceiver);
  });

  describe("servicing", function () {
    it("lets the registrar record a lien or a credit", async function () {
      const { deed, seller } = await deployDesk();
      await deed.mintDeed(mintParams(seller.address, "APN-LIEN"));
      await expect(deed.setDebt(1, ethers.ZeroAddress, ethers.parseEther("12")))
        .to.emit(deed, "DebtUpdated")
        .withArgs(1n, ethers.ZeroAddress, ethers.parseEther("12"));
      await deed.setDebt(1, ethers.ZeroAddress, -ethers.parseEther("3"));
      const [, amt] = await deed.debtOf(1);
      expect(amt).to.equal(-ethers.parseEther("3"));
    });

    it("never lets the holder or their manager erase a lien (regression)", async function () {
      const { deed, seller } = await deployDesk();
      await deed.mintDeed(mintParams(seller.address, "APN-NO-SELF-CLEAR"));
      await deed.setDebt(1, ethers.ZeroAddress, ethers.parseEther("50"));

      // The b6 build let the holder (and any manager the holder appointed) set debt to zero.
      await expect(deed.connect(seller).setDebt(1, ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(
        deed,
        "OwnableUnauthorizedAccount"
      );
      await deed.connect(seller).setManager(1, seller.address);
      await expect(deed.connect(seller).setDebt(1, ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(
        deed,
        "OwnableUnauthorizedAccount"
      );
      await expect(deed.connect(seller).foreclose(1)).to.be.revertedWithCustomError(deed, "OwnableUnauthorizedAccount");
    });

    it("forecloses once, emits Foreclosed, and freezes the debt record", async function () {
      const { deed, seller } = await deployDesk();
      await deed.mintDeed(mintParams(seller.address, "APN-FC"));
      await expect(deed.foreclose(1)).to.emit(deed, "Foreclosed").withArgs(1n);
      const [, , foreclosed] = await deed.debtOf(1);
      expect(foreclosed).to.equal(true);
      await expect(deed.foreclose(1)).to.be.revertedWithCustomError(deed, "AlreadyForeclosed").withArgs(1n);
      await expect(deed.setDebt(1, ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(deed, "AlreadyForeclosed");
    });

    it("reverts reads and servicing for a deed that does not exist", async function () {
      const { deed } = await deployDesk();
      await expect(deed.debtOf(99)).to.be.revertedWithCustomError(deed, "ERC721NonexistentToken").withArgs(99n);
      await expect(deed.setDebt(99, ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(deed, "ERC721NonexistentToken");
    });
  });

  describe("managers", function () {
    it("only the holder (or an approved operator) appoints a manager", async function () {
      const { deed, seller, broker, stranger } = await deployDesk();
      await deed.mintDeed(mintParams(seller.address, "APN-MGR"));
      await expect(deed.connect(stranger).setManager(1, stranger.address))
        .to.be.revertedWithCustomError(deed, "NotHolder")
        .withArgs(1n, stranger.address);
      await expect(deed.connect(seller).setManager(1, broker.address))
        .to.emit(deed, "ManagerUpdated")
        .withArgs(1n, ethers.ZeroAddress, broker.address);
      expect(await deed.managerOf(1)).to.equal(broker.address);
    });

    it("ends the appointment when the deed changes hands", async function () {
      const { deed, seller, buyer, broker } = await deployDesk();
      await deed.mintDeed(mintParams(seller.address, "APN-HANDOVER"));
      await deed.connect(seller).setManager(1, broker.address);
      await expect(deed.connect(seller).transferFrom(seller.address, buyer.address, 1))
        .to.emit(deed, "ManagerUpdated")
        .withArgs(1n, broker.address, ethers.ZeroAddress);
      expect(await deed.managerOf(1)).to.equal(buyer.address);
    });
  });

  it("hands the registrar role over in two steps", async function () {
    const { deed, stranger } = await deployDesk();
    await deed.transferOwnership(stranger.address);
    expect(await deed.owner()).to.not.equal(stranger.address);
    await deed.connect(stranger).acceptOwnership();
    expect(await deed.owner()).to.equal(stranger.address);
  });
});
