// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultTestBase} from "./Base.sol";
import {DarkSafeVault} from "../../contracts/v2/DarkSafeVault.sol";
import {AgentPermit2Batcher} from "../../contracts/v2/AgentPermit2Batcher.sol";
import {MockPermit2} from "../../contracts/test/MockPermit2.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/**
 * Exercises AgentPermit2Batcher against MockPermit2 (see that file's doc comment: a faithful
 * reimplementation of AgentPermit2Batcher's understanding of Permit2's SignatureTransfer, not
 * Permit2's real bytecode). Proves AgentPermit2Batcher's own logic (isolation, access control,
 * fixed destination) and that permit2.ts's off-chain digest agrees with this on-chain hashing â€”
 * not that either agrees with the genuine deployed Permit2 contract.
 */
contract AgentPermit2BatcherTest is VaultTestBase {
    bytes32 private constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 private constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    DarkSafeVault internal vault;
    address[] internal team;
    MockPermit2 internal permit2;
    AgentPermit2Batcher internal batcher;
    MockERC20 internal token;

    uint256 internal constant AGENT1_PK = 0xA11CE;
    uint256 internal constant AGENT2_PK = 0xB0B;
    uint256 internal constant AGENT3_PK = 0xC0FFEE;

    function setUp() public {
        deployShipped();
        team = owners(3, 1);
        vault = createVault(team, 2, 0);
        permit2 = new MockPermit2();
        batcher = new AgentPermit2Batcher(address(vault), address(permit2));
        token = new MockERC20("Agent Token", "AGT", 18);
    }

    // ------------------------------------------------------------------ helpers

    function _agent(uint256 pk) internal pure returns (address) {
        return vm.addr(pk);
    }

    function _approvePermit2(uint256 pk, uint256 amount) internal {
        vm.prank(vm.addr(pk));
        token.approve(address(permit2), amount);
    }

    function _sign(uint256 pk, address token_, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory signature)
    {
        bytes32 tokenPermissionsHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, token_, amount));
        // spender is always the batcher: it is msg.sender when MockPermit2.permitTransferFrom runs.
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissionsHash, address(batcher), nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), permit2.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _entry(uint256 pk, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (AgentPermit2Batcher.BatchEntry memory e)
    {
        e = AgentPermit2Batcher.BatchEntry({
            token: address(token),
            agent: vm.addr(pk),
            amount: amount,
            nonce: nonce,
            deadline: deadline,
            signature: _sign(pk, address(token), amount, nonce, deadline)
        });
    }

    function _entries1(AgentPermit2Batcher.BatchEntry memory e)
        internal
        pure
        returns (AgentPermit2Batcher.BatchEntry[] memory list)
    {
        list = new AgentPermit2Batcher.BatchEntry[](1);
        list[0] = e;
    }

    // ------------------------------------------------------------------ construction

    function test_constructorRejectsZeroVault() public {
        vm.expectRevert(AgentPermit2Batcher.ZeroVault.selector);
        new AgentPermit2Batcher(address(0), address(permit2));
    }

    function test_constructorRejectsZeroPermit2() public {
        vm.expectRevert(AgentPermit2Batcher.ZeroPermit2.selector);
        new AgentPermit2Batcher(address(vault), address(0));
    }

    function test_vaultAndPermit2AreImmutableAndFixed() public view {
        assertEq(batcher.vault(), address(vault));
        assertEq(address(batcher.permit2()), address(permit2));
    }

    // ------------------------------------------------------------------ access control

    function test_batchPermit2Transfer_revertsForNonVaultCaller() public {
        AgentPermit2Batcher.BatchEntry[] memory entries = _entries1(_entry(AGENT1_PK, 1 ether, 0, block.timestamp + 1 days));
        vm.expectRevert(AgentPermit2Batcher.OnlyVault.selector);
        batcher.batchPermit2Transfer(entries);
    }

    function test_sweepOne_revertsWhenNotCalledBySelf() public {
        AgentPermit2Batcher.BatchEntry memory e = _entry(AGENT1_PK, 1 ether, 0, block.timestamp + 1 days);
        vm.expectRevert(AgentPermit2Batcher.OnlySelf.selector);
        batcher.sweepOne(e);
    }

    // ------------------------------------------------------------------ happy path

    function test_happyPath_sweepsExactlyIntoVault() public {
        address agent = _agent(AGENT1_PK);
        token.mint(agent, 100 ether);
        _approvePermit2(AGENT1_PK, type(uint256).max);

        AgentPermit2Batcher.BatchEntry[] memory entries = _entries1(_entry(AGENT1_PK, 40 ether, 0, block.timestamp + 1 days));

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermit2Transfer(entries);

        assertTrue(ok[0]);
        assertEq(token.balanceOf(address(vault)), 40 ether);
        assertEq(token.balanceOf(agent), 60 ether);
    }

    function test_happyPath_multipleIndependentAgentsInOneBatch() public {
        address a1 = _agent(AGENT1_PK);
        address a2 = _agent(AGENT2_PK);
        address a3 = _agent(AGENT3_PK);
        token.mint(a1, 10 ether);
        token.mint(a2, 20 ether);
        token.mint(a3, 30 ether);
        _approvePermit2(AGENT1_PK, type(uint256).max);
        _approvePermit2(AGENT2_PK, type(uint256).max);
        _approvePermit2(AGENT3_PK, type(uint256).max);

        AgentPermit2Batcher.BatchEntry[] memory entries = new AgentPermit2Batcher.BatchEntry[](3);
        entries[0] = _entry(AGENT1_PK, 10 ether, 0, block.timestamp + 1 days);
        entries[1] = _entry(AGENT2_PK, 20 ether, 1, block.timestamp + 1 days);
        entries[2] = _entry(AGENT3_PK, 30 ether, 2, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermit2Transfer(entries);

        assertTrue(ok[0] && ok[1] && ok[2]);
        assertEq(token.balanceOf(address(vault)), 60 ether);
    }

    // ------------------------------------------------------------------ isolation

    function test_missingPermit2ApprovalFailsThatEntryOnly() public {
        address noApproval = _agent(AGENT1_PK);
        address approved = _agent(AGENT2_PK);
        token.mint(noApproval, 10 ether);
        token.mint(approved, 10 ether);
        _approvePermit2(AGENT2_PK, type(uint256).max);
        // AGENT1 never approved Permit2 â€” a real, unskippable prerequisite this contract cannot batch away.

        AgentPermit2Batcher.BatchEntry[] memory entries = new AgentPermit2Batcher.BatchEntry[](2);
        entries[0] = _entry(AGENT1_PK, 5 ether, 0, block.timestamp + 1 days);
        entries[1] = _entry(AGENT2_PK, 5 ether, 0, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermit2Transfer(entries);

        assertFalse(ok[0]);
        assertTrue(ok[1]);
        assertEq(token.balanceOf(noApproval), 10 ether);
        assertEq(token.balanceOf(address(vault)), 5 ether);
    }

    function test_oneBadSignatureDoesNotBlockOthers() public {
        address bad = _agent(AGENT1_PK);
        address good = _agent(AGENT2_PK);
        token.mint(bad, 10 ether);
        token.mint(good, 10 ether);
        _approvePermit2(AGENT1_PK, type(uint256).max);
        _approvePermit2(AGENT2_PK, type(uint256).max);

        AgentPermit2Batcher.BatchEntry memory badEntry = _entry(AGENT1_PK, 5 ether, 0, block.timestamp + 1 days);
        badEntry.signature[0] = badEntry.signature[0] == 0x00 ? bytes1(0x01) : bytes1(0x00); // corrupt r's first byte

        AgentPermit2Batcher.BatchEntry[] memory entries = new AgentPermit2Batcher.BatchEntry[](2);
        entries[0] = badEntry;
        entries[1] = _entry(AGENT2_PK, 5 ether, 0, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermit2Transfer(entries);

        assertFalse(ok[0]);
        assertTrue(ok[1]);
        assertEq(token.balanceOf(bad), 10 ether);
        assertEq(token.balanceOf(good), 5 ether);
    }

    function test_expiredDeadlineFailsThatEntryOnly() public {
        address agent = _agent(AGENT1_PK);
        address other = _agent(AGENT2_PK);
        token.mint(agent, 10 ether);
        token.mint(other, 10 ether);
        _approvePermit2(AGENT1_PK, type(uint256).max);
        _approvePermit2(AGENT2_PK, type(uint256).max);

        uint256 pastDeadline = block.timestamp == 0 ? 0 : block.timestamp - 1;
        AgentPermit2Batcher.BatchEntry[] memory entries = new AgentPermit2Batcher.BatchEntry[](2);
        entries[0] = _entry(AGENT1_PK, 5 ether, 0, pastDeadline);
        entries[1] = _entry(AGENT2_PK, 5 ether, 0, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermit2Transfer(entries);

        assertFalse(ok[0]);
        assertTrue(ok[1]);
        assertEq(token.balanceOf(agent), 10 ether);
    }

    function test_insufficientBalanceFailsThatEntryOnly() public {
        address poor = _agent(AGENT1_PK);
        address rich = _agent(AGENT2_PK);
        token.mint(poor, 1 ether); // signs for 5 but only holds 1
        token.mint(rich, 5 ether);
        _approvePermit2(AGENT1_PK, type(uint256).max);
        _approvePermit2(AGENT2_PK, type(uint256).max);

        AgentPermit2Batcher.BatchEntry[] memory entries = new AgentPermit2Batcher.BatchEntry[](2);
        entries[0] = _entry(AGENT1_PK, 5 ether, 0, block.timestamp + 1 days);
        entries[1] = _entry(AGENT2_PK, 5 ether, 0, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermit2Transfer(entries);

        assertFalse(ok[0]);
        assertTrue(ok[1]);
        assertEq(token.balanceOf(poor), 1 ether);
        assertEq(token.balanceOf(address(vault)), 5 ether);
    }

    // ------------------------------------------------------------------ replay / nonce reuse

    function test_sameNonceTwiceInOneBatchOnlySweepsOnce() public {
        address agent = _agent(AGENT1_PK);
        token.mint(agent, 10 ether);
        _approvePermit2(AGENT1_PK, type(uint256).max);
        AgentPermit2Batcher.BatchEntry memory e = _entry(AGENT1_PK, 5 ether, 0, block.timestamp + 1 days);

        AgentPermit2Batcher.BatchEntry[] memory entries = new AgentPermit2Batcher.BatchEntry[](2);
        entries[0] = e;
        entries[1] = e; // identical nonce: MockPermit2's bitmap rejects the second

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermit2Transfer(entries);

        assertTrue(ok[0]);
        assertFalse(ok[1]);
        assertEq(token.balanceOf(address(vault)), 5 ether);
        assertEq(token.balanceOf(agent), 5 ether);
    }

    function test_replayAcrossSeparateBatchesFails() public {
        address agent = _agent(AGENT1_PK);
        token.mint(agent, 10 ether);
        _approvePermit2(AGENT1_PK, type(uint256).max);
        AgentPermit2Batcher.BatchEntry memory e = _entry(AGENT1_PK, 5 ether, 0, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok1 = batcher.batchPermit2Transfer(_entries1(e));
        assertTrue(ok1[0]);

        vm.prank(address(vault));
        bool[] memory ok2 = batcher.batchPermit2Transfer(_entries1(e));
        assertFalse(ok2[0]);

        assertEq(token.balanceOf(address(vault)), 5 ether);
    }

    function test_differentNoncesFromSameAgentBothSucceed() public {
        address agent = _agent(AGENT1_PK);
        token.mint(agent, 10 ether);
        _approvePermit2(AGENT1_PK, type(uint256).max);

        AgentPermit2Batcher.BatchEntry[] memory entries = new AgentPermit2Batcher.BatchEntry[](2);
        entries[0] = _entry(AGENT1_PK, 3 ether, 0, block.timestamp + 1 days);
        entries[1] = _entry(AGENT1_PK, 4 ether, 1, block.timestamp + 1 days); // different nonce, unordered

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermit2Transfer(entries);

        assertTrue(ok[0] && ok[1]);
        assertEq(token.balanceOf(address(vault)), 7 ether);
    }

    // ------------------------------------------------------------------ end-to-end through the real vault

    function test_endToEnd_throughVaultProposeApproveExecute() public {
        address agent = _agent(AGENT1_PK);
        token.mint(agent, 50 ether);
        _approvePermit2(AGENT1_PK, type(uint256).max);

        AgentPermit2Batcher.BatchEntry[] memory entries = _entries1(_entry(AGENT1_PK, 20 ether, 0, block.timestamp + 1 days));
        bytes memory data = abi.encodeCall(AgentPermit2Batcher.batchPermit2Transfer, (entries));

        bytes32 txHash = propose(vault, team[0], address(batcher), 0, data, 300_000);
        approveAll(vault, txHash, team);

        vm.prank(team[0]);
        bool ran = vault.executeTransaction(txHash);

        assertTrue(ran);
        assertFalse(vault.getTransaction(txHash).failed);
        assertEq(token.balanceOf(address(vault)), 20 ether);
        assertEq(token.balanceOf(agent), 30 ether);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_perEntryOutcomeMatchesBalanceApprovalAndSignatureValidity(
        uint96 mintedRaw,
        uint96 amountRaw,
        bool approved,
        bool corruptSignature,
        bool expireIt
    ) public {
        uint256 minted = uint256(mintedRaw);
        uint256 amount = uint256(amountRaw);
        vm.assume(amount > 0);

        address agent = _agent(AGENT1_PK);
        token.mint(agent, minted);
        if (approved) _approvePermit2(AGENT1_PK, type(uint256).max);

        uint256 deadline = expireIt ? (block.timestamp == 0 ? 0 : block.timestamp - 1) : block.timestamp + 1 days;
        AgentPermit2Batcher.BatchEntry memory e = _entry(AGENT1_PK, amount, 0, deadline);
        if (corruptSignature) e.signature[0] = e.signature[0] == 0x00 ? bytes1(0x01) : bytes1(0x00);

        bool expectSuccess = approved && !corruptSignature && !expireIt && minted >= amount;

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermit2Transfer(_entries1(e));

        assertEq(ok[0], expectSuccess);
        assertEq(token.balanceOf(address(vault)), expectSuccess ? amount : 0);
        assertEq(token.balanceOf(agent), expectSuccess ? minted - amount : minted);
    }
}
