import { z } from "zod";
import {
  customerId,
  customerJson,
  customerRoute,
} from "@/lib/customers/http.server";
import { serviceEvent } from "@/lib/customers/service.server";
const input = z
  .object({
    idempotencyKey: z.string().min(8).max(128),
    description: z.string().trim().max(1000).optional(),
    completedAt: z.string().datetime({ offset: true }).optional(),
    serviceDate: z.string().date().optional(),
  })
  .strict();
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  return customerRoute(true, async (scope) => ({
    serviceEvent: await serviceEvent(
      scope,
      customerId(params.id),
      null,
      input.parse(await customerJson(request)),
    ),
  }));
}
