// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultTestBase} from "./Base.sol";
import {DarkSafeVault} from "../../contracts/v2/DarkSafeVault.sol";
import {AgentPermitBatcher} from "../../contracts/v2/AgentPermitBatcher.sol";
import {MockERC20Permit} from "../../contracts/test/MockERC20Permit.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/**
 * Exercises AgentPermitBatcher standalone (direct calls "as if" from the vault, via vm.prank)
 * and end-to-end through a real DarkSafeVault propose/approve/execute cycle.
 */
contract AgentPermitBatcherTest is VaultTestBase {
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    DarkSafeVault internal vault;
    address[] internal team;
    AgentPermitBatcher internal batcher;
    MockERC20Permit internal token;

    // Agents are not vault owners and carry no Cyprus-1 constraint; real private keys let the
    // test sign genuine EIP-712 permits with vm.sign.
    uint256 internal constant AGENT1_PK = 0xA11CE;
    uint256 internal constant AGENT2_PK = 0xB0B;
    uint256 internal constant AGENT3_PK = 0xC0FFEE;

    function setUp() public {
        deployShipped();
        team = owners(3, 1);
        vault = createVault(team, 2, 0);
        batcher = new AgentPermitBatcher(address(vault));
        token = new MockERC20Permit("Agent Token", "AGT");
    }

    // ------------------------------------------------------------------ helpers

    function _agent(uint256 pk) internal pure returns (address) {
        return vm.addr(pk);
    }

    function _signPermit(uint256 pk, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address owner = vm.addr(pk);
        uint256 nonce = token.nonces(owner);
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), token.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function _entry(uint256 pk, uint256 amount, uint256 deadline)
        internal
        view
        returns (AgentPermitBatcher.BatchEntry memory e)
    {
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, address(batcher), amount, deadline);
        e = AgentPermitBatcher.BatchEntry({
            token: address(token),
            agent: vm.addr(pk),
            amount: amount,
            deadline: deadline,
            v: v,
            r: r,
            s: s
        });
    }

    function _entries1(AgentPermitBatcher.BatchEntry memory e) internal pure returns (AgentPermitBatcher.BatchEntry[] memory list) {
        list = new AgentPermitBatcher.BatchEntry[](1);
        list[0] = e;
    }

    // ------------------------------------------------------------------ construction

    function test_constructorRejectsZeroVault() public {
        vm.expectRevert(AgentPermitBatcher.ZeroVault.selector);
        new AgentPermitBatcher(address(0));
    }

    function test_vaultIsImmutableAndFixed() public view {
        assertEq(batcher.vault(), address(vault));
    }

    // ------------------------------------------------------------------ access control

    function test_batchPermitTransfer_revertsForNonVaultCaller() public {
        AgentPermitBatcher.BatchEntry[] memory entries = _entries1(_entry(AGENT1_PK, 1 ether, block.timestamp + 1 days));
        vm.expectRevert(AgentPermitBatcher.OnlyVault.selector);
        batcher.batchPermitTransfer(entries);
    }

    function test_sweepOne_revertsWhenNotCalledBySelf() public {
        AgentPermitBatcher.BatchEntry memory e = _entry(AGENT1_PK, 1 ether, block.timestamp + 1 days);
        vm.expectRevert(AgentPermitBatcher.OnlySelf.selector);
        batcher.sweepOne(e);
    }

    // ------------------------------------------------------------------ happy path

    function test_happyPath_sweepsExactlyIntoVault() public {
        address agent = _agent(AGENT1_PK);
        token.mint(agent, 100 ether);

        AgentPermitBatcher.BatchEntry[] memory entries = _entries1(_entry(AGENT1_PK, 40 ether, block.timestamp + 1 days));

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermitTransfer(entries);

        assertTrue(ok[0]);
        assertEq(token.balanceOf(address(vault)), 40 ether);
        assertEq(token.balanceOf(agent), 60 ether);
        assertEq(token.allowance(agent, address(batcher)), 0);
    }

    function test_happyPath_multipleIndependentAgentsInOneBatch() public {
        address a1 = _agent(AGENT1_PK);
        address a2 = _agent(AGENT2_PK);
        address a3 = _agent(AGENT3_PK);
        token.mint(a1, 10 ether);
        token.mint(a2, 20 ether);
        token.mint(a3, 30 ether);

        AgentPermitBatcher.BatchEntry[] memory entries = new AgentPermitBatcher.BatchEntry[](3);
        entries[0] = _entry(AGENT1_PK, 10 ether, block.timestamp + 1 days);
        entries[1] = _entry(AGENT2_PK, 20 ether, block.timestamp + 1 days);
        entries[2] = _entry(AGENT3_PK, 30 ether, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermitTransfer(entries);

        assertTrue(ok[0] && ok[1] && ok[2]);
        assertEq(token.balanceOf(address(vault)), 60 ether);
        assertEq(a1.balance + a2.balance + a3.balance, 0); // sanity: native balance untouched
    }

    // ------------------------------------------------------------------ isolation: one bad entry never blocks the rest

    function test_oneBadSignatureDoesNotBlockOthers() public {
        address good = _agent(AGENT1_PK);
        address bad = _agent(AGENT2_PK);
        token.mint(good, 10 ether);
        token.mint(bad, 10 ether);

        AgentPermitBatcher.BatchEntry memory badEntry = _entry(AGENT2_PK, 5 ether, block.timestamp + 1 days);
        // Corrupt the signature: flip a byte of r so it recovers to the wrong signer / fails permit().
        badEntry.r = bytes32(uint256(badEntry.r) ^ 1);

        AgentPermitBatcher.BatchEntry[] memory entries = new AgentPermitBatcher.BatchEntry[](2);
        entries[0] = badEntry;
        entries[1] = _entry(AGENT1_PK, 5 ether, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermitTransfer(entries);

        assertFalse(ok[0]);
        assertTrue(ok[1]);
        assertEq(token.balanceOf(bad), 10 ether); // untouched
        assertEq(token.balanceOf(good), 5 ether);
        assertEq(token.balanceOf(address(vault)), 5 ether);
    }

    function test_expiredDeadlineFailsThatEntryOnly() public {
        address agent = _agent(AGENT1_PK);
        address other = _agent(AGENT2_PK);
        token.mint(agent, 10 ether);
        token.mint(other, 10 ether);

        uint256 pastDeadline = block.timestamp == 0 ? 0 : block.timestamp - 1;
        AgentPermitBatcher.BatchEntry[] memory entries = new AgentPermitBatcher.BatchEntry[](2);
        entries[0] = _entry(AGENT1_PK, 5 ether, pastDeadline);
        entries[1] = _entry(AGENT2_PK, 5 ether, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermitTransfer(entries);

        assertFalse(ok[0]);
        assertTrue(ok[1]);
        assertEq(token.balanceOf(agent), 10 ether);
    }

    function test_insufficientBalanceFailsThatEntryOnly() public {
        address poor = _agent(AGENT1_PK);
        address rich = _agent(AGENT2_PK);
        token.mint(poor, 1 ether); // permits 5 but only holds 1
        token.mint(rich, 5 ether);

        AgentPermitBatcher.BatchEntry[] memory entries = new AgentPermitBatcher.BatchEntry[](2);
        entries[0] = _entry(AGENT1_PK, 5 ether, block.timestamp + 1 days);
        entries[1] = _entry(AGENT2_PK, 5 ether, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermitTransfer(entries);

        assertFalse(ok[0]);
        assertTrue(ok[1]);
        assertEq(token.balanceOf(poor), 1 ether);
        assertEq(token.balanceOf(address(vault)), 5 ether);
    }

    /// @dev A token with no permit() at all: the try/catch around permit() swallows the revert,
    /// and the pull then fails for lack of allowance — isolated exactly like a bad signature.
    function test_nonPermitTokenIsolatesCleanly() public {
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        address agent = _agent(AGENT1_PK);
        plain.mint(agent, 10 ether);

        AgentPermitBatcher.BatchEntry[] memory entries = new AgentPermitBatcher.BatchEntry[](1);
        entries[0] = AgentPermitBatcher.BatchEntry({
            token: address(plain),
            agent: agent,
            amount: 5 ether,
            deadline: block.timestamp + 1 days,
            v: 27,
            r: bytes32(0),
            s: bytes32(0)
        });

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermitTransfer(entries);

        assertFalse(ok[0]);
        assertEq(plain.balanceOf(agent), 10 ether);
    }

    // ------------------------------------------------------------------ replay safety

    function test_sameEntryTwiceInOneBatchOnlySweepsOnce() public {
        address agent = _agent(AGENT1_PK);
        token.mint(agent, 10 ether);
        AgentPermitBatcher.BatchEntry memory e = _entry(AGENT1_PK, 5 ether, block.timestamp + 1 days);

        AgentPermitBatcher.BatchEntry[] memory entries = new AgentPermitBatcher.BatchEntry[](2);
        entries[0] = e;
        entries[1] = e; // identical: same nonce, same signature

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermitTransfer(entries);

        assertTrue(ok[0]);
        assertFalse(ok[1]); // second permit() reverts (nonce spent) and allowance is already 0
        assertEq(token.balanceOf(address(vault)), 5 ether);
        assertEq(token.balanceOf(agent), 5 ether);
    }

    function test_replayAcrossSeparateBatchesFails() public {
        address agent = _agent(AGENT1_PK);
        token.mint(agent, 10 ether);
        AgentPermitBatcher.BatchEntry memory e = _entry(AGENT1_PK, 5 ether, block.timestamp + 1 days);

        vm.prank(address(vault));
        bool[] memory ok1 = batcher.batchPermitTransfer(_entries1(e));
        assertTrue(ok1[0]);

        vm.prank(address(vault));
        bool[] memory ok2 = batcher.batchPermitTransfer(_entries1(e));
        assertFalse(ok2[0]);

        assertEq(token.balanceOf(address(vault)), 5 ether);
    }

    // ------------------------------------------------------------------ end-to-end through the real vault

    function test_endToEnd_throughVaultProposeApproveExecute() public {
        address agent = _agent(AGENT1_PK);
        token.mint(agent, 50 ether);

        AgentPermitBatcher.BatchEntry[] memory entries = _entries1(_entry(AGENT1_PK, 20 ether, block.timestamp + 1 days));
        bytes memory data = abi.encodeCall(AgentPermitBatcher.batchPermitTransfer, (entries));

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

    function testFuzz_perEntryOutcomeMatchesBalanceAndSignatureValidity(
        uint96 mintedRaw,
        uint96 permitAmountRaw,
        bool corruptSignature,
        bool expireIt
    ) public {
        uint256 minted = uint256(mintedRaw);
        uint256 permitAmount = uint256(permitAmountRaw);
        vm.assume(permitAmount > 0);

        address agent = _agent(AGENT1_PK);
        token.mint(agent, minted);

        uint256 deadline = expireIt ? (block.timestamp == 0 ? 0 : block.timestamp - 1) : block.timestamp + 1 days;
        AgentPermitBatcher.BatchEntry memory e = _entry(AGENT1_PK, permitAmount, deadline);
        if (corruptSignature) e.r = bytes32(uint256(e.r) ^ 1);

        bool expectSuccess = !corruptSignature && !expireIt && minted >= permitAmount;

        vm.prank(address(vault));
        bool[] memory ok = batcher.batchPermitTransfer(_entries1(e));

        assertEq(ok[0], expectSuccess);
        assertEq(token.balanceOf(address(vault)), expectSuccess ? permitAmount : 0);
        assertEq(token.balanceOf(agent), expectSuccess ? minted - permitAmount : minted);
    }
}
