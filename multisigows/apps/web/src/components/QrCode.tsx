import React, { useMemo } from 'react';
import { encodeQr } from '../lib/qrcode.js';

const QUIET_ZONE = 4;

export const QrCode: React.FC<{ value: string; size?: number; title?: string }> = ({ value, size = 180, title }) => {
  const qr = useMemo(() => encodeQr(value), [value]);
  const dim = qr.size + QUIET_ZONE * 2;

  const path = useMemo(() => {
    let d = '';
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.dark[y]![x]) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return d;
  }, [qr]);

  return (
    <svg
      role="img"
      aria-label={title ?? `QR code for ${value}`}
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
};

/** Same grouping everywhere an address is confirmed (core/src/vault/format.ts). */
export { groupAddress } from '@darksafe/core';
