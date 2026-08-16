import { DatabaseSync } from 'node:sqlite';

const transitions = {
  proposed: new Set(['accepted', 'failed', 'cancelled']),
  accepted: new Set(['running', 'cancelled']),
  running: new Set(['blocked', 'completed', 'failed', 'cancelled']),
  blocked: new Set(['running', 'failed', 'cancelled']),
  completed: new Set(), failed: new Set(), cancelled: new Set(),
};

export class LocalStore {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (scope TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (message_id TEXT PRIMARY KEY, frame_json TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replay_seen (
        message_id TEXT PRIMARY KEY,
        replay_key TEXT NOT NULL UNIQUE,
        seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        message_id TEXT PRIMARY KEY,
        inner_json TEXT NOT NULL,
        status TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_cursors (mailbox TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        view_json TEXT NOT NULL,
        membership_epoch INTEGER NOT NULL,
        key_epoch INTEGER NOT NULL,
        commit_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capsules (
        capsule_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        capability TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        descriptor_hash TEXT NOT NULL,
        binding_hash TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        state_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS task_events (
        task_id TEXT NOT NULL,
        state_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        previous_state TEXT,
        at TEXT NOT NULL,
        PRIMARY KEY (task_id, state_version)
      );
      CREATE TABLE IF NOT EXISTS approvals (task_id TEXT PRIMARY KEY, approval_digest TEXT NOT NULL, approved_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_claims (
        task_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        event TEXT NOT NULL,
        message_id TEXT,
        task_id TEXT,
        trace_id TEXT,
        outcome TEXT NOT NULL,
        error_code TEXT
      );
    `);
  }

  close() { this.db.close(); }

  saveConversation(view) {
    const existing = this.db.prepare('SELECT membership_epoch,key_epoch,commit_hash FROM conversations WHERE conversation_id=?').get(view.conversationId);
    if (existing) {
      if (view.membershipEpoch < existing.membership_epoch || view.keyEpoch < existing.key_epoch) throw new Error('conversation_rollback');
      if (view.membershipEpoch === existing.membership_epoch && view.commitHash !== existing.commit_hash) throw new Error('conversation_fork');
    }
    const serialized = JSON.stringify({ ...view, epochKey: Buffer.from(view.epochKey).toString('base64') });
    this.db.prepare(`INSERT INTO conversations(conversation_id,view_json,membership_epoch,key_epoch,commit_hash)
      VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET view_json=excluded.view_json,membership_epoch=excluded.membership_epoch,key_epoch=excluded.key_epoch,commit_hash=excluded.commit_hash`)
      .run(view.conversationId, serialized, view.membershipEpoch, view.keyEpoch, view.commitHash);
  }

  loadConversations() {
    return this.db.prepare('SELECT view_json FROM conversations').all().map((row) => {
      const view = JSON.parse(row.view_json);
      return { ...view, epochKey: Buffer.from(view.epochKey, 'base64') };
    });
  }

  nextSequence(scope) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO counters(scope,value) VALUES(?,1) ON CONFLICT(scope) DO UPDATE SET value=value+1').run(scope);
      const value = this.db.prepare('SELECT value FROM counters WHERE scope=?').get(scope).value;
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  putOutbox(frame) {
    this.db.prepare('INSERT OR IGNORE INTO outbox(message_id,frame_json,state) VALUES(?,?,?)')
      .run(frame.messageId, JSON.stringify(frame), 'pending');
  }

  pendingOutbox() {
    return this.db.prepare("SELECT frame_json FROM outbox WHERE state='pending' ORDER BY rowid")
      .all().map((row) => JSON.parse(row.frame_json));
  }

  markPublished(messageId) {
    this.db.prepare("UPDATE outbox SET state='published' WHERE message_id=?").run(messageId);
  }

  markOutboxExpired(messageId) {
    this.db.prepare("UPDATE outbox SET state='expired' WHERE message_id=? AND state='pending'").run(messageId);
    this.audit('delivery.expired', { messageId, outcome: 'expired', errorCode: 'EXPIRED' });
  }

  getCursor(mailbox) {
    return this.db.prepare('SELECT cursor FROM delivery_cursors WHERE mailbox=?').get(mailbox)?.cursor ?? 0;
  }

  setCursor(mailbox, cursor) {
    this.db.prepare('INSERT INTO delivery_cursors(mailbox,cursor) VALUES(?,?) ON CONFLICT(mailbox) DO UPDATE SET cursor=excluded.cursor').run(mailbox, cursor);
  }

  receive(frame, inner, classification = {}) {
    const replayKey = `${frame.conversationId}:${frame.senderDeviceId}:${frame.keyEpoch}:${frame.senderSeq}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seen = this.db.prepare('SELECT 1 FROM replay_seen WHERE message_id=? OR replay_key=?').get(frame.messageId, replayKey);
      if (seen) {
        this.audit('delivery.duplicate', { messageId: frame.messageId, traceId: frame.traceId, outcome: 'ignored', errorCode: 'REPLAY' });
        this.db.exec('COMMIT');
        return { duplicate: true };
      }
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO replay_seen(message_id,replay_key,seen_at) VALUES(?,?,?)').run(frame.messageId, replayKey, now);
      this.db.prepare('INSERT INTO inbox(message_id,inner_json,status,received_at) VALUES(?,?,?,?)')
        .run(frame.messageId, JSON.stringify(inner), classification.inboxStatus ?? 'received', now);
      if (classification.capsule) {
        const capsuleJson = JSON.stringify(classification.capsule);
        const existingCapsule = this.db.prepare('SELECT metadata_json FROM capsules WHERE capsule_id=?').get(classification.capsule.capsuleId);
        if (existingCapsule && existingCapsule.metadata_json !== capsuleJson) throw new Error('capsule_id_collision');
        this.db.prepare('INSERT OR IGNORE INTO capsules(capsule_id,message_id,status,metadata_json) VALUES(?,?,?,?)')
          .run(classification.capsule.capsuleId, frame.messageId, 'quarantined', capsuleJson);
      }
      if (classification.task) {
        const task = classification.task;
        const existingTask = this.db.prepare('SELECT binding_hash FROM tasks WHERE task_id=?').get(task.taskId);
        if (existingTask && existingTask.binding_hash !== task.bindingHash) throw new Error('task_id_collision');
        this.db.prepare(`INSERT OR IGNORE INTO tasks(
          task_id,capability,descriptor_json,descriptor_hash,binding_hash,sender_agent_id,conversation_id,message_id,payload_hash,policy_version,state,state_version,payload_json,error_code
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(task.taskId, task.capability, JSON.stringify(task.descriptor), task.descriptorHash, task.bindingHash,
            task.senderAgentId, task.conversationId, task.messageId, task.payloadHash, task.policyVersion,
            task.state, 1, JSON.stringify(task.payload ?? {}), task.errorCode ?? null);
        this.db.prepare('INSERT OR IGNORE INTO task_events(task_id,state_version,state,previous_state,at) VALUES(?,?,?,?,?)')
          .run(task.taskId, 1, task.state, null, now);
      }
      this.audit('delivery.accepted', { messageId: frame.messageId, traceId: frame.traceId, outcome: 'accepted' });
      this.db.exec('COMMIT');
      return { duplicate: false };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  audit(event, { messageId = null, taskId = null, traceId = null, outcome, errorCode = null }) {
    this.db.prepare('INSERT INTO audit_events(at,event,message_id,task_id,trace_id,outcome,error_code) VALUES(?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), event, messageId, taskId, traceId, outcome, errorCode);
  }

  task(taskId) { return this.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId); }

  approveTask(taskId, approvalDigest) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.task(taskId);
      if (!task || task.state !== 'proposed') throw new Error('task_not_proposed');
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO approvals(task_id,approval_digest,approved_at) VALUES(?,?,?)').run(taskId, approvalDigest, now);
      const version = task.state_version + 1;
      this.db.prepare('UPDATE tasks SET state=?,state_version=?,error_code=NULL WHERE task_id=? AND state_version=?')
        .run('accepted', version, taskId, task.state_version);
      this.db.prepare('INSERT INTO task_events(task_id,state_version,state,previous_state,at) VALUES(?,?,?,?,?)')
        .run(taskId, version, 'accepted', 'proposed', now);
      this.audit('task.transition', { taskId, outcome: 'accepted' });
      this.db.exec('COMMIT');
      return this.task(taskId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  transitionTask(taskId, next, errorCode = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.task(taskId);
      if (!task) throw new Error('task_not_found');
      if (!transitions[task.state]?.has(next)) throw new Error(`invalid_transition:${task.state}:${next}`);
      const version = task.state_version + 1;
      this.db.prepare('UPDATE tasks SET state=?,state_version=?,error_code=? WHERE task_id=? AND state_version=?')
        .run(next, version, errorCode, taskId, task.state_version);
      this.db.prepare('INSERT INTO task_events(task_id,state_version,state,previous_state,at) VALUES(?,?,?,?,?)')
        .run(taskId, version, next, task.state, new Date().toISOString());
      this.audit('task.transition', { taskId, outcome: next, errorCode });
      this.db.exec('COMMIT');
      return this.task(taskId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimAndStart(taskId, idempotencyKey) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.task(taskId);
      if (!task || task.state !== 'accepted') throw new Error('task_not_accepted');
      const now = new Date().toISOString();
      const claim = this.db.prepare('INSERT OR IGNORE INTO execution_claims(task_id,idempotency_key,status,claimed_at) VALUES(?,?,?,?)')
        .run(taskId, idempotencyKey, 'running', now);
      if (claim.changes !== 1) { this.db.exec('COMMIT'); return false; }
      const version = task.state_version + 1;
      this.db.prepare('UPDATE tasks SET state=?,state_version=? WHERE task_id=? AND state_version=?').run('running', version, taskId, task.state_version);
      this.db.prepare('INSERT INTO task_events(task_id,state_version,state,previous_state,at) VALUES(?,?,?,?,?)').run(taskId, version, 'running', 'accepted', now);
      this.audit('task.transition', { taskId, outcome: 'running' });
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  executionAttempt(taskId) { return this.db.prepare('SELECT * FROM execution_claims WHERE task_id=?').get(taskId); }

  completeExecution(taskId, result) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.task(taskId);
      if (!task || task.state !== 'running') throw new Error('task_not_running');
      const version = task.state_version + 1;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE execution_claims SET status=?,result_json=? WHERE task_id=?').run('completed', JSON.stringify(result), taskId);
      this.db.prepare('UPDATE tasks SET state=?,state_version=? WHERE task_id=?').run('completed', version, taskId);
      this.db.prepare('INSERT INTO task_events(task_id,state_version,state,previous_state,at) VALUES(?,?,?,?,?)').run(taskId, version, 'completed', 'running', now);
      this.audit('task.transition', { taskId, outcome: 'completed' });
      this.db.exec('COMMIT');
      return this.task(taskId);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  inboxCount() { return this.db.prepare('SELECT COUNT(*) count FROM inbox').get().count; }
  capsule(capsuleId) { return this.db.prepare('SELECT * FROM capsules WHERE capsule_id=?').get(capsuleId); }
  auditRows() { return this.db.prepare('SELECT * FROM audit_events ORDER BY id').all(); }
}
