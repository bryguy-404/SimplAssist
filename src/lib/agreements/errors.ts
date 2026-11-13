import { SERVICE_AGREEMENT_ERRORS } from "./shared";

export class ServiceAgreementError extends Error {
  constructor(readonly code: string, readonly status = 503) {
    super(SERVICE_AGREEMENT_ERRORS[code] ?? SERVICE_AGREEMENT_ERRORS.service_agreement_unavailable);
  }
}
