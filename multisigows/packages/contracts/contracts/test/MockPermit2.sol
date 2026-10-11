// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Test-only stand-in for Uniswap Permit2, implementing exactly the subset
 * AgentPermit2Batcher calls, per this workspace's understanding of the public
 * `ISignatureTransfer` spec (see AgentPermit2Batcher.sol's doc comment on provenance).
 *
 * This is NOT Permit2's real bytecode. It exists to exercise AgentPermit2Batcher's own logic
 * (per-entry isolation, vault-fixed destination, access control) end-to-end, and to prove the
 * SDK's off-chain digest computation (permit2.ts) agrees with an independent on-chain
 * reimplementation of the same hashing rules. It does NOT prove compatibility with the genuine
 * deployed Permit2 contract â€” only testing against that contract's real bytecode can.
 */
contract MockPermit2 {
    bytes32 public constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 public constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    /// @dev nonce >> 8 => word; nonce & 0xff => bit within that word. Any unused value works.
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;

    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    error SignatureExpired(uint256 deadline);
    error InvalidNonce();
    error InvalidSignatureLength();
    error InvalidSigner();
    error InvalidAmount(uint256 requested);

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, address(this)));
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external {
        if (block.timestamp > permit.deadline) revert SignatureExpired(permit.deadline);
        if (transferDetails.requestedAmount > permit.permitted.amount) revert InvalidAmount(transferDetails.requestedAmount);

        _useNonce(owner, permit.nonce);

        bytes32 tokenPermissionsHash = keccak256(
            abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount)
        );
        // spender is msg.sender (whoever calls this), never a field the caller supplies directly.
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissionsHash, msg.sender, permit.nonce, permit.deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), DOMAIN_SEPARATOR(), structHash));

        if (_recover(digest, signature) != owner) revert InvalidSigner();

        IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }

    function _useNonce(address owner, uint256 nonce) private {
        uint256 wordPos = nonce >> 8;
        uint256 bitPos = nonce & 0xff;
        uint256 mask = 1 << bitPos;
        uint256 word = nonceBitmap[owner][wordPos];
        if (word & mask != 0) revert InvalidNonce();
        nonceBitmap[owner][wordPos] = word | mask;
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (v < 27) v += 27;
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSigner();
    }
}
