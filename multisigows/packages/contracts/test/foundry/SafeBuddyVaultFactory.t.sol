// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultTestBase} from "./Base.sol";
import {SafeBuddyVault} from "../../contracts/v2/SafeBuddyVault.sol";
import {SafeBuddyVaultFactory} from "../../contracts/v2/SafeBuddyVaultFactory.sol";

contract SafeBuddyVaultFactoryFuzzTest is VaultTestBase {
    function setUp() public {
        deployShipped();
    }

    function _params(uint8 n, uint8 t, uint32 delay, uint256 seed)
        internal
        pure
        returns (address[] memory list, uint256 threshold, uint32 minDelay)
    {
        uint256 count = bound(n, 1, 20);
        list = owners(count, seed);
        threshold = bound(t, 1, count);
        minDelay = uint32(bound(delay, 0, MAX_DELAY));
    }

    /// predictWalletAddress is exactly where createWallet deploys, for any creator, salt and parameters.
    function testFuzz_predictionMatchesCreation(address creator, bytes32 salt, uint8 n, uint8 t, uint32 delay, uint256 seed) public {
        (address[] memory list, uint256 threshold, uint32 minDelay) = _params(n, t, delay, seed);
        address predicted = factory.predictWalletAddress(creator, list, threshold, minDelay, salt);
        vm.prank(creator);
        address wallet = factory.createWallet(list, threshold, minDelay, salt);
        assertEq(wallet, predicted);
        assertTrue(factory.isWallet(wallet));
        assertEq(keccak256(wallet.code), factory.proxyCodeHash());
        assertEq(keccak256(wallet.code), keccak256(artifactRuntime("SafeBuddyVaultProxy")));
        SafeBuddyVault v = SafeBuddyVault(payable(wallet));
        assertEq(v.getOwners(), list);
        assertEq(v.getThreshold(), threshold);
        assertEq(v.minExecutionDelay(), minDelay);
    }

    /// A salt someone mined cannot be taken by anyone else: the creator is part of the salt.
    function testFuzz_saltIsBoundToCreator(address a, address b, bytes32 salt, uint256 seed) public {
        vm.assume(a != b);
        address[] memory list = owners(2, seed);
        address forA = factory.predictWalletAddress(a, list, 1, 0, salt);
        assertTrue(forA != factory.predictWalletAddress(b, list, 1, 0, salt));
        vm.prank(b);
        factory.createWallet(list, 1, 0, salt);
        vm.prank(a);
        assertEq(factory.createWallet(list, 1, 0, salt), forA);
    }

    function testFuzz_invalidParametersRevertWithTheVaultsErrors(uint8 n, uint256 badThreshold, uint32 badDelay, uint256 seed) public {
        uint256 count = bound(n, 1, 20);
        address[] memory list = owners(count, seed);
        badThreshold = bound(badThreshold, count + 1, type(uint256).max);
        vm.expectRevert(SafeBuddyVault.InvalidThreshold.selector);
        factory.createWallet(list, badThreshold, 0, bytes32(0));
        vm.expectRevert(SafeBuddyVault.InvalidThreshold.selector);
        factory.createWallet(list, 0, 0, bytes32(0));
        badDelay = uint32(bound(badDelay, uint256(MAX_DELAY) + 1, type(uint32).max));
        vm.expectRevert(SafeBuddyVault.ExecutionDelayTooLong.selector);
        factory.createWallet(list, 1, badDelay, bytes32(0));
    }

    function testFuzz_ownersOutsideCyprus1AreRejected(address outsider, uint256 seed) public {
        vm.assume(uint160(outsider) >> 152 != 0);
        address[] memory list = owners(2, seed);
        list[1] = outsider;
        vm.expectRevert(abi.encodeWithSelector(SafeBuddyVault.InvalidOwnerAddress.selector, outsider));
        factory.createWallet(list, 1, 0, bytes32(0));
    }

    function test_tooManyOwnersAndDuplicatesAreRejected() public {
        address[] memory list = owners(21, 7);
        vm.expectRevert(SafeBuddyVault.TooManyOwners.selector);
        factory.createWallet(list, 1, 0, bytes32(0));
        address[] memory dup = owners(2, 7);
        dup[1] = dup[0];
        vm.expectRevert(abi.encodeWithSelector(SafeBuddyVault.DuplicateOwner.selector, dup[0]));
        factory.createWallet(dup, 1, 0, bytes32(0));
    }

    /// A proxy deployed outside the factory, even pointing at the real implementation, is never a registered wallet.
    function test_isWalletOnlyForFactoryCreatedVaults() public {
        address[] memory list = owners(2, 3);
        bytes memory init = abi.encodeCall(SafeBuddyVault.initialize, (list, 1, 0));
        address stray =
            deployCode_(abi.encodePacked(artifactBytecode("SafeBuddyVaultProxy"), abi.encode(address(implementation), init)));
        assertEq(keccak256(stray.code), factory.proxyCodeHash(), "same code as a real vault");
        assertFalse(factory.isWallet(stray), "but not registered");
    }

    function testFuzz_constructorRejectsCodelessImplementation(address impl) public {
        vm.assume(impl.code.length == 0);
        bytes memory init = abi.encodePacked(artifactBytecode("SafeBuddyVaultFactory"), abi.encode(impl));
        address deployed;
        assembly {
            deployed := create(0, add(init, 0x20), mload(init))
        }
        assertEq(deployed, address(0));
    }

    function test_walletCountTracksCreations() public {
        address[] memory list = owners(1, 9);
        for (uint256 i = 0; i < 3; i++) factory.createWallet(list, 1, 0, bytes32(i));
        assertEq(factory.walletCount(), 3);
    }
}
