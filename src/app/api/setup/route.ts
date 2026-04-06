import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getWrikeClient } from "@/lib/wrike/client";
import type { WrikeContact, WrikeWorkflow } from "@/lib/wrike/types";

export async function GET() {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = getWrikeClient();

  try {
    // Fetch contacts
    const contacts = await client.get<WrikeContact>("/contacts");

    // Fetch top-level folders/spaces
    const folders = await client.get<{ id: string; title: string; scope: string }>(
      "/folders",
      { fields: '["metadata"]' }
    );

    // Fetch workflows to show available statuses
    const workflows = await client.get<WrikeWorkflow>("/workflows");

    const allStatuses = workflows.flatMap((wf) =>
      (wf.customStatuses ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        group: s.group,
        workflow: wf.name,
      }))
    );

    return NextResponse.json({
      instructions: "Copy the IDs you need into src/lib/config.ts, commit, and redeploy.",
      contacts: contacts.map((c) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName}`,
      })),
      folders: folders.slice(0, 50).map((f) => ({
        id: f.id,
        title: f.title,
      })),
      workflows: allStatuses,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: "Wrike API failed", details: message }, { status: 500 });
  }
}
