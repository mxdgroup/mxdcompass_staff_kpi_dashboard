/**
 * Reactivate a suspended Wrike webhook.
 * P15: Routes through WrikeClient for retry, throttle, and timeout.
 * Returns true on success, false on failure (logs the error).
 */
import { getWrikeClient } from "./client";

export async function reactivateWebhook(): Promise<boolean> {
  const webhookId = process.env.WRIKE_WEBHOOK_ID;

  if (!webhookId) {
    console.warn(
      "[wrike] Cannot reactivate webhook — missing WRIKE_WEBHOOK_ID env var",
    );
    return false;
  }

  try {
    await getWrikeClient().put(`/webhooks/${webhookId}`, { status: "Active" });
    console.log(`[wrike] Webhook ${webhookId} reactivated successfully`);
    return true;
  } catch (err) {
    console.error("[wrike] Webhook reactivation failed:", err);
    return false;
  }
}
