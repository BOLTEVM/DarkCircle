// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {QuestateTestBase} from "../Base.sol";
import {QuestateDeed} from "../../../contracts/QuestateDeed.sol";

/**
 * Stateful campaign over the deed registry. The registrar mints, services liens and
 * forecloses; holders move deeds between themselves and appoint managers. Whatever happens:
 * a parcel keeps exactly one deed, foreclosure never reverses, and `managerOf` always
 * reflects the ghost ledger — in particular an appointment never survives a transfer.
 */
contract DeedHandler is Test {
    QuestateDeed public deed;
    address public registrar;
    address[] public holders;

    uint256[] public deedIds;
    mapping(uint256 => address) public ghostOwner;
    mapping(uint256 => address) public ghostManager; // 0 = no appointment
    mapping(uint256 => bool) public ghostForeclosed;
    bytes32[] public parcelHashes;
    mapping(bytes32 => uint256) public parcelDeedId;

    uint256 public violations;
    string public firstViolation;

    constructor(QuestateDeed deed_, address registrar_, address[] memory holders_) {
        deed = deed_;
        registrar = registrar_;
        holders = holders_;
    }

    function _violation(string memory what) internal {
        violations++;
        if (bytes(firstViolation).length == 0) firstViolation = what;
    }

    function deedIdsLen() external view returns (uint256) {
        return deedIds.length;
    }

    function parcelHashesLen() external view returns (uint256) {
        return parcelHashes.length;
    }

    uint256 private _parcelNonce;

    function mint(uint8 toSeed) public {
        address to = holders[toSeed % holders.length];
        QuestateDeed.MintParams memory p;
        p.recipient = to;
        p.legalDescription = "Lot 7, Block 3";
        p.physicalAddress = "1 Obsidian Row";
        p.geoJson = "{\"type\":\"Point\"}";
        p.parcelId = string.concat("DINV-", vm.toString(++_parcelNonce));
        p.legalOwner = "Dark Order LLC";
        p.operatingAgreementHash = keccak256(abi.encodePacked("oa", _parcelNonce));
        p.metadataUri = "ipfs://deed";
        vm.prank(registrar);
        try deed.mintDeed(p) returns (uint256 id) {
            deedIds.push(id);
            ghostOwner[id] = to;
            bytes32 h = keccak256(bytes(p.parcelId));
            parcelHashes.push(h);
            parcelDeedId[h] = id;
        } catch {
            _violation("a lawful mint reverted");
        }
    }

    function _deedHeldBy(address who, uint256 seed) internal view returns (uint256) {
        uint256 n = deedIds.length;
        if (n == 0) return 0;
        uint256 start = seed % n; // reduce first: seed + k would overflow for huge fuzzed seeds
        for (uint256 k = 0; k < n; k++) {
            uint256 id = deedIds[(start + k) % n];
            if (ghostOwner[id] == who) return id;
        }
        return 0;
    }

    function transfer(uint8 fromSeed, uint8 toSeed, uint256 deedSeed) public {
        address from = holders[fromSeed % holders.length];
        address to = holders[toSeed % holders.length];
        if (from == to) return;
        uint256 id = _deedHeldBy(from, deedSeed);
        if (id == 0) return;
        vm.prank(from);
        try deed.transferFrom(from, to, id) {
            ghostOwner[id] = to;
            ghostManager[id] = address(0); // the appointment must end with the sale
        } catch {
            _violation("a holder could not transfer their deed");
        }
    }

    function setManager(uint256 deedSeed, uint8 managerSeed) public {
        if (deedIds.length == 0) return;
        uint256 id = deedIds[deedSeed % deedIds.length];
        address holder = ghostOwner[id];
        address manager = holders[managerSeed % holders.length];
        vm.prank(holder);
        try deed.setManager(id, manager) {
            ghostManager[id] = manager;
        } catch {
            _violation("a holder could not appoint a manager");
        }
    }

    function setDebt(uint256 deedSeed, int96 amt) public {
        if (deedIds.length == 0) return;
        uint256 id = deedIds[deedSeed % deedIds.length];
        if (ghostForeclosed[id]) return;
        vm.prank(registrar);
        try deed.setDebt(id, address(uint160(0x0000_2000)), amt) {} catch {
            _violation("the registrar could not service a live deed");
        }
    }

    function foreclose(uint256 deedSeed) public {
        if (deedIds.length == 0) return;
        uint256 id = deedIds[deedSeed % deedIds.length];
        if (ghostForeclosed[id]) return;
        vm.prank(registrar);
        try deed.foreclose(id) {
            ghostForeclosed[id] = true;
        } catch {
            _violation("the registrar could not foreclose a live deed");
        }
    }
}

contract QuestateDeedInvariantTest is QuestateTestBase {
    DeedHandler internal handler;

    function setUp() public {
        deployDesk();
        handler = new DeedHandler(deed, registrar, actors(4, 7000));
        handler.mint(0);
        handler.mint(1);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = DeedHandler.mint.selector;
        selectors[1] = DeedHandler.transfer.selector;
        selectors[2] = DeedHandler.transfer.selector; // transfers are where appointments die
        selectors[3] = DeedHandler.setManager.selector;
        selectors[4] = DeedHandler.setDebt.selector;
        selectors[5] = DeedHandler.foreclose.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// One deed per parcel, stable forever.
    function invariant_parcelUniqueness() public view {
        uint256 n = handler.parcelHashesLen();
        for (uint256 i = 0; i < n; i++) {
            bytes32 h = handler.parcelHashes(i);
            assertEq(deed.deedIdByParcelHash(h), handler.parcelDeedId(h));
        }
    }

    /// Foreclosure is monotone: once foreclosed, always foreclosed.
    function invariant_foreclosureMonotone() public view {
        uint256 n = handler.deedIdsLen();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.deedIds(i);
            (, , bool foreclosed) = deed.debtOf(id);
            assertEq(foreclosed, handler.ghostForeclosed(id));
        }
    }

    /// managerOf reflects the ghost ledger: the appointed manager, or the holder once the
    /// appointment ended (a transfer always ends it).
    function invariant_managerLedger() public view {
        uint256 n = handler.deedIdsLen();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.deedIds(i);
            address want = handler.ghostManager(id);
            if (want == address(0)) want = handler.ghostOwner(id);
            assertEq(deed.managerOf(id), want);
        }
    }

    function invariant_noViolations() public view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }
}
