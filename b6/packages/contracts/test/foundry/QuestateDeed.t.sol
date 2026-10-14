// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {QuestateTestBase} from "./Base.sol";
import {QuestateDeed} from "../../contracts/QuestateDeed.sol";
import {IERC6065} from "../../contracts/interfaces/IERC6065.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract NoReceiver {
    // deliberately not an ERC-721 receiver
}

/// The deed registry: one deed per parcel ever, the registrar alone services debt and
/// forecloses, and a manager appointment never survives a sale.
contract QuestateDeedFuzzTest is QuestateTestBase {
    function setUp() public {
        deployDesk();
    }

    function testFuzz_onlyRegistrarMints(address caller) public {
        vm.assume(caller != registrar);
        QuestateDeed.MintParams memory p = _params(cyprus(1), "P-1");
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", caller));
        vm.prank(caller);
        deed.mintDeed(p);
    }

    /// Every required field must reject empty, with its own name in the error.
    function testFuzz_emptyFieldsRevert(uint8 field) public {
        field = uint8(bound(field, 0, 4));
        QuestateDeed.MintParams memory p = _params(cyprus(1), "P-2");
        string memory name;
        if (field == 0) { p.parcelId = ""; name = "parcelId"; }
        else if (field == 1) { p.physicalAddress = ""; name = "physicalAddress"; }
        else if (field == 2) { p.legalOwner = ""; name = "legalOwner"; }
        else if (field == 3) { p.geoJson = ""; name = "geoJson"; }
        else { p.operatingAgreementHash = bytes32(0); name = "operatingAgreementHash"; }
        vm.expectRevert(abi.encodeWithSelector(QuestateDeed.EmptyField.selector, name));
        vm.prank(registrar);
        deed.mintDeed(p);
    }

    /// One deed per parcel, forever: the second mint of the same parcel reverts and the
    /// first deed keeps the claim.
    function testFuzz_parcelUniqueForever(bytes32 salt) public {
        string memory parcel = string.concat("P-", vm.toString(uint256(salt)));
        vm.prank(registrar);
        uint256 first = deed.mintDeed(_params(cyprus(1), parcel));

        QuestateDeed.MintParams memory dup = _params(cyprus(3), parcel);
        vm.expectRevert(abi.encodeWithSelector(QuestateDeed.ParcelAlreadyRegistered.selector, parcel, first));
        vm.prank(registrar);
        deed.mintDeed(dup);
        assertEq(deed.deedIdByParcelHash(keccak256(bytes(parcel))), first);
        assertEq(deed.ownerOf(first), cyprus(1));
    }

    function testFuzz_idsIncrementFromOne(uint8 k) public {
        k = uint8(bound(k, 1, 16));
        for (uint256 i = 0; i < k; i++) {
            assertEq(_mintDeed(cyprus(100 + i)), i + 1);
        }
        assertEq(deed.totalSupply(), k);
    }

    function testFuzz_mintRefusesNonReceiver() public {
        address noReceiver = address(new NoReceiver());
        QuestateDeed.MintParams memory p = _params(noReceiver, "P-nr");
        vm.expectRevert(abi.encodeWithSignature("ERC721InvalidReceiver(address)", noReceiver));
        vm.prank(registrar);
        deed.mintDeed(p);
    }

    // --- servicing -----------------------------------------------------------

    function testFuzz_debtOnlyRegistrar(address caller, int256 amt) public {
        uint256 id = _mintDeed(cyprus(1));
        vm.assume(caller != registrar);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", caller));
        vm.prank(caller);
        deed.setDebt(id, cyprus(50), amt);
    }

    /// Foreclosure is a point of no return: no debt servicing, no second foreclosure.
    function testFuzz_forecloseIrreversible(int256 amt) public {
        uint256 id = _mintDeed(cyprus(1));
        vm.prank(registrar);
        deed.foreclose(id);
        (, , bool foreclosed) = deed.debtOf(id);
        assertTrue(foreclosed);

        vm.expectRevert(abi.encodeWithSelector(QuestateDeed.AlreadyForeclosed.selector, id));
        vm.prank(registrar);
        deed.setDebt(id, cyprus(50), amt);

        vm.expectRevert(abi.encodeWithSelector(QuestateDeed.AlreadyForeclosed.selector, id));
        vm.prank(registrar);
        deed.foreclose(id);
    }

    // --- managers --------------------------------------------------------------

    /// A manager appointment ends the moment the deed changes hands: the buyer never
    /// inherits the seller's manager.
    function testFuzz_managerEndsOnTransfer(address manager) public {
        vm.assume(manager != address(0));
        address seller = cyprus(1);
        address buyer = cyprus(2);
        uint256 id = _mintDeed(seller);

        vm.prank(seller);
        deed.setManager(id, manager);
        assertEq(deed.managerOf(id), manager);

        vm.prank(seller);
        deed.transferFrom(seller, buyer, id);
        assertEq(deed.managerOf(id), buyer); // cleared, falls back to the new holder
    }

    function testFuzz_onlyHolderAppointsManager(address caller) public {
        uint256 id = _mintDeed(cyprus(1));
        vm.assume(caller != cyprus(1));
        vm.expectRevert(abi.encodeWithSelector(QuestateDeed.NotHolder.selector, id, caller));
        vm.prank(caller);
        deed.setManager(id, cyprus(9));
    }

    /// The registrar role can change hands but never disappear: liens must stay serviceable.
    function testFuzz_renounceIsDisabled(address caller) public {
        vm.expectRevert(QuestateDeed.RenounceDisabled.selector);
        vm.prank(caller);
        deed.renounceOwnership();
        assertEq(deed.owner(), registrar);

        vm.expectRevert(QuestateDeed.RenounceDisabled.selector);
        vm.prank(registrar);
        deed.renounceOwnership();
        assertEq(deed.owner(), registrar);
    }

    function test_interfaces() public view {
        assertTrue(deed.supportsInterface(type(IERC6065).interfaceId));
        assertTrue(deed.supportsInterface(type(IERC721).interfaceId));
        assertTrue(deed.supportsInterface(type(IERC721Receiver).interfaceId) == false);
    }

    function _params(address to, string memory parcel) internal pure returns (QuestateDeed.MintParams memory p) {
        p.recipient = to;
        p.legalDescription = "Lot 7, Block 3";
        p.physicalAddress = "1 Obsidian Row";
        p.geoJson = "{\"type\":\"Point\"}";
        p.parcelId = parcel;
        p.legalOwner = "Dark Order LLC";
        p.operatingAgreementHash = keccak256(bytes(parcel));
        p.metadataUri = "ipfs://deed";
    }
}
