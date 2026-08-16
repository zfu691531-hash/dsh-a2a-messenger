import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  decryptVault,
  encryptVault,
  generateEncryptionKeys,
  generateSigningKeys,
  sha256,
  signObject,
  verifyObject,
} from './crypto.mjs';

function deviceCertificatePayload(identity, device) {
  return {
    schemaVersion: 1,
    agentId: identity.agentId,
    deviceId: device.deviceId,
    keyVersion: device.keyVersion,
    signingPublicKey: device.signing.publicKey,
    encryptionPublicKey: device.encryption.publicKey,
    issuedAt: device.issuedAt,
  };
}

export function createIdentity(displayName = 'agent') {
  const root = generateSigningKeys();
  const identity = {
    agentId: randomUUID(),
    displayName,
    identityRevision: 1,
    root,
    devices: [],
    revokedDevices: [],
  };
  addDevice(identity, 'primary');
  return identity;
}

export function addDevice(identity, label = 'device') {
  const device = {
    deviceId: randomUUID(),
    label,
    keyVersion: 1,
    issuedAt: new Date().toISOString(),
    signing: generateSigningKeys(),
    encryption: generateEncryptionKeys(),
  };
  device.certificate = signObject(deviceCertificatePayload(identity, device), identity.root.privateKey);
  identity.devices.push(device);
  return device;
}

export function rotateDevice(identity, deviceId) {
  const previous = identity.devices.find((device) => device.deviceId === deviceId);
  if (!previous || identity.revokedDevices.includes(deviceId)) throw new Error('device_not_active');
  previous.keyVersion += 1;
  previous.issuedAt = new Date().toISOString();
  previous.signing = generateSigningKeys();
  previous.encryption = generateEncryptionKeys();
  previous.certificate = signObject(deviceCertificatePayload(identity, previous), identity.root.privateKey);
  return previous;
}

export function revokeDevice(identity, deviceId) {
  if (!identity.devices.some((device) => device.deviceId === deviceId)) throw new Error('device_not_found');
  if (!identity.revokedDevices.includes(deviceId)) identity.revokedDevices.push(deviceId);
  identity.identityRevision += 1;
  const payload = {
    type: 'device.revoke',
    agentId: identity.agentId,
    deviceId,
    revision: identity.identityRevision,
    revokedAt: new Date().toISOString(),
  };
  return { payload, signature: signObject(payload, identity.root.privateKey) };
}

export function publicDevice(identity, device = identity.devices[0]) {
  return {
    agentId: identity.agentId,
    displayName: identity.displayName,
    rootPublicKey: identity.root.publicKey,
    deviceId: device.deviceId,
    label: device.label,
    keyVersion: device.keyVersion,
    issuedAt: device.issuedAt,
    signingPublicKey: device.signing.publicKey,
    encryptionPublicKey: device.encryption.publicKey,
    certificate: device.certificate,
  };
}

export function verifyDeviceCertificate(device) {
  return verifyObject({
    schemaVersion: 1,
    agentId: device.agentId,
    deviceId: device.deviceId,
    keyVersion: device.keyVersion,
    signingPublicKey: device.signingPublicKey,
    encryptionPublicKey: device.encryptionPublicKey,
    issuedAt: device.issuedAt,
  }, device.certificate, device.rootPublicKey);
}

export const identityFingerprint = (identityOrPublicDevice) =>
  sha256(identityOrPublicDevice.root?.publicKey ?? identityOrPublicDevice.rootPublicKey)
    .match(/.{1,4}/g).join(' ');

export function verifyContact(expectedFingerprint, publicDeviceRecord) {
  const actual = identityFingerprint(publicDeviceRecord);
  return { verified: actual === expectedFingerprint, actual };
}

export function saveEncryptedIdentity(path, identity, passphrase) {
  writeFileSync(path, `${JSON.stringify(encryptVault(identity, passphrase), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadEncryptedIdentity(path, passphrase) {
  return decryptVault(JSON.parse(readFileSync(path, 'utf8')), passphrase);
}
