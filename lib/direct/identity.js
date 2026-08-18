import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export function fingerprintPublicKey(publicKey) {
    const der = Buffer.from(publicKey, 'base64url');
    createPublicKey({ key: der, format: 'der', type: 'spki' });
    return `ed25519:${createHash('sha256').update(der).digest('base64url')}`;
}
export function createDirectIdentity() {
    const pair = generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64url');
    const privateKey = pair.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64url');
    return { publicKey, privateKey, fingerprint: fingerprintPublicKey(publicKey) };
}
export function openDirectIdentity(filePath) {
    if (existsSync(filePath))
        return parseStoredIdentity(readFileSync(filePath, 'utf8'));
    const identity = createDirectIdentity();
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    const stored = {
        version: 1,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
    };
    writeFileSync(tmp, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, filePath);
    return identity;
}
export function signText(identity, text) {
    const key = createPrivateKey({
        key: Buffer.from(identity.privateKey, 'base64url'),
        format: 'der',
        type: 'pkcs8',
    });
    return sign(null, Buffer.from(text, 'utf8'), key).toString('base64url');
}
export function verifyText(publicKey, text, signature) {
    try {
        const key = createPublicKey({
            key: Buffer.from(publicKey, 'base64url'),
            format: 'der',
            type: 'spki',
        });
        return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64url'));
    }
    catch {
        return false;
    }
}
function parseStoredIdentity(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw new Error('direct identity file is not valid JSON; restore it instead of generating a new identity');
    }
    if (typeof raw !== 'object' || raw === null)
        throw new Error('direct identity file is invalid');
    const stored = raw;
    if (stored.version !== 1 ||
        typeof stored.publicKey !== 'string' ||
        typeof stored.privateKey !== 'string') {
        throw new Error('direct identity file has an unsupported format');
    }
    try {
        const privateKey = createPrivateKey({
            key: Buffer.from(stored.privateKey, 'base64url'),
            format: 'der',
            type: 'pkcs8',
        });
        const derivedPublic = createPublicKey(privateKey)
            .export({ format: 'der', type: 'spki' })
            .toString('base64url');
        if (derivedPublic !== stored.publicKey)
            throw new Error('public/private key mismatch');
        return {
            publicKey: stored.publicKey,
            privateKey: stored.privateKey,
            fingerprint: fingerprintPublicKey(stored.publicKey),
        };
    }
    catch (err) {
        throw new Error(`direct identity file is corrupt: ${err.message}`);
    }
}
