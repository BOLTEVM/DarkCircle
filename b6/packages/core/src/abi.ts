import { Interface } from 'ethers';

/**
 * The parts of the contracts the site calls. `test/abi.test.ts` checks every fragment against the
 * compiled Hardhat artifacts, so a contract change that is not mirrored here fails the build.
 */

const DEED_RECORD = 'tuple(string legalDescription, string physicalAddress, string geoJson, string parcelId, string legalOwner, bytes32 operatingAgreementHash)';
const MINT_PARAMS =
  'tuple(address recipient, string legalDescription, string physicalAddress, string geoJson, string parcelId, string legalOwner, bytes32 operatingAgreementHash, string metadataUri)';

export const DEED_ABI = [
  // ERC-721 / Enumerable
  'function ownerOf(uint256 id) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function tokenURI(uint256 id) view returns (string)',
  'function getApproved(uint256 id) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function approve(address to, uint256 id)',
  'function owner() view returns (address)',
  // EIP-6065
  'function debtOf(uint256 id) view returns (address debtToken, int256 debtAmt, bool foreclosed)',
  'function managerOf(uint256 id) view returns (address)',
  `function deedRecord(uint256 id) view returns (${DEED_RECORD})`,
  'function deedIdByParcelHash(bytes32 parcelHash) view returns (uint256)',
  // registrar
  `function mintDeed(${MINT_PARAMS} p) returns (uint256 id)`,
  'function setDebt(uint256 id, address debtToken, int256 debtAmt)',
  'function foreclose(uint256 id)',
  // holder
  'function setManager(uint256 id, address manager)',
  // errors the site explains in words
  'error OwnableUnauthorizedAccount(address account)',
  'error EmptyField(string field)',
  'error ParcelAlreadyRegistered(string parcelId, uint256 existingId)',
  'error AlreadyForeclosed(uint256 id)',
  'error NotHolder(uint256 id, address caller)',
  'error ERC721NonexistentToken(uint256 tokenId)',
  'error ERC721InvalidReceiver(address receiver)',
  // raised by the registry when the brokerage moves a deed it was not approved for
  'error ERC721InsufficientApproval(address operator, uint256 tokenId)',
  'error RenounceDisabled()',
] as const;

const BROKER = 'tuple(string name, string licenseId, uint16 commissionBps, bool active, bool registered)';
const LISTING =
  'tuple(uint256 deedId, address seller, uint64 createdAt, uint8 status, address broker, uint16 commissionBps, uint256 askPrice, address buyer, uint256 salePrice, uint256 acceptedOfferId, string details)';
const OFFER = 'tuple(uint256 listingId, address buyer, uint64 expiresAt, uint8 status, uint256 amount, address debtToken, uint256 maxDebt)';

export const BROKERAGE_ABI = [
  'function deed() view returns (address)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function listingCount() view returns (uint256)',
  'function offerCount() view returns (uint256)',
  'function totalProceedsOwed() view returns (uint256)',
  'function totalOfferEscrow() view returns (uint256)',
  'function proceeds(address payee) view returns (uint256)',
  'function activeListingOfDeed(uint256 deedId) view returns (uint256)',
  'function MAX_COMMISSION_BPS() view returns (uint16)',
  'function MAX_DETAILS_BYTES() view returns (uint256)',
  'function MAX_OFFER_DURATION() view returns (uint256)',
  `function getBroker(address broker) view returns (${BROKER})`,
  'function brokerCount() view returns (uint256)',
  'function brokersPage(uint256 offset, uint256 limit) view returns (address[])',
  `function getListing(uint256 listingId) view returns (${LISTING})`,
  `function getOffer(uint256 offerId) view returns (${OFFER})`,
  'function offerCountForListing(uint256 listingId) view returns (uint256)',
  'function offersForListing(uint256 listingId, uint256 offset, uint256 limit) view returns (uint256[])',
  'function offerCountForBuyer(address buyer) view returns (uint256)',
  'function offersByBuyer(address buyer, uint256 offset, uint256 limit) view returns (uint256[])',
  'function listingCountForSeller(address seller) view returns (uint256)',
  'function listingsBySeller(address seller, uint256 offset, uint256 limit) view returns (uint256[])',
  'function quoteSettlement(uint256 listingId, uint256 price) view returns (uint256 sellerNet, uint256 commission)',
  // sellers
  'function createListing(uint256 deedId, uint256 askPrice, address broker, string details) returns (uint256 listingId)',
  'function updateListing(uint256 listingId, uint256 askPrice, string details)',
  'function cancelListing(uint256 listingId)',
  'function acceptOffer(uint256 offerId)',
  // buyers
  'function buy(uint256 listingId, address debtToken, uint256 maxDebt) payable',
  'function makeOffer(uint256 listingId, uint64 expiresAt, address debtToken, uint256 maxDebt) payable returns (uint256 offerId)',
  'function withdrawOffer(uint256 offerId)',
  // payees
  'function withdrawProceeds()',
  // operator
  'function registerBroker(address broker, string name, string licenseId, uint16 commissionBps)',
  'function setBrokerActive(address broker, bool active)',
  'function setPaused(bool value)',
  // errors
  'error OwnableUnauthorizedAccount(address account)',
  'error Paused()',
  'error InvalidBroker(address broker)',
  'error CommissionTooHigh(uint16 bps)',
  'error EmptyField(string field)',
  'error DetailsTooLong(uint256 length)',
  'error ZeroPrice()',
  'error NotDeedHolder(uint256 deedId)',
  'error DeedForeclosed(uint256 deedId)',
  'error DeedAlreadyListed(uint256 deedId, uint256 listingId)',
  'error ListingNotActive(uint256 listingId)',
  'error NotSeller(uint256 listingId)',
  'error SellerCannotBuy()',
  'error WrongPayment(uint256 expected, uint256 sent)',
  'error BadExpiry(uint64 expiresAt)',
  'error OfferNotOpen(uint256 offerId)',
  'error OfferExpired(uint256 offerId)',
  'error NotOfferBuyer(uint256 offerId)',
  'error LienAboveBuyerLimit(address debtToken, int256 debtAmt, uint256 maxDebt)',
  'error NothingToWithdraw()',
  'error TransferFailed()',
  'error PageTooLarge(uint256 limit)',
  'error NotADeedRegistry(address registry)',
  'error OwnableInvalidOwner(address owner)',
  'error ReentrancyGuardReentrantCall()',
  'error RenounceDisabled()',
] as const;

export const deedInterface = new Interface(DEED_ABI as unknown as string[]);
export const brokerageInterface = new Interface(BROKERAGE_ABI as unknown as string[]);

const ERROR_WORDS: Record<string, (args: readonly unknown[]) => string> = {
  OwnableUnauthorizedAccount: () => 'Only the brokerage operator (or registrar) can do that.',
  Paused: () => 'The desk is paused: no new listings, offers or closings right now. Withdrawals still work.',
  InvalidBroker: () => 'That broker is not registered or no longer takes listings.',
  CommissionTooHigh: () => 'Commission may not exceed 10%.',
  EmptyField: (a) => `The field "${String(a[0])}" is required.`,
  DetailsTooLong: (a) => `Listing details are ${String(a[0])} bytes; the limit is 1,024.`,
  ZeroPrice: () => 'The amount must be above zero.',
  NotDeedHolder: () => 'Your wallet does not hold this deed.',
  DeedForeclosed: () => 'The registrar has foreclosed this property; it cannot be sold through the desk.',
  DeedAlreadyListed: () => 'This deed is already listed.',
  ListingNotActive: () => 'This listing is no longer active.',
  NotSeller: () => 'Only the seller can do that.',
  SellerCannotBuy: () => 'You are the seller of this listing.',
  WrongPayment: () => 'The amount sent does not match the asking price (it may have just changed).',
  BadExpiry: () => 'An offer must expire in the future and within 90 days.',
  OfferNotOpen: () => 'This offer is no longer open.',
  OfferExpired: () => 'This offer has expired.',
  NotOfferBuyer: () => 'Only the buyer who made this offer can withdraw it.',
  LienAboveBuyerLimit: () => 'The registrar has recorded a lien larger than the buyer accepted. The buyer must make a new offer.',
  NothingToWithdraw: () => 'Nothing to withdraw.',
  TransferFailed: () => 'The payout could not be delivered to this address.',
  ERC721InsufficientApproval: () => 'Approve the brokerage for this deed first.',
  NotADeedRegistry: () => 'That address is not an ERC-721 + EIP-6065 deed registry.',
  OwnableInvalidOwner: () => 'That is not a valid new owner address.',
  ReentrancyGuardReentrantCall: () => 'A contract tried to call back into the brokerage mid-transaction; refused.',
  RenounceDisabled: () => 'Ownership cannot be renounced; transfer it to another account instead.',
  PageTooLarge: () => 'Pages are limited to 100 records.',
  ParcelAlreadyRegistered: (a) => `Parcel ${String(a[0])} already has a deed (#${String(a[1])}).`,
  AlreadyForeclosed: () => 'This deed is already foreclosed.',
  NotHolder: () => 'Only the deed holder can do that.',
  ERC721NonexistentToken: (a) => `Deed #${String(a[0])} does not exist.`,
  ERC721InvalidReceiver: () => 'That address is a contract that cannot hold deeds.',
};

/** Revert data hides in different places depending on the node: a string, `{ data }`, or deeper. */
function revertDataCandidates(data: unknown, depth = 0): string[] {
  if (typeof data === 'string') return /^0x[0-9a-fA-F]{8,}$/.test(data) ? [data] : [];
  if (data && typeof data === 'object' && depth < 3) {
    return Object.values(data as Record<string, unknown>).flatMap((v) => revertDataCandidates(v, depth + 1));
  }
  return [];
}

/** Finds revert data in a node error message or payload and says what it means. */
export function explainRevert(message: string, data?: unknown): string {
  const candidates = revertDataCandidates(data);
  const inMessage = message.match(/0x[0-9a-fA-F]{8,}/g);
  if (inMessage) candidates.push(...inMessage);
  // Hardhat spells the error out instead: "reverted with custom error 'ListingNotActive(1)'".
  const named = message.match(/custom error '([A-Za-z0-9_]+)\(/);
  if (named && ERROR_WORDS[named[1]!] && candidates.length === 0) return ERROR_WORDS[named[1]!]!([]);
  for (const hex of candidates) {
    for (const iface of [brokerageInterface, deedInterface]) {
      try {
        const parsed = iface.parseError(hex);
        if (parsed) {
          const words = ERROR_WORDS[parsed.name];
          return words ? words(parsed.args) : parsed.name;
        }
      } catch {
        // not this interface
      }
    }
  }
  return message;
}
