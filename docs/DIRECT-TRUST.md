# Direct session trust setup

Direct sessions use WebRTC DataChannel for encrypted peer-to-peer traffic. They do not use
GitHub, TeamMCP, paste services, or TURN for message forwarding.

## 1. Start in direct-only mode

Configure each machine with its own stable display name:

```yaml
- id: a2a-messenger
  config:
    agentName: 'alice'
    transport: 'none'
    trustedPeers: []
```

The plugin creates a persistent Ed25519 identity in
`~/.dsh-a2a-messenger/direct-identity.json`. This file contains the private key. Do not send
it to anyone, commit it, or place it in a shared folder. Back it up securely: deleting it
creates a new identity that peers will not trust.

## 2. Exchange fingerprints

On each machine, run:

```text
/a2a-identity
```

Exchange the returned `name=ed25519:fingerprint` entries over an already trusted channel,
such as an in-person QR check or an existing authenticated chat. Compare the whole entry.

Alice then configures Bob's entry:

```yaml
trustedPeers:
  - 'bob=ed25519:REPLACE_WITH_BOBS_FULL_FINGERPRINT'
```

Bob configures Alice's entry in the same way. Restart DSH after changing configuration.
An empty list rejects every incoming direct connection.

## 3. Connect

1. Alice runs `/a2a-connect` and sends the signed `A2A2-...` offer code to Bob.
2. Bob runs `/a2a-join <offer-code>` and sends the resulting answer code to Alice.
3. Alice runs `/a2a-join <answer-code>`.
4. Both users verify `/a2a-status` shows the expected peer name and fingerprint.

Old unsigned `A2A1` codes are deliberately rejected; both peers must run the hardened
version.

## Security boundary

- The signature prevents signaling modification and binds the configured peer name to a
  stable public key.
- The answer is bound to the pending offer's session id.
- Message sender identity comes from the verified session, never from message JSON.
- Incoming text remains quarantined until the local user runs `/a2a-accept`.
- Direct messages cannot request or invoke local tools or shell commands.
- Connection codes contain SDP and network candidates. Signing does not hide them; exchange
  codes only through a channel you accept for this metadata.
- WebRTC can expose network addresses to the peer. Without TURN, strict or symmetric NAT may
  prevent the connection; the plugin fails instead of relaying business traffic.
