// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeBuddyVault} from "./SafeBuddyVault.sol";
import {SafeBuddyVaultProxy} from "./SafeBuddyVaultProxy.sol";

/**
 * @title SafeBuddyVaultFactory
 * @notice Creates SafeBuddyVault instances as CREATE2 proxies to one fixed implementation.
 *
 * On Quai the vault address must fall in the caller's zone (Cyprus-1: first byte 0x00, with
 * the Quai-ledger bit clear), so clients mine `salt` off-chain with predictWalletAddress.
 * The caller's address is folded into the CREATE2 salt, so nobody can squat a mined salt.
 *
 * There is deliberately no way to register an externally deployed wallet: isWallet is true
 * only for vaults this factory created and initialised itself.
 */
contract SafeBuddyVaultFactory {
    error InvalidImplementation();

    address public immutable implementation;
    /// @notice keccak256 of every SafeBuddyVaultProxy's runtime code (identical across instances).
    bytes32 public immutable proxyCodeHash;

    mapping(address => bool) public isWallet;
    uint256 public walletCount;

    event WalletCreated(
        address indexed wallet,
        address indexed creator,
        address[] owners,
        uint256 threshold,
        uint32 minExecutionDelay,
        bytes32 salt
    );

    // The code-length check below also rejects address(0), which has no code.
    // forge-lint: disable-next-line(missing-zero-check)
    constructor(address implementation_) {
        if (implementation_.code.length == 0) revert InvalidImplementation();
        implementation = implementation_;
        proxyCodeHash = keccak256(type(SafeBuddyVaultProxy).runtimeCode);
    }

    /// @notice Validation happens in SafeBuddyVault.initialize; its errors bubble up unchanged.
    function createWallet(
        address[] calldata owners,
        uint256 threshold,
        uint32 minExecutionDelay,
        bytes32 salt
    ) external returns (address wallet) {
        wallet = address(
            new SafeBuddyVaultProxy{salt: _fullSalt(msg.sender, salt)}(
                implementation,
                _initData(owners, threshold, minExecutionDelay)
            )
        );
        isWallet[wallet] = true;
        walletCount += 1;
        // The only external call above is the new proxy's constructor, which runs our own pinned
        // proxy and implementation code and cannot call back into this factory.
        // forge-lint: disable-next-line(reentrancy-events)
        emit WalletCreated(wallet, msg.sender, owners, threshold, minExecutionDelay, salt);
    }

    function predictWalletAddress(
        address creator,
        address[] calldata owners,
        uint256 threshold,
        uint32 minExecutionDelay,
        bytes32 salt
    ) external view returns (address) {
        // CREATE2 init code is creation code followed by constructor arguments. The creation code
        // is a compile-time constant, so the packed encoding cannot collide.
        bytes memory args = abi.encode(implementation, _initData(owners, threshold, minExecutionDelay));
        // forge-lint: disable-next-line(encode-packed-collision)
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(SafeBuddyVaultProxy).creationCode, args));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _fullSalt(creator, salt), initCodeHash))))
        );
    }

    function _fullSalt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(creator, salt));
    }

    function _initData(address[] calldata owners, uint256 threshold, uint32 minExecutionDelay)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(SafeBuddyVault.initialize, (owners, threshold, minExecutionDelay));
    }
}
