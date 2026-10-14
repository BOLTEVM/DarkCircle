// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {QuestateTestBase} from "../Base.sol";
import {QuestateDeed} from "../../../contracts/QuestateDeed.sol";
import {QuestateBrokerage} from "../../../contracts/QuestateBrokerage.sol";

/**
 * Stateful campaign over the brokerage desk. Sellers list, buyers buy at the ask or escrow
 * offers, offers get accepted or withdrawn, the operator pauses and unpauses, payees pull
 * their proceeds, time warps. The money identity must hold after every call:
 *
 *     desk.balance == totalProceedsOwed + totalOfferEscrow
 *
 * and the deed of an active listing is always in the desk's custody, never anywhere else.
 */
contract BrokerageHandler is Test {
    QuestateDeed public deed;
    QuestateBrokerage public desk;
    address public registrar;
    address public operator;
    address public broker;
    address[] public sellers;
    address[] public buyers;

    uint256[] public deedIds;
    mapping(uint256 => address) public ghostOwner;
    uint256[] public offerIds;

    uint256 public violations;
    string public firstViolation;

    constructor(QuestateDeed deed_, QuestateBrokerage desk_, address registrar_, address operator_, address broker_) {
        deed = deed_;
        desk = desk_;
        registrar = registrar_;
        operator = operator_;
        broker = broker_;
        for (uint256 i = 0; i < 3; i++) {
            sellers.push(cyprusActor(100 + i));
            buyers.push(cyprusActor(103 + i));
        }
    }

    function cyprusActor(uint256 seed) internal pure returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encode("questate.actor", seed)))) >> 9);
        if (uint160(a) <= 1) a = address(uint160(0x0000_1000));
    }

    function _violation(string memory what) internal {
        violations++;
        if (bytes(firstViolation).length == 0) firstViolation = what;
    }

    function deedIdsLen() external view returns (uint256) {
        return deedIds.length;
    }

    uint256 private _parcelNonce;

    function mintTo(uint8 sellerSeed) public {
        address seller = sellers[sellerSeed % sellers.length];
        QuestateDeed.MintParams memory p;
        p.recipient = seller;
        p.legalDescription = "Lot 7, Block 3";
        p.physicalAddress = "1 Obsidian Row";
        p.geoJson = "{\"type\":\"Point\"}";
        p.parcelId = string.concat("INV-", vm.toString(++_parcelNonce));
        p.legalOwner = "Dark Order LLC";
        p.operatingAgreementHash = keccak256(abi.encodePacked("oa", _parcelNonce));
        p.metadataUri = "ipfs://deed";
        vm.prank(registrar);
        uint256 id = deed.mintDeed(p);
        deedIds.push(id);
        ghostOwner[id] = seller;
    }

    /// First deed the seller holds that is not already listed, or none.
    function _listableDeed(address seller) internal view returns (uint256) {
        for (uint256 i = 0; i < deedIds.length; i++) {
            uint256 id = deedIds[i];
            if (ghostOwner[id] == seller && desk.activeListingOfDeed(id) == 0) return id;
        }
        return 0;
    }

    function _listedDeed(uint256 seed) internal view returns (uint256) {
        uint256 n = deedIds.length;
        if (n == 0) return 0;
        uint256 start = seed % n; // reduce first: seed + k would overflow for huge fuzzed seeds
        for (uint256 k = 0; k < n; k++) {
            uint256 id = deedIds[(start + k) % n];
            if (desk.activeListingOfDeed(id) != 0) return id;
        }
        return 0;
    }

    function list(uint8 sellerSeed, uint96 askSeed) public {
        if (desk.paused()) return;
        address seller = sellers[sellerSeed % sellers.length];
        uint256 id = _listableDeed(seller);
        if (id == 0) return;
        uint256 ask = bound(askSeed, 1, 100 ether);
        vm.prank(seller);
        deed.approve(address(desk), id);
        vm.prank(seller);
        try desk.createListing(id, ask, broker, "{}") {
            ghostOwner[id] = address(desk);
        } catch {
            _violation("a lawful listing reverted");
        }
    }

    function buy(uint8 buyerSeed, uint256 deedSeed) public {
        if (desk.paused()) return;
        uint256 id = _listedDeed(deedSeed);
        if (id == 0) return;
        uint256 listingId = desk.activeListingOfDeed(id);
        address seller = desk.getListing(listingId).seller;
        address buyer = buyers[buyerSeed % buyers.length];
        if (buyer == seller) return;
        uint256 ask = desk.getListing(listingId).askPrice;
        vm.deal(buyer, ask);
        vm.prank(buyer);
        try desk.buy{value: ask}(listingId, address(0), 0) {
            ghostOwner[id] = buyer;
        } catch {
            _violation("a lawful buy reverted");
        }
    }

    function makeOffer(uint8 buyerSeed, uint256 deedSeed, uint96 amountSeed) public returns (uint256 offerId) {
        if (desk.paused()) return 0;
        uint256 id = _listedDeed(deedSeed);
        if (id == 0) return 0;
        uint256 listingId = desk.activeListingOfDeed(id);
        if (desk.getListing(listingId).seller == buyers[buyerSeed % buyers.length]) return 0;
        address buyer = buyers[buyerSeed % buyers.length];
        uint256 amount = bound(amountSeed, 1, 10 ether);
        vm.deal(buyer, amount);
        vm.prank(buyer);
        try desk.makeOffer{value: amount}(listingId, uint64(block.timestamp + 1 days), address(0), 0) returns (uint256 o) {
            offerIds.push(o);
            offerId = o;
        } catch {
            _violation("a lawful offer reverted");
        }
    }

    function _openOffer(uint256 seed) internal view returns (uint256) {
        uint256 n = offerIds.length;
        if (n == 0) return 0;
        uint256 start = seed % n; // reduce first: seed + k would overflow for huge fuzzed seeds
        for (uint256 k = 0; k < n; k++) {
            uint256 o = offerIds[(start + k) % n];
            if (desk.getOffer(o).status == QuestateBrokerage.OfferStatus.Open) return o;
        }
        return 0;
    }

    /// The buyer's exit must work in every state: paused, cancelled, whatever.
    function withdrawOffer(uint256 offerSeed) public {
        uint256 o = _openOffer(offerSeed);
        if (o == 0) return;
        address buyer = desk.getOffer(o).buyer;
        vm.prank(buyer);
        try desk.withdrawOffer(o) {} catch {
            _violation("an open offer could not be withdrawn");
        }
    }

    function acceptOffer(uint256 offerSeed) public {
        if (desk.paused()) return;
        uint256 o = _openOffer(offerSeed);
        if (o == 0) return;
        QuestateBrokerage.Offer memory offer = desk.getOffer(o);
        if (block.timestamp > offer.expiresAt) return;
        uint256 listingId = offer.listingId;
        if (uint256(desk.getListing(listingId).status) != uint256(QuestateBrokerage.ListingStatus.Active)) return;
        address seller = desk.getListing(listingId).seller;
        uint256 deedId = desk.getListing(listingId).deedId;
        vm.prank(seller);
        try desk.acceptOffer(o) {
            ghostOwner[deedId] = offer.buyer;
        } catch {
            _violation("a lawful acceptance reverted");
        }
    }

    function cancelListing(uint256 deedSeed, bool byOperator) public {
        uint256 id = _listedDeed(deedSeed);
        if (id == 0) return;
        uint256 listingId = desk.activeListingOfDeed(id);
        address seller = desk.getListing(listingId).seller;
        vm.prank(byOperator ? operator : seller);
        try desk.cancelListing(listingId) {
            ghostOwner[id] = seller;
        } catch {
            _violation("a lawful cancellation reverted");
        }
    }

    function setPaused(bool flag) public {
        vm.prank(operator);
        desk.setPaused(flag);
    }

    function withdrawProceeds(uint8 whoSeed) public {
        address who = (whoSeed % 2 == 0) ? sellers[whoSeed % sellers.length] : broker;
        if (desk.proceeds(who) == 0) return;
        vm.prank(who);
        try desk.withdrawProceeds() {} catch {
            _violation("credited proceeds could not be withdrawn");
        }
    }

    function warp(uint32 dt) public {
        vm.warp(block.timestamp + bound(dt, 0, 12 hours));
    }
}

contract QuestateBrokerageInvariantTest is QuestateTestBase {
    BrokerageHandler internal handler;

    function setUp() public {
        deployDesk();
        _registerBroker(broker(), 250);
        handler = new BrokerageHandler(deed, desk, registrar, operator, broker());

        // Seed the market so listings can happen immediately.
        handler.mintTo(0);
        handler.mintTo(1);
        handler.list(0, 1);
        handler.list(1, 2);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = BrokerageHandler.mintTo.selector;
        selectors[1] = BrokerageHandler.list.selector;
        selectors[2] = BrokerageHandler.buy.selector;
        selectors[3] = BrokerageHandler.makeOffer.selector;
        selectors[4] = BrokerageHandler.withdrawOffer.selector;
        selectors[5] = BrokerageHandler.acceptOffer.selector;
        selectors[6] = BrokerageHandler.cancelListing.selector;
        selectors[7] = BrokerageHandler.setPaused.selector;
        selectors[8] = BrokerageHandler.withdrawProceeds.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function broker() internal view returns (address) {
        return cyprus(500);
    }

    /// The money identity: the desk's balance is exactly credited proceeds plus open escrow.
    function invariant_moneyIdentity() public view {
        assertEq(address(desk).balance, desk.totalProceedsOwed() + desk.totalOfferEscrow());
    }

    /// Custody: a deed under an active listing is held by the desk; every other deed sits
    /// exactly where the ghost ledger says.
    function invariant_custody() public view {
        uint256 n = handler.deedIdsLen();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.deedIds(i);
            if (desk.activeListingOfDeed(id) != 0) {
                assertEq(deed.ownerOf(id), address(desk));
            } else {
                assertEq(deed.ownerOf(id), handler.ghostOwner(id));
            }
        }
    }

    /// Every exit and entry behaved lawfully through the whole random sequence.
    function invariant_noViolations() public view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }
}
