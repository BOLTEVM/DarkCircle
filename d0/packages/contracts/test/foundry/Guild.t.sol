// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {OrderTestBase, Sink} from "./Base.sol";
import {Guild} from "../../contracts/Guild.sol";

/// The guild core: a permission manager where value only leaves through `execute`, and a
/// batch of actions is all-or-nothing. These properties are what every governance module
/// relies on, so they are fuzzed directly against the shipped bytecode.
contract GuildFuzzTest is OrderTestBase {
    Guild internal guild; // this test contract is ROOT
    address internal executor = cyprus(50);
    Sink internal sink;

    function setUp() public {
        guild = Guild(payable(deployCode_(abi.encodePacked(artifactBytecode("Guild"), abi.encode(address(this))))));
        guild.grant(guild.EXECUTE_ROLE(), executor);
        sink = new Sink();
    }

    function testFuzz_grantRevokeLifecycle(address who, bytes32 role) public {
        vm.assume(who != address(0) && who != address(guild) && who != address(this));

        assertFalse(guild.hasPermission(role, who));
        guild.grant(role, who);
        assertTrue(guild.hasPermission(role, who));

        vm.expectRevert(abi.encodeWithSelector(Guild.AlreadyGranted.selector, role, who));
        guild.grant(role, who);

        guild.revoke(role, who);
        assertFalse(guild.hasPermission(role, who));

        vm.expectRevert(abi.encodeWithSelector(Guild.NotGranted.selector, role, who));
        guild.revoke(role, who);
    }

    function testFuzz_onlyRootGrants(address caller, address who) public {
        // Hoist both role reads: an external call inside the pranked call's arguments would
        // consume the prank, and the grant would run as this (ROOT-holding) contract.
        bytes32 root = guild.ROOT_ROLE();
        bytes32 exec = guild.EXECUTE_ROLE();
        vm.assume(!guild.hasPermission(root, caller));
        vm.expectRevert(abi.encodeWithSelector(Guild.Unauthorized.selector, root, caller));
        vm.prank(caller);
        guild.grant(exec, who);
    }

    function testFuzz_onlyExecutorExecutes(address caller) public {
        vm.assume(caller != executor && caller != address(guild));
        Guild.Action[] memory acts = new Guild.Action[](1);
        acts[0] = Guild.Action({to: address(sink), value: 0, data: abi.encodeCall(Sink.poke, (1))});
        vm.expectRevert(abi.encodeWithSelector(Guild.Unauthorized.selector, guild.EXECUTE_ROLE(), caller));
        vm.prank(caller);
        guild.execute(acts);
    }

    /// Tribute and plain receives must add up to the treasury balance exactly.
    function testFuzz_tributeAccumulates(uint96 a, uint96 b, bytes32 invoice) public {
        address alice = cyprus(60);
        address bob = cyprus(61);
        vm.deal(alice, uint256(a) + b);
        vm.deal(bob, uint256(a) + b);

        vm.prank(alice);
        guild.payTribute{value: a}(invoice);
        vm.prank(bob);
        (bool ok,) = address(guild).call{value: b}("");
        assertTrue(ok);

        assertEq(address(guild).balance, uint256(a) + b);
    }

    /// An executed action moves exactly `value` from treasury to target, no more, no less.
    function testFuzz_executeMovesExactValue(uint96 tribute, uint96 spend) public {
        vm.assume(spend <= tribute);
        vm.deal(address(this), tribute);
        guild.payTribute{value: tribute}(bytes32(uint256(1)));

        Guild.Action[] memory acts = new Guild.Action[](1);
        acts[0] = Guild.Action({to: address(sink), value: spend, data: abi.encodeCall(Sink.poke, (7))});
        vm.prank(executor);
        guild.execute(acts);

        assertEq(sink.received(), spend);
        assertEq(address(guild).balance, uint256(tribute) - spend);
    }

    /// If any action in a batch fails, the whole batch reverts: no partial proposal.
    function testFuzz_batchIsAllOrNothing(uint96 tribute, bool failFirst) public {
        vm.deal(address(this), tribute);
        guild.payTribute{value: tribute}(bytes32(uint256(2)));

        uint256 half = uint256(tribute) / 2;
        Guild.Action[] memory acts = new Guild.Action[](2);
        acts[failFirst ? 1 : 0] = Guild.Action({to: address(sink), value: half, data: abi.encodeCall(Sink.poke, (1))});
        acts[failFirst ? 0 : 1] = Guild.Action({to: address(sink), value: half, data: abi.encodeWithSignature("failNow()")});

        vm.expectRevert(abi.encodeWithSelector(Guild.ActionFailed.selector, failFirst ? 0 : 1));
        vm.prank(executor);
        guild.execute(acts);

        assertEq(sink.received(), 0);
        assertEq(sink.calls(), 0);
        assertEq(address(guild).balance, tribute);
    }

    /// The guild always holds every permission over itself; nothing can revoke that.
    function testFuzz_selfPermissionImmutable(bytes32 role) public {
        assertTrue(guild.hasPermission(role, address(guild)));
        vm.expectRevert(abi.encodeWithSelector(Guild.NotGranted.selector, role, address(guild)));
        guild.revoke(role, address(guild));
        assertTrue(guild.hasPermission(role, address(guild)));
    }
}
