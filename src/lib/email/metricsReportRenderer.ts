import {
  SIMPLASSIST_LEGAL_LINE,
  SIMPLASSIST_LEGAL_LINE_HTML,
} from "./legalFooter";
import {
  BUSINESS_METRIC_KEYS_V1,
  BUSINESS_METRIC_LABELS_V1,
  type BusinessMetricCountKeyV1,
} from "@/lib/metrics/contract";
import {
  parseMetricsReportPayloadV1,
  type MetricsReportDefinitionV1,
  type MetricsReportSnapshotPayloadV1,
} from "@/lib/metrics/reportSnapshot";

export interface MetricsReportRenderOptions {
  test?: boolean;
}

export interface MetricsReportEmail {
  subject: string;
  text: string;
  html: string;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const COUNT_COLUMNS = BUSINESS_METRIC_KEYS_V1.flatMap((key) =>
  key === "booking_confirmed"
    ? ([
        "booking_confirmed",
        "booking_confirmed_ai",
        "booking_confirmed_dashboard",
      ] as const)
    : ([key] as const),
) satisfies readonly BusinessMetricCountKeyV1[];

const COUNT_LABELS = {
  ...BUSINESS_METRIC_LABELS_V1,
  booking_confirmed_ai: "Bookings confirmed — AI",
  booking_confirmed_dashboard: "Bookings confirmed — Dashboard",
} as const satisfies Record<BusinessMetricCountKeyV1, string>;

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  useGrouping: true,
});

/**
 * Builds the count-only v1 monthly report message. The payload is reparsed at
 * this boundary so callers cannot render a forged or internally inconsistent
 * object by asserting the TypeScript type.
 */
export function renderMetricsReportEmail(
  value: unknown,
  options: MetricsReportRenderOptions = {},
): MetricsReportEmail {
  const payload = parseMetricsReportPayloadV1(value);
  const monthLabel = formatMonth(payload.period.month);
  const brandLabel = normalizePlainText(payload.scope.brand_name);
  const subject = `${options.test ? "[TEST] " : ""}${
    brandLabel
  } — ${monthLabel} SimplAssist activity report`;

  return {
    subject,
    text: renderText(payload, monthLabel, brandLabel),
    html: renderHtml(payload, monthLabel),
  };
}

function renderText(
  payload: MetricsReportSnapshotPayloadV1,
  monthLabel: string,
  brandLabel: string,
): string {
  const selectionLabel =
    payload.selection.mode === "all"
      ? "All businesses"
      : `${payload.selection.business_ids.length} selected ${pluralize(
          payload.selection.business_ids.length,
          "business",
          "businesses",
        )}`;
  const lines = [
    `${brandLabel} — ${monthLabel} SimplAssist activity report`,
    "",
    `Reporting period: ${monthLabel} (UTC)`,
    `Business selection: ${selectionLabel}`,
    "",
    "Brand totals",
    ...COUNT_COLUMNS.map(
      (key) => `${COUNT_LABELS[key]}: ${formatCount(payload.totals[key])}`,
    ),
    "",
    "Per-business breakdown",
  ];

  if (payload.businesses.length === 0) {
    lines.push("No businesses recorded activity in this reporting period.");
  } else {
    lines.push(renderTextBusinessTable(payload));
  }

  lines.push(
    "",
    "Metric availability",
    "Availability labels distinguish recoverable history from live-only collection.",
    ...renderTextDefinitions(payload),
    "",
    SIMPLASSIST_LEGAL_LINE,
  );

  return lines.join("\n");
}

function renderTextBusinessTable(
  payload: MetricsReportSnapshotPayloadV1,
): string {
  const header = ["Business", ...COUNT_COLUMNS.map((key) => COUNT_LABELS[key])];
  const rows = payload.businesses.map((business) => [
    business.business_name,
    ...COUNT_COLUMNS.map((key) => formatCount(business.counts[key])),
  ]);
  const separator = header.map(() => "---");
  return [header, separator, ...rows]
    .map((row) => row.map(escapeTextTableCell).join(" | "))
    .join("\n");
}

function renderTextDefinitions(
  payload: MetricsReportSnapshotPayloadV1,
): string[] {
  const byKey = new Map(
    payload.definitions.map((definition) => [
      definition.metric_key,
      definition,
    ]),
  );

  return BUSINESS_METRIC_KEYS_V1.map((key) => {
    const definition = byKey.get(key) as MetricsReportDefinitionV1;
    return `${BUSINESS_METRIC_LABELS_V1[key]}: Definition v${
      definition.definition_version
    } · Available since ${formatAvailableSince(
      definition.available_since,
    )} UTC · ${coverageLabel(definition)}`;
  });
}

function renderHtml(
  payload: MetricsReportSnapshotPayloadV1,
  monthLabel: string,
): string {
  const selectionLabel =
    payload.selection.mode === "all"
      ? "All businesses"
      : `${payload.selection.business_ids.length} selected ${pluralize(
          payload.selection.business_ids.length,
          "business",
          "businesses",
        )}`;

  const totalsRows = COUNT_COLUMNS.map(
    (key) =>
      `<tr><th scope="row">${escapeHtml(COUNT_LABELS[key])}</th><td>${escapeHtml(
        formatCount(payload.totals[key]),
      )}</td></tr>`,
  ).join("");

  const businessSection =
    payload.businesses.length === 0
      ? "<p>No businesses recorded activity in this reporting period.</p>"
      : renderHtmlBusinessTable(payload);

  const definitions = renderHtmlDefinitions(payload);

  return [
    "<!doctype html>",
    '<html><body style="font-family:Arial,sans-serif;color:#1c1917;line-height:1.5">',
    `<h1>${escapeHtml(payload.scope.brand_name)} — ${escapeHtml(
      monthLabel,
    )} SimplAssist activity report</h1>`,
    `<p><strong>Reporting period:</strong> ${escapeHtml(
      monthLabel,
    )} (UTC)<br><strong>Business selection:</strong> ${escapeHtml(
      selectionLabel,
    )}</p>`,
    "<h2>Brand totals</h2>",
    '<table border="1" cellpadding="6" cellspacing="0"><thead><tr><th scope="col">Metric</th><th scope="col">Count</th></tr></thead>',
    `<tbody>${totalsRows}</tbody></table>`,
    "<h2>Per-business breakdown</h2>",
    businessSection,
    "<h2>Metric availability</h2>",
    "<p>Availability labels distinguish recoverable history from live-only collection.</p>",
    `<ul>${definitions}</ul>`,
    SIMPLASSIST_LEGAL_LINE_HTML,
    "</body></html>",
  ].join("");
}

function renderHtmlBusinessTable(
  payload: MetricsReportSnapshotPayloadV1,
): string {
  const headers = ["Business", ...COUNT_COLUMNS.map((key) => COUNT_LABELS[key])]
    .map((label) => `<th scope="col">${escapeHtml(label)}</th>`)
    .join("");
  const rows = payload.businesses
    .map((business) => {
      const cells = COUNT_COLUMNS.map(
        (key) => `<td>${escapeHtml(formatCount(business.counts[key]))}</td>`,
      ).join("");
      return `<tr><th scope="row">${escapeHtml(
        business.business_name,
      )}</th>${cells}</tr>`;
    })
    .join("");

  return `<table border="1" cellpadding="6" cellspacing="0"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderHtmlDefinitions(
  payload: MetricsReportSnapshotPayloadV1,
): string {
  const byKey = new Map(
    payload.definitions.map((definition) => [
      definition.metric_key,
      definition,
    ]),
  );

  return BUSINESS_METRIC_KEYS_V1.map((key) => {
    const definition = byKey.get(key) as MetricsReportDefinitionV1;
    const detail = `Definition v${
      definition.definition_version
    } · Available since ${formatAvailableSince(
      definition.available_since,
    )} UTC · ${coverageLabel(definition)}`;
    return `<li><strong>${escapeHtml(
      BUSINESS_METRIC_LABELS_V1[key],
    )}</strong>: ${escapeHtml(detail)}</li>`;
  }).join("");
}

function coverageLabel(definition: MetricsReportDefinitionV1): string {
  return definition.supports_historical_backfill
    ? "Recoverable historical source backfill"
    : "Live collection only";
}

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-");
  return `${MONTH_NAMES[Number(monthNumber) - 1]} ${year}`;
}

function formatAvailableSince(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function formatCount(count: number): string {
  return COUNT_FORMATTER.format(count);
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function escapeTextTableCell(value: string): string {
  return normalizePlainText(value).replace(/\|/g, "\\|");
}

function normalizePlainText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
