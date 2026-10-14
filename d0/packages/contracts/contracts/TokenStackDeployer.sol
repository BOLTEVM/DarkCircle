// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Guild} from "./Guild.sol";
import {GovernanceToken} from "./GovernanceToken.sol";
import {MajorityVoting} from "./MajorityVoting.sol";

/**
 * Deploys the token-voting stack (GovernanceToken + MajorityVoting) for one guild.
 *
 * This contract exists for one reason: EIP-170 caps deployed bytecode at 24 KiB, and a
 * factory that embeds the creation code of every contract a guild needs (guild, token,
 * voting, council) comes out near 32 KiB. Splitting the token stack out keeps both this
 * deployer and the GuildFactory under the cap. It is stateless and immutable: deployed
 * once as part of the protocol, it only ever runs `new` on behalf of the factory.
 *
 * The freshly deployed token is owned by the guild itself, so minting stays a governance
 * act; the deployer keeps no role on anything it creates.
 */
contract TokenStackDeployer {
    function deploy(
        address guild,
        string memory tokenName,
        string memory tokenSymbol,
        uint256 supportThreshold,
        uint256 minParticipation,
        uint64 minDuration
    ) external returns (address token, address module) {
        GovernanceToken t = new GovernanceToken(tokenName, tokenSymbol, guild, 0);
        MajorityVoting v = new MajorityVoting(Guild(payable(guild)), t, supportThreshold, minParticipation, minDuration);
        return (address(t), address(v));
    }
}
