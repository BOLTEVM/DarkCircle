// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {QuestateDeed} from "../../contracts/QuestateDeed.sol";
import {QuestateBrokerage} from "../../contracts/QuestateBrokerage.sol";

/**
 * Shared setup for the Dark Questate Foundry suites.
 *
 * Both contracts are deployed from the Hardhat artifacts, i.e. the exact bytecode
 * scripts/deploy-quai.mjs ships to Quai. Foundry's own compile of those contracts is used
 * only for their ABIs. Run `hardhat compile` before `forge test`.
 */
abstract contract QuestateTestBase is Test {
    address internal registrar = cyprus(900);
    address internal operator = cyprus(901);

    QuestateDeed internal deed;
    QuestateBrokerage internal desk;

    function artifactBytecode(string memory name) internal view returns (bytes memory) {
        string memory json = vm.readFile(string.concat("artifacts/contracts/", name, ".sol/", name, ".json"));
        return vm.parseJsonBytes(json, ".bytecode");
    }

    function deployCode_(bytes memory initCode) internal returns (address deployed) {
        assembly {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(deployed != address(0), "deployment failed");
    }

    function deployDesk() internal {
        deed = QuestateDeed(deployCode_(abi.encodePacked(artifactBytecode("QuestateDeed"), abi.encode(registrar))));
        desk = QuestateBrokerage(
            deployCode_(abi.encodePacked(artifactBytecode("QuestateBrokerage"), abi.encode(address(deed), operator)))
        );
    }

    /// @dev Deterministic Cyprus-1 Quai-ledger address: first byte 0x00, second byte below 0x80.
    function cyprus(uint256 seed) internal pure returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encode("questate.actor", seed)))) >> 9);
        if (uint160(a) <= 1) a = address(uint160(0x0000_1000));
    }

    function actors(uint256 count, uint256 seedBase) internal pure returns (address[] memory list) {
        list = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            list[i] = cyprus(seedBase + i);
        }
    }

    uint256 private _parcelNonce;

    function _mintDeed(address to) internal returns (uint256 id) {
        QuestateDeed.MintParams memory p;
        p.recipient = to;
        p.legalDescription = "Lot 7, Block 3";
        p.physicalAddress = "1 Obsidian Row";
        p.geoJson = "{\"type\":\"Point\"}";
        p.parcelId = string.concat("PARCEL-", vm.toString(++_parcelNonce));
        p.legalOwner = "Dark Order LLC";
        p.operatingAgreementHash = keccak256(abi.encodePacked("oa", _parcelNonce));
        p.metadataUri = "ipfs://deed";
        vm.prank(registrar);
        id = deed.mintDeed(p);
    }

    function _registerBroker(address broker, uint16 bps) internal {
        vm.prank(operator);
        desk.registerBroker(broker, "Desk Broker", "LIC-1", bps);
    }

    /// Seller lists a deed they hold; the desk takes custody.
    function _list(address seller, uint256 deedId, uint256 ask, address broker) internal returns (uint256 listingId) {
        vm.prank(seller);
        deed.approve(address(desk), deedId);
        vm.prank(seller);
        listingId = desk.createListing(deedId, ask, broker, "{}");
    }
}
