import { describe, expect, it } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';
import { ipfsCidV0 } from '../src/cid.js';
import { intakeFileJson, normaliseParcelId, packageDeedIntake, readIntakeFile, type DeedIntakeInput } from '../src/intake.js';

const cyprus = { addressRule: 'cyprus1' as const };

const input = (over: Partial<DeedIntakeInput> = {}): DeedIntakeInput => ({
  recipient: '0x001598ce5966385c9290b1b87079f1be620cf2a2',
  parcelId: ' apn 401 x ',
  physicalAddress: '401 Harbour Street, Port Vale',
  legalOwner: 'Harbour Street Holdings LLC',
  legalDescription: 'Lot 15, Block 3718, as recorded in the Port Vale register.',
  geoJson: JSON.stringify({
    type: 'Polygon',
    coordinates: [
      [
        [-9.4215, 38.6917],
        [-9.4205, 38.6917],
        [-9.4205, 38.6907],
        [-9.4215, 38.6907],
        [-9.4215, 38.6917],
      ],
    ],
  }),
  operatingAgreementText: 'OPERATING AGREEMENT of Harbour Street Holdings LLC. Members: ...',
  ...over,
});

describe('deed intake', () => {
  it('normalises parcel ids the way they are compared on chain', () => {
    expect(normaliseParcelId(' apn 401 x ')).toBe('APN-401-X');
  });

  it('packages mint arguments whose metadata URI is the real CID of the document', () => {
    const res = packageDeedIntake(input(), cyprus);
    expect(res.ok).toBe(true);
    const pkg = res.pkg!;
    expect(pkg.mintArgs.parcelId).toBe('APN-401-X');
    expect(pkg.mintArgs.recipient).toBe('0x001598Ce5966385c9290B1b87079f1bE620CF2A2');
    expect(pkg.agreementHash).toBe(keccak256(toUtf8Bytes(input().operatingAgreementText)));
    expect(pkg.mintArgs.operatingAgreementHash).toBe(pkg.agreementHash);
    expect(pkg.metadataCid).toBe(ipfsCidV0(new TextEncoder().encode(pkg.metadataJson)));
    expect(pkg.mintArgs.metadataUri).toBe(`ipfs://${pkg.metadataCid}`);
    expect(pkg.areaSqm).toBeGreaterThan(9_000);
    expect(JSON.parse(pkg.mintArgs.geoJson).properties.apn).toBe('APN-401-X');
  });

  it('is deterministic', () => {
    expect(packageDeedIntake(input(), cyprus).pkg!.metadataCid).toBe(packageDeedIntake(input(), cyprus).pkg!.metadataCid);
  });

  it('lists every problem before anything irreversible', () => {
    const res = packageDeedIntake(
      input({ recipient: '0x1234567890123456789012345678901234567890', parcelId: '!', geoJson: '{}', operatingAgreementText: 'short' }),
      cyprus
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join(' | ')).toMatch(/Owner wallet.*Parcel id.*operating agreement.*Boundary/);
  });

  it('round-trips through the intake file the registrar loads', () => {
    const pkg = packageDeedIntake(input(), cyprus).pkg!;
    const back = readIntakeFile(intakeFileJson(pkg), cyprus);
    expect(back.ok).toBe(true);
    expect(back.pkg!.mintArgs).toEqual(pkg.mintArgs);
    expect(back.pkg!.metadataCid).toBe(pkg.metadataCid);
  });

  it('catches an intake file edited after export', () => {
    const pkg = packageDeedIntake(input(), cyprus).pkg!;
    const file = JSON.parse(intakeFileJson(pkg));
    file.mintArgs.recipient = '0x0000000000000000000000000000000000005c01';
    const res = readIntakeFile(JSON.stringify(file), cyprus);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/edited after export/);
  });

  it('refuses files that are not intake files', () => {
    expect(readIntakeFile('nope', cyprus).ok).toBe(false);
    expect(readIntakeFile('{"kind":"other"}', cyprus).ok).toBe(false);
  });
});
