import type { ReviewSmsOverview } from "@/lib/billing/reviewSms";
import { US_STATES } from "@/lib/usStates";
import { body, fieldLabel, ink, inputField, statusSuccess, statusWarning, tile } from "@/lib/theme-v2/theme";

export const LEGAL_FIELDS = [
  ["legalBusinessName", "Legal business name", "text"],
  ["address", "Business street address", "text"],
  ["city", "City", "text"],
  ["zip", "ZIP code", "text"],
  ["authorizedRepName", "Authorized representative name", "text"],
  ["authorizedRepEmail", "Representative email", "email"],
  ["authorizedRepPhone", "Representative phone (+1…)", "tel"],
] as const;
export const REPRESENTATIVE_FIELDS = ["authorizedRepName", "authorizedRepEmail", "authorizedRepPhone"] as const;

export function ReviewSmsRegistrationFields({ overview, id }: { overview: ReviewSmsOverview; id: string }) {
  const fields = overview.setup?.fields || {};
  const sharedRegistration = overview.sharedRegistration;
  const identityLocked = fields.identityLocked === true || Boolean(sharedRegistration);
  const representativeEditable = sharedRegistration?.status === "approved" && fields.representativeEditable === true;
  return (
    <>
      {identityLocked && !sharedRegistration ? (
        <p className={`text-xs ${body}`}>
          Your existing registered business details are shown below. Contact
          support if they need to change.
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {LEGAL_FIELDS.map(([name, label, type]) => (
          <div key={name}>
            <label htmlFor={`${id}-${name}`} className={fieldLabel}>
              {label}
            </label>
            <input
              id={`${id}-${name}`}
              name={name}
              type={type}
              required
              readOnly={identityLocked && !(representativeEditable && REPRESENTATIVE_FIELDS.some((key) => key === name))}
              defaultValue={name === "legalBusinessName" && sharedRegistration
                ? sharedRegistration.legalBusinessName
                : String(fields[name] || "")}
              maxLength={
                name === "address"
                  ? 200
                  : name === "authorizedRepEmail"
                    ? 254
                    : 120
              }
              className={inputField}
            />
          </div>
        ))}
        <div>
          <label htmlFor={`${id}-state`} className={fieldLabel}>
            State
          </label>
          <select
            id={`${id}-state`}
            name="state"
            required
            disabled={identityLocked}
            defaultValue={String(fields.state || "")}
            className={inputField}
          >
            <option value="">Choose a state</option>
            {US_STATES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-entity`} className={fieldLabel}>
            Business structure
          </label>
          <select
            id={`${id}-entity`}
            name="entityType"
            required
            disabled={identityLocked}
            defaultValue={String(fields.entityType || "")}
            className={inputField}
          >
            <option value="">Choose a structure</option>
            <option value="llc">LLC</option>
            <option value="c_corp">C corporation</option>
            <option value="s_corp">S corporation</option>
            <option value="nonprofit">Nonprofit</option>
            <option value="partnership">Partnership</option>
            <option value="sole_proprietor">Sole proprietor</option>
          </select>
        </div>
        <div>
          <label
            htmlFor={fields.hasEin || sharedRegistration ? undefined : `${id}-ein`}
            className={fieldLabel}
          >
            Employer identification number (EIN)
          </label>
          {fields.hasEin || sharedRegistration ? (
            <p className={`rounded-2xl p-3 text-sm ${statusSuccess}`}>
              EIN already saved. It is not displayed here.
            </p>
          ) : (
            <input
              id={`${id}-ein`}
              name="ein"
              required
              type="password"
              autoComplete="off"
              placeholder="XX-XXXXXXX"
              pattern="[0-9]{2}-?[0-9]{7}"
              maxLength={10}
              className={inputField}
            />
          )}
        </div>
      </div>
    </>
  );
}

export function ReviewSmsRegistrationNotice({ overview }: { overview: ReviewSmsOverview }) {
  const registrationUnavailable = overview.sharedRegistration?.status === "revoked";
  return (
    <>
      {overview.sharedRegistration ? (
        <div className={`${tile} p-4`}>
          <p className={`font-semibold ${ink}`}>Uses your existing legal registration</p>
          <p className={`mt-2 text-sm ${body}`}>
            This business uses the legal registration for {overview.sharedRegistration.legalBusinessName}.
            Its legal name, EIN, and registration address are read-only here. Contact support if they need to change.
            Each business needs its own approved review-text program and number.
          </p>
          {overview.sharedRegistration.status === "approved" && overview.setup?.fields.representativeEditable === true ? <p className={`mt-2 text-sm ${body}`}>
            Enter the representative authorized to manage texting for this business.
            These contact details can be updated until this business is registered.
          </p> : null}
          <p className={`mt-2 text-sm ${body}`}>
            {overview.setup?.fields.publicAddressVisibility === "city_state"
              ? "The full registration address is used privately for carrier approval. Your public SimplAssist business and policy pages show only the city and state."
              : "Your registered business address is used for carrier approval."}
          </p>
          {registrationUnavailable ? <p role="status" className={`mt-3 text-sm ${statusWarning}`}>
            This legal registration is unavailable. Contact support before continuing texting setup.
            Email reviews remain available.
          </p> : null}
        </div>
      ) : null}
    </>
  );
}
