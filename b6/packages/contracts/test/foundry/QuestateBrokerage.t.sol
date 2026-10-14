// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {QuestateTestBase} from "./Base.sol";
import {QuestateBrokerage} from "../../contracts/QuestateBrokerage.sol";
import {HostileParty} from "../../contracts/test/HostileParty.sol";

/// The brokerage desk: custody of the deed until closing, escrowed offers, atomic settlement
/// with a pull-payment split, and a money identity (balance == owed + escrowed) that every
/// fuzz path must preserve.
contract QuestateBrokerageFuzzTest is QuestateTestBase {
    address internal broker = cyprus(500);

    function setUp() public {
        deployDesk();
        _registerBroker(broker, 250); // 2.5%
    }

    // --- broker registration ---------------------------------------------------

    function testFuzz_registerBrokerValidation(address b, uint16 bps) public {
        vm.assume(b != address(0));
        if (bps > desk.MAX_COMMISSION_BPS()) {
            vm.expectRevert(abi.encodeWithSelector(QuestateBrokerage.CommissionTooHigh.selector, bps));
            vm.prank(operator);
            desk.registerBroker(b, "Name", "LIC", bps);
        } else {
            vm.prank(operator);
            desk.registerBroker(b, "Name", "LIC", bps);
            QuestateBrokerage.Broker memory got = desk.getBroker(b);
            assertTrue(got.registered && got.active);
            assertEq(got.commissionBps, bps);
        }
    }

    function testFuzz_brokerUpdateKeepsSingleEntry(uint8 updates) public {
        updates = uint8(bound(updates, 1, 8));
        for (uint256 i = 0; i < updates; i++) {
            vm.prank(operator);
            desk.registerBroker(broker, "Name", "LIC", uint16(i));
        }
        assertEq(desk.brokerCount(), 1);
        assertEq(desk.getBroker(broker).commissionBps, updates - 1);
    }

    function testFuzz_onlyOperatorRegisters(address caller) public {
        vm.assume(caller != operator);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", caller));
        vm.prank(caller);
        desk.registerBroker(cyprus(1), "Name", "LIC", 100);
    }

    // --- listing ----------------------------------------------------------------

    function testFuzz_listingTakesCustody(uint128 ask) public {
        vm.assume(ask > 0);
        address seller = cyprus(1);
        uint256 id = _mintDeed(seller);
        uint256 listingId = _list(seller, id, ask, broker);

        assertEq(deed.ownerOf(id), address(desk)); // custody until closing
        assertEq(desk.activeListingOfDeed(id), listingId);
        QuestateBrokerage.Listing memory l = desk.getListing(listingId);
        assertEq(uint256(l.status), uint256(QuestateBrokerage.ListingStatus.Active));
        assertEq(l.askPrice, ask);
        assertEq(l.commissionBps, 250);
    }

    function testFuzz_listingGuards(uint128 ask) public {
        vm.assume(ask > 0);
        address seller = cyprus(1);
        uint256 id = _mintDeed(seller);

        // zero price
        vm.prank(seller);
        deed.approve(address(desk), id);
        vm.expectRevert(QuestateBrokerage.ZeroPrice.selector);
        vm.prank(seller);
        desk.createListing(id, 0, broker, "{}");

        // unregistered broker
        vm.expectRevert(abi.encodeWithSelector(QuestateBrokerage.InvalidBroker.selector, cyprus(77)));
        vm.prank(seller);
        desk.createListing(id, ask, cyprus(77), "{}");

        // not the holder
        vm.expectRevert(abi.encodeWithSelector(QuestateBrokerage.NotDeedHolder.selector, id));
        vm.prank(cyprus(2));
        desk.createListing(id, ask, broker, "{}");

        // listed once, never twice. Custody moved to the desk on the first listing, so the
        // seller hits NotDeedHolder before the DeedAlreadyListed guard (defense in depth).
        uint256 listingId = _list(seller, id, ask, broker);
        assertEq(desk.activeListingOfDeed(id), listingId);
        vm.expectRevert(abi.encodeWithSelector(QuestateBrokerage.NotDeedHolder.selector, id));
        vm.prank(seller);
        desk.createListing(id, ask, broker, "{}");
    }

    function testFuzz_foreclosedDeedCannotList(uint128 ask) public {
        vm.assume(ask > 0);
        address seller = cyprus(1);
        uint256 id = _mintDeed(seller);
        vm.prank(registrar);
        deed.foreclose(id);
        vm.prank(seller);
        deed.approve(address(desk), id);
        vm.expectRevert(abi.encodeWithSelector(QuestateBrokerage.DeedForeclosed.selector, id));
        vm.prank(seller);
        desk.createListing(id, ask, broker, "{}");
    }

    // --- buying at the ask --------------------------------------------------------

    function testFuzz_buySettlementSplitsExactly(uint128 askSeed) public {
        uint256 ask = bound(askSeed, 1, 1_000_000 ether);
        address seller = cyprus(1);
        address buyer = cyprus(2);
        uint256 id = _mintDeed(seller);
        uint256 listingId = _list(seller, id, ask, broker);

        vm.deal(buyer, ask);
        vm.prank(buyer);
        desk.buy{value: ask}(listingId, address(0), 0);

        uint256 commission = (ask * 250) / 10_000;
        assertEq(deed.ownerOf(id), buyer); // atomic: deed moved with the money
        assertEq(desk.proceeds(seller), ask - commission);
        assertEq(desk.proceeds(broker), commission);
        assertEq(desk.totalProceedsOwed(), ask);
        assertEq(desk.activeListingOfDeed(id), 0);

        (uint256 sellerNet, uint256 quotedCommission) = desk.quoteSettlement(listingId, ask);
        assertEq(quotedCommission, commission);
        assertEq(sellerNet, ask - commission);
    }

    function testFuzz_buyRequiresExactPrice(uint128 askSeed, uint128 paidSeed) public {
        uint256 ask = bound(askSeed, 1, 1_000_000 ether);
        uint256 paid = bound(paidSeed, 0, 2_000_000 ether);
        vm.assume(paid != ask);
        uint256 id = _mintDeed(cyprus(1));
        uint256 listingId = _list(cyprus(1), id, ask, broker);
        vm.deal(cyprus(2), paid);
        vm.expectRevert(abi.encodeWithSelector(QuestateBrokerage.WrongPayment.selector, ask, paid));
        vm.prank(cyprus(2));
        desk.buy{value: paid}(listingId, address(0), 0);
    }

    function testFuzz_sellerCannotBuy(uint128 ask) public {
        vm.assume(ask > 0);
        uint256 id = _mintDeed(cyprus(1));
        uint256 listingId = _list(cyprus(1), id, ask, broker);
        vm.deal(cyprus(1), ask);
        vm.expectRevert(QuestateBrokerage.SellerCannotBuy.selector);
        vm.prank(cyprus(1));
        desk.buy{value: ask}(listingId, address(0), 0);
    }

    /// The lien the buyer named is the ceiling: a bigger lien, a different lien token, or a
    /// foreclosure before closing all stop the sale.
    function testFuzz_lienGuard(uint256 recorded, uint256 accepted) public {
        recorded = bound(recorded, 1, 1_000 ether);
        accepted = bound(accepted, 0, 1_000 ether);
        uint256 id = _mintDeed(cyprus(1));
        uint256 listingId = _list(cyprus(1), id, 100 ether, broker);

        vm.prank(registrar);
        deed.setDebt(id, cyprus(50), int256(recorded));

        vm.deal(cyprus(2), 100 ether);
        if (recorded > accepted) {
            vm.expectRevert(
                abi.encodeWithSelector(QuestateBrokerage.LienAboveBuyerLimit.selector, cyprus(50), int256(recorded), accepted)
            );
        }
        vm.prank(cyprus(2));
        desk.buy{value: 100 ether}(listingId, cyprus(50), accepted);

        // a different token than the one carrying the lien always fails
        uint256 id2 = _mintDeed(cyprus(1));
        uint256 listing2 = _list(cyprus(1), id2, 100 ether, broker);
        vm.prank(registrar);
        deed.setDebt(id2, cyprus(50), int256(recorded));
        vm.deal(cyprus(2), 100 ether);
        vm.expectRevert();
        vm.prank(cyprus(2));
        desk.buy{value: 100 ether}(listing2, cyprus(51), type(uint256).max);
    }

    // --- offers -----------------------------------------------------------------

    function testFuzz_offerEscrowAndWithdrawAnywhere(uint96 amountSeed, bool pauseFirst, bool cancelFirst) public {
        uint256 amount = bound(amountSeed, 1, 10 ether);
        uint256 id = _mintDeed(cyprus(1));
        uint256 listingId = _list(cyprus(1), id, 100 ether, broker);

        address buyer = cyprus(2);
        vm.deal(buyer, amount);
        vm.prank(buyer);
        uint256 offerId = desk.makeOffer{value: amount}(listingId, uint64(block.timestamp + 1 days), address(0), 0);
        assertEq(desk.totalOfferEscrow(), amount);
        assertEq(address(desk).balance, amount);

        if (cancelFirst) {
            vm.prank(cyprus(1));
            desk.cancelListing(listingId);
        }
        if (pauseFirst) {
            vm.prank(operator);
            desk.setPaused(true);
        }

        uint256 before_ = buyer.balance;
        vm.prank(buyer);
        desk.withdrawOffer(offerId); // works while paused and after cancellation
        assertEq(buyer.balance, before_ + amount);
        assertEq(desk.totalOfferEscrow(), 0);
        assertEq(address(desk).balance, 0);
    }

    function testFuzz_offerExpiryBounds(uint64 expiresAt) public {
        uint256 id = _mintDeed(cyprus(1));
        uint256 listingId = _list(cyprus(1), id, 100 ether, broker);
        vm.warp(1_000_000);
        vm.deal(cyprus(2), 1 ether);
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + 90 days) {
            vm.expectRevert(abi.encodeWithSelector(QuestateBrokerage.BadExpiry.selector, expiresAt));
            vm.prank(cyprus(2));
            desk.makeOffer{value: 1 ether}(listingId, expiresAt, address(0), 0);
        } else {
            vm.prank(cyprus(2));
            desk.makeOffer{value: 1 ether}(listingId, expiresAt, address(0), 0);
        }
    }

    function testFuzz_acceptOfferSettles(uint96 offerSeed) public {
        uint256 amount = bound(offerSeed, 1, 10 ether);
        uint256 id = _mintDeed(cyprus(1));
        uint256 listingId = _list(cyprus(1), id, 100 ether, broker);

        address buyer = cyprus(2);
        vm.deal(buyer, amount);
        vm.prank(buyer);
        uint256 offerId = desk.makeOffer{value: amount}(listingId, uint64(block.timestamp + 1 days), address(0), 0);

        // only the seller may accept
        vm.expectRevert(abi.encodeWithSelector(QuestateBrokerage.NotSeller.selector, listingId));
        vm.prank(buyer);
        desk.acceptOffer(offerId);

        vm.prank(cyprus(1));
        desk.acceptOffer(offerId);

        uint256 commission = (amount * 250) / 10_000;
        assertEq(deed.ownerOf(id), buyer);
        assertEq(desk.proceeds(cyprus(1)), amount - commission);
        assertEq(desk.proceeds(broker), commission);
        assertEq(desk.totalOfferEscrow(), 0);
        assertEq(desk.totalProceedsOwed(), amount);
        assertEq(address(desk).balance, amount);
    }

    // --- cancellation and pause -----------------------------------------------------

    function testFuzz_cancelReturnsDeed(bool byOperator) public {
        uint256 id = _mintDeed(cyprus(1));
        uint256 listingId = _list(cyprus(1), id, 100 ether, broker);

        vm.expectRevert(abi.encodeWithSelector(QuestateBrokerage.NotSeller.selector, listingId));
        vm.prank(cyprus(3));
        desk.cancelListing(listingId);

        vm.prank(byOperator ? operator : cyprus(1));
        desk.cancelListing(listingId);
        assertEq(deed.ownerOf(id), cyprus(1));
        assertEq(desk.activeListingOfDeed(id), 0);
        assertEq(uint256(desk.getListing(listingId).status), uint256(QuestateBrokerage.ListingStatus.Cancelled));
    }

    function testFuzz_pauseScope() public {
        uint256 id = _mintDeed(cyprus(1));
        uint256 listingId = _list(cyprus(1), id, 100 ether, broker);
        vm.deal(cyprus(2), 200 ether);
        vm.prank(cyprus(2));
        uint256 offerId = desk.makeOffer{value: 1 ether}(listingId, uint64(block.timestamp + 1 days), address(0), 0);

        vm.prank(operator);
        desk.setPaused(true);

        vm.expectRevert(QuestateBrokerage.Paused.selector);
        vm.prank(cyprus(2));
        desk.buy{value: 100 ether}(listingId, address(0), 0);
        vm.expectRevert(QuestateBrokerage.Paused.selector);
        vm.prank(cyprus(2));
        desk.makeOffer{value: 1 ether}(listingId, uint64(block.timestamp + 2 days), address(0), 0);
        uint256 id2 = _mintDeed(cyprus(1));
        vm.prank(cyprus(1));
        deed.approve(address(desk), id2);
        vm.expectRevert(QuestateBrokerage.Paused.selector);
        vm.prank(cyprus(1));
        desk.createListing(id2, 1 ether, broker, "{}");

        // the exits stay open
        vm.prank(cyprus(2));
        desk.withdrawOffer(offerId);
        vm.prank(cyprus(1));
        desk.cancelListing(listingId);
        assertEq(deed.ownerOf(id), cyprus(1));
    }

    // --- pull payments --------------------------------------------------------------

    /// A payee that rejects the coin cannot block a closing — only its own withdrawal.
    function testFuzz_hostilePayeeCannotBlockClosing() public {
        HostileParty hostileSeller = new HostileParty(address(desk));
        uint256 id = _mintDeed(address(hostileSeller));
        vm.prank(address(hostileSeller));
        deed.approve(address(desk), id);
        vm.prank(address(hostileSeller));
        uint256 listingId = desk.createListing(id, 100 ether, broker, "{}");

        address buyer = cyprus(2);
        vm.deal(buyer, 100 ether);
        vm.prank(buyer);
        desk.buy{value: 100 ether}(listingId, address(0), 0); // closes fine: proceeds are credited
        assertEq(deed.ownerOf(id), buyer);

        hostileSeller.setMode(1, 0); // rejects the coin
        vm.prank(address(hostileSeller));
        vm.expectRevert(QuestateBrokerage.TransferFailed.selector);
        desk.withdrawProceeds();

        // the credited balance survives the failed withdrawal
        (uint256 sellerNet, ) = desk.quoteSettlement(listingId, 100 ether);
        assertEq(desk.proceeds(address(hostileSeller)), sellerNet);

        // and once it behaves, it is paid in full
        hostileSeller.setMode(0, 0);
        uint256 before_ = address(hostileSeller).balance;
        vm.prank(address(hostileSeller));
        desk.withdrawProceeds();
        assertEq(address(hostileSeller).balance, before_ + sellerNet);
        assertEq(desk.totalProceedsOwed(), desk.proceeds(broker));
    }

    function testFuzz_withdrawNothingReverts(address who) public {
        vm.expectRevert(QuestateBrokerage.NothingToWithdraw.selector);
        vm.prank(who);
        desk.withdrawProceeds();
    }

    // --- ownership ----------------------------------------------------------------

    /// Nobody, the operator included, can leave the desk ownerless (it could never be unpaused).
    function testFuzz_renounceIsDisabled(address caller) public {
        vm.expectRevert(QuestateBrokerage.RenounceDisabled.selector);
        vm.prank(caller);
        desk.renounceOwnership();
        assertEq(desk.owner(), operator);

        vm.expectRevert(QuestateBrokerage.RenounceDisabled.selector);
        vm.prank(operator);
        desk.renounceOwnership();
        assertEq(desk.owner(), operator);
    }
}
