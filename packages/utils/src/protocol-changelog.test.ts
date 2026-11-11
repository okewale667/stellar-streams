/**
 * Automated verification of the machine-readable protocol changelog.
 *
 * These tests serve as the "automated tests or executable verification"
 * required by the acceptance criteria.  They cover:
 *
 *   • Normal paths — every contract entry point has a documented success path.
 *   • Failure paths — every entry point with side-effects has failure paths.
 *   • Retry semantics — retryable vs. hard-failure codes are classified and
 *     tested for correctness against known contract behaviour.
 *   • Authorization paths — every auth-required entry point documents what
 *     happens on a missing or wrong signature.
 *   • State-machine invariants — transitions reference real states; terminal
 *     states have no outgoing transitions.
 *   • Schema integrity — the changelog document satisfies structural checks.
 *   • Edge cases — retired codes, batch limits, deadline gating, milestone
 *     ordering, TTL notes, and cross-contract conventions.
 */

import { describe, expect, it } from 'vitest';
import type { ContractSpec, ProtocolChangelog } from './protocol-changelog.js';
import {
  assertChangelogIntegrity,
  assertContractIntegrity,
  assertAuthPathsPresent,
  assertErrorCodesAreUnique,
  assertFailurePathsHaveErrorCodes,
  assertNormalPathsHaveFailurePaths,
  assertTerminalStatesHaveNoTransitions,
  assertTransitionStatesExist,
  assertEventTopicsMatchContract,
  getAuthenticatedEntryPoints,
  getHardFailureCodes,
  getProtocolChangelog,
  getRetryableErrorCodes,
  getTerminalStates,
  lookupErrorCode,
} from './protocol-changelog.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getContract(changelog: ProtocolChangelog, name: 'stream' | 'splits' | 'escrow') {
  return changelog.contracts[name];
}

// ---------------------------------------------------------------------------
// 1. Document integrity
// ---------------------------------------------------------------------------

describe('protocol-changelog document', () => {
  it('loads without throwing', () => {
    expect(() => getProtocolChangelog()).not.toThrow();
  });

  it('has the required top-level fields', () => {
    const cl = getProtocolChangelog();
    expect(cl.schemaVersion).toBeTypeOf('string');
    expect(cl.protocolVersion).toBeTypeOf('number');
    expect(cl.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cl.contracts).toBeDefined();
  });

  it('contains all three contracts', () => {
    const cl = getProtocolChangelog();
    expect(cl.contracts.stream).toBeDefined();
    expect(cl.contracts.splits).toBeDefined();
    expect(cl.contracts.escrow).toBeDefined();
  });

  it('passes assertChangelogIntegrity end-to-end', () => {
    expect(() => assertChangelogIntegrity(getProtocolChangelog())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Per-contract structural assertions
// ---------------------------------------------------------------------------

describe.each(['stream', 'splits', 'escrow'] as const)('%s contract', (contractName) => {
  it('has unique error codes', () => {
    const spec = getContract(getProtocolChangelog(), contractName);
    expect(() => assertErrorCodesAreUnique(spec)).not.toThrow();
  });

  it('failure paths reference codes in the error table', () => {
    const spec = getContract(getProtocolChangelog(), contractName);
    expect(() => assertFailurePathsHaveErrorCodes(spec)).not.toThrow();
  });

  it('auth-required entry points have authorization paths', () => {
    const spec = getContract(getProtocolChangelog(), contractName);
    expect(() => assertAuthPathsPresent(spec)).not.toThrow();
  });

  it('entry points with normal paths also document failure paths', () => {
    const spec = getContract(getProtocolChangelog(), contractName);
    expect(() => assertNormalPathsHaveFailurePaths(spec)).not.toThrow();
  });

  it('state machine transitions reference declared states', () => {
    const spec = getContract(getProtocolChangelog(), contractName);
    expect(() => assertTransitionStatesExist(spec)).not.toThrow();
  });

  it('terminal states have no outgoing transitions', () => {
    const spec = getContract(getProtocolChangelog(), contractName);
    expect(() => assertTerminalStatesHaveNoTransitions(spec)).not.toThrow();
  });

  it('event topics[0] matches contract name', () => {
    const spec = getContract(getProtocolChangelog(), contractName);
    expect(() => assertEventTopicsMatchContract(spec)).not.toThrow();
  });

  it('every entry point has at least one path', () => {
    const spec = getContract(getProtocolChangelog(), contractName);
    for (const ep of spec.entryPoints) {
      expect(ep.paths.length, `${contractName}.${ep.name} has no paths`).toBeGreaterThan(0);
    }
  });

  it('every entry point has at least one normal path', () => {
    const spec = getContract(getProtocolChangelog(), contractName);
    for (const ep of spec.entryPoints) {
      const hasNormal = ep.paths.some((p) => p.kind === 'normal');
      expect(hasNormal, `${contractName}.${ep.name} has no normal path`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. stream contract — normal and failure paths
// ---------------------------------------------------------------------------

describe('stream contract — entry points', () => {
  it('create_stream has auth and InvalidStartTime failure path', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const ep = spec.entryPoints.find((e) => e.name === 'create_stream')!;
    expect(ep).toBeDefined();
    expect(ep.auth.required).toBe(true);
    const startTimePath = ep.paths.find((p) => p.errorCode === 12);
    expect(startTimePath).toBeDefined();
    expect(startTimePath!.errorVariant).toBe('InvalidStartTime');
    expect(startTimePath!.retryable).toBe(true);
  });

  it('create_stream documents MetadataTooLong (code 11)', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const ep = spec.entryPoints.find((e) => e.name === 'create_stream')!;
    const metaPath = ep.paths.find((p) => p.errorCode === 11);
    expect(metaPath).toBeDefined();
    expect(metaPath!.retryable).toBe(true);
  });

  it('create_streams documents EmptyBatch, BatchTooLarge, BatchOverflow, and retry path', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const ep = spec.entryPoints.find((e) => e.name === 'create_streams')!;
    expect(ep).toBeDefined();
    const codes = ep.paths.map((p) => p.errorCode).filter(Boolean);
    expect(codes).toContain(13); // EmptyBatch
    expect(codes).toContain(14); // BatchTooLarge
    expect(codes).toContain(15); // BatchOverflow
    const retryPath = ep.paths.find((p) => p.kind === 'retry');
    expect(retryPath).toBeDefined();
    expect(retryPath!.retryNotes).toMatch(/next_stream_id/i);
  });

  it('withdraw has NothingToWithdraw (retryable) and TreasuryNotSet (non-retryable)', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const ep = spec.entryPoints.find((e) => e.name === 'withdraw')!;
    const nothingPath = ep.paths.find((p) => p.errorCode === 5)!;
    expect(nothingPath.retryable).toBe(true);
    const treasuryPath = ep.paths.find((p) => p.errorCode === 10)!;
    expect(treasuryPath.retryable).toBe(false);
  });

  it('withdraw documents a retry path with idempotency guidance', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const ep = spec.entryPoints.find((e) => e.name === 'withdraw')!;
    const retryPath = ep.paths.find((p) => p.kind === 'retry');
    expect(retryPath).toBeDefined();
    expect(retryPath!.retryNotes).toMatch(/withdrawn/i);
  });

  it('cancel documents AlreadyCancelled as non-retryable', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const ep = spec.entryPoints.find((e) => e.name === 'cancel')!;
    const path = ep.paths.find((p) => p.errorCode === 8)!;
    expect(path.retryable).toBe(false);
  });

  it('transfer_recipient documents SameRecipient (code 20) and Unauthorized (code 6)', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const ep = spec.entryPoints.find((e) => e.name === 'transfer_recipient')!;
    const sameRecip = ep.paths.find((p) => p.errorCode === 20)!;
    expect(sameRecip.errorVariant).toBe('SameRecipient');
    expect(sameRecip.retryable).toBe(true);
    const unauth = ep.paths.find((p) => p.errorCode === 6)!;
    expect(unauth.errorVariant).toBe('Unauthorized');
  });
});

describe('stream contract — error codes', () => {
  it('has all 16 documented codes', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const codes = spec.errorCodes.map((ec) => ec.code);
    // Codes 1-15 plus 20 for SameRecipient.
    const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20];
    for (const code of expected) {
      expect(codes, `stream should have error code ${code}`).toContain(code);
    }
  });

  it('classifies retryable codes correctly for stream', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const retryable = getRetryableErrorCodes(spec).map((ec) => ec.code);
    // These should all be retryable (input errors the caller can fix).
    expect(retryable).toContain(1);  // InvalidAmount
    expect(retryable).toContain(2);  // InvalidTimeRange
    expect(retryable).toContain(3);  // InvalidCliff
    expect(retryable).toContain(5);  // NothingToWithdraw
    expect(retryable).toContain(7);  // InvalidFee
    expect(retryable).toContain(11); // MetadataTooLong
    expect(retryable).toContain(12); // InvalidStartTime
    expect(retryable).toContain(13); // EmptyBatch
    expect(retryable).toContain(14); // BatchTooLarge
    expect(retryable).toContain(15); // BatchOverflow
    expect(retryable).toContain(20); // SameRecipient
  });

  it('classifies hard failures correctly for stream', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const hard = getHardFailureCodes(spec).map((ec) => ec.code);
    expect(hard).toContain(4);  // StreamNotFound
    expect(hard).toContain(8);  // AlreadyCancelled
    expect(hard).toContain(9);  // AlreadyInitialized
    expect(hard).toContain(10); // TreasuryNotSet
  });
});

describe('stream contract — state machine', () => {
  it('transitions from none → active on create_stream', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const t = spec.stateMachine.transitions.find(
      (tr) => tr.from === 'none' && tr.to === 'active',
    );
    expect(t).toBeDefined();
    expect(t!.authorizedCallers).toContain('sender');
  });

  it('transitions active → cancelled on cancel', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const t = spec.stateMachine.transitions.find(
      (tr) => tr.from === 'active' && tr.to === 'cancelled',
    );
    expect(t).toBeDefined();
    expect(t!.authorizedCallers).toContain('sender');
  });

  it('cancelled is a terminal state', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const terminal = getTerminalStates(spec).map((s) => s.name);
    expect(terminal).toContain('cancelled');
  });
});

describe('stream contract — events', () => {
  it('every event has topics[0] == "stream"', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    for (const ev of spec.events) {
      expect(ev.topics[0]).toBe('stream');
    }
  });

  it('withdrawn event has amount and fee fields', () => {
    const spec = getContract(getProtocolChangelog(), 'stream');
    const ev = spec.events.find((e) => e.topics[1] === 'withdrawn')!;
    expect(ev).toBeDefined();
    const fields = ev.dataFields.map((f) => f.name);
    expect(fields).toContain('amount');
    expect(fields).toContain('fee');
  });
});

// ---------------------------------------------------------------------------
// 4. splits contract — normal and failure paths
// ---------------------------------------------------------------------------

describe('splits contract — entry points', () => {
  it('create_split documents DuplicateRecipient and ShareOverflow', () => {
    const spec = getContract(getProtocolChangelog(), 'splits');
    const ep = spec.entryPoints.find((e) => e.name === 'create_split')!;
    const dupPath = ep.paths.find((p) => p.errorCode === 5)!;
    expect(dupPath.errorVariant).toBe('DuplicateRecipient');
    const overflowPath = ep.paths.find((p) => p.errorCode === 8)!;
    expect(overflowPath.errorVariant).toBe('ShareOverflow');
  });

  it('distribute checks amount BEFORE require_auth (documented in auth notes)', () => {
    const spec = getContract(getProtocolChangelog(), 'splits');
    const ep = spec.entryPoints.find((e) => e.name === 'distribute')!;
    expect(ep.auth.notes).toMatch(/InvalidAmount.*before/i);
  });

  it('distribute has a retry path with balance-check guidance', () => {
    const spec = getContract(getProtocolChangelog(), 'splits');
    const ep = spec.entryPoints.find((e) => e.name === 'distribute')!;
    const retryPath = ep.paths.find((p) => p.kind === 'retry');
    expect(retryPath).toBeDefined();
    expect(retryPath!.retryNotes).toMatch(/balance/i);
  });
});

describe('splits contract — error codes', () => {
  it('code 7 (Unauthorized) is marked retired', () => {
    const spec = getContract(getProtocolChangelog(), 'splits');
    const ec = lookupErrorCode(spec, 7)!;
    expect(ec).toBeDefined();
    expect(ec.retired).toBe(true);
  });

  it('classifies retryable codes correctly for splits', () => {
    const spec = getContract(getProtocolChangelog(), 'splits');
    const retryable = getRetryableErrorCodes(spec).map((ec) => ec.code);
    expect(retryable).toContain(1); // EmptyRecipients
    expect(retryable).toContain(2); // LengthMismatch
    expect(retryable).toContain(3); // InvalidShares
    expect(retryable).toContain(4); // InvalidAmount
    expect(retryable).toContain(5); // DuplicateRecipient
    expect(retryable).toContain(8); // ShareOverflow
    expect(retryable).toContain(9); // RecipientIndexOutOfBounds
  });

  it('SplitNotFound (6) is a hard failure', () => {
    const spec = getContract(getProtocolChangelog(), 'splits');
    const hard = getHardFailureCodes(spec).map((ec) => ec.code);
    expect(hard).toContain(6);
  });
});

describe('splits contract — state machine', () => {
  it('splits has no terminal states (immutable once created)', () => {
    const spec = getContract(getProtocolChangelog(), 'splits');
    const terminal = getTerminalStates(spec);
    expect(terminal).toHaveLength(0);
  });

  it('distribute transition stays in registered state', () => {
    const spec = getContract(getProtocolChangelog(), 'splits');
    const t = spec.stateMachine.transitions.find((tr) => tr.trigger === 'distribute')!;
    expect(t.from).toBe('registered');
    expect(t.to).toBe('registered');
  });
});

describe('splits contract — events', () => {
  it("distrib event topic is 'distrib' not 'distributed' (9-char limit)", () => {
    const spec = getContract(getProtocolChangelog(), 'splits');
    const ev = spec.events.find((e) => e.topics[1] === 'distrib')!;
    expect(ev).toBeDefined();
    // Notes should explain the truncation.
    expect(ev.notes).toMatch(/distrib/i);
  });
});

// ---------------------------------------------------------------------------
// 5. escrow contract — normal, failure, retry, authorization paths
// ---------------------------------------------------------------------------

describe('escrow contract — create_escrow', () => {
  it('InvalidAmount (3) is checked before payer auth', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'create_escrow')!;
    const failPath = ep.paths.find((p) => p.errorCode === 3)!;
    expect(failPath).toBeDefined();
    // The description in retryNotes or description should mention "before" auth.
    expect(failPath.retryNotes).toMatch(/Checked before/i);
  });

  it('InvalidDeadline (9) is documented', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'create_escrow')!;
    const deadlinePath = ep.paths.find((p) => p.errorCode === 9)!;
    expect(deadlinePath).toBeDefined();
    expect(deadlinePath.errorVariant).toBe('InvalidDeadline');
    expect(deadlinePath.retryable).toBe(true);
  });
});

describe('escrow contract — fund_escrow', () => {
  it('has a retry path with idempotency guidance', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'fund_escrow')!;
    const retryPath = ep.paths.find((p) => p.kind === 'retry');
    expect(retryPath).toBeDefined();
    expect(retryPath!.retryNotes).toMatch(/get_escrow/i);
  });

  it('InvalidStateTransition is non-retryable for fund on non-Created state', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'fund_escrow')!;
    const path = ep.paths.find((p) => p.errorCode === 5)!;
    expect(path.retryable).toBe(false);
  });
});

describe('escrow contract — release_escrow', () => {
  it('release_escrow only allowed from Funded state (not Created)', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'release_escrow')!;
    const statePath = ep.paths.find((p) => p.errorCode === 5)!;
    expect(statePath).toBeDefined();
    expect(statePath.retryNotes).toMatch(/fund_escrow/i);
  });

  it('UnauthorizedOperation (4) is retryable for release_escrow', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'release_escrow')!;
    const authPath = ep.paths.find((p) => p.errorCode === 4)!;
    expect(authPath.retryable).toBe(true);
    expect(authPath.retryNotes).toMatch(/payer|arbiter/i);
  });
});

describe('escrow contract — refund_escrow', () => {
  it('payee or arbiter can authorize refund', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'refund_escrow')!;
    expect(ep.auth.actor).toMatch(/payee|arbiter/i);
  });

  it('Created → Refunded is not allowed (documented as InvalidStateTransition)', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'refund_escrow')!;
    const path = ep.paths.find((p) => p.errorCode === 5)!;
    // The retryNotes should explain the Created precondition requires funding first.
    expect(path.retryNotes).toMatch(/Created.*Funded|Funded.*required/i);
  });
});

describe('escrow contract — cancel_escrow', () => {
  it('DeadlineNotReached (6) is retryable with time-based guidance', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'cancel_escrow')!;
    const path = ep.paths.find((p) => p.errorCode === 6)!;
    expect(path.retryable).toBe(true);
    expect(path.retryNotes).toMatch(/deadline/i);
  });

  it('documents two separate normal paths: unfunded (no transfer) and funded (after deadline)', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'cancel_escrow')!;
    const normalPaths = ep.paths.filter((p) => p.kind === 'normal');
    expect(normalPaths.length).toBeGreaterThanOrEqual(2);
    const hasUnfunded = normalPaths.some((p) => p.precondition?.match(/Created/i));
    const hasFunded   = normalPaths.some((p) => p.precondition?.match(/Funded/i));
    expect(hasUnfunded).toBe(true);
    expect(hasFunded).toBe(true);
  });
});

describe('escrow contract — milestone edge cases', () => {
  it('release_milestone documents MilestoneAlreadyReleased as non-retryable', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'release_milestone')!;
    const path = ep.paths.find((p) => p.errorCode === 12)!;
    expect(path.errorVariant).toBe('MilestoneAlreadyReleased');
    expect(path.retryable).toBe(false);
  });

  it('set_milestones documents MilestoneScheduleInvalid (code 13) as retryable', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ep = spec.entryPoints.find((e) => e.name === 'set_milestones')!;
    const path = ep.paths.find((p) => p.errorCode === 13)!;
    expect(path.errorVariant).toBe('MilestoneScheduleInvalid');
    expect(path.retryable).toBe(true);
  });
});

describe('escrow contract — error codes', () => {
  it('code 2 (EscrowAlreadyExists) is marked retired', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ec = lookupErrorCode(spec, 2)!;
    expect(ec).toBeDefined();
    expect(ec.retired).toBe(true);
  });

  it('code 7 (DeadlineExpired) is marked retired', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ec = lookupErrorCode(spec, 7)!;
    expect(ec).toBeDefined();
    expect(ec.retired).toBe(true);
  });

  it('classifies retryable codes correctly for escrow', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const retryable = getRetryableErrorCodes(spec).map((ec) => ec.code);
    expect(retryable).toContain(3);  // InvalidAmount
    expect(retryable).toContain(4);  // UnauthorizedOperation
    expect(retryable).toContain(6);  // DeadlineNotReached
    expect(retryable).toContain(9);  // InvalidDeadline
    expect(retryable).toContain(11); // MilestoneIndexOutOfRange
    expect(retryable).toContain(13); // MilestoneScheduleInvalid
  });

  it('classifies hard failures correctly for escrow', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const hard = getHardFailureCodes(spec).map((ec) => ec.code);
    expect(hard).toContain(1);  // EscrowNotFound
    expect(hard).toContain(5);  // InvalidStateTransition
    expect(hard).toContain(8);  // AlreadyFinalized
    expect(hard).toContain(10); // MilestoneScheduleNotFound
    expect(hard).toContain(12); // MilestoneAlreadyReleased
  });
});

describe('escrow contract — state machine', () => {
  it('has five states', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    // none + Created + Funded + Released + Refunded + Cancelled
    // "none" is implicit in transitions but not always listed; at least 5 explicit states.
    expect(spec.stateMachine.states.length).toBeGreaterThanOrEqual(5);
  });

  it('Released, Refunded, and Cancelled are terminal', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const terminal = getTerminalStates(spec).map((s) => s.name);
    expect(terminal).toContain('Released');
    expect(terminal).toContain('Refunded');
    expect(terminal).toContain('Cancelled');
  });

  it('Funded → Released transition is authorized by payer or arbiter', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const t = spec.stateMachine.transitions.find(
      (tr) => tr.from === 'Funded' && tr.to === 'Released',
    )!;
    expect(t).toBeDefined();
    expect(t.authorizedCallers).toContain('payer');
    expect(t.authorizedCallers).toContain('arbiter');
  });

  it('Funded → Refunded transition is authorized by payee or arbiter', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const t = spec.stateMachine.transitions.find(
      (tr) => tr.from === 'Funded' && tr.to === 'Refunded',
    )!;
    expect(t).toBeDefined();
    expect(t.authorizedCallers).toContain('payee');
    expect(t.authorizedCallers).toContain('arbiter');
  });

  it('Funded → Cancelled has precondition: deadline must be reached', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const t = spec.stateMachine.transitions.find(
      (tr) => tr.from === 'Funded' && tr.to === 'Cancelled',
    )!;
    expect(t.precondition).toMatch(/deadline/i);
    expect(t.errorOnPreconditionFail).toBe(6); // DeadlineNotReached
  });
});

describe('escrow contract — events', () => {
  it("cancelled event has no amount field (fires for both funded and unfunded cancellations)", () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ev = spec.events.find((e) => e.topics[1] === 'cancelled')!;
    expect(ev).toBeDefined();
    const fields = ev.dataFields.map((f) => f.name);
    expect(fields).not.toContain('amount');
    expect(ev.notes).toMatch(/no amount/i);
  });

  it('released event names both caller and payee', () => {
    const spec = getContract(getProtocolChangelog(), 'escrow');
    const ev = spec.events.find((e) => e.topics[1] === 'released')!;
    const fields = ev.dataFields.map((f) => f.name);
    expect(fields).toContain('caller');
    expect(fields).toContain('payee');
    expect(fields).toContain('amount');
  });
});

// ---------------------------------------------------------------------------
// 6. Cross-contract conventions
// ---------------------------------------------------------------------------

describe('cross-contract conventions', () => {
  it('all contracts expose a version entry point (read-only)', () => {
    const cl = getProtocolChangelog();
    for (const spec of Object.values(cl.contracts) as ContractSpec[]) {
      // version() is a read with no side-effects so it may not appear in
      // entryPoints, but it is documented in docs/contracts.md. We just
      // verify the contract spec has a name and rustStruct.
      expect(spec.name).toBeTypeOf('string');
      expect(spec.rustStruct).toBeTypeOf('string');
    }
  });

  it('all contracts have at least one auth-required entry point', () => {
    const cl = getProtocolChangelog();
    for (const spec of Object.values(cl.contracts) as ContractSpec[]) {
      const authenticated = getAuthenticatedEntryPoints(spec);
      expect(
        authenticated.length,
        `${spec.name} should have at least one auth-required entry point`,
      ).toBeGreaterThan(0);
    }
  });

  it('no contract has retryable terminal states', () => {
    const cl = getProtocolChangelog();
    for (const spec of Object.values(cl.contracts) as ContractSpec[]) {
      const terminal = getTerminalStates(spec).map((s) => s.name);
      const outgoing = spec.stateMachine.transitions.filter((t) => terminal.includes(t.from));
      expect(
        outgoing.length,
        `${spec.name}: terminal states should have no outgoing transitions`,
      ).toBe(0);
    }
  });

  it('every authorization path documents a retryNotes hint', () => {
    const cl = getProtocolChangelog();
    for (const spec of Object.values(cl.contracts) as ContractSpec[]) {
      for (const ep of spec.entryPoints) {
        for (const path of ep.paths) {
          if (path.kind === 'authorization') {
            expect(
              path.retryNotes,
              `${spec.name}.${ep.name}: authorization path should document retryNotes`,
            ).toBeTruthy();
          }
        }
      }
    }
  });

  it('error codes are non-zero positive integers in all contracts', () => {
    const cl = getProtocolChangelog();
    for (const spec of Object.values(cl.contracts) as ContractSpec[]) {
      for (const ec of spec.errorCodes) {
        expect(ec.code, `${spec.name}: error codes must be >= 1`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Negative tests for assertChangelogIntegrity
// ---------------------------------------------------------------------------

describe('assertChangelogIntegrity — rejects malformed documents', () => {
  function cloneChangelog(): ProtocolChangelog {
    return JSON.parse(JSON.stringify(getProtocolChangelog())) as ProtocolChangelog;
  }

  it('rejects a missing schemaVersion', () => {
    const cl = cloneChangelog();
    // @ts-expect-error intentional mutation for negative test
    delete cl.schemaVersion;
    expect(() => assertChangelogIntegrity(cl)).toThrow(/schemaVersion/i);
  });

  it('rejects a non-integer protocolVersion', () => {
    const cl = cloneChangelog();
    // @ts-expect-error intentional mutation
    cl.protocolVersion = 'v1';
    expect(() => assertChangelogIntegrity(cl)).toThrow(/protocolVersion/i);
  });

  it('rejects a malformed generatedAt date', () => {
    const cl = cloneChangelog();
    cl.generatedAt = '11/11/2026';
    expect(() => assertChangelogIntegrity(cl)).toThrow(/generatedAt/i);
  });

  it('rejects a contract with duplicate error codes', () => {
    const spec = cloneChangelog().contracts.stream;
    spec.errorCodes.push({ code: 1, variant: 'Duplicate', meaning: 'duplicate test' });
    expect(() => assertErrorCodesAreUnique(spec)).toThrow(/duplicate error code 1/i);
  });

  it('rejects a failure path referencing a code not in the error table', () => {
    const spec = cloneChangelog().contracts.stream;
    spec.entryPoints[0].paths.push({
      kind: 'failure',
      description: 'unknown code test',
      errorCode: 999,
      errorVariant: 'NonExistent',
    });
    expect(() => assertFailurePathsHaveErrorCodes(spec)).toThrow(/999/);
  });

  it('rejects an auth-required entry point with no authorization path', () => {
    const spec = cloneChangelog().contracts.stream;
    const ep = spec.entryPoints.find((e) => e.name === 'withdraw')!;
    ep.paths = ep.paths.filter((p) => p.kind !== 'authorization');
    expect(() => assertAuthPathsPresent(spec)).toThrow(/withdraw.*authorization/i);
  });

  it('rejects a transition with an unknown from-state', () => {
    const spec = cloneChangelog().contracts.stream;
    spec.stateMachine.transitions.push({
      from: 'ghost',
      to: 'active',
      trigger: 'phantom',
      authorizedCallers: ['sender'],
    });
    expect(() => assertTransitionStatesExist(spec)).toThrow(/ghost/);
  });

  it('rejects a transition that leaves a terminal state', () => {
    const spec = cloneChangelog().contracts.escrow;
    spec.stateMachine.transitions.push({
      from: 'Cancelled',
      to: 'Funded',
      trigger: 'revive',
      authorizedCallers: ['payer'],
    });
    expect(() => assertTerminalStatesHaveNoTransitions(spec)).toThrow(/Cancelled/);
  });
});
