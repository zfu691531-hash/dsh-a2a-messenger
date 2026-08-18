# Direct trust and device identity

Each installation owns one persistent device identity in `direct-identity.json`:

- Ed25519 signs pairing cards, WebRTC offer/answer codes, and mailbox envelopes;
- X25519 derives per-envelope AES-256-GCM keys;
- a random `deviceId` separates devices from the mutable person/display name.

The v0.4 identity format migrates in place: the Ed25519 key and fingerprint remain unchanged while encryption keys and `deviceId` are added. Never share or sync this private identity file.

## Pairing

1. Each device runs `/a2a-pair`.
2. Exchange the `A2AC1-...` cards through an authenticated channel.
3. Run `/a2a-pair-accept <card>`; the contact starts as TOFU.
4. Compare the complete Ed25519 fingerprint out of band.
5. Run `/a2a-verify name@device <fingerprint-suffix>`.

Multiple devices may have the same person name. Address them as `name@device`; the cryptographic fingerprint, not the display label, is authoritative. `/a2a-untrust` revokes one local device record immediately. Legacy `trustedPeers` entries remain accepted for direct sessions but lack mailbox encryption keys until a pairing card is exchanged.

## Signaling and transport boundary

- Manual mode carries signed `A2A2-...` codes through a channel selected by the users.
- Automatic mode carries the same signed codes inside an authenticated, expiring sealed mailbox envelope.
- SDP contains IP addresses and ICE candidates. Manual codes expose them to the carrying channel; sealed automatic signaling hides the payload from the mailbox provider, but not traffic metadata.
- WebRTC encrypts the data channel. `strict` and `stun` aim for a direct data path; `relay` explicitly sends data through configured TURN.

## Message boundary

- Session identity is taken from the verified A2A2 signing key, never peer-supplied message JSON.
- Incoming text remains quarantined until the local user accepts it.
- Direct receipts report network/quarantine state and later local accept/reject state; they do not mean the model followed the message.
- Pairing authenticates a device, not every statement its user or agent sends.

## Cryptographic limitations

Mailbox sealing uses static X25519 device keys, random message IDs and IVs, HKDF-SHA256, AES-256-GCM, and an Ed25519 envelope signature. It provides confidentiality, integrity, sender authentication, expiry, and recipient binding, but not Signal-style forward secrecy or global revocation. A stolen device key requires local revocation on every peer and a new pairing card.
