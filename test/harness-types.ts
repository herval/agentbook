// Types the tests share. Types only: Node strips this file to nothing.

// What a test reads back from agentbook's API, or from a fake it runs: JSON it checks field by field, as the page
// reads it. Left unchecked on purpose (the test's own checks are what check it); the one `any` the tests have.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

// What agentbook-cli's /api/status says of its link to its server, the part the harness waits on (plugin/cli/uplink.ts).
export interface CliStatus {
  // The server it's logged in to, if any.
  server?: string;
  connected?: boolean;
  // Ops it has yet to send up.
  waiting?: number;
  seq?: number;
  // How far it has sent up to.
  scanned?: number;
}
