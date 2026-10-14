// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Guild} from "./Guild.sol";
import {GovernanceToken} from "./GovernanceToken.sol";
import {CouncilMultisig} from "./CouncilMultisig.sol";
import {GuildNameRegistry} from "./GuildNameRegistry.sol";
import {TokenStackDeployer} from "./TokenStackDeployer.sol";

/**
 * The Founding Rite, one transaction: deploy the guild, its governance module (token
 * voting or council multisig), mint the initial voting power to the founder, record the
 * metadata, hand EXECUTE_ROLE to the module and cut the factory out entirely. After this
 * transaction no key but the guild's own governance can act: the factory retains nothing.
 *
 * Modeled on the Aragon protocol-factory flow (whole protocol orchestrated on-chain in
 * one verifiable transaction), reduced to one guild per call.
 */
contract GuildFactory {
    enum Mode {
        Token,
        Council
    }

    struct FoundParams {
        string name; // registry handle: 1-64 chars, a-z 0-9 hyphen underscore
        string metadata; // guild metadata (text or an off-chain JSON pointer)
        Mode mode;
        // Token mode
        string tokenName;
        string tokenSymbol;
        uint256 initialSupply; // minted to the founder (msg.sender)
        uint256 supportThreshold; // bps, e.g. 5000 = 50%
        uint256 minParticipation; // bps of snapshot total supply
        uint64 minDuration; // seconds a vote stays open at minimum
        // Council mode
        address[] members;
        uint256 minApprovals;
    }

    GuildNameRegistry public immutable registry;
    TokenStackDeployer public immutable tokenStack;

    event GuildFounded(
        string name,
        address indexed guild,
        address indexed founder,
        Mode mode,
        address token,
        address module
    );

    constructor(GuildNameRegistry registry_, TokenStackDeployer tokenStack_) {
        registry = registry_;
        tokenStack = tokenStack_;
    }

    function foundGuild(
        FoundParams calldata p
    ) external returns (address guildAddr, address tokenAddr, address moduleAddr) {
        Guild guild = new Guild(address(this));
        guildAddr = address(guild);

        // The factory wires everything while it still holds ROOT, then revokes itself.
        guild.grant(guild.EXECUTE_ROLE(), address(this));

        if (p.mode == Mode.Token) {
            // The token stack deploys from its own contract so this factory stays under
            // the EIP-170 size cap; ownership of the token goes straight to the guild.
            (tokenAddr, moduleAddr) = tokenStack.deploy(
                guildAddr,
                p.tokenName,
                p.tokenSymbol,
                p.supportThreshold,
                p.minParticipation,
                p.minDuration
            );

            uint256 n = bytes(p.metadata).length > 0 ? 2 : (p.initialSupply > 0 ? 1 : 0);
            if (n > 0) {
                Guild.Action[] memory acts = new Guild.Action[](n);
                uint256 k = 0;
                if (p.initialSupply > 0) {
                    acts[k++] = Guild.Action({
                        to: tokenAddr,
                        value: 0,
                        data: abi.encodeCall(GovernanceToken.mint, (msg.sender, p.initialSupply))
                    });
                }
                if (bytes(p.metadata).length > 0) {
                    acts[k++] = Guild.Action({
                        to: guildAddr,
                        value: 0,
                        data: abi.encodeCall(Guild.setMetadata, (p.metadata))
                    });
                }
                guild.execute(acts);
            }
        } else {
            moduleAddr = address(new CouncilMultisig(guild, p.members, p.minApprovals));
            if (bytes(p.metadata).length > 0) {
                Guild.Action[] memory acts = new Guild.Action[](1);
                acts[0] = Guild.Action({
                    to: guildAddr,
                    value: 0,
                    data: abi.encodeCall(Guild.setMetadata, (p.metadata))
                });
                guild.execute(acts);
            }
        }

        guild.grant(guild.EXECUTE_ROLE(), moduleAddr);
        guild.revoke(guild.EXECUTE_ROLE(), address(this));
        guild.revoke(guild.ROOT_ROLE(), address(this));

        registry.register(p.name, guildAddr, tokenAddr, moduleAddr, uint8(p.mode));
        emit GuildFounded(p.name, guildAddr, msg.sender, p.mode, tokenAddr, moduleAddr);
    }
}
