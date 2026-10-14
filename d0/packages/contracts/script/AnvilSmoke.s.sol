// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Guild} from "../contracts/Guild.sol";
import {GuildNameRegistry} from "../contracts/GuildNameRegistry.sol";
import {TokenStackDeployer} from "../contracts/TokenStackDeployer.sol";
import {GuildFactory} from "../contracts/GuildFactory.sol";
import {GovernanceToken} from "../contracts/GovernanceToken.sol";
import {MajorityVoting} from "../contracts/MajorityVoting.sol";

/**
 * Live-node smoke: deploy the protocol, wire it, found one guild of each mode and pay an
 * x402 tribute, all against a running anvil. This is the EVM-level dry run of the founding
 * rite; the Quai deploy itself goes through scripts/deploy-quai.mjs.
 *
 *   anvil --port 8545 &
 *   forge script script/AnvilSmoke.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
 *     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 */
contract AnvilSmoke is Script {
    function run() external {
        vm.startBroadcast();

        GuildNameRegistry registry = new GuildNameRegistry();
        TokenStackDeployer tokenStack = new TokenStackDeployer();
        GuildFactory factory = new GuildFactory(registry, tokenStack);
        registry.wire(address(factory));

        // Token hall
        GuildFactory.FoundParams memory tp;
        tp.name = "anvil-token-hall";
        tp.metadata = "darkorder:anvil-smoke";
        tp.mode = GuildFactory.Mode.Token;
        tp.tokenName = "Anvil Hall Token";
        tp.tokenSymbol = "AHT";
        tp.initialSupply = 1_000 ether;
        tp.supportThreshold = 5_000;
        tp.minParticipation = 1_000;
        tp.minDuration = 5 minutes;
        (address tg, address tt, address tm) = factory.foundGuild(tp);

        // Council hall
        address[] memory members = new address[](3);
        members[0] = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // anvil account 0
        members[1] = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // anvil account 1
        members[2] = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // anvil account 2
        GuildFactory.FoundParams memory cp;
        cp.name = "anvil-council-hall";
        cp.metadata = "darkorder:anvil-smoke";
        cp.mode = GuildFactory.Mode.Council;
        cp.members = members;
        cp.minApprovals = 2;
        (address cg,, address cm) = factory.foundGuild(cp);

        // x402 tribute into the token hall's treasury
        Guild(payable(tg)).payTribute{value: 0.01 ether}(keccak256("invoice-anvil-1"));

        vm.stopBroadcast();

        console2.log("registry       ", address(registry));
        console2.log("tokenStack     ", address(tokenStack));
        console2.log("factory        ", address(factory));
        console2.log("tokenHall      ", tg);
        console2.log("  token        ", tt);
        console2.log("  voting       ", tm);
        console2.log("  treasury wei ", tg.balance);
        console2.log("  token owner  ", GovernanceToken(tt).owner());
        console2.log("councilHall    ", cg);
        console2.log("  council      ", cm);
        console2.log("registry count ", registry.count());
        require(registry.count() == 2, "expected two halls");
        require(GovernanceToken(tt).owner() == tg, "token must be guild-owned");
        require(tg.balance == 0.01 ether, "tribute missing");
        require(MajorityVoting(tm).supportThreshold() == 5_000, "threshold mismatch");
        console2.log("ANVIL SMOKE OK");
    }
}
