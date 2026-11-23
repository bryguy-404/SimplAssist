import { NextRequest } from "next/server";
import { deleteConversations } from "@/lib/conversations/delete.server";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  return deleteConversations([params.id]);
}
