// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {OrderTestBase} from "./Base.sol";
import {Guild} from "../../contracts/Guild.sol";
import {GovernanceToken} from "../../contracts/GovernanceToken.sol";
import {MajorityVoting} from "../../contracts/MajorityVoting.sol";
import {CouncilMultisig} from "../../contracts/CouncilMultisig.sol";
import {GuildNameRegistry} from "../../contracts/GuildNameRegistry.sol";
import {GuildFactory} from "../../contracts/GuildFactory.sol";

/// The Founding Rite is one transaction that must leave no way back: when it returns, the
/// factory holds no role on the guild it created, governance holds EXECUTE, the token is
/// owned by the guild alone, and the registry record matches reality.
contract GuildFactoryFuzzTest is OrderTestBase {
    function setUp() public {
        deployProtocol();
    }

    function _tokenParams(uint256 supply, uint256 support, uint256 participation)
        internal
        returns (GuildFactory.FoundParams memory p)
    {
        p.name = _nextName();
        p.metadata = "darkorder:test";
        p.mode = GuildFactory.Mode.Token;
        p.tokenName = "Hall Token";
        p.tokenSymbol = "HALL";
        p.initialSupply = supply;
        p.supportThreshold = support;
        p.minParticipation = participation;
        p.minDuration = 1 hours;
    }

    function testFuzz_tokenModeLeavesNoWayBack(uint96 supply, uint32 s, uint32 p) public {
        uint256 support = bound(s, 0, 10_000);
        uint256 participation = bound(p, 0, 10_000);
        address founder = cyprus(1);

        GuildFactory.FoundParams memory params = _tokenParams(supply, support, participation);
        vm.prank(founder);
        (address g, address t, address m) = factory.foundGuild(params);
        Guild guild = Guild(payable(g));
        GovernanceToken token = GovernanceToken(t);
        MajorityVoting voting = MajorityVoting(m);

        // The factory is fully cut out.
        assertFalse(guild.hasPermission(guild.ROOT_ROLE(), address(factory)));
        assertFalse(guild.hasPermission(guild.EXECUTE_ROLE(), address(factory)));
        // Governance holds the only EXECUTE grant besides the guild itself.
        assertTrue(guild.hasPermission(guild.EXECUTE_ROLE(), m));
        // Minting is a governance act: the guild owns the token.
        assertEq(token.owner(), g);
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(founder), supply);
        // The voting module points at the real guild and token, with the founding thresholds.
        assertEq(address(voting.guild()), g);
        assertEq(address(voting.token()), t);
        assertEq(voting.supportThreshold(), support);
        assertEq(voting.minParticipation(), participation);
        assertEq(voting.minDuration(), 1 hours);
        // The directory record matches reality.
        GuildNameRegistry.GuildRecord memory r = registry.recordOf(g);
        assertEq(r.name, params.name);
        assertEq(r.token, t);
        assertEq(r.module, m);
        assertEq(r.mode, 0);
        assertEq(registry.resolve(params.name), g);
        assertEq(keccak256(bytes(guild.metadata())), keccak256("darkorder:test"));
    }

    function testFuzz_councilModeLeavesNoWayBack(uint8 n, uint8 minAseed) public {
        n = uint8(bound(n, 1, 8));
        uint256 minA = bound(minAseed, 1, n);
        address founder = cyprus(1);
        address[] memory members = actors(n, 800);

        GuildFactory.FoundParams memory params;
        params.name = _nextName();
        params.metadata = "darkorder:test";
        params.mode = GuildFactory.Mode.Council;
        params.members = members;
        params.minApprovals = minA;
        vm.prank(founder);
        (address g, address t, address m) = factory.foundGuild(params);
        Guild guild = Guild(payable(g));
        CouncilMultisig council = CouncilMultisig(m);

        assertEq(t, address(0));
        assertFalse(guild.hasPermission(guild.ROOT_ROLE(), address(factory)));
        assertFalse(guild.hasPermission(guild.EXECUTE_ROLE(), address(factory)));
        assertTrue(guild.hasPermission(guild.EXECUTE_ROLE(), m));
        assertEq(council.memberCount(), n);
        assertEq(council.minApprovals(), minA);
        assertEq(address(council.guild()), g);

        GuildNameRegistry.GuildRecord memory r = registry.recordOf(g);
        assertEq(r.mode, 1);
        assertEq(r.token, address(0));
        assertEq(r.module, m);
    }

    function testFuzz_invalidThresholdsPropagate(uint32 s, uint32 p) public {
        uint256 support = uint256(s) + (uint256(p) % 2) * 10_001; // at least one branch goes over
        uint256 participation = p;
        vm.assume(support > 10_000 || participation > 10_000);

        GuildFactory.FoundParams memory params = _tokenParams(0, support, participation);
        uint256 bad = support > 10_000 ? support : participation;
        vm.expectRevert(abi.encodeWithSelector(MajorityVoting.ThresholdInvalid.selector, bad));
        vm.prank(cyprus(1));
        factory.foundGuild(params);
    }

    function testFuzz_invalidCouncilPropagates(uint8 n, uint256 minA) public {
        n = uint8(bound(n, 1, 8));
        vm.assume(minA == 0 || minA > n);
        GuildFactory.FoundParams memory params;
        params.name = _nextName();
        params.mode = GuildFactory.Mode.Council;
        params.members = actors(n, 900);
        params.minApprovals = minA;
        vm.expectRevert(
            abi.encodeWithSelector(CouncilMultisig.MinApprovalsInvalid.selector, minA, uint256(n))
        );
        vm.prank(cyprus(1));
        factory.foundGuild(params);
    }

    /// The second guild that wants a taken handle reverts, and the first guild keeps it.
    function testFuzz_handlesAreUnique() public {
        string memory name = "the-dark-hall";
        GuildFactory.FoundParams memory a = _tokenParams(1 ether, 5_000, 0);
        a.name = name;
        vm.prank(cyprus(1));
        (address first,,) = factory.foundGuild(a);

        GuildFactory.FoundParams memory b = _tokenParams(2 ether, 5_000, 0);
        b.name = name;
        vm.expectRevert(abi.encodeWithSelector(GuildNameRegistry.NameTaken.selector, name));
        vm.prank(cyprus(2));
        factory.foundGuild(b);

        assertEq(registry.resolve(name), first);
        assertEq(registry.count(), 1);
    }

    /// Every found, of either mode, lands in the directory in order.
    function testFuzz_directoryEnumeratesEveryFound(uint8 k) public {
        k = uint8(bound(k, 1, 12));
        address[] memory members = actors(3, 950);
        for (uint256 i = 0; i < k; i++) {
            if (i % 2 == 0) foundTokenGuild(cyprus(1), 1 ether);
            else foundCouncilGuild(cyprus(1), members, 2);
        }
        assertEq(registry.count(), k);
        GuildNameRegistry.GuildRecord[] memory all = registry.page(0, k);
        assertEq(all.length, k);
        for (uint256 i = 0; i < k; i++) {
            assertEq(all[i].mode, i % 2 == 0 ? 0 : 1);
            assertTrue(all[i].guild != address(0));
            assertEq(registry.resolve(all[i].name), all[i].guild);
        }
    }

    /// Metadata is optional: an empty metadata string skips the execute path entirely.
    function test_emptyMetadataFounds() public {
        GuildFactory.FoundParams memory params = _tokenParams(1 ether, 5_000, 0);
        params.metadata = "";
        vm.prank(cyprus(1));
        (address g,,) = factory.foundGuild(params);
        assertEq(bytes(Guild(payable(g)).metadata()).length, 0);
    }
}
