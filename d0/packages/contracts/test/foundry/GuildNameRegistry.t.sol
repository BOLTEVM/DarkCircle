// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {OrderTestBase} from "./Base.sol";
import {GuildNameRegistry} from "../../contracts/GuildNameRegistry.sol";

/// The registry is the on-chain directory of the halls: its charset rule is the contract
/// with QNS, and a record, once written at founding, must be immutable.
contract GuildNameRegistryFuzzTest is OrderTestBase {
    function setUp() public {
        deployProtocol();
    }

    /// The validator in the contract and this mirror must agree on every byte string:
    /// 1-64 chars, lowercase a-z 0-9 hyphen underscore (the QNS charset).
    function testFuzz_validationMatchesCharset(bytes memory raw) public {
        bytes memory b = _bound(raw, 80);
        string memory name = string(b);
        if (_valid(b)) {
            vm.prank(address(factory));
            registry.register(name, cyprus(900), address(0), cyprus(901), 1);
            assertEq(registry.resolve(name), cyprus(900));
        } else {
            vm.expectRevert(abi.encodeWithSelector(GuildNameRegistry.NameInvalid.selector, name));
            vm.prank(address(factory));
            registry.register(name, cyprus(900), address(0), cyprus(901), 1);
        }
    }

    function testFuzz_onlyDeployerWires(address caller) public {
        vm.assume(caller != address(this)); // deployProtocol ran from this contract
        GuildNameRegistry fresh = GuildNameRegistry(deployCode_(artifactBytecode("GuildNameRegistry")));
        vm.expectRevert(abi.encodeWithSelector(GuildNameRegistry.NotDeployer.selector, caller));
        vm.prank(caller);
        fresh.wire(caller);
    }

    function testFuzz_wireOnlyOnce(address other) public {
        vm.assume(other != address(0));
        vm.expectRevert(GuildNameRegistry.AlreadyWired.selector);
        registry.wire(other);
    }

    /// Wiring the zero address would leave the registry rewirable yet unusable; it reverts.
    function test_wireZeroReverts() public {
        GuildNameRegistry fresh = GuildNameRegistry(deployCode_(artifactBytecode("GuildNameRegistry")));
        vm.expectRevert(GuildNameRegistry.FactoryZero.selector);
        fresh.wire(address(0));
        // ...so the deployer can still wire the real factory afterwards.
        fresh.wire(cyprus(7));
        assertEq(fresh.factory(), cyprus(7));
    }

    function testFuzz_registerOnlyByFactory(address caller) public {
        vm.assume(caller != address(factory));
        vm.expectRevert(abi.encodeWithSelector(GuildNameRegistry.NotFactory.selector, caller));
        vm.prank(caller);
        registry.register("hall-x", cyprus(1), address(0), cyprus(2), 0);
    }

    /// A handle is claimed forever: the second registration of the same name must revert.
    function testFuzz_nameTakenForever(bytes32 salt) public {
        string memory name = _saltName(salt);
        vm.startPrank(address(factory));
        registry.register(name, cyprus(1), cyprus(2), cyprus(3), 0);
        vm.expectRevert(abi.encodeWithSelector(GuildNameRegistry.NameTaken.selector, name));
        registry.register(name, cyprus(4), cyprus(5), cyprus(6), 1);
        vm.stopPrank();
        // ...and the first record survived the attempt.
        GuildNameRegistry.GuildRecord memory r = registry.recordOf(cyprus(1));
        assertEq(r.name, name);
        assertEq(r.token, cyprus(2));
        assertEq(r.mode, 0);
    }

    /// A zero guild address must not count as a claim: without a guard the name would look
    /// free afterwards (the taken check reads _guilds[h] != address(0)).
    function testFuzz_zeroGuildRejected(bytes32 salt) public {
        string memory name = _saltName(salt);
        vm.startPrank(address(factory));
        vm.expectRevert(GuildNameRegistry.GuildZero.selector);
        registry.register(name, address(0), address(0), cyprus(3), 0);
        vm.stopPrank();
        assertEq(registry.resolve(name), address(0));
    }

    /// page() must return exactly the records in registration order, for any window.
    function testFuzz_pageWindows(uint8 countSeed, uint256 offset, uint256 limit) public {
        uint256 total = bound(countSeed, 0, 24);
        vm.startPrank(address(factory));
        for (uint256 i = 0; i < total; i++) {
            registry.register(_saltName(bytes32(i)), cyprus(100 + i), address(0), cyprus(200 + i), 0);
        }
        vm.stopPrank();

        offset = bound(offset, 0, total + 3);
        limit = bound(limit, 0, 30);
        GuildNameRegistry.GuildRecord[] memory page = registry.page(offset, limit);

        uint256 want = offset >= total ? 0 : ((total - offset > limit) ? limit : total - offset);
        assertEq(page.length, want);
        for (uint256 i = 0; i < page.length; i++) {
            assertEq(page[i].guild, cyprus(100 + offset + i));
            assertEq(page[i].name, _saltName(bytes32(offset + i)));
        }
    }

    // --- helpers -------------------------------------------------------------

    function _bound(bytes memory raw, uint256 maxLen) internal pure returns (bytes memory out) {
        uint256 n = raw.length > maxLen ? maxLen : raw.length;
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) out[i] = raw[i];
    }

    function _valid(bytes memory b) internal pure returns (bool) {
        if (b.length == 0 || b.length > 64) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7A) || c == 0x2D || c == 0x5F;
            if (!ok) return false;
        }
        return true;
    }

    /// A deterministic valid handle derived from fuzz entropy.
    function _saltName(bytes32 salt) internal pure returns (string memory) {
        bytes32 h = keccak256(abi.encode(salt));
        bytes memory out = new bytes(12);
        bytes memory alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        for (uint256 i = 0; i < 12; i++) {
            out[i] = alphabet[uint8(h[i]) % 36];
        }
        return string(out);
    }
}
