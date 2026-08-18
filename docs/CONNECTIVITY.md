# Connectivity policy and physical validation

## What “no self-hosted server” means

The plugin can operate without infrastructure deployed by its users. That does not mean every mode is third-party-free:

| Path | Control plane | Data plane | Third party learns |
|---|---|---|---|
| Manual + `strict` | user-selected code carrier | direct WebRTC | carrier sees SDP unless exchanged offline |
| Sealed mailbox + `strict` | GitHub/shared folder, encrypted | direct WebRTC | timing, size, account/repository metadata |
| Sealed mailbox + `stun` | mailbox + STUN | direct WebRTC | above plus public source address/time at STUN |
| Sealed mailbox + `relay` | mailbox + TURN | TURN relay | TURN observes endpoints, timing, volume; content remains WebRTC-encrypted |
| Async sealed message | GitHub/shared folder | store-and-forward | metadata and ciphertext |

Use `/a2a-doctor` on both machines before claiming a route. Candidate types are:

- `host`: local/interface address;
- `srflx`: public mapped address learned through STUN;
- `prflx`: peer-reflexive candidate learned during checks;
- `relay`: TURN relay candidate.

## Two-device validation matrix

Run the following on two physical machines with separately paired identities. Record both `/a2a-doctor` outputs, route status, connect time, selected policy, success/failure, and whether a direct receipt reaches `quarantined`.

| Case | Machine A | Machine B | Expected |
|---|---|---|---|
| Same LAN strict | home/office LAN | same LAN | host candidates connect |
| Cross-network STUN | home broadband | mobile hotspot | direct succeeds when NAT permits |
| Dual carrier | carrier A | carrier B | success or explicit ICE failure; never mailbox plaintext fallback |
| IPv6 | IPv6-enabled ISP | IPv6-enabled ISP | host IPv6 candidate may connect without STUN mapping |
| Symmetric NAT | strict enterprise/mobile NAT | another NAT | direct may fail; result must be explicit |
| TURN-only | blocked UDP/direct | configured TURN | relay candidate only, status says TURN |
| Offline recipient | sender online | recipient offline | sealed mailbox persists; direct call waits until polling/online |
| Route outage | GitHub blocked | shared folder available | GitHub send fails; filesystem works only when explicitly selected |
| Tampering | alter one envelope byte | recipient polls | message rejected before quarantine |
| Revocation | revoke peer device | peer sends/calls | envelope/direct identity rejected |

## Operational checks

1. Verify the effective `mailboxEncryption` and route in `/a2a-status`.
2. Verify `Third-party discovery contacted` in `/a2a-doctor` matches policy.
3. Send a harmless direct message and inspect `/a2a-receipts`.
4. Accept or reject it on the receiver and confirm the sender sees the terminal receipt.
5. Search the backing GitHub Issue or shared files for the harmless plaintext marker; sealed mode must contain only `DSH1-...` envelopes.
6. Disable the selected route and verify the send reports an error instead of switching routes.

Local automated WebRTC loopback proves codec, identity, rendezvous, quarantine, and receipt integration; it cannot prove a particular ISP/NAT/firewall pair. Keep physical results separate from unit-test claims.
