export const ORCHARD_PROTOCOL_VERSION = 1;

export function createMachineOutcome(command, payload = {}) {
  return {
    protocolVersion: ORCHARD_PROTOCOL_VERSION,
    command,
    ...payload,
  };
}
