// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title CircleswapAirdrop
 * @notice Pays two tokens (Q0 and QAXE) to the accounts in a Merkle tree, once each, on request.
 *
 * @dev Flow, in the order it is meant to be used:
 *        1. the owner deploys this contract and TRANSFERS the two tokens to it (a plain ERC-20 transfer);
 *        2. the owner publishes the distribution file (index, account, amounts, proof for everyone) and calls
 *           `setMerkleRoot` ONCE with the root, the totals the tree adds up to, and a claim deadline;
 *        3. any account in the tree calls `claim` (or anyone calls it for them: the tokens go to the account);
 *        4. after the deadline the owner may `sweep` whatever was not claimed.
 *
 *      What it guarantees, and what it does not:
 *        - the root can be set once and never changed, so the owner cannot move an allocation after people can
 *          see it. A root set to the wrong tree is the one mistake nothing here can undo: check the published file
 *          against the root before calling `setMerkleRoot`;
 *        - `setMerkleRoot` refuses unless the contract already holds the full totals, so every claim in the tree is
 *          payable, and a claim cannot fail for want of funds;
 *        - each index claims once (a bitmap), and the leaf hashes (index, account, amountA, amountB) twice, so a leaf
 *          cannot be passed off as an inner node of the tree;
 *        - the owner cannot touch the two airdrop tokens before the deadline. Any OTHER token sent here by mistake
 *          can be returned at any time.
 *
 *      Not supported: fee-on-transfer or rebasing tokens (the balance check and the payouts assume face value).
 */
contract CircleswapAirdrop is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The first token of the pot (Q0).
    IERC20 public immutable tokenA;
    /// @notice The second token of the pot (QAXE).
    IERC20 public immutable tokenB;

    /// @notice The tree of allocations. Zero until the owner sets it; set exactly once.
    bytes32 public merkleRoot;
    /// @notice The sum of every amountA in the tree: what the contract had to hold when the root was set.
    uint256 public totalA;
    /// @notice The sum of every amountB in the tree.
    uint256 public totalB;
    /// @notice Last second at which a claim is accepted. Zero until the root is set.
    uint64 public claimDeadline;

    /// @notice Paid out so far.
    uint256 public claimedA;
    uint256 public claimedB;

    /// @notice A claim window must be at least this long, so the people in the tree cannot be shut out by a short one.
    uint64 public constant MIN_CLAIM_WINDOW = 14 days;

    mapping(uint256 => uint256) private claimedBitMap;

    event MerkleRootSet(bytes32 indexed root, uint256 totalA, uint256 totalB, uint64 claimDeadline);
    event Claimed(uint256 indexed index, address indexed account, uint256 amountA, uint256 amountB);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error SameToken();
    error RootAlreadySet();
    error RootNotSet();
    error EmptyRoot();
    error DeadlineTooSoon(uint64 earliest);
    error NotFunded(uint256 haveA, uint256 needA, uint256 haveB, uint256 needB);
    error ClaimWindowClosed();
    error AlreadyClaimed();
    error InvalidProof();
    error NothingToClaim();
    error ClaimWindowOpen(uint64 until);

    constructor(address initialOwner, IERC20 tokenA_, IERC20 tokenB_) Ownable(initialOwner) {
        if (address(tokenA_) == address(0) || address(tokenB_) == address(0)) revert ZeroAddress();
        if (address(tokenA_) == address(tokenB_)) revert SameToken();
        tokenA = tokenA_;
        tokenB = tokenB_;
    }

    // ---------------------------------------------------------------------------------------------------- owner

    /**
     * @notice Open the claim window with the tree the owner has published. Callable once.
     * @param root     The Merkle root of the leaves keccak256(keccak256(abi.encode(index, account, amountA, amountB))).
     * @param totalA_  The sum of every amountA in the tree.
     * @param totalB_  The sum of every amountB in the tree.
     * @param deadline Unix time of the last accepted claim; at least MIN_CLAIM_WINDOW from now.
     */
    function setMerkleRoot(bytes32 root, uint256 totalA_, uint256 totalB_, uint64 deadline) external onlyOwner {
        if (merkleRoot != bytes32(0)) revert RootAlreadySet();
        if (root == bytes32(0)) revert EmptyRoot();
        uint64 earliest = uint64(block.timestamp) + MIN_CLAIM_WINDOW;
        if (deadline < earliest) revert DeadlineTooSoon(earliest);
        uint256 haveA = tokenA.balanceOf(address(this));
        uint256 haveB = tokenB.balanceOf(address(this));
        if (haveA < totalA_ || haveB < totalB_) revert NotFunded(haveA, totalA_, haveB, totalB_);

        merkleRoot = root;
        totalA = totalA_;
        totalB = totalB_;
        claimDeadline = deadline;
        emit MerkleRootSet(root, totalA_, totalB_, deadline);
    }

    /**
     * @notice Return tokens to `to`. The two airdrop tokens only once the claim window has closed (everything that was
     *         not claimed, plus any dust); any other token at any time.
     */
    function sweep(IERC20 token, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == tokenA || token == tokenB) {
            // before the root is set nothing is promised yet, so the owner may take their own deposit back
            if (merkleRoot != bytes32(0) && block.timestamp <= claimDeadline) revert ClaimWindowOpen(claimDeadline);
        }
        uint256 amount = token.balanceOf(address(this));
        if (amount > 0) token.safeTransfer(to, amount);
        emit Swept(address(token), to, amount);
    }

    // --------------------------------------------------------------------------------------------------- claims

    /// @notice Whether an index has been paid.
    function isClaimed(uint256 index) public view returns (bool) {
        uint256 word = claimedBitMap[index / 256];
        return word & (1 << (index % 256)) != 0;
    }

    /**
     * @notice Pay `account` its allocation. Anyone may call it; the tokens always go to `account`.
     * @param index    The account's position in the tree.
     * @param account  The account the allocation belongs to.
     * @param amountA  Its amount of the first token.
     * @param amountB  Its amount of the second token.
     * @param proof    Sibling hashes from its leaf to the root.
     */
    function claim(uint256 index, address account, uint256 amountA, uint256 amountB, bytes32[] calldata proof)
        external
        nonReentrant
    {
        if (merkleRoot == bytes32(0)) revert RootNotSet();
        if (block.timestamp > claimDeadline) revert ClaimWindowClosed();
        if (amountA == 0 && amountB == 0) revert NothingToClaim();
        if (isClaimed(index)) revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amountA, amountB))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();

        claimedBitMap[index / 256] |= (1 << (index % 256));
        claimedA += amountA;
        claimedB += amountB;
        if (amountA > 0) tokenA.safeTransfer(account, amountA);
        if (amountB > 0) tokenB.safeTransfer(account, amountB);
        emit Claimed(index, account, amountA, amountB);
    }

    /// @notice What is still to be claimed from the tree.
    function unclaimed() external view returns (uint256 a, uint256 b) {
        return (claimedA >= totalA ? 0 : totalA - claimedA, claimedB >= totalB ? 0 : totalB - claimedB);
    }
}
