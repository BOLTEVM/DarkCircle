// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultTestBase} from "../foundry/Base.sol";
import {SafeBuddyVault} from "../../contracts/v2/SafeBuddyVault.sol";

interface IERC20Calls {
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * Differential tests: the TypeScript library the web app, CLI verifier and watcher use
 * (packages/core, called through scripts/ffi/core-oracle.mjs) must agree with the
 * shipped contracts on every fuzzed input.
 *
 * Run with `forge test --profile differential` after building packages/core.
 */
contract CoreDifferentialTest is VaultTestBase {
    SafeBuddyVault internal vault;
    address[] internal team;

    function setUp() public {
        deployShipped();
        team = owners(2, 50);
        vault = createVault(team, 1, 0);
    }

    function _oracle(string[] memory args) internal returns (bytes memory) {
        string[] memory cmd = new string[](args.length + 2);
        cmd[0] = "node";
        cmd[1] = "scripts/ffi/core-oracle.mjs";
        for (uint256 i = 0; i < args.length; i++) cmd[i + 2] = args[i];
        return vm.ffi(cmd);
    }

    function _csv(address[] memory list) internal pure returns (string memory s) {
        for (uint256 i = 0; i < list.length; i++) s = string.concat(s, i == 0 ? "" : ",", vm.toString(list[i]));
    }

    function _bytesFrom(bytes32 seed, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = keccak256(abi.encode(seed, i))[0];
    }

    function _decode(address to, uint256 value, bytes memory data)
        internal
        returns (uint8 kind, address a, uint256 n, bytes32 h)
    {
        string[] memory args = new string[](5);
        args[0] = "decode";
        args[1] = vm.toString(address(vault));
        args[2] = vm.toString(to);
        args[3] = vm.toString(value);
        args[4] = vm.toString(data);
        return abi.decode(_oracle(args), (uint8, address, uint256, bytes32));
    }

    // ------------------------------------------------------------------ hashing

    function testFuzz_txHashAgreesWithCore(
        address to,
        uint256 value,
        bytes32 dataSeed,
        uint8 dataLen,
        uint64 gasLimit,
        uint64 expiration,
        uint32 delay,
        uint256 nonce
    ) public {
        bytes memory data = _bytesFrom(dataSeed, dataLen);
        string[] memory args = new string[](10);
        args[0] = "txhash";
        args[1] = vm.toString(address(vault));
        args[2] = vm.toString(block.chainid);
        args[3] = vm.toString(to);
        args[4] = vm.toString(value);
        args[5] = vm.toString(data);
        args[6] = vm.toString(uint256(gasLimit));
        args[7] = vm.toString(uint256(expiration));
        args[8] = vm.toString(uint256(delay));
        args[9] = vm.toString(nonce);
        assertEq(bytes32(_oracle(args)), vault.getTransactionHash(to, value, data, gasLimit, expiration, delay, nonce));
    }

    // ------------------------------------------------------------------ vault addresses

    struct Creation {
        address creator;
        bytes32 salt;
        address[] list;
        uint256 threshold;
        uint32 minDelay;
    }

    function _predictViaCore(Creation memory c) internal returns (address) {
        string[] memory args = new string[](8);
        args[0] = "predict";
        args[1] = vm.toString(address(factory));
        args[2] = vm.toString(address(implementation));
        args[3] = vm.toString(c.creator);
        args[4] = vm.toString(c.salt);
        args[5] = _csv(c.list);
        args[6] = vm.toString(c.threshold);
        args[7] = vm.toString(uint256(c.minDelay));
        return abi.decode(_oracle(args), (address));
    }

    function testFuzz_predictionAgreesWithCore(address creator, bytes32 salt, uint8 n, uint8 t, uint32 delay, uint256 seed) public {
        uint256 count = bound(n, 1, 20);
        Creation memory c = Creation({
            creator: creator,
            salt: salt,
            list: owners(count, seed),
            threshold: bound(t, 1, count),
            minDelay: uint32(bound(delay, 0, MAX_DELAY))
        });
        address fromCore = _predictViaCore(c);
        assertEq(fromCore, factory.predictWalletAddress(c.creator, c.list, c.threshold, c.minDelay, c.salt));
        vm.prank(c.creator);
        assertEq(factory.createWallet(c.list, c.threshold, c.minDelay, c.salt), fromCore);
    }

    /// The salt the web app mines really creates a vault on a Cyprus-1 Quai-ledger address.
    function testFuzz_minedSaltCreatesCyprusVault(address creator, bytes32 startSalt, uint8 n, uint256 seed) public {
        uint256 count = bound(n, 1, 5);
        address[] memory list = owners(count, seed);
        string[] memory args = new string[](8);
        args[0] = "mine";
        args[1] = vm.toString(address(factory));
        args[2] = vm.toString(address(implementation));
        args[3] = vm.toString(creator);
        args[4] = _csv(list);
        args[5] = vm.toString(count);
        args[6] = "3600";
        args[7] = vm.toString(startSalt);
        (bytes32 salt, address predicted) = abi.decode(_oracle(args), (bytes32, address));
        vm.prank(creator);
        address wallet = factory.createWallet(list, count, 3600, salt);
        assertEq(wallet, predicted);
        assertEq(uint160(wallet) >> 152, 0, "first byte is the Cyprus-1 zone");
        assertLt((uint160(wallet) >> 144) & 0xff, 0x80, "Quai ledger, not Qi");
    }

    // ------------------------------------------------------------------ factory authenticity

    /// Masking the immutable ranges pinned in core makes any genuine factory match the pin,
    /// whatever implementation it was deployed with; any other byte change does not.
    function testFuzz_factoryMaskAgreesWithPin(address impl, uint16 flipAt) public {
        vm.assume(impl.code.length == 0 && uint160(impl) > 0x10000);
        vm.etch(impl, hex"00");
        address f = deployCode_(abi.encodePacked(artifactBytecode("SafeBuddyVaultFactory"), abi.encode(impl)));
        bytes memory code = f.code;
        string[] memory args = new string[](2);
        args[0] = "mask";
        args[1] = vm.toString(code);
        (, bool matches) = abi.decode(_oracle(args), (bytes32, bool));
        assertTrue(matches, "a genuine factory must match the pin");

        uint256 at = bound(flipAt, 0, 150); // before the first immutable range (byte 194)
        code[at] = bytes1(uint8(code[at]) ^ 0x01);
        args[1] = vm.toString(code);
        (, bool tampered) = abi.decode(_oracle(args), (bytes32, bool));
        assertFalse(tampered, "a modified factory must not match the pin");
    }

    // ------------------------------------------------------------------ calldata decoding

    function testFuzz_adminDecodeAgreesWithCore(uint8 which, address who, uint256 num, bytes32 h) public {
        bytes memory data;
        uint8 expectedKind = 3 + (which % 5);
        if (which % 5 == 0) data = abi.encodeCall(SafeBuddyVault.addOwner, (who, num));
        else if (which % 5 == 1) data = abi.encodeCall(SafeBuddyVault.removeOwner, (who, num));
        else if (which % 5 == 2) data = abi.encodeCall(SafeBuddyVault.changeThreshold, (num));
        else if (which % 5 == 3) data = abi.encodeCall(SafeBuddyVault.setMinExecutionDelay, (uint32(num)));
        else data = abi.encodeCall(SafeBuddyVault.cancelByConsensus, (h));

        (uint8 kind, address a, uint256 n, bytes32 hh) = _decode(address(vault), 0, data);
        assertEq(kind, expectedKind);
        if (which % 5 <= 1) {
            assertEq(a, who);
            assertEq(n, num);
        } else if (which % 5 == 2) {
            assertEq(n, num);
        } else if (which % 5 == 3) {
            assertEq(n, uint32(num));
        } else {
            assertEq(hh, h);
        }
    }

    /**
     * Admin calldata whose address word has dirty upper bytes: core must refuse to show a
     * clean decode, and the vault must refuse to run it. Both sides reject the same bytes.
     */
    function testFuzz_dirtyAdminCalldataRejectedByBoth(bytes12 dirt, uint256 seed) public {
        vm.assume(dirt != bytes12(0));
        address newOwner = cyprus(seed);
        bytes memory data = abi.encodeCall(SafeBuddyVault.addOwner, (newOwner, 1));
        for (uint256 i = 0; i < 12; i++) data[4 + i] = dirt[i];

        (uint8 kind,,,) = _decode(address(vault), 0, data);
        assertEq(kind, 8, "core must not decode it as a clean addOwner");

        bytes32 txHash = propose(vault, team[0], address(vault), 0, data, 0);
        vm.prank(team[0]);
        vm.expectRevert();
        vault.executeTransaction{gas: 5_000_000}(txHash);
        assertFalse(vault.isOwner(newOwner));
    }

    // ------------------------------------------------------------------ the app's own judgements

    struct Draft {
        address to;
        uint256 value;
        bytes data;
        uint64 gasLimit;
        uint64 expiration;
        uint32 requestedDelay;
    }

    function _coreAcceptsDraft(SafeBuddyVault v, Draft memory d) internal returns (bool) {
        string[] memory args = new string[](10);
        args[0] = "validate";
        args[1] = vm.toString(address(v));
        args[2] = vm.toString(uint256(v.minExecutionDelay()));
        args[3] = vm.toString(block.timestamp);
        args[4] = vm.toString(d.to);
        args[5] = vm.toString(d.value);
        args[6] = vm.toString(d.data);
        args[7] = vm.toString(uint256(d.gasLimit));
        args[8] = vm.toString(uint256(d.expiration));
        args[9] = vm.toString(uint256(d.requestedDelay));
        return abi.decode(_oracle(args), (bool));
    }

    /// Whatever draft the app's pre-check accepts, the vault accepts too: the app never sends a
    /// proposal that is certain to revert (a revert on Quai burns the whole gas limit).
    function testFuzz_validateDraftNeverApprovesWhatTheVaultRejects(
        uint32 floor,
        bool self,
        uint96 value,
        uint64 gasLimit,
        uint32 requestedDelay,
        uint256 expOffset
    ) public {
        SafeBuddyVault v = createVault(team, 1, uint32(bound(floor, 0, 2 days)));
        Draft memory d = Draft({
            to: self ? address(v) : cyprus(uint256(expOffset)),
            value: value % 3 == 0 ? 0 : value,
            data: self ? abi.encodeCall(SafeBuddyVault.changeThreshold, (1)) : bytes(""),
            gasLimit: uint64(bound(gasLimit, 0, 31_000_000)),
            requestedDelay: uint32(bound(requestedDelay, 0, 31 days)),
            expiration: uint64(block.timestamp + bound(expOffset, 0, 64 days))
        });
        if (self && gasLimit % 2 == 0) d.gasLimit = 0;
        bool coreOk = _coreAcceptsDraft(v, d);
        vm.prank(team[0]);
        try v.proposeTransaction(d.to, d.value, d.data, d.gasLimit, d.expiration, d.requestedDelay) {}
        catch {
            assertFalse(coreOk, "core accepted a draft the vault rejects");
        }
    }

    function _adminCandidate(SafeBuddyVault v, address[] memory current, uint256 seed) internal pure returns (address) {
        uint256 pick = seed % 7;
        if (pick == 0) return current[seed % current.length]; // already an owner
        if (pick == 1) return address(0);
        if (pick == 2) return address(1); // the sentinel
        if (pick == 3) return address(v);
        if (pick == 4) return address(uint160(0x01) << 152 | uint160(seed)); // wrong zone
        if (pick == 5) return address(uint160(0x0080) << 144 | uint160(uint64(seed))); // Qi ledger: accepted, never signs
        return cyprus(seed); // a fresh Cyprus-1 account
    }

    /// When the app says "the vault will reject this" about an admin change, it does; and when
    /// the app says nothing of the sort, the change goes through.
    function testFuzz_riskPredictsAdminRejection(uint8 kind, uint256 seed, uint256 num) public {
        address[] memory current = owners(3, 70);
        SafeBuddyVault v = createVault(current, 2, 0);
        bytes memory data;
        uint256 k = kind % 4;
        if (k == 0) data = abi.encodeCall(SafeBuddyVault.addOwner, (_adminCandidate(v, current, seed), bound(num, 0, 5)));
        else if (k == 1) data = abi.encodeCall(SafeBuddyVault.removeOwner, (_adminCandidate(v, current, seed), bound(num, 0, 4)));
        else if (k == 2) data = abi.encodeCall(SafeBuddyVault.changeThreshold, (bound(num, 0, 5)));
        else data = abi.encodeCall(SafeBuddyVault.setMinExecutionDelay, (uint32(bound(num, 0, 40 days))));

        string[] memory args = new string[](6);
        args[0] = "adminrisk";
        args[1] = vm.toString(address(v));
        args[2] = _csv(current);
        args[3] = "2";
        args[4] = "0";
        args[5] = vm.toString(data);
        bool predictedReject = abi.decode(_oracle(args), (bool));

        bytes32 h = propose(v, current[0], address(v), 0, data, 0);
        vm.prank(current[1]);
        v.approveTransaction(h);
        vm.prank(current[0]);
        (bool ok,) = address(v).call{gas: 5_000_000}(abi.encodeCall(SafeBuddyVault.executeTransaction, (h)));
        assertEq(predictedReject, !ok, "core's rejection prediction disagrees with the vault");
    }

    function testFuzz_erc20TransferDecodeAgreesWithCore(address token, address recipient, uint256 amount) public {
        vm.assume(token != address(vault));
        bytes memory data = abi.encodeCall(IERC20Calls.transfer, (recipient, amount));
        (uint8 kind, address a, uint256 n,) = _decode(token, 0, data);
        assertEq(kind, 1);
        assertEq(a, recipient);
        assertEq(n, amount);
        (uint8 trailing,,,) = _decode(token, 0, abi.encodePacked(data, bytes1(0xff)));
        assertEq(trailing, 9, "trailing bytes must not decode as a clean transfer");
    }
}
