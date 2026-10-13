import { keccak256, toUtf8Bytes } from 'ethers';
import { checkAddress } from './address.js';
import { canonicalJson, ipfsCidV0 } from './cid.js';
import type { NetworkConfig } from './config.js';
import { parcelAreaSqm, parseParcelGeoJson } from './geo.js';

/**
 * Deed intake: what a property owner submits so the registrar can mint a deed.
 *
 *   validate  ->  package  ->  (registrar mints, on chain)  ->  verify
 *
 * Validation and packaging are free and repeatable. Minting is the irreversible step: a parcel id
 * can be registered once, ever, and the record cannot be edited afterwards. Packaging produces the
 * metadata document, its real CIDv0, the operating-agreement hash and the exact mint arguments, so
 * the registrar signs precisely what the owner reviewed.
 */

export interface DeedIntakeInput {
  recipient: string;
  parcelId: string;
  physicalAddress: string;
  legalOwner: string;
  legalDescription: string;
  geoJson: string;
  operatingAgreementText: string;
}

export interface DeedMintArgs {
  recipient: string;
  legalDescription: string;
  physicalAddress: string;
  geoJson: string;
  parcelId: string;
  legalOwner: string;
  operatingAgreementHash: string;
  metadataUri: string;
}

export interface DeedIntakePackage {
  mintArgs: DeedMintArgs;
  metadataJson: string;
  metadataCid: string;
  agreementHash: string;
  areaSqm: number;
}

export interface IntakeResult {
  ok: boolean;
  errors: string[];
  pkg?: DeedIntakePackage;
}

/** Parcel ids are compared exactly on chain, so they are normalised before they get there. */
export function normaliseParcelId(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').toUpperCase();
}

export function hashAgreement(text: string): string {
  return keccak256(toUtf8Bytes(text));
}

export function validateDeedIntake(input: DeedIntakeInput, network: Pick<NetworkConfig, 'addressRule'>): string[] {
  const errors: string[] = [];
  const recipient = checkAddress(input.recipient, network.addressRule);
  if (!recipient.ok) errors.push(`Owner wallet: ${recipient.error}`);
  const parcelId = normaliseParcelId(input.parcelId);
  if (!/^[A-Z0-9][A-Z0-9._/-]{2,63}$/.test(parcelId)) {
    errors.push('Parcel id must be 3-64 letters, digits, dots, slashes or dashes (as printed on the tax roll).');
  }
  if (input.physicalAddress.trim().length < 5) errors.push('Street address is required.');
  if (input.legalOwner.trim().length < 3) errors.push('The legal owner named on the deed is required.');
  if (input.legalDescription.trim().length < 10) errors.push('The legal description (as on the recorded deed) is required.');
  if (input.operatingAgreementText.trim().length < 20) {
    errors.push("Paste the owning entity's operating agreement (its keccak256 hash goes on chain).");
  }
  const geo = parseParcelGeoJson(input.geoJson);
  if (!geo.ok) errors.push(`Boundary: ${geo.error}`);
  return errors;
}

/** Validates, then builds the metadata document and mint arguments. Pure and deterministic. */
export function packageDeedIntake(input: DeedIntakeInput, network: Pick<NetworkConfig, 'addressRule'>): IntakeResult {
  const errors = validateDeedIntake(input, network);
  if (errors.length) return { ok: false, errors };

  const geo = parseParcelGeoJson(input.geoJson);
  const polygon = geo.polygon!;
  const parcelId = normaliseParcelId(input.parcelId);
  // The boundary goes on chain in a canonical, compact form: same parcel, same bytes.
  const geoJson = JSON.stringify({ type: 'Feature', geometry: polygon, properties: { apn: parcelId } });
  const agreementHash = hashAgreement(input.operatingAgreementText);
  const areaSqm = Math.round(parcelAreaSqm(polygon) * 100) / 100;

  const metadata = {
    name: `Dark Questate deed ${parcelId}`,
    description: input.legalDescription.trim(),
    attributes: [
      { trait_type: 'Parcel id', value: parcelId },
      { trait_type: 'Street address', value: input.physicalAddress.trim() },
      { trait_type: 'Legal owner', value: input.legalOwner.trim() },
      { trait_type: 'Area (m²)', value: areaSqm },
    ],
    // The first holder is part of the document, so the CID covers every mint argument.
    initialHolder: checkAddress(input.recipient, network.addressRule).address!,
    eip6065: {
      legalDescription: input.legalDescription.trim(),
      physicalAddress: input.physicalAddress.trim(),
      parcelId,
      legalOwner: input.legalOwner.trim(),
      operatingAgreementHash: agreementHash,
      geoJson: JSON.parse(geoJson),
    },
  };
  const metadataJson = canonicalJson(metadata);
  const metadataCid = ipfsCidV0(new TextEncoder().encode(metadataJson));

  return {
    ok: true,
    errors: [],
    pkg: {
      agreementHash,
      areaSqm,
      metadataJson,
      metadataCid,
      mintArgs: {
        recipient: checkAddress(input.recipient, network.addressRule).address!,
        legalDescription: input.legalDescription.trim(),
        physicalAddress: input.physicalAddress.trim(),
        geoJson,
        parcelId,
        legalOwner: input.legalOwner.trim(),
        operatingAgreementHash: agreementHash,
        metadataUri: `ipfs://${metadataCid}`,
      },
    },
  };
}

/** The file an owner hands the registrar: the arguments to sign plus the document they point at. */
export function intakeFileJson(pkg: DeedIntakePackage): string {
  return canonicalJson({
    kind: 'dark-questate/deed-intake',
    version: 1,
    mintArgs: pkg.mintArgs,
    metadataCid: pkg.metadataCid,
    metadata: JSON.parse(pkg.metadataJson),
  });
}

/** Reads an intake file back, re-deriving everything so a hand-edited file cannot smuggle in a mismatch. */
export function readIntakeFile(text: string, network: Pick<NetworkConfig, 'addressRule'>): IntakeResult {
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['That file is not JSON.'] };
  }
  if (obj?.kind !== 'dark-questate/deed-intake' || obj?.version !== 1 || typeof obj?.mintArgs !== 'object') {
    return { ok: false, errors: ['That is not a Dark Questate deed intake file.'] };
  }
  const a = obj.mintArgs as Partial<DeedMintArgs>;
  const description = obj.metadata?.eip6065?.legalDescription;
  return checkPackage(
    {
      recipient: String(a.recipient ?? ''),
      parcelId: String(a.parcelId ?? ''),
      physicalAddress: String(a.physicalAddress ?? ''),
      legalOwner: String(a.legalOwner ?? ''),
      legalDescription: String(a.legalDescription ?? description ?? ''),
      geoJson: String(a.geoJson ?? ''),
      operatingAgreementText: '',
    },
    String(a.operatingAgreementHash ?? ''),
    String(obj.metadataCid ?? ''),
    network
  );
}

function checkPackage(
  input: DeedIntakeInput,
  agreementHash: string,
  claimedCid: string,
  network: Pick<NetworkConfig, 'addressRule'>
): IntakeResult {
  // The agreement text itself never leaves the owner, so only its hash is checked here.
  const errors = validateDeedIntake({ ...input, operatingAgreementText: 'x'.repeat(20) }, network);
  if (!/^0x[0-9a-fA-F]{64}$/.test(agreementHash) || /^0x0{64}$/.test(agreementHash)) {
    errors.push('The operating agreement hash is missing or malformed.');
  }
  if (errors.length) return { ok: false, errors };
  const rebuilt = packageDeedIntake({ ...input, operatingAgreementText: 'placeholder agreement text' }, network).pkg!;
  // Swap in the real hash and rebuild the document it belongs in.
  const metadata = JSON.parse(rebuilt.metadataJson);
  metadata.eip6065.operatingAgreementHash = agreementHash;
  const metadataJson = canonicalJson(metadata);
  const metadataCid = ipfsCidV0(new TextEncoder().encode(metadataJson));
  if (!claimedCid) return { ok: false, errors: ['The file has no metadata CID; export it again from the intake form.'] };
  if (claimedCid !== metadataCid) {
    return { ok: false, errors: [`The file's metadata CID (${claimedCid}) does not match its contents (${metadataCid}). It was edited after export.`] };
  }
  return {
    ok: true,
    errors: [],
    pkg: {
      agreementHash,
      areaSqm: rebuilt.areaSqm,
      metadataJson,
      metadataCid,
      mintArgs: { ...rebuilt.mintArgs, operatingAgreementHash: agreementHash, metadataUri: `ipfs://${metadataCid}` },
    },
  };
}
