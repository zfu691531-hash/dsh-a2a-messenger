import type { DirectIdentity } from './direct/identity.js';
export type ContactTrust = 'tofu' | 'verified' | 'revoked';
export interface Contact {
    name: string;
    deviceName: string;
    deviceId: string;
    fingerprint: string;
    publicKey: string;
    encryptionPublicKey: string;
    trust: ContactTrust;
    addedAt: number;
    verifiedAt?: number;
    revokedAt?: number;
}
interface ContactCardPayload {
    v: 1;
    name: string;
    deviceName: string;
    deviceId: string;
    publicKey: string;
    encryptionPublicKey: string;
    createdAt: number;
}
interface ContactCard extends ContactCardPayload {
    signature: string;
}
export declare function encodeContactCard(name: string, deviceName: string, identity: DirectIdentity, now?: number): string;
export declare function decodeContactCard(code: string): ContactCard | undefined;
export declare class ContactStore {
    private readonly filePath;
    private readonly contacts;
    private constructor();
    static open(filePath: string): ContactStore;
    importLegacy(peers: ReadonlyMap<string, string>): void;
    acceptCard(code: string): Contact;
    verify(nameOrFingerprint: string, expectedShortFingerprint?: string): Contact;
    revoke(nameOrFingerprint: string): Contact;
    find(nameOrFingerprint: string): Contact | undefined;
    active(): Contact[];
    list(): Contact[];
    trustedPeers(): ReadonlyMap<string, string>;
    private persist;
}
export {};
