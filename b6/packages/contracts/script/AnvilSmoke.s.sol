// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {QuestateDeed} from "../contracts/QuestateDeed.sol";
import {QuestateBrokerage} from "../contracts/QuestateBrokerage.sol";

/**
 * Live-node smoke: deploy the deed registry and brokerage desk, register a broker, mint a
 * deed, list it and close the sale at the ask — all against a running anvil. This is the
 * EVM-level dry run of the full questate closing path; a Quai deploy would go through the
 * same calls from scripts.
 *
 *   anvil --port 8545 &
 *   forge script script/AnvilSmoke.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
 *     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 */
contract AnvilSmoke is Script {
    function run() external {
        address deployer = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // anvil account 0
        address broker = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // anvil account 1
        address buyer = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // anvil account 2
        uint256 ask = 1 ether;
        uint16 commissionBps = 250;

        vm.startBroadcast(); // deployer is registrar of the deed desk and operator of the brokerage

        QuestateDeed deed = new QuestateDeed(deployer);
        QuestateBrokerage desk = new QuestateBrokerage(address(deed), deployer);
        desk.registerBroker(broker, "Anvil Brokerage", "LIC-ANVIL-1", commissionBps);

        QuestateDeed.MintParams memory p;
        p.recipient = deployer;
        p.legalDescription = "Lot 1, Block 0, Anvil Addition";
        p.physicalAddress = "1 Anvil Row";
        p.geoJson = "{\"type\":\"Point\",\"coordinates\":[0,0]}";
        p.parcelId = "ANVIL-PARCEL-1";
        p.legalOwner = "Dark Order LLC";
        p.operatingAgreementHash = keccak256("oa-anvil");
        p.metadataUri = "ipfs://anvil-deed";
        uint256 deedId = deed.mintDeed(p);

        deed.approve(address(desk), deedId);
        uint256 listingId = desk.createListing(deedId, ask, broker, "{\"smoke\":true}");

        vm.stopBroadcast();

        // The buyer closes at the exact ask.
        vm.broadcast(buyer);
        desk.buy{value: ask}(listingId, address(0), 0);

        (uint256 sellerNet, uint256 commission) = desk.quoteSettlement(listingId, ask);
        console2.log("deed registry  ", address(deed));
        console2.log("brokerage desk ", address(desk));
        console2.log("deedId         ", deedId);
        console2.log("listingId      ", listingId);
        console2.log("sellerNet      ", sellerNet);
        console2.log("commission     ", commission);
        console2.log("desk balance   ", address(desk).balance);
        require(deed.ownerOf(deedId) == buyer, "buyer must hold the deed");
        require(desk.proceeds(deployer) == sellerNet, "seller proceeds mismatch");
        require(desk.proceeds(broker) == commission, "broker commission mismatch");
        require(address(desk).balance == sellerNet + commission, "money identity broken");
        console2.log("ANVIL SMOKE OK");
    }
}
