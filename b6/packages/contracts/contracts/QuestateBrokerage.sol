// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC6065} from "./interfaces/IERC6065.sol";

/**
 * @title QuestateBrokerage
 * @notice Dark Questate's brokerage desk on Quai: sellers list EIP-6065 deeds through a licensed
 *         broker, buyers buy at the asking price or make escrowed offers, and closing is atomic:
 *         the deed goes to the buyer and the price is split between seller and broker in the
 *         same transaction. Prices are in the native coin (QUAI).
 *
 * Custody and money, in plain terms:
 *  - A listed deed is held by this contract until the listing closes or is cancelled, so a sale
 *    can never fail because the seller moved the deed or withdrew an approval.
 *  - An offer's deposit stays the buyer's until the seller accepts it. The buyer can withdraw
 *    an unaccepted offer at any time, also while the desk is paused and after the listing ends.
 *  - Sale proceeds are credited, then withdrawn by the seller and broker themselves (pull
 *    payments), so a payee that rejects the coin cannot block a closing.
 *  - The buyer fixes the largest lien they accept when they buy or offer. If the registrar
 *    records a bigger lien, or forecloses, before the closing, the closing reverts.
 *
 * What the owner (the brokerage operator) can and cannot do: register and deactivate brokers,
 * pause new business, and cancel a listing, which returns the deed to its seller. The owner has
 * no path to any deposit, any credited proceeds, or any listed deed.
 */
contract QuestateBrokerage is Ownable2Step, ReentrancyGuard {
    uint16 public constant BPS_DENOMINATOR = 10_000;
    /// @notice A broker's commission may not exceed 10% of the sale price.
    uint16 public constant MAX_COMMISSION_BPS = 1_000;
    /// @notice Listing details (JSON written by the seller) are capped to bound storage gas.
    uint256 public constant MAX_DETAILS_BYTES = 1_024;
    uint256 public constant MAX_OFFER_DURATION = 90 days;
    uint256 public constant MAX_PAGE = 100;

    enum ListingStatus {
        None,
        Active,
        Sold,
        Cancelled
    }

    enum OfferStatus {
        None,
        Open,
        Withdrawn,
        Accepted
    }

    struct Broker {
        string name;
        string licenseId;
        uint16 commissionBps;
        bool active;
        bool registered;
    }

    struct Listing {
        uint256 deedId;
        address seller;
        uint64 createdAt;
        ListingStatus status;
        address broker;
        uint16 commissionBps;
        uint256 askPrice;
        address buyer;
        uint256 salePrice;
        uint256 acceptedOfferId;
        string details;
    }

    struct Offer {
        uint256 listingId;
        address buyer;
        uint64 expiresAt;
        OfferStatus status;
        uint256 amount;
        address debtToken;
        uint256 maxDebt;
    }

    IERC721 public immutable deed;
    bool public paused;

    mapping(address => Broker) private _brokers;
    address[] private _brokerList;

    mapping(uint256 => Listing) private _listings;
    uint256 public listingCount;
    mapping(uint256 => Offer) private _offers;
    uint256 public offerCount;

    mapping(uint256 => uint256[]) private _offersByListing;
    mapping(address => uint256[]) private _offersByBuyer;
    mapping(address => uint256[]) private _listingsBySeller;

    /// @notice deed id => the listing that currently holds it (0 when none).
    mapping(uint256 => uint256) public activeListingOfDeed;

    /// @notice Credited sale proceeds, withdrawable by their owner.
    mapping(address => uint256) public proceeds;
    /// @notice Sum of all credited, unwithdrawn proceeds.
    uint256 public totalProceedsOwed;
    /// @notice Sum of all open offer deposits.
    uint256 public totalOfferEscrow;

    event BrokerRegistered(address indexed broker, string name, string licenseId, uint16 commissionBps);
    event BrokerActiveSet(address indexed broker, bool active);
    event PausedSet(bool paused);
    event ListingCreated(uint256 indexed listingId, uint256 indexed deedId, address indexed seller, address broker, uint256 askPrice);
    event ListingUpdated(uint256 indexed listingId, uint256 askPrice);
    event ListingCancelled(uint256 indexed listingId, address indexed cancelledBy);
    event OfferMade(uint256 indexed offerId, uint256 indexed listingId, address indexed buyer, uint256 amount, uint64 expiresAt);
    event OfferWithdrawn(uint256 indexed offerId, address indexed buyer, uint256 amount);
    event Sale(
        uint256 indexed listingId,
        uint256 indexed deedId,
        address indexed buyer,
        address seller,
        address broker,
        uint256 price,
        uint256 commission,
        uint256 offerId
    );
    event ProceedsWithdrawn(address indexed payee, uint256 amount);

    error NotADeedRegistry(address registry);
    error Paused();
    error InvalidBroker(address broker);
    error CommissionTooHigh(uint16 bps);
    error EmptyField(string field);
    error DetailsTooLong(uint256 length);
    error ZeroPrice();
    error NotDeedHolder(uint256 deedId);
    error DeedForeclosed(uint256 deedId);
    error DeedAlreadyListed(uint256 deedId, uint256 listingId);
    error ListingNotActive(uint256 listingId);
    error NotSeller(uint256 listingId);
    error SellerCannotBuy();
    error WrongPayment(uint256 expected, uint256 sent);
    error BadExpiry(uint64 expiresAt);
    error OfferNotOpen(uint256 offerId);
    error OfferExpired(uint256 offerId);
    error NotOfferBuyer(uint256 offerId);
    error LienAboveBuyerLimit(address debtToken, int256 debtAmt, uint256 maxDebt);
    error NothingToWithdraw();
    error TransferFailed();
    error PageTooLarge(uint256 limit);

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(address deedRegistry, address operator) Ownable(operator) {
        bool ok;
        try IERC165(deedRegistry).supportsInterface(type(IERC721).interfaceId) returns (bool a) {
            ok = a;
        } catch {}
        if (ok) {
            try IERC165(deedRegistry).supportsInterface(type(IERC6065).interfaceId) returns (bool b) {
                ok = b;
            } catch {
                ok = false;
            }
        }
        if (!ok) revert NotADeedRegistry(deedRegistry);
        deed = IERC721(deedRegistry);
    }

    /* ================================================================ operator */

    /// @notice Registers a broker, or updates one already registered (reactivating it).
    function registerBroker(address broker, string calldata name, string calldata licenseId, uint16 commissionBps)
        external
        onlyOwner
    {
        if (broker == address(0)) revert InvalidBroker(broker);
        if (bytes(name).length == 0) revert EmptyField("name");
        if (bytes(licenseId).length == 0) revert EmptyField("licenseId");
        if (commissionBps > MAX_COMMISSION_BPS) revert CommissionTooHigh(commissionBps);
        Broker storage b = _brokers[broker];
        if (!b.registered) {
            b.registered = true;
            _brokerList.push(broker);
        }
        b.name = name;
        b.licenseId = licenseId;
        b.commissionBps = commissionBps;
        b.active = true;
        emit BrokerRegistered(broker, name, licenseId, commissionBps);
    }

    /// @notice A deactivated broker takes no new listings. Existing listings keep the
    ///         commission they were created with.
    function setBrokerActive(address broker, bool active) external onlyOwner {
        if (!_brokers[broker].registered) revert InvalidBroker(broker);
        _brokers[broker].active = active;
        emit BrokerActiveSet(broker, active);
    }

    /// @notice Stops new listings, offers and closings. Cancelling, withdrawing offers and
    ///         withdrawing proceeds always stay open.
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    /* ================================================================ sellers */

    /**
     * @notice Lists a deed you hold. Approve this contract for the deed first: it takes custody
     *         until the listing closes or is cancelled.
     */
    function createListing(uint256 deedId, uint256 askPrice, address broker, string calldata details)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 listingId)
    {
        if (askPrice == 0) revert ZeroPrice();
        if (bytes(details).length > MAX_DETAILS_BYTES) revert DetailsTooLong(bytes(details).length);
        Broker storage b = _brokers[broker];
        if (!b.active) revert InvalidBroker(broker);
        if (deed.ownerOf(deedId) != msg.sender) revert NotDeedHolder(deedId);
        (, , bool foreclosed) = IERC6065(address(deed)).debtOf(deedId);
        if (foreclosed) revert DeedForeclosed(deedId);
        uint256 existing = activeListingOfDeed[deedId];
        if (existing != 0) revert DeedAlreadyListed(deedId, existing);

        listingId = ++listingCount;
        Listing storage l = _listings[listingId];
        l.deedId = deedId;
        l.seller = msg.sender;
        l.createdAt = uint64(block.timestamp);
        l.status = ListingStatus.Active;
        l.broker = broker;
        l.commissionBps = b.commissionBps;
        l.askPrice = askPrice;
        l.details = details;
        activeListingOfDeed[deedId] = listingId;
        _listingsBySeller[msg.sender].push(listingId);

        deed.transferFrom(msg.sender, address(this), deedId);
        emit ListingCreated(listingId, deedId, msg.sender, broker, askPrice);
    }

    /// @notice Changes the asking price and the listing details. Open offers are unaffected.
    function updateListing(uint256 listingId, uint256 askPrice, string calldata details) external {
        Listing storage l = _activeListing(listingId);
        if (l.seller != msg.sender) revert NotSeller(listingId);
        if (askPrice == 0) revert ZeroPrice();
        if (bytes(details).length > MAX_DETAILS_BYTES) revert DetailsTooLong(bytes(details).length);
        l.askPrice = askPrice;
        l.details = details;
        emit ListingUpdated(listingId, askPrice);
    }

    /// @notice Ends a listing and returns the deed to the seller. The seller or the operator may
    ///         cancel. Open offers stay withdrawable by their buyers.
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage l = _activeListing(listingId);
        if (msg.sender != l.seller && msg.sender != owner()) revert NotSeller(listingId);
        l.status = ListingStatus.Cancelled;
        activeListingOfDeed[l.deedId] = 0;
        deed.transferFrom(address(this), l.seller, l.deedId);
        emit ListingCancelled(listingId, msg.sender);
    }

    /// @notice Closes a sale to an open, unexpired offer.
    function acceptOffer(uint256 offerId) external whenNotPaused nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.status != OfferStatus.Open) revert OfferNotOpen(offerId);
        if (block.timestamp > o.expiresAt) revert OfferExpired(offerId);
        Listing storage l = _activeListing(o.listingId);
        if (l.seller != msg.sender) revert NotSeller(o.listingId);
        _requireLienWithin(l.deedId, o.debtToken, o.maxDebt);

        o.status = OfferStatus.Accepted;
        totalOfferEscrow -= o.amount;
        _settle(o.listingId, l, o.buyer, o.amount, offerId);
    }

    /* ================================================================ buyers */

    /**
     * @notice Buys at the asking price. `debtToken`/`maxDebt` is the largest lien you accept
     *         (pass maxDebt 0 to accept none).
     */
    function buy(uint256 listingId, address debtToken, uint256 maxDebt) external payable whenNotPaused nonReentrant {
        Listing storage l = _activeListing(listingId);
        if (msg.sender == l.seller) revert SellerCannotBuy();
        if (msg.value != l.askPrice) revert WrongPayment(l.askPrice, msg.value);
        _requireLienWithin(l.deedId, debtToken, maxDebt);
        _settle(listingId, l, msg.sender, msg.value, 0);
    }

    /// @notice Places an offer; the deposit is the offered price and stays escrowed until the
    ///         seller accepts it or you withdraw it.
    function makeOffer(uint256 listingId, uint64 expiresAt, address debtToken, uint256 maxDebt)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 offerId)
    {
        Listing storage l = _activeListing(listingId);
        if (msg.sender == l.seller) revert SellerCannotBuy();
        if (msg.value == 0) revert ZeroPrice();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_OFFER_DURATION) revert BadExpiry(expiresAt);

        offerId = ++offerCount;
        _offers[offerId] = Offer({
            listingId: listingId,
            buyer: msg.sender,
            expiresAt: expiresAt,
            status: OfferStatus.Open,
            amount: msg.value,
            debtToken: debtToken,
            maxDebt: maxDebt
        });
        _offersByListing[listingId].push(offerId);
        _offersByBuyer[msg.sender].push(offerId);
        totalOfferEscrow += msg.value;
        emit OfferMade(offerId, listingId, msg.sender, msg.value, expiresAt);
    }

    /// @notice Returns an unaccepted offer's deposit. Works in every state of the listing.
    function withdrawOffer(uint256 offerId) external nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.buyer != msg.sender) revert NotOfferBuyer(offerId);
        if (o.status != OfferStatus.Open) revert OfferNotOpen(offerId);
        uint256 amount = o.amount;
        o.status = OfferStatus.Withdrawn;
        totalOfferEscrow -= amount;
        _pay(msg.sender, amount);
        emit OfferWithdrawn(offerId, msg.sender, amount);
    }

    /* ================================================================ payees */

    function withdrawProceeds() external nonReentrant {
        uint256 amount = proceeds[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        proceeds[msg.sender] = 0;
        totalProceedsOwed -= amount;
        _pay(msg.sender, amount);
        emit ProceedsWithdrawn(msg.sender, amount);
    }

    /* ================================================================ reads */

    function getBroker(address broker) external view returns (Broker memory) {
        return _brokers[broker];
    }

    function brokerCount() external view returns (uint256) {
        return _brokerList.length;
    }

    function brokersPage(uint256 offset, uint256 limit) external view returns (address[] memory) {
        return _page(_brokerList, offset, limit);
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    function getOffer(uint256 offerId) external view returns (Offer memory) {
        return _offers[offerId];
    }

    function offerCountForListing(uint256 listingId) external view returns (uint256) {
        return _offersByListing[listingId].length;
    }

    function offersForListing(uint256 listingId, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_offersByListing[listingId], offset, limit);
    }

    function offerCountForBuyer(address buyer) external view returns (uint256) {
        return _offersByBuyer[buyer].length;
    }

    function offersByBuyer(address buyer, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_offersByBuyer[buyer], offset, limit);
    }

    function listingCountForSeller(address seller) external view returns (uint256) {
        return _listingsBySeller[seller].length;
    }

    function listingsBySeller(address seller, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_listingsBySeller[seller], offset, limit);
    }

    /// @notice Seller's net and broker's commission for a sale at `price` under `listingId`.
    function quoteSettlement(uint256 listingId, uint256 price) external view returns (uint256 sellerNet, uint256 commission) {
        commission = (price * _listings[listingId].commissionBps) / BPS_DENOMINATOR;
        sellerNet = price - commission;
    }

    /* ================================================================ internals */

    function _activeListing(uint256 listingId) private view returns (Listing storage l) {
        l = _listings[listingId];
        if (l.status != ListingStatus.Active) revert ListingNotActive(listingId);
    }

    function _requireLienWithin(uint256 deedId, address debtToken, uint256 maxDebt) private view {
        (address token, int256 amt, bool foreclosed) = IERC6065(address(deed)).debtOf(deedId);
        if (foreclosed) revert DeedForeclosed(deedId);
        if (amt > 0 && (token != debtToken || uint256(amt) > maxDebt)) {
            revert LienAboveBuyerLimit(token, amt, maxDebt);
        }
    }

    function _settle(uint256 listingId, Listing storage l, address buyer, uint256 price, uint256 offerId) private {
        uint256 commission = (price * l.commissionBps) / BPS_DENOMINATOR;
        uint256 sellerNet = price - commission;

        l.status = ListingStatus.Sold;
        l.buyer = buyer;
        l.salePrice = price;
        l.acceptedOfferId = offerId;
        activeListingOfDeed[l.deedId] = 0;

        proceeds[l.seller] += sellerNet;
        if (commission > 0) proceeds[l.broker] += commission;
        totalProceedsOwed += price;

        // Last: hands control to the buyer only if it is a contract, and every entry point
        // that could be re-entered is nonReentrant.
        deed.safeTransferFrom(address(this), buyer, l.deedId);
        emit Sale(listingId, l.deedId, buyer, l.seller, l.broker, price, commission, offerId);
    }

    function _pay(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _page(uint256[] storage items, uint256 offset, uint256 limit) private view returns (uint256[] memory out) {
        if (limit > MAX_PAGE) revert PageTooLarge(limit);
        uint256 n = items.length;
        if (offset >= n) return new uint256[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        out = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) out[i - offset] = items[i];
    }

    function _page(address[] storage items, uint256 offset, uint256 limit) private view returns (address[] memory out) {
        if (limit > MAX_PAGE) revert PageTooLarge(limit);
        uint256 n = items.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) out[i - offset] = items[i];
    }
}
