import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

// ─── Mock ICP identity constructors ───────────────────────────────────────────
// identityFromPem detects key type via Node.js crypto, then delegates to the
// appropriate ICP SDK constructor. We mock the constructors to avoid depending
// on the full ICP SDK in unit tests — the important thing is that the right
// branch is taken based on PEM content.

const { mockEd25519FromSecretKey, mockSecp256k1FromPem } = vi.hoisted(() => ({
  mockEd25519FromSecretKey: vi.fn(() => ({ type: 'Ed25519KeyIdentity' })),
  mockSecp256k1FromPem: vi.fn(() => ({ type: 'Secp256k1KeyIdentity' })),
}));

vi.mock('@icp-sdk/core/identity', () => ({
  Ed25519KeyIdentity: {
    fromSecretKey: mockEd25519FromSecretKey,
  },
}));

vi.mock('@icp-sdk/core/identity/secp256k1', () => ({
  Secp256k1KeyIdentity: {
    fromPem: mockSecp256k1FromPem,
  },
}));

import { identityFromPem } from '../src/identity.js';

// ─── Fixture PEM generators ───────────────────────────────────────────────────

// Clear mock call counts before each test so assertions in one test don't
// bleed into the next.
beforeEach(() => {
  mockEd25519FromSecretKey.mockClear();
  mockSecp256k1FromPem.mockClear();
});

function makeEd25519Pem(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

function makeSecp256k1Pem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('identityFromPem', () => {
  it('detects Ed25519 PEM (dfx default) and calls Ed25519KeyIdentity.fromSecretKey', () => {
    const pem = makeEd25519Pem();
    identityFromPem(pem);
    expect(mockEd25519FromSecretKey).toHaveBeenCalledOnce();
    expect(mockSecp256k1FromPem).not.toHaveBeenCalled();
  });

  it('detects secp256k1 PEM (icp-cli default) and calls Secp256k1KeyIdentity.fromPem', () => {
    const pem = makeSecp256k1Pem();
    identityFromPem(pem);
    expect(mockSecp256k1FromPem).toHaveBeenCalledOnce();
    expect(mockSecp256k1FromPem).toHaveBeenCalledWith(pem);
    expect(mockEd25519FromSecretKey).not.toHaveBeenCalled();
  });

  it('throws an error for invalid PEM content', () => {
    // Node.js crypto throws an OpenSSL decoder error — just verify it throws
    expect(() => identityFromPem('not a pem')).toThrow();
  });

  it('throws a descriptive error for unsupported key type (e.g. RSA)', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const rsaPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => identityFromPem(rsaPem)).toThrowError(/unsupported key type/i);
  });
});
