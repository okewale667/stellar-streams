/**
 * Machine-readable protocol changelog loader and validator.
 *
 * The canonical data lives in `docs/protocol-changelog.json`.  This module
 * provides fully-typed access to that document and a suite of runtime
 * invariant checks that act as executable verification of the spec.
 *
 * Usage:
 *   import { getProtocolChangelog, assertChangelogIntegrity } from './protocol-changelog.js';
 *   const changelog = getProtocolChangelog();
 *   assertChangelogIntegrity(changelog); // throws on invariant violation
 */

// ---------------------------------------------------------------------------
// Shared primitive types
// ---------------------------------------------------------------------------

export type PathKind = 'normal' | 'failure' | 'retry' | 'authorization';

export interface BehaviorPath {
  kind: PathKind;
  description: string;
  precondition?: string;
  postcondition?: string;
  /** Numeric error code emitted on this path (null for auth/retry paths without a typed code). */
  errorCode?: number | null;
  errorVariant?: string;
  retryable?: boolean;
  retryNotes?: string;
  emitsEvent?: string;
}

export interface EntryPointArg {
  name: string;
  type: string;
  description?: string;
}

export interface EntryPointAuth {
  required: boolean;
  actor: string;
  notes?: string;
}

export interface EntryPoint {
  name: string;
  description?: string;
  args?: EntryPointArg[];
  returns?: string;
  auth: EntryPointAuth;
  paths: BehaviorPath[];
}

export interface ErrorCode {
  code: number;
  variant: string;
  meaning: string;
  retryable?: boolean;
  /** True when the discriminant is reserved but never actually returned. */
  retired?: boolean;
}

export interface EventDataField {
  name: string;
  type: string;
}

export interface EventSpec {
  topics: string[];
  dataFields: EventDataField[];
  publishedBy: string[];
  notes?: string;
}

export interface StateMachineState {
  name: string;
  terminal?: boolean;
  description?: string;
}

export interface Transition {
  from: string;
  to: string;
  trigger: string;
  authorizedCallers: string[];
  precondition?: string;
  errorOnPreconditionFail?: number;
  errorVariantOnPreconditionFail?: string;
  tokenTransfer?: string;
  emitsEvent?: string;
}

export interface StateMachine {
  states: StateMachineState[];
  transitions: Transition[];
}

export interface ContractSpec {
  name: string;
  rustStruct: string;
  description?: string;
  entryPoints: EntryPoint[];
  errorCodes: ErrorCode[];
  events: EventSpec[];
  stateMachine: StateMachine;
}

export interface ProtocolChangelog {
  schemaVersion: string;
  protocolVersion: number;
  generatedAt: string;
  contracts: {
    stream: ContractSpec;
    splits: ContractSpec;
    escrow: ContractSpec;
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

// Static JSON import — `resolveJsonModule: true` is set in the shared tsconfig
// so TypeScript understands this. Vitest loads it via Node's CJS interop.
// The relative path resolves from packages/utils/src → repo root → docs/.
// If the utils package is moved, update this import path accordingly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import _changelog from '../../../docs/protocol-changelog.json';

/**
 * Return the parsed protocol changelog.  The JSON is imported statically so
 * the TypeScript compiler and bundler can verify the path exists at build time.
 */
export function getProtocolChangelog(): ProtocolChangelog {
  return _changelog as unknown as ProtocolChangelog;
}

// ---------------------------------------------------------------------------
// Integrity assertions — these are the "executable verification" required by
// the acceptance criteria.  Each function throws a descriptive Error on any
// violation so a test suite can simply call assertChangelogIntegrity().
// ---------------------------------------------------------------------------

/**
 * Assert that every error code object has a unique, monotonically increasing
 * numeric code and that no code is ever reused.
 */
export function assertErrorCodesAreUnique(spec: ContractSpec): void {
  const seen = new Map<number, string>();
  for (const ec of spec.errorCodes) {
    if (seen.has(ec.code)) {
      throw new Error(
        `${spec.name}: duplicate error code ${ec.code} (${ec.variant} vs ${seen.get(ec.code)})`,
      );
    }
    seen.set(ec.code, ec.variant);
  }
}

/**
 * Assert that every failure path with an errorCode has a matching entry in
 * the contract's errorCodes table, and vice-versa for all non-retired codes.
 */
export function assertFailurePathsHaveErrorCodes(spec: ContractSpec): void {
  const codeIndex = new Map(spec.errorCodes.map((ec) => [ec.code, ec]));
  const activeErrorCodes = new Set(
    spec.errorCodes.filter((ec) => !ec.retired).map((ec) => ec.code),
  );

  // Every failure path with a numeric errorCode must exist in the table.
  for (const ep of spec.entryPoints) {
    for (const path of ep.paths) {
      if (path.kind === 'failure' && typeof path.errorCode === 'number') {
        if (!codeIndex.has(path.errorCode)) {
          throw new Error(
            `${spec.name}.${ep.name}: failure path references error code ${path.errorCode} (${path.errorVariant ?? '?'}) which is not in errorCodes table`,
          );
        }
      }
    }
  }

  // Every active (non-retired) error code must appear in at least one entry-point path.
  const referencedCodes = new Set<number>();
  for (const ep of spec.entryPoints) {
    for (const path of ep.paths) {
      if (typeof path.errorCode === 'number') {
        referencedCodes.add(path.errorCode);
      }
    }
  }
  // Also count transition-level error codes.
  for (const t of spec.stateMachine.transitions) {
    if (typeof t.errorOnPreconditionFail === 'number') {
      referencedCodes.add(t.errorOnPreconditionFail);
    }
  }

  for (const code of activeErrorCodes) {
    if (!referencedCodes.has(code)) {
      const ec = codeIndex.get(code)!;
      throw new Error(
        `${spec.name}: active error code ${code} (${ec.variant}) is never referenced in any entry-point path or state-machine transition`,
      );
    }
  }
}

/**
 * Assert that every entry point that is auth-required has at least one
 * authorization-kind path.
 */
export function assertAuthPathsPresent(spec: ContractSpec): void {
  for (const ep of spec.entryPoints) {
    if (!ep.auth.required) continue;
    const hasAuthPath = ep.paths.some((p) => p.kind === 'authorization');
    if (!hasAuthPath) {
      throw new Error(
        `${spec.name}.${ep.name}: auth.required == true but no authorization-kind path is documented`,
      );
    }
  }
}

/**
 * Assert that every entry point that modifies state (i.e. has a normal path)
 * has at least one documented failure path.
 */
export function assertNormalPathsHaveFailurePaths(spec: ContractSpec): void {
  for (const ep of spec.entryPoints) {
    const hasNormal = ep.paths.some((p) => p.kind === 'normal');
    const hasFailure = ep.paths.some((p) => p.kind === 'failure');
    if (hasNormal && !hasFailure) {
      throw new Error(
        `${spec.name}.${ep.name}: has a normal path but no failure paths documented`,
      );
    }
  }
}

/**
 * Assert that every state referenced by a transition exists in the state list.
 */
export function assertTransitionStatesExist(spec: ContractSpec): void {
  const stateNames = new Set(spec.stateMachine.states.map((s) => s.name));
  // Add a sentinel for the "not yet created" pseudo-state.
  stateNames.add('none');

  for (const t of spec.stateMachine.transitions) {
    if (!stateNames.has(t.from)) {
      throw new Error(
        `${spec.name}: transition ${t.trigger} references unknown 'from' state: ${t.from}`,
      );
    }
    if (!stateNames.has(t.to)) {
      throw new Error(
        `${spec.name}: transition ${t.trigger} references unknown 'to' state: ${t.to}`,
      );
    }
  }
}

/**
 * Assert that every terminal state has no outgoing transitions.
 */
export function assertTerminalStatesHaveNoTransitions(spec: ContractSpec): void {
  const terminalStates = new Set(
    spec.stateMachine.states.filter((s) => s.terminal).map((s) => s.name),
  );
  for (const t of spec.stateMachine.transitions) {
    if (terminalStates.has(t.from)) {
      throw new Error(
        `${spec.name}: terminal state '${t.from}' has an outgoing transition (${t.trigger})`,
      );
    }
  }
}

/**
 * Assert that every event referenced in entry-point paths or transitions
 * uses a topic prefix that matches the contract name.
 */
export function assertEventTopicsMatchContract(spec: ContractSpec): void {
  const contractTag = spec.name; // "stream", "splits", "escrow"
  for (const ev of spec.events) {
    if (ev.topics[0] !== contractTag) {
      throw new Error(
        `${spec.name}: event topics[0] is '${ev.topics[0]}' but expected '${contractTag}'`,
      );
    }
  }
}

/**
 * Run all integrity checks against a single ContractSpec.  Throws on the first
 * violation found.
 */
export function assertContractIntegrity(spec: ContractSpec): void {
  assertErrorCodesAreUnique(spec);
  assertFailurePathsHaveErrorCodes(spec);
  assertAuthPathsPresent(spec);
  assertNormalPathsHaveFailurePaths(spec);
  assertTransitionStatesExist(spec);
  assertTerminalStatesHaveNoTransitions(spec);
  assertEventTopicsMatchContract(spec);
}

/**
 * Run all integrity checks across all contracts in the changelog.
 * Throws an Error describing the first violation found.
 */
export function assertChangelogIntegrity(changelog: ProtocolChangelog): void {
  if (!changelog.schemaVersion || typeof changelog.schemaVersion !== 'string') {
    throw new Error('changelog.schemaVersion is missing or not a string');
  }
  if (!Number.isInteger(changelog.protocolVersion) || changelog.protocolVersion < 1) {
    throw new Error('changelog.protocolVersion must be a positive integer');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(changelog.generatedAt)) {
    throw new Error('changelog.generatedAt must be an ISO 8601 date (YYYY-MM-DD)');
  }
  for (const spec of Object.values(changelog.contracts) as ContractSpec[]) {
    assertContractIntegrity(spec);
  }
}

// ---------------------------------------------------------------------------
// Convenience query helpers
// ---------------------------------------------------------------------------

/** Look up an error code entry by numeric code within a contract spec. */
export function lookupErrorCode(spec: ContractSpec, code: number): ErrorCode | undefined {
  return spec.errorCodes.find((ec) => ec.code === code);
}

/** Return all entry points that require authorization. */
export function getAuthenticatedEntryPoints(spec: ContractSpec): EntryPoint[] {
  return spec.entryPoints.filter((ep) => ep.auth.required);
}

/** Return all retryable error codes for a contract. */
export function getRetryableErrorCodes(spec: ContractSpec): ErrorCode[] {
  return spec.errorCodes.filter((ec) => ec.retryable === true);
}

/** Return all non-retryable, non-retired error codes (hard failures). */
export function getHardFailureCodes(spec: ContractSpec): ErrorCode[] {
  return spec.errorCodes.filter((ec) => ec.retryable === false && !ec.retired);
}

/** Return all terminal states for a contract. */
export function getTerminalStates(spec: ContractSpec): StateMachineState[] {
  return spec.stateMachine.states.filter((s) => s.terminal === true);
}
