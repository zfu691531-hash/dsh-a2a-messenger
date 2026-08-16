import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';

export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function generateSigningKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function generateEncryptionKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function signObject(value, privateKey) {
  return sign(null, Buffer.from(canonical(value)), createPrivateKey(privateKey)).toString('base64');
}

export function verifyObject(value, signature, publicKey) {
  try {
    return verify(
      null,
      Buffer.from(canonical(value)),
      createPublicKey(publicKey),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export function encryptAead(plaintext, key, aad = '', nonce = randomBytes(12)) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: nonce.toString('base64'),
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
  };
}

export function decryptAead(ciphertext, nonce, key, aad = '') {
  const packed = Buffer.from(ciphertext, 'base64');
  if (packed.length < 17) throw new Error('ciphertext_too_short');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(packed.subarray(-16));
  return Buffer.concat([decipher.update(packed.subarray(0, -16)), decipher.final()]);
}

function wrappingKey(shared, context) {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(context), 32));
}

export function wrapKeyForDevice(key, recipientPublicKey, context) {
  const ephemeral = generateEncryptionKeys();
  const shared = diffieHellman({
    privateKey: createPrivateKey(ephemeral.privateKey),
    publicKey: createPublicKey(recipientPublicKey),
  });
  return {
    ephemeralPublicKey: ephemeral.publicKey,
    ...encryptAead(key, wrappingKey(shared, context), context),
  };
}

export function unwrapKeyForDevice(wrapped, recipientPrivateKey, context) {
  const shared = diffieHellman({
    privateKey: createPrivateKey(recipientPrivateKey),
    publicKey: createPublicKey(wrapped.ephemeralPublicKey),
  });
  return decryptAead(wrapped.ciphertext, wrapped.nonce, wrappingKey(shared, context), context);
}

export const randomEpochKey = () => randomBytes(32);

export function encryptVault(value, passphrase) {
  if (!passphrase || passphrase.length < 12) throw new Error('passphrase_too_short');
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const encrypted = encryptAead(Buffer.from(JSON.stringify(value)), key, 'dsh-a2a-vault/v1');
  key.fill(0);
  return { version: 1, kdf: 'scrypt-N131072-r8-p1', salt: salt.toString('base64'), ...encrypted };
}

export function decryptVault(vault, passphrase) {
  if (vault.version !== 1) throw new Error('unsupported_vault_version');
  if (vault.kdf !== 'scrypt-N131072-r8-p1') throw new Error('unsupported_vault_kdf');
  const key = scryptSync(passphrase, Buffer.from(vault.salt, 'base64'), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const plaintext = decryptAead(vault.ciphertext, vault.nonce, key, 'dsh-a2a-vault/v1');
  key.fill(0);
  return JSON.parse(plaintext.toString('utf8'));
}

export function constantTimeEqual(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
