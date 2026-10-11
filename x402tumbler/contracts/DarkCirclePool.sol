// SPDX-License-Identifier: UNLICENSED
// Pinned: the deployment tooling compares on-chain code with this build byte for byte, so a compiler change
// must be a deliberate edit here (and in package.json), never a silent upgrade.
pragma solidity 0.8.37;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Groth16 verifier exported by snarkjs for circuits/unshield.circom. Nine public signals, in the order
///      merkleRoot, nullifier, changeCommitment, recipient, token, amount, relayer, relayerFee, publicInputsHash.
interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[9] calldata pubSignals
    ) external view returns (bool);
}

/// @dev circomlibjs-generated Poseidon over BN254 (the parameters circomlib and poseidon-lite use).
interface IPoseidon2 {
    function poseidon(uint256[2] memory input) external pure returns (uint256);
}

interface IPoseidon4 {
    function poseidon(uint256[4] memory input) external pure returns (uint256);
}

/// @title DarkCirclePool
/// @notice Reference shielded pool for ONE ERC-20 (WQUAI or WQI each get their own instance). UNAUDITED.
///
/// Implements what src/sim/railgunContract.ts simulates:
///  - `shield` pulls the tokens and derives the note commitment ON CHAIN from (npk, token, amount, rho), so a
///    leaf can never claim more value than was deposited (the property AUDIT.md finding A-05 is about);
///  - `unshield` verifies a Groth16 proof of circuits/unshield.circom (constraints C1 to C7): membership,
///    ownership (with the spending key restricted to [0, L), so a note has exactly one nullifier),
///    nullifier binding, value conservation and the binding of recipient, amount, relayer and fee;
///  - payment amounts are range-checked here as well as by the verifier's field checks, so the pool's
///    accounting never depends on the verifier alone;
///  - the nullifier is recorded before any token moves, and the whole call is non-reentrant;
///  - there is no owner, no upgrade path and no pause: the pool's behaviour is fixed at deployment.
///
/// NOT implemented, and therefore NOT safe for real funds (AUDIT.md O-1, O-14):
///  - C8, the compliance check on a note's deposit origin (PPOI). It needs its own circuit and list root;
///  - a relayer registry or fee market: any address may relay, the proof binds the relayer the spender chose;
///  - an independent audit, and a trusted setup that is not a single local contributor.
contract DarkCirclePool {
    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant DEPTH = 16;
    uint256 public constant ROOT_HISTORY = 64;
    uint256 public constant MAX_VALUE = 1 << 128;
    /// @notice `changeLeafIndex` in the Unshield event when the spend created no change note (leaf 0 is real).
    uint32 public constant NO_LEAF = type(uint32).max;

    IERC20 public immutable token;
    IGroth16Verifier public immutable verifier;
    IPoseidon2 public immutable hasher2;
    IPoseidon4 public immutable hasher4;

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    /// @dev Everything the proof binds besides the token (the pool supplies its own). Passed as one struct so the
    ///      call stays inside the EVM's stack limit.
    struct Payment {
        uint256 root;
        uint256 nullifier;
        uint256 changeCommitment;
        address recipient;
        uint256 amount;
        address relayer;
        uint256 fee;
    }

    uint32 public nextIndex;
    uint256 public currentRoot;
    mapping(uint256 => bool) public isKnownRoot;
    mapping(uint256 => bool) public nullifierSpent;
    mapping(uint256 => bool) public commitmentSeen;

    uint256[DEPTH] private zeros;
    uint256[DEPTH] private filled;
    uint256[ROOT_HISTORY] private rootRing;
    uint256 private rootCursor;
    uint256 private guard = 1;

    event Shield(uint256 indexed commitment, uint32 leafIndex, uint256 amount, address indexed depositor);
    event Unshield(
        uint256 indexed nullifier,
        address indexed recipient,
        uint256 amount,
        address indexed relayer,
        uint256 fee,
        uint256 changeCommitment,
        uint32 changeLeafIndex
    );

    modifier nonReentrant() {
        require(guard == 1, "reentrant");
        guard = 2;
        _;
        guard = 1;
    }

    constructor(address token_, address verifier_, address hasher2_, address hasher4_) {
        require(token_ != address(0) && verifier_ != address(0) && hasher2_ != address(0) && hasher4_ != address(0), "zero address");
        // An address without code answers every call with success and no data: a verifier or token there
        // would leave the pool unusable, so each dependency must already be a deployed contract.
        require(token_.code.length > 0 && verifier_.code.length > 0 && hasher2_.code.length > 0 && hasher4_.code.length > 0, "dependency has no code");
        token = IERC20(token_);
        verifier = IGroth16Verifier(verifier_);
        hasher2 = IPoseidon2(hasher2_);
        hasher4 = IPoseidon4(hasher4_);

        // zeros[i] is the root of an empty subtree of height i; the empty tree's root is zeros[DEPTH].
        uint256 z = 0;
        for (uint256 i = 0; i < DEPTH; i++) {
            zeros[i] = z;
            z = IPoseidon2(hasher2_).poseidon([z, z]);
        }
        currentRoot = z;
        rootRing[0] = z;
        isKnownRoot[z] = true;
    }

    /// @notice Deposit `amount` tokens (approve first) as a note owned by the holder of `npk`.
    /// @param npk    note public key, Poseidon2(spendingKey.x, viewingKey.x); must be a canonical field element
    /// @param amount deposited amount, 0 < amount < 2^128
    /// @param rho    note randomness, a canonical field element
    function shield(uint256 npk, uint256 amount, uint256 rho) external nonReentrant returns (uint256 commitment, uint32 leafIndex) {
        require(amount > 0 && amount < MAX_VALUE, "amount out of range");
        require(npk < FIELD && rho < FIELD, "not a field element");

        uint256 beforeBalance = token.balanceOf(address(this));
        _tokenCall(abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)), "transferFrom failed");
        require(token.balanceOf(address(this)) - beforeBalance == amount, "fee-on-transfer tokens are not supported");

        commitment = hasher4.poseidon([npk, uint256(uint160(address(token))), amount, rho]);
        require(!commitmentSeen[commitment], "duplicate commitment");
        commitmentSeen[commitment] = true;
        leafIndex = _insert(commitment);
        emit Shield(commitment, leafIndex, amount, msg.sender);
    }

    /// @notice Pay `amount` to `recipient` (and `fee` to `relayer`) from a note, proven in zero knowledge.
    function unshield(Proof calldata proof, Payment calldata pay) external nonReentrant {
        require(isKnownRoot[pay.root], "unknown root");
        require(pay.nullifier != 0 && pay.nullifier < FIELD, "bad nullifier");
        require(!nullifierSpent[pay.nullifier], "already spent");
        require(pay.changeCommitment < FIELD, "bad change commitment");
        // The circuit bounds these too (C5), but the pool must not rely on the verifier's field checks alone:
        // with a verifier that skipped them, fee + FIELD would satisfy the proof and pay out far more.
        require(pay.amount > 0 && pay.amount < MAX_VALUE, "amount out of range");
        require(pay.fee < MAX_VALUE, "fee out of range");
        require(pay.recipient != address(0), "zero recipient");
        require(pay.fee == 0 || pay.relayer != address(0), "a fee needs a relayer");
        require(pay.recipient != address(this) && pay.relayer != address(this), "the pool cannot pay itself");
        require(_verify(proof, pay), "invalid proof");

        // effects before interactions
        nullifierSpent[pay.nullifier] = true;
        uint32 changeLeaf = NO_LEAF;
        if (pay.changeCommitment != 0) {
            require(!commitmentSeen[pay.changeCommitment], "duplicate change commitment");
            commitmentSeen[pay.changeCommitment] = true;
            changeLeaf = _insert(pay.changeCommitment);
        }

        _tokenCall(abi.encodeCall(IERC20.transfer, (pay.recipient, pay.amount)), "payout failed");
        if (pay.fee > 0) _tokenCall(abi.encodeCall(IERC20.transfer, (pay.relayer, pay.fee)), "fee payout failed");
        emit Unshield(pay.nullifier, pay.recipient, pay.amount, pay.relayer, pay.fee, pay.changeCommitment, changeLeaf);
    }

    /// @dev ERC-20 call that accepts both conventions: a `true` return value, or no return data at all (older
    ///      tokens). The token is known to have code (constructor), so empty return data is not an EOA's
    ///      silent success. A `false` return, a revert or malformed data all revert here.
    function _tokenCall(bytes memory data, string memory failure) private {
        (bool ok, bytes memory ret) = address(token).call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), failure);
    }

    /// @dev Poseidon2(Poseidon4(recipient, token, amount, relayer), Poseidon2(fee, root)): constraint C7, computed
    ///      here so the proof is tied to exactly the payment the caller submits.
    function _binding(Payment calldata pay) private view returns (uint256) {
        uint256 left = hasher4.poseidon([uint256(uint160(pay.recipient)), uint256(uint160(address(token))), pay.amount, uint256(uint160(pay.relayer))]);
        uint256 right = hasher2.poseidon([pay.fee, pay.root]);
        return hasher2.poseidon([left, right]);
    }

    /// @dev Builds the nine public signals (the pool supplies its own token, so a note of another asset cannot
    ///      be spent here) and asks the verifier.
    function _verify(Proof calldata proof, Payment calldata pay) private view returns (bool) {
        uint256[9] memory s;
        s[0] = pay.root;
        s[1] = pay.nullifier;
        s[2] = pay.changeCommitment;
        s[3] = uint256(uint160(pay.recipient));
        s[4] = uint256(uint160(address(token)));
        s[5] = pay.amount;
        s[6] = uint256(uint160(pay.relayer));
        s[7] = pay.fee;
        s[8] = _binding(pay);
        return verifier.verifyProof(proof.a, proof.b, proof.c, s);
    }

    function _insert(uint256 leaf) private returns (uint32 index) {
        index = nextIndex;
        require(index < (uint32(1) << uint32(DEPTH)), "tree full");
        uint32 position = index;
        uint256 node = leaf;
        for (uint256 i = 0; i < DEPTH; i++) {
            if (position & 1 == 0) {
                filled[i] = node;
                node = hasher2.poseidon([node, zeros[i]]);
            } else {
                node = hasher2.poseidon([filled[i], node]);
            }
            position >>= 1;
        }
        nextIndex = index + 1;

        rootCursor = (rootCursor + 1) % ROOT_HISTORY;
        uint256 expired = rootRing[rootCursor];
        if (expired != 0) isKnownRoot[expired] = false;
        rootRing[rootCursor] = node;
        isKnownRoot[node] = true;
        currentRoot = node;
    }
}
