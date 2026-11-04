# DarkCircle ceremony circuit provenance

## Why this directory exists

Commit `445a6015f9739239bf034d3f990f200b69779f30` contains an earlier
`x402tumbler/circuits/unshield.circom` implementing C1–C7, with nine public inputs and no PPOI
membership constraint. Its SHA-256 is:

```
bd2d9606df77f34fac12caf3694bb3a6bccc7231ae1ec23f2eeebe7250032f19
```

That earlier file was **not** the circuit compiled for the multi-party ceremony. Referencing that
commit as the ceremony source was a provenance error.

## Authoritative ceremony source

The exact frozen ceremony circuit and its executable specification are published here:

- `frozen/unshield.circom` — C1–C8, including the PPOI membership proof and ten public inputs.
- `frozen/unshieldVerifier.ts` — executable specification, for inspection rather than compilation.
- `frozen/SOURCE_MANIFEST.json` — source digest, pinned toolchain, and expected R1CS properties.
- `frozen/COMPILE.md` — independent reproduction instructions.

Expected digests:

```
unshield.circom     fe3a25a69d3a5b29478d1a4a861e36280a2e0049d7e664f01ce7372e4c93d2b8
unshieldVerifier.ts 51117153109fc31a3db2d96addea1cc17ea14538d4f4d5401812d95dfa58bc2f
unshield.r1cs       1687738ec20ee5298c6f0fefc8ea8ceef8c528b0be9f592cfe0ea6ea4ec34779
```

Using `circom2@0.2.23` and `circomlib@2.0.5`, the frozen circuit compiles to 25,921 constraints,
10 public inputs, and 41 private inputs. A clean-room compilation has reproduced the expected R1CS
byte-for-byte.

## Scope of this correction

This correction is additive. It does not replace the historical application circuit, modify contracts
or deployment code, regenerate ceremony keys, or alter any contribution. It publishes the missing
source and corrects the public provenance record. Verification of the source-to-R1CS relationship is
one part of the ceremony verification; contributors should also verify the zkey chain and record only
checks they actually performed.
