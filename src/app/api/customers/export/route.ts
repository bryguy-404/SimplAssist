import { filtersFromParams } from "@/lib/customers/domain";
import { exportCustomersCsv } from "@/lib/customers/csv";
import { customerRoute } from "@/lib/customers/http.server";
import {
  ensureCustomerScope,
  exportCustomerPage,
} from "@/lib/customers/service.server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return customerRoute(false, async (scope) => {
    const filters = filtersFromParams(new URL(request.url).searchParams);
    const before = new Date().toISOString();
    let after: { id: string; created_at: string } | null = null;
    let header = true;
    let done = false;
    // Fetch the first page before opening the response so initial failures return JSON.
    let pending = await exportCustomerPage(scope, filters, before, after);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (done) {
            controller.close();
            return;
          }
          const page = pending;
          controller.enqueue(encoder.encode(exportCustomersCsv(page, header)));
          header = false;
          if (!page.length) {
            done = true;
            controller.close();
            return;
          }
          const last = page[page.length - 1];
          after = { id: last.id, created_at: last.created_at };
          await ensureCustomerScope(scope);
          pending = await exportCustomerPage(scope, filters, before, after);
        } catch (error) {
          done = true;
          controller.error(error);
        }
      },
      cancel() {
        done = true;
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="customers.csv"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
