import { DatabaseSync } from 'node:sqlite';
import { MAX_FRAME_BYTES, MAX_RECIPIENTS, validateFrame } from './protocol.mjs';

const MAX_MAILBOX_MESSAGES = 10_000;

export class LoopbackRelayTransport {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mailbox TEXT NOT NULL,
        message_id TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(mailbox, message_id)
      );
    `);
    this.online = true;
  }

  setOnline(online) { this.online = online; }
  close() { this.db.close(); }
  health() { return { ok: this.online, kind: 'loopback-sqlite', plaintextContent: false }; }

  publish(frame) {
    if (!this.online) throw new Error('relay_offline');
    const frameJson = JSON.stringify(frame);
    if (Buffer.byteLength(frameJson) > MAX_FRAME_BYTES) throw new Error('relay_frame_too_large');
    validateFrame(frame);
    if (frame.recipientDeviceIds.length > MAX_RECIPIENTS) throw new Error('relay_fanout_exceeded');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const mailbox of frame.recipientDeviceIds) {
        const count = this.db.prepare('SELECT COUNT(*) count FROM deliveries WHERE mailbox=?').get(mailbox).count;
        if (count >= MAX_MAILBOX_MESSAGES) throw new Error('relay_mailbox_quota');
        this.db.prepare('INSERT OR IGNORE INTO deliveries(mailbox,message_id,frame_json,created_at) VALUES(?,?,?,?)')
          .run(mailbox, frame.messageId, frameJson, new Date().toISOString());
      }
      this.db.exec('COMMIT');
      return { accepted: true, messageId: frame.messageId };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pull(mailbox, cursor = 0, limit = 100) {
    if (!this.online) throw new Error('relay_offline');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_pull_limit');
    return this.db.prepare('SELECT id,frame_json FROM deliveries WHERE mailbox=? AND id>? ORDER BY id LIMIT ?')
      .all(mailbox, cursor, limit).map((row) => {
        if (Buffer.byteLength(row.frame_json) > MAX_FRAME_BYTES) throw new Error('relay_frame_too_large');
        try { return { deliveryId: row.id, frame: JSON.parse(row.frame_json) }; }
        catch { throw new Error('relay_invalid_frame_json'); }
      });
  }

  injectDuplicate(mailbox, messageId) {
    const row = this.db.prepare('SELECT frame_json FROM deliveries WHERE mailbox=? AND message_id=?').get(mailbox, messageId);
    if (!row) throw new Error('delivery_not_found');
    this.db.prepare('INSERT INTO deliveries(mailbox,message_id,frame_json,created_at) VALUES(?,?,?,?)')
      .run(mailbox, `${messageId}:duplicate:${Date.now()}`, row.frame_json, new Date().toISOString());
  }

  rawFrames() { return this.db.prepare('SELECT frame_json FROM deliveries').all().map((row) => row.frame_json); }
}
