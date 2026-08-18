export interface DirectIdentity {
    publicKey: string;
    privateKey: string;
    fingerprint: string;
    encryptionPublicKey: string;
    encryptionPrivateKey: string;
    deviceId: string;
}
export declare function fingerprintPublicKey(publicKey: string): string;
export declare function createDirectIdentity(): DirectIdentity;
export declare function openDirectIdentity(filePath: string): DirectIdentity;
export declare function signText(identity: DirectIdentity, text: string): string;
export declare function verifyText(publicKey: string, text: string, signature: string): boolean;
