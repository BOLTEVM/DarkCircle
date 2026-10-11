pragma circom 2.0.0;

/*
 * DarkCircle unshield circuit (reference implementation, UNAUDITED)
 *
 * Proves, in zero knowledge, constraints C1 to C7 of the executable specification in
 * src/sim/unshieldVerifier.ts. The simulation checks the same statement from a witness that includes the
 * spending key; this circuit takes the spending key as a PRIVATE input, so the verifier learns only the
 * public signals below.
 *
 *   C1  commitment = Poseidon4(npk, token, inValue, inRho)
 *   C2  the commitment is the leaf at `leafIndex` under `merkleRoot` (fixed depth)
 *   C3  npk = Poseidon2((spendingKey * Base8).x, viewingPublicKeyX), with 0 <= spendingKey < L   (ownership)
 *   C4  nullifier = Poseidon3(spendingKey, commitment, leafIndex)            (double-spend binding)
 *
 * The range in C3 is what makes C4 a binding: Base8 has order L (the BabyJubjub subgroup order), so
 * spendingKey and spendingKey + k*L are the SAME public key, and without the range every note would have
 * up to eight valid nullifiers (one per k with spendingKey + k*L < p), i.e. could be spent eight times.
 * Restricting the key to [0, L) leaves exactly one scalar per public key, hence one nullifier per note.
 *   C5  inValue = amount + relayerFee + changeValue, each in [0, 2^128), amount > 0
 *   C6  changeCommitment = Poseidon4(changeNpk, token, changeValue, changeRho), or 0 when there is no change
 *   C7  publicInputsHash = Poseidon2(Poseidon4(recipient, token, amount, relayer), Poseidon2(relayerFee, merkleRoot))
 *
 * NOT covered here: C8, the compliance (PPOI) check on the note's deposit origin. It needs its own proof and
 * an on-chain list root; until it exists the contract cannot enforce it (AUDIT.md O-14).
 *
 * The hashes are the standard circomlib Poseidon over BN254, the same parameters poseidon-lite uses in the
 * simulation, and the curve generator is circomlib's Base8, the simulation's GENERATOR. The self-test stage
 * of the deployment pipeline proves a real note from the simulation and compares every public signal.
 *
 * Public signal order (the order the verifier contract receives them in):
 *   merkleRoot, nullifier, changeCommitment, recipient, token, amount, relayer, relayerFee, publicInputsHash
 */

include "poseidon.circom";
include "bitify.circom";
include "comparators.circom";
include "escalarmulfix.circom";
include "switcher.circom";

/* One level of the Merkle path: parent = isRight ? H(sibling, cur) : H(cur, sibling). */
template MerkleLevel() {
    signal input cur;
    signal input sibling;
    signal input isRight;
    signal output parent;

    isRight * (isRight - 1) === 0;

    component sw = Switcher();
    sw.sel <== isRight;
    sw.L <== cur;
    sw.R <== sibling;

    component h = Poseidon(2);
    h.inputs[0] <== sw.outL;
    h.inputs[1] <== sw.outR;
    parent <== h.out;
}

template Unshield(DEPTH) {
    // ---- public inputs (declaration order is the verifier's public-signal order)
    signal input merkleRoot;
    signal input nullifier;
    signal input changeCommitment;
    signal input recipient;
    signal input token;
    signal input amount;
    signal input relayer;
    signal input relayerFee;
    signal input publicInputsHash;

    // ---- private inputs
    signal input spendingKey;
    signal input viewingPublicKeyX;
    signal input inValue;
    signal input inRho;
    signal input leafIndex;
    signal input siblings[DEPTH];
    signal input changeNpk;
    signal input changeValue;
    signal input changeRho;

    // ---- C3: ownership. npk = Poseidon2((spendingKey * Base8).x, viewingPublicKeyX), 0 <= spendingKey < L
    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];
    // L, the order of Base8. L < 2^251, so 251 bits hold every key and LessThan(251) is sound on them.
    var SUBGROUP_ORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041;
    component skBits = Num2Bits(251);
    skBits.in <== spendingKey;
    component skInRange = LessThan(251);
    skInRange.in[0] <== spendingKey;
    skInRange.in[1] <== SUBGROUP_ORDER;
    skInRange.out === 1;
    component pk = EscalarMulFix(251, BASE8);
    for (var i = 0; i < 251; i++) {
        pk.e[i] <== skBits.out[i];
    }
    component npkHash = Poseidon(2);
    npkHash.inputs[0] <== pk.out[0];
    npkHash.inputs[1] <== viewingPublicKeyX;

    // ---- C1: the input note's commitment
    component commit = Poseidon(4);
    commit.inputs[0] <== npkHash.out;
    commit.inputs[1] <== token;
    commit.inputs[2] <== inValue;
    commit.inputs[3] <== inRho;

    // ---- C2: Merkle membership under the public root
    component idxBits = Num2Bits(DEPTH);
    idxBits.in <== leafIndex;
    component level[DEPTH];
    for (var d = 0; d < DEPTH; d++) {
        level[d] = MerkleLevel();
        level[d].sibling <== siblings[d];
        level[d].isRight <== idxBits.out[d];
    }
    level[0].cur <== commit.out;
    for (var d = 1; d < DEPTH; d++) {
        level[d].cur <== level[d - 1].parent;
    }
    merkleRoot === level[DEPTH - 1].parent;

    // ---- C4: nullifier
    component nullHash = Poseidon(3);
    nullHash.inputs[0] <== spendingKey;
    nullHash.inputs[1] <== commit.out;
    nullHash.inputs[2] <== leafIndex;
    nullifier === nullHash.out;

    // ---- C5: ranges and conservation (no wrap-around: every term is below 2^128)
    component inBits = Num2Bits(128);
    inBits.in <== inValue;
    component amountBits = Num2Bits(128);
    amountBits.in <== amount;
    component feeBits = Num2Bits(128);
    feeBits.in <== relayerFee;
    component changeBits = Num2Bits(128);
    changeBits.in <== changeValue;
    inValue === amount + relayerFee + changeValue;

    component amountIsZero = IsZero();
    amountIsZero.in <== amount;
    amountIsZero.out === 0;

    // ---- C6: the change note, or no change at all
    component changeIsZero = IsZero();
    changeIsZero.in <== changeValue;
    signal hasChange;
    hasChange <== 1 - changeIsZero.out;
    component changeHash = Poseidon(4);
    changeHash.inputs[0] <== changeNpk;
    changeHash.inputs[1] <== token;
    changeHash.inputs[2] <== changeValue;
    changeHash.inputs[3] <== changeRho;
    changeCommitment === hasChange * changeHash.out;

    // ---- C7: binding of the public payment fields
    component bind1 = Poseidon(4);
    bind1.inputs[0] <== recipient;
    bind1.inputs[1] <== token;
    bind1.inputs[2] <== amount;
    bind1.inputs[3] <== relayer;
    component bind2 = Poseidon(2);
    bind2.inputs[0] <== relayerFee;
    bind2.inputs[1] <== merkleRoot;
    component bind = Poseidon(2);
    bind.inputs[0] <== bind1.out;
    bind.inputs[1] <== bind2.out;
    publicInputsHash === bind.out;
}

component main {public [merkleRoot, nullifier, changeCommitment, recipient, token, amount, relayer, relayerFee, publicInputsHash]} = Unshield(16);
