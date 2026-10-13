import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";

const { ethers } = hre;

/** A closed square parcel around (lng, lat), as the site's deed intake produces it. */
export function squareParcel(lng: number, lat: number, apn: string, half = 0.0005): string {
  return JSON.stringify({
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lng - half, lat + half],
          [lng + half, lat + half],
          [lng + half, lat - half],
          [lng - half, lat - half],
          [lng - half, lat + half],
        ],
      ],
    },
    properties: { apn },
  });
}

export const AGREEMENT_HASH = ethers.keccak256(ethers.toUtf8Bytes("OPERATING AGREEMENT: HARBOR TERRACE HOLDINGS LLC"));

export function mintParams(recipient: string, parcelId: string, overrides: Record<string, unknown> = {}) {
  return {
    recipient,
    legalDescription: `Lot 7, Block 12, as recorded for ${parcelId}`,
    physicalAddress: "7 Harbor Terrace, Port Vale",
    geoJson: squareParcel(-70.25, 43.65, parcelId),
    parcelId,
    legalOwner: "Harbor Terrace Holdings LLC",
    operatingAgreementHash: AGREEMENT_HASH,
    metadataUri: "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    ...overrides,
  };
}

export const COMMISSION_BPS = 300; // 3%
export const DAY = 24 * 60 * 60;

export async function deployDesk() {
  const [operator, seller, buyer, rival, broker, stranger] = await ethers.getSigners();
  const deed: any = await (await ethers.getContractFactory("QuestateDeed")).deploy(operator.address);
  await deed.waitForDeployment();
  const desk: any = await (await ethers.getContractFactory("QuestateBrokerage")).deploy(await deed.getAddress(), operator.address);
  await desk.waitForDeployment();
  await desk.registerBroker(broker.address, "Obsidian Realty", "LIC-0042", COMMISSION_BPS);
  return { deed, desk, operator, seller, buyer, rival, broker, stranger };
}

/** Mints a deed to `seller` and lists it through `broker` at `price`. */
export async function listedDeed(ctx: Awaited<ReturnType<typeof deployDesk>>, parcelId: string, price: bigint) {
  const { deed, desk, seller, broker } = ctx;
  await deed.mintDeed(mintParams(seller.address, parcelId));
  const deedId = await deed.deedIdByParcelHash(ethers.keccak256(ethers.toUtf8Bytes(parcelId)));
  await deed.connect(seller).approve(await desk.getAddress(), deedId);
  await desk.connect(seller).createListing(deedId, price, broker.address, JSON.stringify({ v: 1, title: parcelId }));
  const listingId = await desk.listingCount();
  return { deedId, listingId };
}

export async function deadline(seconds: number): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp + seconds);
}
