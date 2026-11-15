import { randomInt } from 'node:crypto';

/**
 * PNR = 2-letter operator prefix + 8 random characters from an unambiguous alphabet
 * (no 0/O, 1/I/L), e.g. "DS7KQ4M9XA". Random (not sequential) so PNRs cannot be guessed.
 * 8 chars from 31 symbols ≈ 8.5 × 10^11 combinations; the unique index on bookings.pnr
 * is the final guard and the service retries on the (astronomically rare) collision.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generatePnr(operatorCode: string): string {
  const prefix = operatorCode.replace(/[^A-Z]/g, '').padEnd(2, 'X').slice(0, 2);
  let body = '';
  for (let i = 0; i < 8; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return prefix + body;
}

export const PNR_PATTERN = /^[A-Z0-9]{10}$/;
