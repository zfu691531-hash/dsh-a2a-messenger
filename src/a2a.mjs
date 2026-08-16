export const A2A_WIRE_VERSION = '1.0';
export const A2A_SPEC_PATCH_REVIEWED = '1.0.1';
export const EXTENSIONS = [
  'https://dsh-a2a.dev/extensions/messenger-envelope/v1',
  'https://dsh-a2a.dev/extensions/identity-device/v1',
  'https://dsh-a2a.dev/extensions/group-membership/v1',
  'https://dsh-a2a.dev/extensions/context-capsule/v1',
  'https://dsh-a2a.dev/extensions/capability-task/v1',
];

export function a2aHeaders(extra = {}) {
  return {
    ...extra,
    'A2A-Version': A2A_WIRE_VERSION,
    'A2A-Extensions': EXTENSIONS.join(','),
    'Content-Type': 'application/a2a+json',
  };
}

export function createAgentCard({ name, description, url, version = '0.1.0' }) {
  if (!name || !description || !/^https:\/\//.test(url) || !version) throw new Error('invalid_agent_card');
  return {
    name,
    description,
    supportedInterfaces: [{ url, protocolBinding: 'HTTP+JSON', protocolVersion: A2A_WIRE_VERSION }],
    version,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: EXTENSIONS.map((uri) => ({ uri, required: false })),
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: 'dsh-a2a-messenger', name: 'Encrypted agent messaging', description: 'Product extension adapter', tags: ['messaging', 'tasks'] }],
  };
}

const taskStateMap = {
  proposed: 'TASK_STATE_SUBMITTED',
  accepted: 'TASK_STATE_SUBMITTED',
  running: 'TASK_STATE_WORKING',
  blocked: 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  cancelled: 'TASK_STATE_CANCELED',
};

export function mapProductTaskState(state) {
  const mapped = taskStateMap[state];
  if (!mapped) throw new Error('unknown_product_task_state');
  return mapped;
}

export function toA2AMessage(inner, { messageId, contextId, taskId } = {}) {
  if (!messageId) throw new Error('a2a_message_id_required');
  return {
    messageId,
    contextId,
    taskId,
    role: 'ROLE_USER',
    parts: [{ data: inner.payload ?? {} }],
    extensions: EXTENSIONS,
    metadata: {
      [EXTENSIONS[0]]: { productType: inner.type, contentHash: inner.contentHash },
    },
  };
}

export function toA2AArtifact(result, artifactId) {
  if (!artifactId) throw new Error('a2a_artifact_id_required');
  return { artifactId, name: 'task-result', parts: [{ data: result }], extensions: [EXTENSIONS[4]] };
}
