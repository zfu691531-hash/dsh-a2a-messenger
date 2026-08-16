import { DatabaseSync } from 'node:sqlite';

const transitions = {
  proposed: new Set(['accepted', 'failed', 'cancelled']),
  accepted: new Set(['running', 'cancelled']),
  running: new Set(['blocked', 'completed', 'failed', 'cancelled']),
  blocked: new Set(['running', 'failed', 'cancelled']),
  completed: new Set(), failed: new Set(), cancelled: new Set(),
};

const MAX_ACTIVE_WORK_PACKAGES = 64;
const MAX_ACTIVE_WORK_BYTES = 256 * 1024 * 1024;

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
      CREATE TABLE IF NOT EXISTS work_packages (
        package_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        authorization_task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL,
        sender_device_id TEXT NOT NULL,
        sender_key_version INTEGER NOT NULL,
        conversation_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        total_bytes INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL,
        received_chunks INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        materialized_path TEXT
      );
      CREATE TABLE IF NOT EXISTS work_package_chunks (
        package_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        digest TEXT NOT NULL,
        data_blob BLOB NOT NULL,
        PRIMARY KEY (package_id, file_path, chunk_index),
        FOREIGN KEY (package_id) REFERENCES work_packages(package_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS outbound_work_tasks (
        task_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        created_at TEXT NOT NULL
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
    this.expireWorkPackages();
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
      const persistedInner = classification.workPackageChunk
        ? { ...inner, payload: { ...inner.payload, data: undefined } }
        : inner;
      this.db.prepare('INSERT INTO inbox(message_id,inner_json,status,received_at) VALUES(?,?,?,?)')
        .run(frame.messageId, JSON.stringify(persistedInner), classification.inboxStatus ?? 'received', now);
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
      if (classification.workPackageManifest) {
        const manifest = classification.workPackageManifest;
        const existing = this.db.prepare('SELECT manifest_hash FROM work_packages WHERE package_id=?').get(manifest.packageId);
        if (existing && existing.manifest_hash !== manifest.manifestHash) throw new Error('work_package_id_collision');
        const totalChunks = manifest.files.reduce((sum, file) => sum + file.chunkCount, 0);
        if (!existing) {
          const active = this.db.prepare(`SELECT COUNT(*) count,COALESCE(SUM(total_bytes),0) bytes FROM work_packages
            WHERE status NOT IN ('materialized','expired')`).get();
          if (active.count >= MAX_ACTIVE_WORK_PACKAGES || active.bytes + manifest.totalBytes > MAX_ACTIVE_WORK_BYTES) {
            throw new Error('work_staging_quota');
          }
          this.db.prepare(`INSERT INTO work_packages(
            package_id,task_id,authorization_task_id,kind,sender_agent_id,sender_device_id,sender_key_version,conversation_id,
            manifest_json,manifest_hash,status,total_bytes,total_chunks,received_chunks,expires_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`)
            .run(manifest.packageId, manifest.taskId, classification.authorizationTaskId, manifest.kind,
              frame.senderAgentId, frame.senderDeviceId, frame.senderKeyVersion, frame.conversationId,
              JSON.stringify(manifest), manifest.manifestHash, totalChunks === 0 ? 'ready' : 'staging',
              manifest.totalBytes, totalChunks, new Date(frame.expiresAt).toISOString());
        }
      }
      if (classification.workPackageChunk) {
        const chunk = classification.workPackageChunk;
        const pkg = this.db.prepare(`SELECT task_id,status,sender_agent_id,sender_device_id,sender_key_version,expires_at
          FROM work_packages WHERE package_id=?`).get(chunk.packageId);
        if (!pkg || pkg.task_id !== chunk.taskId) throw new Error('work_package_manifest_required');
        if (pkg.sender_agent_id !== frame.senderAgentId || pkg.sender_device_id !== frame.senderDeviceId
          || pkg.sender_key_version !== frame.senderKeyVersion) throw new Error('work_package_sender_mismatch');
        if (Date.parse(pkg.expires_at) <= Date.now()) throw new Error('work_package_expired');
        if (!['staging', 'ready'].includes(pkg.status)) throw new Error('work_package_closed');
        const bytes = Buffer.from(chunk.data, 'base64');
        const existing = this.db.prepare(`SELECT chunk_count,byte_length,digest,data_blob FROM work_package_chunks
          WHERE package_id=? AND file_path=? AND chunk_index=?`).get(chunk.packageId, chunk.path, chunk.chunkIndex);
        if (existing) {
          if (existing.chunk_count !== chunk.chunkCount || existing.byte_length !== chunk.byteLength
            || existing.digest !== chunk.sha256 || !Buffer.from(existing.data_blob).equals(bytes)) {
            throw new Error('work_chunk_collision');
          }
        } else {
          this.db.prepare(`INSERT INTO work_package_chunks(
            package_id,task_id,file_path,chunk_index,chunk_count,byte_length,digest,data_blob
          ) VALUES(?,?,?,?,?,?,?,?)`).run(chunk.packageId, chunk.taskId, chunk.path, chunk.chunkIndex,
            chunk.chunkCount, chunk.byteLength, chunk.sha256, bytes);
          this.db.prepare('UPDATE work_packages SET received_chunks=received_chunks+1 WHERE package_id=?').run(chunk.packageId);
        }
        const progress = this.db.prepare('SELECT received_chunks,total_chunks FROM work_packages WHERE package_id=?').get(chunk.packageId);
        if (progress.received_chunks === progress.total_chunks) {
          this.db.prepare("UPDATE work_packages SET status='ready' WHERE package_id=? AND status='staging'").run(chunk.packageId);
        }
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

  registerOutboundWorkTask(taskId, conversationId) {
    this.db.prepare('INSERT OR IGNORE INTO outbound_work_tasks(task_id,conversation_id,created_at) VALUES(?,?,?)')
      .run(taskId, conversationId, new Date().toISOString());
  }

  outboundWorkTask(taskId, conversationId) {
    return this.db.prepare('SELECT * FROM outbound_work_tasks WHERE task_id=? AND conversation_id=?').get(taskId, conversationId);
  }

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
  workPackage(packageId) { return this.db.prepare('SELECT * FROM work_packages WHERE package_id=?').get(packageId); }
  workPackageManifest(packageId) {
    const row = this.workPackage(packageId);
    return row ? JSON.parse(row.manifest_json) : null;
  }
  workPackageChunks(packageId) {
    return this.db.prepare(`SELECT package_id,task_id,file_path,chunk_index,chunk_count,byte_length,digest,data_blob
      FROM work_package_chunks WHERE package_id=? ORDER BY file_path,chunk_index`).all(packageId);
  }
  approveWorkPackage(packageId, authorizationTaskId) {
    this.expireWorkPackages();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pkg = this.workPackage(packageId);
      const task = this.task(authorizationTaskId);
      if (!pkg || pkg.authorization_task_id !== authorizationTaskId || pkg.status !== 'ready') throw new Error('work_package_not_ready');
      if (!task || task.state !== 'accepted' || task.capability !== 'work.package') throw new Error('work_package_task_not_accepted');
      this.db.prepare("UPDATE work_packages SET status='approved',approved_at=? WHERE package_id=?")
        .run(new Date().toISOString(), packageId);
      this.audit('work_package.approved', { taskId: authorizationTaskId, outcome: 'approved' });
      this.db.exec('COMMIT');
      return this.workPackage(packageId);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  beginWorkPackageMaterialization(packageId, destination) {
    this.expireWorkPackages();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pkg = this.workPackage(packageId);
      const task = pkg && this.task(pkg.authorization_task_id);
      if (!pkg || pkg.status !== 'approved' || !task || task.state !== 'accepted') throw new Error('work_package_not_approved');
      const now = new Date().toISOString();
      const version = task.state_version + 1;
      if (typeof destination !== 'string' || destination.length === 0) throw new Error('work_destination_required');
      this.db.prepare("UPDATE work_packages SET status='materializing',materialized_path=? WHERE package_id=?").run(destination, packageId);
      this.db.prepare("UPDATE tasks SET state='running',state_version=? WHERE task_id=? AND state_version=?")
        .run(version, task.task_id, task.state_version);
      this.db.prepare('INSERT INTO task_events(task_id,state_version,state,previous_state,at) VALUES(?,?,?,?,?)')
        .run(task.task_id, version, 'running', 'accepted', now);
      this.audit('work_package.materializing', { taskId: task.task_id, outcome: 'running' });
      this.db.exec('COMMIT');
      return this.workPackage(packageId);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  retryWorkPackageMaterialization(packageId, destination) {
    this.expireWorkPackages();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pkg = this.workPackage(packageId);
      const task = pkg && this.task(pkg.authorization_task_id);
      if (!pkg || pkg.status !== 'blocked' || !task || task.state !== 'blocked') throw new Error('work_package_not_blocked');
      if (typeof destination !== 'string' || destination.length === 0) throw new Error('work_destination_required');
      const now = new Date().toISOString();
      const version = task.state_version + 1;
      this.db.prepare("UPDATE work_packages SET status='materializing',materialized_path=? WHERE package_id=?").run(destination, packageId);
      this.db.prepare("UPDATE tasks SET state='running',state_version=?,error_code=NULL WHERE task_id=? AND state_version=?")
        .run(version, task.task_id, task.state_version);
      this.db.prepare('INSERT INTO task_events(task_id,state_version,state,previous_state,at) VALUES(?,?,?,?,?)')
        .run(task.task_id, version, 'running', 'blocked', now);
      this.audit('work_package.retrying', { taskId: task.task_id, outcome: 'running' });
      this.db.exec('COMMIT');
      return this.workPackage(packageId);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  completeWorkPackageMaterialization(packageId, destination) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pkg = this.workPackage(packageId);
      const task = pkg && this.task(pkg.authorization_task_id);
      if (!pkg || pkg.status !== 'materializing' || !task || task.state !== 'running') throw new Error('work_package_not_materializing');
      const version = task.state_version + 1;
      const now = new Date().toISOString();
      this.db.prepare("UPDATE work_packages SET status='materialized',materialized_path=? WHERE package_id=?").run(destination, packageId);
      this.db.prepare('DELETE FROM work_package_chunks WHERE package_id=?').run(packageId);
      this.db.prepare("UPDATE tasks SET state='completed',state_version=? WHERE task_id=? AND state_version=?")
        .run(version, task.task_id, task.state_version);
      this.db.prepare('INSERT INTO task_events(task_id,state_version,state,previous_state,at) VALUES(?,?,?,?,?)')
        .run(task.task_id, version, 'completed', 'running', now);
      this.audit('work_package.materialized', { taskId: task.task_id, outcome: 'completed' });
      this.db.exec('COMMIT');
      return this.workPackage(packageId);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  blockWorkPackageMaterialization(packageId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pkg = this.workPackage(packageId);
      const task = pkg && this.task(pkg.authorization_task_id);
      if (pkg?.status === 'materializing' && task?.state === 'running') {
        const version = task.state_version + 1;
        const now = new Date().toISOString();
        this.db.prepare("UPDATE work_packages SET status='blocked' WHERE package_id=?").run(packageId);
        this.db.prepare("UPDATE tasks SET state='blocked',state_version=?,error_code='MATERIALIZATION_RECONCILIATION_REQUIRED' WHERE task_id=?")
          .run(version, task.task_id);
        this.db.prepare('INSERT INTO task_events(task_id,state_version,state,previous_state,at) VALUES(?,?,?,?,?)')
          .run(task.task_id, version, 'blocked', 'running', now);
        this.audit('work_package.blocked', { taskId: task.task_id, outcome: 'blocked', errorCode: 'MATERIALIZATION_RECONCILIATION_REQUIRED' });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  expireWorkPackages(now = Date.now()) {
    const expired = this.db.prepare(`SELECT package_id,authorization_task_id FROM work_packages
      WHERE status NOT IN ('materialized','expired','materializing') AND expires_at<=?`).all(new Date(now).toISOString());
    if (expired.length === 0) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const pkg of expired) {
        const task = this.task(pkg.authorization_task_id);
        if (task && ['proposed', 'accepted', 'running', 'blocked'].includes(task.state)) {
          const next = task.state === 'accepted' ? 'cancelled' : 'failed';
          const version = task.state_version + 1;
          this.db.prepare('UPDATE tasks SET state=?,state_version=?,error_code=? WHERE task_id=?')
            .run(next, version, 'WORK_PACKAGE_EXPIRED', task.task_id);
          this.db.prepare('INSERT INTO task_events(task_id,state_version,state,previous_state,at) VALUES(?,?,?,?,?)')
            .run(task.task_id, version, next, task.state, new Date(now).toISOString());
        }
        this.db.prepare('DELETE FROM work_package_chunks WHERE package_id=?').run(pkg.package_id);
        this.db.prepare("UPDATE work_packages SET status='expired' WHERE package_id=?").run(pkg.package_id);
        this.audit('work_package.expired', { taskId: pkg.authorization_task_id, outcome: 'expired', errorCode: 'WORK_PACKAGE_EXPIRED' });
      }
      this.db.exec('COMMIT');
      return expired.length;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  auditRows() { return this.db.prepare('SELECT * FROM audit_events ORDER BY id').all(); }
}
