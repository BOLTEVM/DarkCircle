// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {OrderTestBase} from "./Base.sol";
import {Guild} from "../../contracts/Guild.sol";

/// The whole protocol boots and both founding modes produce a wired, registry-listed guild.
contract SmokeTest is OrderTestBase {
    function test_protocolBootsAndFounds() public {
        deployProtocol();
        address founder = cyprus(1);

        (Guild tg,, ) = foundTokenGuild(founder, 1_000 ether);
        assertEq(registry.count(), 1);
        assertEq(registry.recordOf(address(tg)).guild, address(tg));

        address[] memory members = actors(3, 10);
        (Guild cg,) = foundCouncilGuild(founder, members, 2);
        assertEq(registry.count(), 2);
        assertEq(registry.recordOf(address(cg)).mode, 1);

        // The factory retains nothing on either guild.
        assertFalse(tg.hasPermission(tg.ROOT_ROLE(), address(factory)));
        assertFalse(tg.hasPermission(tg.EXECUTE_ROLE(), address(factory)));
        assertFalse(cg.hasPermission(cg.ROOT_ROLE(), address(factory)));
        assertFalse(cg.hasPermission(cg.EXECUTE_ROLE(), address(factory)));
    }
}
