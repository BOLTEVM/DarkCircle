# Reproduce the DarkCircle ceremony R1CS

These instructions independently rebuild the ceremony circuit from the frozen source. No private
keys, entropy, or secret ceremony data are required.

## 1. Enter this directory

From the repository root:

```sh
cd x402tumbler/ceremony/frozen
```

Confirm the source digest. On Windows:

```powershell
certutil -hashfile unshield.circom SHA256
```

On macOS or Linux:

```sh
sha256sum unshield.circom
```

The digest must be:

```
fe3a25a69d3a5b29478d1a4a861e36280a2e0049d7e664f01ce7372e4c93d2b8
```

Stop if it differs.

## 2. Install the pinned compiler and library

```sh
npm install circom2@0.2.23 circomlib@2.0.5
```

Do not substitute another compiler version: different versions can emit different R1CS bytes for
identical source.

## 3. Compile

```sh
node node_modules/circom2/cli.js unshield.circom --r1cs --wasm --sym -l node_modules/circomlib/circuits -o .
```

The include path ends in `/circuits`; using only `node_modules/circomlib` will not resolve the stock
circuit imports.

The compiler should report:

```
non-linear constraints: 14432
linear constraints: 11489
public inputs: 10
private inputs: 41
```

The total is 25,921 constraints.

## 4. Compare the R1CS digest

On Windows:

```powershell
certutil -hashfile unshield.r1cs SHA256
```

On macOS or Linux:

```sh
sha256sum unshield.r1cs
```

The digest must be:

```
1687738ec20ee5298c6f0fefc8ea8ceef8c528b0be9f592cfe0ea6ea4ec34779
```

For an independent structural check:

```sh
npx snarkjs r1cs info unshield.r1cs
```

A byte-for-byte digest match establishes that this inspected source and pinned toolchain reproduce
the ceremony R1CS. A mismatch with the pinned versions is a stop condition: preserve the output and
report it rather than signing an attestation.
