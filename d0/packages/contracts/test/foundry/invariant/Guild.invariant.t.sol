// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {OrderTestBase, Sink} from "../Base.sol";
import {Guild} from "../../../contracts/Guild.sol";

bytes32 constant ROOT_ROLE = keccak256("ROOT_ROLE");
bytes32 constant EXECUTE_ROLE = keccak256("EXECUTE_ROLE");
bytes32 constant SET_METADATA_ROLE = keccak256("SET_METADATA_ROLE");

/**
 * Stateful campaign over the guild core. The handler holds ROOT and EXECUTE; random actors
 * get granted and revoked at will while tribute flows in and lawful batches spend it.
 * Whatever happens: the treasury equals tracked inflows minus tracked spends, and no
 * outsider ever executes.
 */
contract GuildHandler is Test {
    Guild public guild;
    Sink public sink;
    address[] public actorList;

    uint256 public expectedTreasury;
    uint256 public violations;
    string public firstViolation;

    bytes32[] internal _roles;

    constructor(Guild guild_, Sink sink_, address[] memory actors_) {
        guild = guild_;
        sink = sink_;
        actorList = actors_;
        _roles.push(ROOT_ROLE);
        _roles.push(EXECUTE_ROLE);
        _roles.push(SET_METADATA_ROLE);
    }

    function _violation(string memory what) internal {
        violations++;
        if (bytes(firstViolation).length == 0) firstViolation = what;
    }

    function _actor(uint8 seed) internal view returns (address) {
        return actorList[seed % actorList.length];
    }

    function tribute(uint96 amount) public {
        amount = uint96(bound(amount, 0, 1 ether));
        vm.deal(address(this), amount);
        guild.payTribute{value: amount}(keccak256(abi.encode(amount, expectedTreasury)));
        expectedTreasury += amount;
    }

    function plainReceive(uint96 amount) public {
        amount = uint96(bound(amount, 0, 1 ether));
        vm.deal(address(this), amount);
        (bool ok,) = address(guild).call{value: amount}("");
        require(ok, "plain receive reverted");
        expectedTreasury += amount;
    }

    function grantRole(uint8 roleSeed, uint8 whoSeed) public {
        try guild.grant(_roles[roleSeed % _roles.length], _actor(whoSeed)) {} catch {}
    }

    function revokeRole(uint8 roleSeed, uint8 whoSeed) public {
        try guild.revoke(_roles[roleSeed % _roles.length], _actor(whoSeed)) {} catch {}
    }

    /// The handler holds EXECUTE_ROLE, so this is a lawful proposal spend.
    function executeToSink(uint96 value) public {
        uint256 v = bound(value, 0, address(guild).balance);
        Guild.Action[] memory acts = new Guild.Action[](1);
        acts[0] = Guild.Action({to: address(sink), value: v, data: abi.encodeCall(Sink.poke, (v))});
        guild.execute(acts);
        expectedTreasury -= v;
    }

    /// An actor without EXECUTE_ROLE must never get a batch through.
    function outsiderExecute(uint8 whoSeed) public {
        address who = _actor(whoSeed);
        if (guild.hasPermission(EXECUTE_ROLE, who)) return;
        Guild.Action[] memory acts = new Guild.Action[](1);
        acts[0] = Guild.Action({to: address(sink), value: 0, data: abi.encodeCall(Sink.poke, (1))});
        vm.prank(who);
        try guild.execute(acts) {
            _violation("outsider executed a batch");
        } catch {}
    }
}

contract GuildInvariantTest is OrderTestBase {
    Guild internal guild;
    Sink internal sink;
    GuildHandler internal handler;
    address[] internal actorList;

    function setUp() public {
        // The test contract founds the guild and hands the handler ROOT + EXECUTE.
        guild = Guild(payable(deployCode_(abi.encodePacked(artifactBytecode("Guild"), abi.encode(address(this))))));
        sink = new Sink();
        actorList = actors(8, 1000);
        handler = new GuildHandler(guild, sink, actorList);
        guild.grant(ROOT_ROLE, address(handler));
        guild.grant(EXECUTE_ROLE, address(handler));

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = GuildHandler.tribute.selector;
        selectors[1] = GuildHandler.plainReceive.selector;
        selectors[2] = GuildHandler.grantRole.selector;
        selectors[3] = GuildHandler.revokeRole.selector;
        selectors[4] = GuildHandler.executeToSink.selector;
        selectors[5] = GuildHandler.executeToSink.selector; // spends are where the rules bite
        selectors[6] = GuildHandler.outsiderExecute.selector;
        selectors[7] = GuildHandler.outsiderExecute.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Treasury accounting: balance == everything paid in minus everything executed out.
    function invariant_treasuryAccounting() public view {
        assertEq(address(guild).balance, handler.expectedTreasury());
    }

    /// The permission wall held through every random sequence.
    function invariant_noUnsafeExecution() public view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }

    /// The guild always holds every permission over itself.
    function invariant_selfPermission() public view {
        assertTrue(guild.hasPermission(ROOT_ROLE, address(guild)));
        assertTrue(guild.hasPermission(EXECUTE_ROLE, address(guild)));
        assertTrue(guild.hasPermission(keccak256("ANY_ROLE_AT_ALL"), address(guild)));
    }
}
