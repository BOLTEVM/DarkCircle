// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Guild} from "../../contracts/Guild.sol";
import {GovernanceToken} from "../../contracts/GovernanceToken.sol";
import {MajorityVoting} from "../../contracts/MajorityVoting.sol";
import {CouncilMultisig} from "../../contracts/CouncilMultisig.sol";
import {GuildNameRegistry} from "../../contracts/GuildNameRegistry.sol";
import {TokenStackDeployer} from "../../contracts/TokenStackDeployer.sol";
import {GuildFactory} from "../../contracts/GuildFactory.sol";

/**
 * Shared setup for the Foundry suites.
 *
 * Every protocol contract is deployed from the Hardhat artifacts, i.e. the exact bytecode
 * scripts/deploy-quai.mjs ships to Quai. Foundry's own compile of those contracts is used
 * only for their ABIs. Run `hardhat compile` before `forge test`.
 */
abstract contract OrderTestBase is Test {
    GuildNameRegistry internal registry;
    TokenStackDeployer internal tokenStack;
    GuildFactory internal factory;

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

    /// Registry, token stack and factory, wired exactly as scripts/deploy-quai.mjs wires them.
    function deployProtocol() internal {
        registry = GuildNameRegistry(deployCode_(artifactBytecode("GuildNameRegistry")));
        tokenStack = TokenStackDeployer(deployCode_(artifactBytecode("TokenStackDeployer")));
        factory = GuildFactory(
            deployCode_(
                abi.encodePacked(artifactBytecode("GuildFactory"), abi.encode(address(registry), address(tokenStack)))
            )
        );
        registry.wire(address(factory));
    }

    /// @dev Deterministic Cyprus-1 Quai-ledger address: first byte 0x00, second byte below 0x80.
    function cyprus(uint256 seed) internal pure returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encode("darkorder.actor", seed)))) >> 9);
        if (uint160(a) <= 1) a = address(uint160(0x0000_1000));
    }

    function actors(uint256 count, uint256 seedBase) internal pure returns (address[] memory list) {
        list = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            list[i] = cyprus(seedBase + i);
        }
    }

    uint256 private _nameNonce;

    function _nextName() internal returns (string memory) {
        return string.concat("hall-", vm.toString(++_nameNonce));
    }

    /// Found a token-mode guild through the factory with sensible defaults.
    function foundTokenGuild(address founder, uint256 initialSupply)
        internal
        returns (Guild guild, GovernanceToken token, MajorityVoting voting)
    {
        GuildFactory.FoundParams memory p;
        p.name = _nextName();
        p.metadata = "darkorder:test";
        p.mode = GuildFactory.Mode.Token;
        p.tokenName = "Hall Token";
        p.tokenSymbol = "HALL";
        p.initialSupply = initialSupply;
        p.supportThreshold = 5_000;
        p.minParticipation = 1_000;
        p.minDuration = 1 hours;
        vm.prank(founder);
        (address g, address t, address m) = factory.foundGuild(p);
        guild = Guild(payable(g));
        token = GovernanceToken(t);
        voting = MajorityVoting(m);
    }

    /// Found a council-mode guild through the factory.
    function foundCouncilGuild(address founder, address[] memory members, uint256 minApprovals)
        internal
        returns (Guild guild, CouncilMultisig council)
    {
        GuildFactory.FoundParams memory p;
        p.name = _nextName();
        p.metadata = "darkorder:test";
        p.mode = GuildFactory.Mode.Council;
        p.members = members;
        p.minApprovals = minApprovals;
        vm.prank(founder);
        (address g,, address m) = factory.foundGuild(p);
        guild = Guild(payable(g));
        council = CouncilMultisig(m);
    }

    /// Move past the founding block so a proposal snapshot (block.number - 1) sees delegations.
    function rollPastSnapshot() internal {
        vm.roll(block.number + 1);
    }
}

/// A sink that records what a guild `execute` batch sent it, and can be told to fail.
contract Sink {
    uint256 public received;
    uint256 public calls;
    bool public fail;

    function setFail(bool f) external {
        fail = f;
    }

    function poke(uint256 x) external payable returns (uint256) {
        require(!fail, "Sink: told to fail");
        received += msg.value;
        calls += 1;
        return x + 1;
    }

    function failNow() external payable {
        revert("Sink: failNow");
    }

    receive() external payable {
        require(!fail, "Sink: told to fail");
        received += msg.value;
    }
}
