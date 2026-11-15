/**
 * Allowed state transitions. Anything not listed here is rejected with 409 INVALID_TRANSITION.
 *
 *   Trip:    SCHEDULED ──► DEPARTED ──► COMPLETED
 *                 └──────► CANCELLED
 *
 *   Refund:  PENDING ──► PROCESSED
 *               └──────► FAILED ──► PENDING (retry)
 */
export type TripStatus = 'SCHEDULED' | 'DEPARTED' | 'COMPLETED' | 'CANCELLED';
export type RefundStatus = 'PENDING' | 'PROCESSED' | 'FAILED';

const TRIP_TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  SCHEDULED: ['DEPARTED', 'CANCELLED'],
  DEPARTED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

const REFUND_TRANSITIONS: Record<RefundStatus, RefundStatus[]> = {
  PENDING: ['PROCESSED', 'FAILED'],
  FAILED: ['PENDING'],
  PROCESSED: [],
};

export const canTransitionTrip = (from: TripStatus, to: TripStatus) => TRIP_TRANSITIONS[from].includes(to);
export const canTransitionRefund = (from: RefundStatus, to: RefundStatus) => REFUND_TRANSITIONS[from].includes(to);
export const allowedTripTransitions = (from: TripStatus) => TRIP_TRANSITIONS[from];
