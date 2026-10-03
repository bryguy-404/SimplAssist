import { z } from "zod";
import {
  customerId,
  customerJson,
  customerRoute,
} from "@/lib/customers/http.server";
import { serviceEvent } from "@/lib/customers/service.server";
export async function PATCH(
  request: Request,
  { params }: { params: { id: string; eventId: string } },
) {
  return customerRoute(true, async (scope) => ({
    serviceEvent: await serviceEvent(
      scope,
      customerId(params.id),
      customerId(params.eventId),
      z
        .object({ status: z.enum(["open", "completed"]) })
        .strict()
        .parse(await customerJson(request)),
    ),
  }));
}
