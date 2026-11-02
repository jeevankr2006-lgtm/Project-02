'use strict';

// An error that is safe to show to the client.
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const validationFailed = (details, message = 'Request failed validation') =>
  new ApiError(400, 'VALIDATION_FAILED', message, details);

module.exports = { ApiError, validationFailed };
