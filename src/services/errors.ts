/** A rule the services refuse to break. The REST layer maps `code` to a status (src/api/errors.ts); messages never contain input values or tokens. */
export type ErrorCode =
  | 'not_found'
  | 'course_not_draft'
  | 'course_not_active'
  | 'course_finished'
  | 'threshold_locked'
  | 'ends_at_shortened'
  | 'ends_at_passed'
  | 'no_cards'
  | 'assessment_closed'
  | 'rating_required'
  | 'invalid_option'
  | 'not_open'
  | 'not_enrolled'
  | 'removed'
  | 'course_over'
  | 'sent_again'
  | 'duplicate';

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
