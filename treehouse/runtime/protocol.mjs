export const TREEHOUSE_PROTOCOL_VERSION = 1;

export function createMachineOutcome(command, payload = {}) {
  return {
    protocolVersion: TREEHOUSE_PROTOCOL_VERSION,
    command,
    ...payload,
  };
}
