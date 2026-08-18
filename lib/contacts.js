import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fingerprintPublicKey, signText, verifyText } from './direct/identity.js';
const CARD_PREFIX = 'A2AC1-';
const MAX_CARD_CHARS = 4096;
function canonicalCard(card) {
    return JSON.stringify([
        card.v,
        card.name,
        card.deviceName,
        card.deviceId,
        card.publicKey,
        card.encryptionPublicKey,
        card.createdAt,
    ]);
}
export function encodeContactCard(name, deviceName, identity, now = Date.now()) {
    const payload = {
        v: 1,
        name: name.trim(),
        deviceName: deviceName.trim(),
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        encryptionPublicKey: identity.encryptionPublicKey,
        createdAt: now,
    };
    if (!payload.name || payload.name.length > 128)
        throw new Error('contact name must be 1-128 characters');
    if (!payload.deviceName || payload.deviceName.length > 128)
        throw new Error('device name must be 1-128 characters');
    const card = { ...payload, signature: signText(identity, canonicalCard(payload)) };
    return CARD_PREFIX + Buffer.from(JSON.stringify(card), 'utf8').toString('base64url');
}
export function decodeContactCard(code) {
    const trimmed = code.trim();
    if (!trimmed.startsWith(CARD_PREFIX) || trimmed.length > MAX_CARD_CHARS)
        return undefined;
    try {
        const raw = JSON.parse(Buffer.from(trimmed.slice(CARD_PREFIX.length), 'base64url').toString('utf8'));
        if (raw.v !== 1 ||
            typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > 128 ||
            typeof raw.deviceName !== 'string' || raw.deviceName.length === 0 || raw.deviceName.length > 128 ||
            typeof raw.deviceId !== 'string' || raw.deviceId.length < 8 || raw.deviceId.length > 128 ||
            typeof raw.publicKey !== 'string' || raw.publicKey.length > 256 ||
            typeof raw.encryptionPublicKey !== 'string' || raw.encryptionPublicKey.length > 256 ||
            typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt) ||
            typeof raw.signature !== 'string' || raw.signature.length > 256)
            return undefined;
        const { signature, ...payload } = raw;
        if (!verifyText(raw.publicKey, canonicalCard(payload), signature))
            return undefined;
        fingerprintPublicKey(raw.publicKey);
        createPublicKey({
            key: Buffer.from(raw.encryptionPublicKey, 'base64url'),
            format: 'der',
            type: 'spki',
        });
        return raw;
    }
    catch {
        return undefined;
    }
}
export class ContactStore {
    filePath;
    contacts = new Map();
    constructor(filePath) {
        this.filePath = filePath;
    }
    static open(filePath) {
        const store = new ContactStore(filePath);
        if (!existsSync(filePath))
            return store;
        try {
            const raw = JSON.parse(readFileSync(filePath, 'utf8'));
            if (Array.isArray(raw.contacts)) {
                for (const item of raw.contacts) {
                    const contact = parseContact(item);
                    if (contact)
                        store.contacts.set(contact.fingerprint, contact);
                }
            }
        }
        catch {
            throw new Error('contacts file is corrupt; restore it instead of replacing trusted identities');
        }
        return store;
    }
    importLegacy(peers) {
        let changed = false;
        for (const [fingerprint, name] of peers) {
            if (this.contacts.has(fingerprint))
                continue;
            this.contacts.set(fingerprint, {
                name,
                deviceName: 'legacy',
                deviceId: `legacy-${fingerprint.slice(-12)}`,
                fingerprint,
                publicKey: '',
                encryptionPublicKey: '',
                trust: 'verified',
                addedAt: Date.now(),
            });
            changed = true;
        }
        if (changed)
            this.persist();
    }
    acceptCard(code) {
        const card = decodeContactCard(code);
        if (!card)
            throw new Error('invalid or tampered contact card');
        const fingerprint = fingerprintPublicKey(card.publicKey);
        const existing = this.contacts.get(fingerprint);
        const contact = {
            name: card.name,
            deviceName: card.deviceName,
            deviceId: card.deviceId,
            fingerprint,
            publicKey: card.publicKey,
            encryptionPublicKey: card.encryptionPublicKey,
            trust: existing?.trust === 'verified' ? 'verified' : 'tofu',
            addedAt: existing?.addedAt ?? Date.now(),
            verifiedAt: existing?.verifiedAt,
        };
        this.contacts.set(fingerprint, contact);
        this.persist();
        return contact;
    }
    verify(nameOrFingerprint, expectedShortFingerprint) {
        const contact = this.find(nameOrFingerprint);
        if (!contact || contact.trust === 'revoked')
            throw new Error(`active contact "${nameOrFingerprint}" not found`);
        if (expectedShortFingerprint && expectedShortFingerprint.length < 12) {
            throw new Error('fingerprint confirmation must contain at least 12 trailing characters');
        }
        if (expectedShortFingerprint && !contact.fingerprint.endsWith(expectedShortFingerprint)) {
            throw new Error('fingerprint confirmation does not match');
        }
        contact.trust = 'verified';
        contact.verifiedAt = Date.now();
        delete contact.revokedAt;
        this.persist();
        return contact;
    }
    revoke(nameOrFingerprint) {
        const contact = this.find(nameOrFingerprint);
        if (!contact)
            throw new Error(`contact "${nameOrFingerprint}" not found`);
        contact.trust = 'revoked';
        contact.revokedAt = Date.now();
        this.persist();
        return contact;
    }
    find(nameOrFingerprint) {
        const exact = this.contacts.get(nameOrFingerprint);
        if (exact)
            return exact;
        const separator = nameOrFingerprint.lastIndexOf('@');
        if (separator > 0) {
            const name = nameOrFingerprint.slice(0, separator);
            const device = nameOrFingerprint.slice(separator + 1);
            return this.list().find((contact) => contact.name === name &&
                (contact.deviceName === device || contact.deviceId.startsWith(device)));
        }
        const matches = this.active().filter((contact) => contact.name === nameOrFingerprint);
        if (matches.length > 1) {
            throw new Error(`contact "${nameOrFingerprint}" has multiple devices; use name@device`);
        }
        return matches[0];
    }
    active() {
        return this.list().filter((contact) => contact.trust !== 'revoked');
    }
    list() {
        return [...this.contacts.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    trustedPeers() {
        return new Map(this.active().map((contact) => [contact.fingerprint, contact.name]));
    }
    persist() {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: 1, contacts: this.list() }, null, 2), 'utf8');
        renameSync(tmp, this.filePath);
    }
}
function parseContact(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const raw = value;
    if (typeof raw.name !== 'string' ||
        typeof raw.deviceName !== 'string' ||
        typeof raw.deviceId !== 'string' ||
        typeof raw.fingerprint !== 'string' ||
        typeof raw.publicKey !== 'string' ||
        typeof raw.encryptionPublicKey !== 'string' ||
        (raw.trust !== 'tofu' && raw.trust !== 'verified' && raw.trust !== 'revoked') ||
        typeof raw.addedAt !== 'number')
        return undefined;
    return raw;
}
